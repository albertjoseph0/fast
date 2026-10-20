/**
 * Governance: the Outbox the orchestrator proposes into, the board's approvals and
 * human tasks, and the only writer of actions. Approvals bind to the payload hash, so
 * any change to an approved payload sends it back for approval.
 */
import { existsSync } from "node:fs";
import type { StudioConfig } from "../config/schema.ts";
import type { Outbox, ProposeInput } from "../core/context.ts";
import type { Clock } from "../core/ports.ts";
import type { StudioStore } from "../core/store.ts";
import type { Action, ActionKind, ActionStatus, HumanTask, HumanTaskDraft, PolicyFinding, VentureBindings } from "../core/types.ts";
import { payloadHash } from "./hash.ts";
import type { LedgerSync } from "./ledger.ts";
import { POLICY_VERSION, evaluateAction, statusFor, type CoveringApproval, type PolicyContext } from "./policy.ts";

/** Statuses that hold the dedupe key: a new proposal with the same key returns the open one. */
export const OPEN_STATUSES: readonly ActionStatus[] = ["proposed", "blocked", "awaiting_approval", "awaiting_human_task", "approved", "executing"];
/** How long a board rejection of an unchanged payload stands before the same proposal may ask again. */
export const REJECTION_COOLDOWN_DAYS = 14;
/** Statuses re-run through policy as the world changes (cash, time, tasks, approvals). */
const REEVALUATE: readonly ActionStatus[] = ["proposed", "blocked", "awaiting_approval", "awaiting_human_task"];
const TERMINAL: readonly ActionStatus[] = ["executed", "dry_run", "failed", "rejected", "cancelled"];
const DECIDED: readonly ActionStatus[] = ["approved", "blocked", "rejected", "cancelled"];

/** Task outputs written back into VentureBindings when the key matches. */
const BINDING_KEYS = [
  "ascAppId",
  "appStoreUrl",
  "playUrl",
  "easProjectId",
  "revenueCatProjectId",
  "posthogProjectId",
  "webBaseUrl",
  "privacyUrl",
  "termsUrl",
  "supportUrl",
  "deepLinkDomain",
  "backendUrl",
  "metaAppId",
] as const satisfies readonly (keyof VentureBindings)[];

export class Governance implements Outbox {
  private readonly store: StudioStore;
  private readonly config: StudioConfig;
  private readonly clock: Clock;
  private readonly ledger: LedgerSync;
  private readonly killSwitchPath: string | null;
  private readonly dryRun: boolean;

  /** `dryRun` must match the executor's: while it is on, a dry_run of the same payload holds its dedupe key. */
  constructor(deps: { store: StudioStore; config: StudioConfig; clock: Clock; ledger: LedgerSync; killSwitchPath: string | null; dryRun?: boolean }) {
    this.store = deps.store;
    this.config = deps.config;
    this.clock = deps.clock;
    this.ledger = deps.ledger;
    this.killSwitchPath = deps.killSwitchPath;
    this.dryRun = deps.dryRun ?? false;
  }

  killSwitchActive(): boolean {
    return this.killSwitchPath !== null && existsSync(this.killSwitchPath);
  }

  policyContext(): PolicyContext {
    return {
      config: this.config,
      store: this.store,
      now: this.clock.iso(),
      today: this.clock.today(),
      killSwitchActive: this.killSwitchActive(),
      ledger: this.ledger,
    };
  }

  /**
   * Propose an action, or return the one already holding its dedupe key: an open action, a dry run
   * of the same payload while dry-run is on, or a recent board rejection of the same payload.
   */
  propose<K extends ActionKind>(input: ProposeInput<K>): Action<K> {
    const key = `${input.kind}:${input.ventureId ?? "studio"}:${input.naturalKey}`;
    const hash = payloadHash(input.kind, input.ventureId, input.payload);
    const held = this.holderOf(key, hash);
    if (held) return held as Action<K>;

    const now = this.clock.iso();
    const draft: Action<K> = {
      id: this.store.nextId("action"),
      kind: input.kind,
      summary: input.summary,
      rationale: input.rationale,
      proposedBy: input.proposedBy,
      payload: input.payload,
      payloadHash: hash,
      idempotencyKey: key,
      dedupeKey: key,
      costCents: input.costCents ?? input.commitment?.maxTotalCents ?? 0,
      findings: [],
      status: "proposed",
      approvals: [],
      blockedByTaskIds: [],
      policyVersion: POLICY_VERSION,
      createdAt: now,
      ...(input.ventureId !== undefined ? { ventureId: input.ventureId } : {}),
      ...(input.commitment ? { commitment: input.commitment } : {}),
      ...(input.experimentId ? { experimentId: input.experimentId } : {}),
      ...(input.cellId ? { cellId: input.cellId } : {}),
    };
    const action = this.evaluated(draft);
    this.put(action);
    this.store.emit("action.proposed", { actionId: action.id, kind: action.kind, status: action.status, costCents: action.costCents }, action.ventureId);
    if (action.status === "blocked") this.emitBlocked(action);
    return action;
  }

