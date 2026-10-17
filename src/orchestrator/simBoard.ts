/**
 * A simulated board for simulation runs: approves what governance routed to humans and
 * completes human tasks with plausible outputs after a delay, the way an operator
 * working through the CLI queue would. Never used in live mode.
 */
import type { StudioConfig } from "../config/schema.ts";
import type { Clock } from "../core/ports.ts";
import type { Rng } from "../core/rng.ts";
import type { StudioStore } from "../core/store.ts";
import type { Action, HumanTask } from "../core/types.ts";
import type { Governance } from "../governance/outbox.ts";

export interface SimBoardPolicy {
  /** Days an approval waits before the board looks at it. */
  approvalDelayDays: number;
  /** Days a human task takes. */
  taskDelayDays: number;
  /** Probability the board rejects an approval it reviews (judgement noise). */
  rejectRate: number;
  /** Kinds the board always rejects (e.g. to test a studio without paid acquisition). */
  neverApprove: Action["kind"][];
}

export const DEFAULT_BOARD_POLICY: SimBoardPolicy = { approvalDelayDays: 1, taskDelayDays: 2, rejectRate: 0, neverApprove: [] };

const DAY_MS = 86_400_000;

function ageDays(from: string, now: string): number {
  return (new Date(now).getTime() - new Date(from).getTime()) / DAY_MS;
}

export class SimBoard {
  private readonly store: StudioStore;
  private readonly governance: Governance;
  private readonly clock: Clock;
  private readonly rng: Rng;
  private readonly member: string;
  private readonly policy: SimBoardPolicy;

  constructor(o: { store: StudioStore; governance: Governance; clock: Clock; rng: Rng; config: StudioConfig; policy?: Partial<SimBoardPolicy> }) {
    this.store = o.store;
    this.governance = o.governance;
    this.clock = o.clock;
    this.rng = o.rng;
    this.member = o.config.autonomy.board[0] ?? "owner";
    this.policy = { ...DEFAULT_BOARD_POLICY, ...o.policy };
  }

  act(): { approved: string[]; rejected: string[]; tasksDone: string[] } {
    const now = this.clock.iso();
    const approved: string[] = [];
    const rejected: string[] = [];
    for (const a of this.store.actions.list((x) => x.status === "awaiting_approval" && ageDays(x.createdAt, now) >= this.policy.approvalDelayDays)) {
      const r = this.rng.fork(`board:${a.id}`);
      if (this.policy.neverApprove.includes(a.kind) || r.next() < this.policy.rejectRate) {
        this.governance.reject(a.id, this.member, "sim board declined");
        rejected.push(a.id);
      } else {
        this.governance.approve(a.id, this.member, { channel: "cli", note: "sim board" });
        approved.push(a.id);
      }
    }
    const tasksDone: string[] = [];
    for (const t of this.store.tasks.list((x) => x.status === "open" && ageDays(x.createdAt, now) >= this.policy.taskDelayDays)) {
      const outputs = this.outputsFor(t);
      try {
        this.governance.completeTask(t.id, outputs, this.member);
        tasksDone.push(t.id);
      } catch {
        // An input the board cannot synthesize: leave it open, as a real operator might.
      }
    }
    return { approved, rejected, tasksDone };
  }

  private outputsFor(t: HumanTask): Record<string, string> {
    const v = t.ventureId ? this.store.ventures.get(t.ventureId) : undefined;
    const slug = v?.slug ?? "studio";
    const r = this.rng.fork(`task:${t.id}`);
    const priorDecisions = this.store.tasks.count((x) => x.ventureId === t.ventureId && x.kind === t.kind && x.status === "done");
    const out: Record<string, string> = {};
    for (const input of t.inputs) {
      const p = input.pattern ?? "";
      switch (input.key) {
        case "ascAppId":
          out[input.key] = String(1_000_000_000 + Math.floor(r.next() * 8_999_999_999));
          break;
        case "platform":
          out[input.key] = /Platform:\s*(\w+)/i.exec(t.instructions)?.[1]?.toLowerCase() ?? "instagram";
          break;
        case "handle":
          out[input.key] = `${slug.replace(/-/g, "")}.app`.slice(0, 30);
          break;
        case "tokenSecretRef":
          out[input.key] = "SIM_SOCIAL_TOKEN";
          break;
        case "decision":
          // Approve reviews; resubmit once then abandon; re-run an escalated step once then kill.
          if (/approved/.test(p)) out[input.key] = "approved";
          else if (/resubmit/.test(p)) out[input.key] = priorDecisions === 0 ? "resubmit" : "abandon";
          else if (/rerun/.test(p)) out[input.key] = priorDecisions === 0 ? "rerun" : "kill";
          else out[input.key] = "approve";
          break;
        case "reviewer":
          out[input.key] = "sim board";
          break;
        case "backendUrl":
          out[input.key] = "https://verdict.sim.example";
          break;
        case "webBaseUrl":
          out[input.key] = `https://${slug}.sim.example`;
          break;
        case "deepLinkDomain":
          out[input.key] = `${slug}.sim.example`;
          break;
        case "network":
          out[input.key] = "meta";
          break;
        case "adAccountId":
          out[input.key] = "act_sim_0001";
          break;
        case "fundedCents":
          out[input.key] = "500000";
          break;
        default:
          if (/yes/.test(p)) out[input.key] = "yes";
          else if (/\\d/.test(p)) out[input.key] = "1234567890";
          else if (/https/.test(p)) out[input.key] = `https://${slug}.sim.example`;
          else out[input.key] = "SIM_VALUE";
      }
    }
    return out;
  }
}