  /** Board approval bound to the action's current payload hash and to the needs_human findings the approver was shown. */
  approve(id: string, approver: string, opts: { channel?: "cli" | "web"; note?: string } = {}): Action {
    this.assertBoard(approver);
    const action = this.store.actions.require(id);
    if (TERMINAL.includes(action.status) || action.status === "executing") throw new Error(`action ${id} is ${action.status} and cannot be approved`);
    const hash = payloadHash(action.kind, action.ventureId, action.payload);
    const coveredRuleIds = [...new Set(action.findings.filter((f) => f.severity === "needs_human").map((f) => f.ruleId))];
    const approval: CoveringApproval = {
      approver,
      payloadHash: hash,
      at: this.clock.iso(),
      channel: opts.channel ?? "cli",
      coveredRuleIds,
      ...(opts.note ? { note: opts.note } : {}),
    };
    return this.transition({ ...action, approvals: [...action.approvals, approval] }, { approver });
  }

  reject(id: string, by: string, reason: string): Action {
    return this.close(id, "rejected", { ruleId: "board.rejected", severity: "info", message: `${by}: ${reason}` }, { by });
  }

  cancel(id: string, reason: string): Action {
    return this.close(id, "cancelled", { ruleId: "governance.cancelled", severity: "info", message: reason }, {});
  }

  /** Re-run policy on every waiting action. Returns those whose status changed. */
  reevaluateOpen(): Action[] {
    const changed: Action[] = [];
    for (const a of this.list({ status: [...REEVALUATE] })) {
      const next = this.transition(a);
      if (next.status !== a.status) changed.push(next);
    }
    return changed;
  }

  /** Re-run policy on one action that is waiting or approved (the executor's pre-flight). */
  recheck(id: string): Action {
    const a = this.store.actions.require(id);
    if (!REEVALUATE.includes(a.status) && a.status !== "approved") return a;
    return this.transition(a);
  }

  openTask(draft: HumanTaskDraft, blocksActionIds: string[] = []): HumanTask {
    const existing = this.store.tasks.list((t) => t.status === "open" && t.kind === draft.kind && t.ventureId === draft.ventureId)[0];
    const task: HumanTask = existing
      ? { ...existing, blocksActionIds: [...new Set([...existing.blocksActionIds, ...blocksActionIds])] }
      : { ...draft, id: this.store.nextId("task"), blocksActionIds: [...new Set(blocksActionIds)], status: "open", createdAt: this.clock.iso() };
    this.store.tasks.put(task);
    for (const actionId of blocksActionIds) {
      const a = this.store.actions.get(actionId);
      if (!a || TERMINAL.includes(a.status)) continue;
      const blockedByTaskIds = [...new Set([...a.blockedByTaskIds, task.id])];
      this.put({ ...a, blockedByTaskIds, status: a.status === "blocked" ? "blocked" : "awaiting_human_task" });
    }
    if (task.ventureId) {
      const v = this.store.ventures.get(task.ventureId);
      if (v && !v.blockedOn.includes(task.id)) this.store.ventures.put({ ...v, blockedOn: [...v.blockedOn, task.id], updatedAt: this.clock.iso() });
    }
    if (!existing) this.store.emit("task.opened", { taskId: task.id, kind: task.kind, blocksActionIds: task.blocksActionIds }, task.ventureId);
    return task;
  }

  completeTask(id: string, outputs: Record<string, string>, by: string): HumanTask {
    this.assertBoard(by);
    const task = this.store.tasks.require(id);
    if (task.status !== "open") throw new Error(`task ${id} is ${task.status}`);
    const problems = task.inputs.flatMap((input) => {
      const value = outputs[input.key];
      if (value === undefined || value.trim() === "") return [`${input.key} is required`];
      if (input.pattern && !new RegExp(`^(?:${input.pattern})$`).test(value)) return [`${input.key} does not match ${input.pattern}`];
      return [];
    });
    if (problems.length) throw new Error(`task ${id} inputs invalid: ${problems.join("; ")}`);

    const now = this.clock.iso();
    const done: HumanTask = { ...task, status: "done", outputs: { ...outputs }, completedAt: now, completedBy: by };
    this.store.tasks.put(done);
    if (task.ventureId) this.writeBindings(task.ventureId, task.id, outputs);
    this.store.emit("task.completed", { taskId: id, kind: task.kind, by }, task.ventureId);
    for (const actionId of task.blocksActionIds) {
      const a = this.store.actions.get(actionId);
      if (!a) continue;
      const unblocked = { ...a, blockedByTaskIds: a.blockedByTaskIds.filter((t) => t !== id) };
      if (TERMINAL.includes(a.status)) this.put(unblocked);
      else this.transition(unblocked);
    }
    return done;
  }

  list(filter: { status?: Action["status"][]; ventureId?: string; kind?: ActionKind[] } = {}): Action[] {
    return this.store.actions
      .list(
        (a) =>
          (!filter.status || filter.status.includes(a.status)) &&
          (!filter.ventureId || a.ventureId === filter.ventureId) &&
          (!filter.kind || filter.kind.includes(a.kind)),
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
  }

  tasks(filter: { status?: HumanTask["status"][]; ventureId?: string } = {}): HumanTask[] {
    return this.store.tasks
      .list((t) => (!filter.status || filter.status.includes(t.status)) && (!filter.ventureId || t.ventureId === filter.ventureId))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
  }

  // -- internals ---------------------------------------------------------------

  private holderOf(key: string, hash: string): Action | undefined {
    const same = this.store.actions.list((a) => a.dedupeKey === key);
    const open = same.find((a) => OPEN_STATUSES.includes(a.status));
    if (open) return open;
    const cooldownStart = new Date(this.clock.now().getTime() - REJECTION_COOLDOWN_DAYS * 86_400_000).toISOString();
    return same.find(
      (a) => a.payloadHash === hash && ((this.dryRun && a.status === "dry_run") || (a.status === "rejected" && (a.decidedAt ?? a.createdAt) >= cooldownStart)),
    );
  }

  /** The action with a fresh payload hash, findings and status. */
  private evaluated<K extends ActionKind>(a: Action<K>): Action<K> {
    // Recomputed so an edited payload can never ride on an approval of the old one.
    const withHash = { ...a, payloadHash: payloadHash(a.kind, a.ventureId, a.payload) };
    const findings = evaluateAction(withHash, this.policyContext());
    const status = statusFor(withHash, findings);
    const decided = DECIDED.includes(status) && status !== a.status ? { decidedAt: this.clock.iso() } : {};
    return { ...withHash, findings, status, policyVersion: POLICY_VERSION, ...decided };
  }

  private transition(a: Action, data: Record<string, unknown> = {}): Action {
    const previous = this.store.actions.get(a.id)?.status;
    const next = this.evaluated(a);
    this.put(next);
    if (next.status !== previous) {
      this.store.emit("action.decided", { actionId: next.id, kind: next.kind, from: previous, status: next.status, ...data }, next.ventureId);
      if (next.status === "blocked") this.emitBlocked(next);
    }
    return next;
  }

  private close(id: string, status: "rejected" | "cancelled", finding: PolicyFinding, data: Record<string, unknown>): Action {
    const a = this.store.actions.require(id);
    if (!OPEN_STATUSES.includes(a.status) || a.status === "executing") throw new Error(`action ${id} is ${a.status} and cannot be ${status}`);
    const next: Action = { ...a, status, findings: [...a.findings, finding], decidedAt: this.clock.iso() };
    this.put(next);
    this.store.emit("action.decided", { actionId: id, kind: a.kind, from: a.status, status, reason: finding.message, ...data }, a.ventureId);
    return next;
  }

  private emitBlocked(a: Action): void {
    const findings = a.findings.filter((f) => f.severity === "block").map((f) => ({ ruleId: f.ruleId, message: f.message }));
    this.store.emit("policy.blocked", { actionId: a.id, kind: a.kind, findings }, a.ventureId);
  }

  private writeBindings(ventureId: string, taskId: string, outputs: Record<string, string>): void {
    const v = this.store.ventures.get(ventureId);
    if (!v) return;
    const bindings: VentureBindings = { ...v.bindings };
    for (const key of BINDING_KEYS) {
      const value = outputs[key];
      if (value !== undefined && value !== "") bindings[key] = value;
    }
    this.store.ventures.put({ ...v, bindings, blockedOn: v.blockedOn.filter((t) => t !== taskId), updatedAt: this.clock.iso() });
  }

  private put(a: Action): void {
    this.store.governanceActions().put(a);
  }

  private assertBoard(person: string): void {
    if (!this.config.autonomy.board.includes(person)) throw new Error(`${person} is not on the board`);
  }
}
