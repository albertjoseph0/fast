/**
 * The studio: one tick is one operating day. Phases run in a fixed order; each phase is
 * isolated so one failing venture or API never stops the rest of the day. The tick is
 * idempotent per date, and every external side effect goes through governance.
 */
import { join } from "node:path";
import type { StudioConfig } from "../config/schema.ts";
import type { TickContext } from "../core/context.ts";
import type { Clock, PortSet } from "../core/ports.ts";
import type { Rng } from "../core/rng.ts";
import type { StudioStore } from "../core/store.ts";
import type { AllocationPlan, StudioEventType, Venture } from "../core/types.ts";
import { Executor } from "../governance/executor.ts";
import { BudgetExceededError, LedgerSync } from "../governance/ledger.ts";
import { Governance, OPEN_STATUSES } from "../governance/outbox.ts";
import { LlmError } from "../llm/errors.ts";
import { taskDraft } from "../playbook/setup.ts";
import { applyLifecycleDecisions, planAllocation, reviewMatureVentures } from "./allocator.ts";
import type { StudioDeps } from "./deps.ts";
import { promoteScreened, runDiscovery } from "./discovery.ts";
import { publishOwnedContent, runAttentionProbe, runCreativeLoop, syncContentStats, syncCreatorSubmissions } from "./growth.ts";
import { pollDueJobs } from "./jobs.ts";
import { ensureExperiment, proposeKill, retryPrepareVariant, runExperiments, settleVariants, testExposureCents, VARIANT_TO_PREPARE } from "./labPhase.ts";
import { blockingTasks, isActive, isLiveOnStore, ladderComplete, patch, timeboxExpired } from "./lifecycle.ts";
import { advanceBuilding, advanceInReview } from "./pipeline.ts";
import { applyTaskOutcomes, openBootstrapTasks } from "./tasks.ts";
import { boardMemo, renderReport, type TickSummary, ventureLines, writeReport } from "./report.ts";

const DAY_MS = 86_400_000;
const METRIC_RESYNC_DAYS = 7;
const COHORT_WINDOW_DAYS = 120;
const MAX_BACKFILL_DAYS = 60;
const SCALE_DECLINE_COOLDOWN_DAYS = 7;
/** Policy rules that hold spend for lack of studio cash rather than for anything about the venture. */
const CASH_RULES: readonly string[] = ["reserve", "daily_cap"];

/** The LLM adapter wraps the meter's BudgetExceededError in an LlmError; media lets it through. */
function isBudgetError(err: unknown): boolean {
  return err instanceof BudgetExceededError || (err instanceof LlmError && err.code === "budget_exceeded");
}

export interface StudioOptions {
  config: StudioConfig;
  store: StudioStore;
  clock: Clock;
  rng: Rng;
  ports: PortSet;
  deps: StudioDeps;
  /** Directory for reports and the kill-switch file. */
  dataDir: string;
  /** Shared with the LLM/media cost meter; created here when omitted. */
  ledger?: LedgerSync;
  /** Write the LLM board memo every N ticks (0 disables). */
  memoEveryTicks?: number;
  /**
   * Record approved writes instead of sending them. The composition root passes the same flag it gave
   * the ports, so the executor and the HTTP layer never disagree; defaults to live mode with config.dryRun.
   */
  dryRun?: boolean;
  onPhase?: (name: string, detail: string) => void;
}

function shiftDate(date: string, days: number): string {
  return new Date(new Date(`${date}T00:00:00.000Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

export class Studio {
  readonly config: StudioConfig;
  readonly store: StudioStore;
  readonly clock: Clock;
  readonly ledger: LedgerSync;
  readonly governance: Governance;
  readonly executor: Executor;
  private readonly rng: Rng;
  private readonly ports: PortSet;
  private readonly deps: StudioDeps;
  private readonly dataDir: string;
  private readonly memoEveryTicks: number;
  private readonly onPhase: ((name: string, detail: string) => void) | undefined;

  constructor(o: StudioOptions) {
    this.config = o.config;
    this.store = o.store;
    this.clock = o.clock;
    this.rng = o.rng;
    this.ports = o.ports;
    this.deps = o.deps;
    this.dataDir = o.dataDir;
    this.memoEveryTicks = o.memoEveryTicks ?? 7;
    this.onPhase = o.onPhase;
    const killSwitchPath = join(o.dataDir, o.config.autonomy.killSwitchFile);
    this.ledger = o.ledger ?? new LedgerSync({ store: o.store, config: o.config, clock: o.clock });
    const dryRun = o.dryRun ?? (o.config.mode === "live" && o.config.dryRun);
    this.governance = new Governance({ store: o.store, config: o.config, clock: o.clock, ledger: this.ledger, killSwitchPath, dryRun });
    this.executor = new Executor({ store: o.store, config: o.config, clock: o.clock, write: o.ports.write, ledger: this.ledger, governance: this.governance, dryRun, killSwitchPath });
  }

  private context(tick: number): TickContext {
    const store = this.store;
    return {
      config: this.config,
      ports: this.ports.read,
      store,
      rng: this.rng.fork(`tick:${this.clock.today()}`),
      today: this.clock.today(),
      tick,
      outbox: this.governance,
      log: (type: StudioEventType, data: Record<string, unknown>, ventureId?: string) => {
        store.emit(type, data, ventureId);
      },
    };
  }

  /** Run one operating day. Returns a summary; a second call on the same date is a no-op. */
  async tick(): Promise<TickSummary> {
    const today = this.clock.today();
    const meta = this.store.meta;
    if (meta.lastTickDate === today) {
      return this.summary(this.context(meta.tick), { date: today, tick: meta.tick, skipped: true, phases: [], errors: [] });
    }
    const tick = meta.tick + 1;
    const ctx = this.context(tick);
    const phases: TickSummary["phases"] = [];
    const errors: string[] = [];
    let plan: AllocationPlan | undefined;
    let llmBudgetHit = false;

    const run = async (name: string, fn: () => Promise<string> | string): Promise<void> => {
      const started = Date.now();
      try {
        const detail = await fn();
        phases.push({ name, detail, ms: Date.now() - started });
        this.onPhase?.(name, detail);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (isBudgetError(err)) llmBudgetHit = true;
        phases.push({ name, detail: "", ms: Date.now() - started, error: message });
        errors.push(`${name}: ${message}`);
        this.onPhase?.(name, `ERROR ${message}`);
      }
    };
    /** Per-venture isolation inside a phase. */
    const each = async (ventures: Venture[], fn: (v: Venture) => Promise<string> | string): Promise<string> => {
      const out: string[] = [];
      for (const v0 of ventures) {
        const v = this.store.ventures.get(v0.id);
        if (!v || !isActive(v)) continue;
        try {
          out.push(`${v.id}: ${await fn(v)}`);
        } catch (err) {
          if (isBudgetError(err)) llmBudgetHit = true;
          const message = err instanceof Error ? err.message : String(err);
          errors.push(`${v.id}: ${message}`);
          out.push(`${v.id}: ERROR ${message}`);
        }
      }
      return out.join("; ") || "none";
    };

    ctx.log("tick.started", { tick, date: today, killSwitch: this.governance.killSwitchActive() });

    await run("blocked-time", () => this.accountBlockedTime(meta.lastTickDate, today));
    await run("jobs", async () => `${(await pollDueJobs(ctx)).length} jobs polled`);
    await run("sync", () => this.syncMetrics(ctx));
    await run("tasks", () => {
      const opened = openBootstrapTasks(ctx);
      const applied = applyTaskOutcomes(ctx);
      // Held payouts a human checked at the marketplace: booked as paid, or released to be paid again.
      for (const t of this.store.tasks.list((x) => x.kind === "creators.verify_payout" && x.status === "done")) {
        for (const actionId of t.blocksActionIds) {
          if (this.executor.resolveUnknownPayout(actionId, t.outputs?.["decision"] === "sent")) applied.push(`${actionId} payout ${t.outputs?.["decision"]} (${t.id})`);
        }
      }
      return [...opened.map((id) => `opened ${id}`), ...applied].join(", ") || "no task outcomes";
    });
    await run("lifecycle", () => applyLifecycleDecisions(ctx).join(", ") || "no decisions");
    await run("lab", async () => {
      const outcomes = await runExperiments(ctx, this.deps, (experimentId, err) => {
        if (isBudgetError(err)) llmBudgetHit = true;
        errors.push(`${experimentId}: ${err instanceof Error ? err.message : String(err)}`);
      });
      return outcomes.map((o) => `${o.experimentId} ${o.decision}`).join(", ") || "no decisions";
    });
    await run("creators", async () => {
      await syncCreatorSubmissions(ctx, this.deps);
      await syncContentStats(ctx);
      return `${this.store.submissions.count()} submissions tracked`;
    });
    await run("ventures", () => this.advanceVentures(ctx, () => llmBudgetHit, each));
    await run("discovery", async () => {
      const promoted = promoteScreened(ctx);
      if (llmBudgetHit) return `promoted ${promoted.join(", ") || "none"}; discovery skipped (LLM budget)`;
      const found = await runDiscovery(ctx, this.deps, this.ledger.freeCash());
      return `promoted ${promoted.join(", ") || "none"}; ${found}`;
    });
    await run("allocate", async () => {
      plan = planAllocation(ctx, this.ledger);
      const loops = await each(
        this.store.ventures.list((v) => v.stage === "scaling"),
        (v) => runCreativeLoop(ctx, this.deps, v, plan?.lanes.find((l) => l.ventureId === v.id)?.proposedDailyCents ?? 0),
      );
      const mature = reviewMatureVentures(ctx, plan);
      return `${plan.lanes.length} lanes; ${loops}${mature.length ? `; ${mature.join(", ")}` : ""}`;
    });
    await run("publish", () => {
      publishOwnedContent(ctx);
      return `${this.store.content.count((c) => c.status === "scheduled")} posts scheduled`;
    });
    await run("govern", async () => {
      const reevaluated = this.governance.reevaluateOpen().length;
      const stuck = this.executor.reconcile().length;
      const executed = await this.executor.runApproved();
      // Lifecycle decisions approved and executed this tick take effect today.
      const applied = applyLifecycleDecisions(ctx);
      return `${reevaluated} re-evaluated, ${stuck} reconciled, ${executed.length} executed${applied.length ? `, ${applied.join(", ")}` : ""}`;
    });

    meta.tick = tick;
    meta.lastTickDate = today;
    let summary = this.summary(ctx, { date: today, tick, skipped: false, phases, errors });
    if (this.memoEveryTicks > 0 && tick % this.memoEveryTicks === 0 && !llmBudgetHit) {
      await run("memo", async () => {
        summary = { ...summary, memo: await boardMemo(ctx, this.deps, summary) };
        ctx.log("memo.written", { headline: summary.memo?.headline ?? "" });
        return summary.memo?.headline ?? "";
      });
      summary = { ...summary, phases, errors };
    }
    summary = { ...summary, reportPath: writeReport(this.dataDir, today, renderReport(ctx, summary, plan, this.ledger)) };
    ctx.log("tick.committed", { tick, date: today, errors: errors.length, executed: summary.executed });
    this.store.commit();
    return summary;
  }

  /** Execute approved actions outside a tick (after a human approves from the CLI). */
  async executeApproved(): Promise<number> {
    const executed = await this.executor.runApproved();
    this.store.commit();
    return executed.length;
  }

  private summary(ctx: TickContext, base: Pick<TickSummary, "date" | "tick" | "skipped" | "phases" | "errors">): TickSummary {
    const today = base.date;
    const actions = this.store.actions.list();
    return {
      ...base,
      cashCents: this.ledger.cash(),
      freeCashCents: this.ledger.freeCash(),
      ventures: ventureLines(ctx),
      proposed: actions.filter((a) => a.createdAt.slice(0, 10) === today).length,
      executed: actions.filter((a) => (a.executedAt ?? "").slice(0, 10) === today).length,
      awaitingApproval: actions.filter((a) => a.status === "awaiting_approval").length,
      openTasks: this.store.tasks.count((t) => t.status === "open"),
    };
  }

  /**
   * Time blocked on human tasks, or on studio cash (its experiment's creator campaigns held by the
   * reserve or the daily cap while the studio funds other ventures), does not count against a
   * venture's time box.
   */
  private accountBlockedTime(lastTickDate: string | null, today: string): string {
    if (!lastTickDate) return "first tick";
    const elapsed = Math.max(0, new Date(`${today}T00:00:00.000Z`).getTime() - new Date(`${lastTickDate}T00:00:00.000Z`).getTime());
    const waitingOnCash = new Set(
      this.store.actions
        .list((a) => a.kind === "creator.campaign_create" && a.status === "blocked" && Boolean(a.experimentId) && a.findings.some((f) => f.severity === "block" && CASH_RULES.includes(f.ruleId)))
        .map((a) => a.ventureId),
    );
    let humans = 0;
    let cash = 0;
    for (const v of this.store.ventures.list((x) => isActive(x) && (x.blockedOn.length > 0 || waitingOnCash.has(x.id)))) {
      const open = v.blockedOn.filter((id) => this.store.tasks.get(id)?.status === "open");
      // Optional tasks (a brand account nobody connects) must not freeze the time box.
      const blocking = blockingTasks(this.store, v).length > 0;
      const starved = waitingOnCash.has(v.id);
      patch(this.store, this.clock, v, { blockedOn: open, blockedMs: v.blockedMs + (blocking || starved ? elapsed : 0) });
      if (blocking) humans++;
      else if (starved) cash++;
    }
    return `${humans} ventures blocked on humans, ${cash} waiting on studio cash`;
  }

  /** Pull analytics, cohorts and ad stats; book revenue, refunds, inference and ad spend. */
  private async syncMetrics(ctx: TickContext): Promise<string> {
    const today = ctx.today;
    const until = shiftDate(today, -1);
    let rows = 0;
    const failed: string[] = [];
    // Every app on sale earns and costs money whatever its stage (a variant in build or review included).
    for (const v of this.store.ventures.list((x) => isLiveOnStore(x))) {
      try {
        rows += await this.syncVenture(ctx, v, today, until);
      } catch (err) {
        failed.push(`${v.id}: ${err instanceof Error ? err.message : String(err)}`);
        // An analytics or subscription project that was never bound: make sure someone is asked for it.
        if (err instanceof Error && err.name === "MissingBindingError" && !this.store.tasks.count((t) => t.kind === "integrations.bind_projects" && t.ventureId === v.id && t.status === "open")) {
          ctx.outbox.openTask(taskDraft("integrations.bind_projects", v.id, `${v.name} (${v.slug}): ${err.message}`));
        }
      }
    }
    for (const c of this.store.adCampaigns.list((x) => Boolean(x.externalId) && x.status !== "pending")) {
      try {
        const stats = await ctx.ports.ads.stats({ network: c.network, campaignExternalId: c.externalId as string, since: c.startAt.slice(0, 10), until: today });
        this.ledger.syncAds(c, stats);
      } catch (err) {
        failed.push(`${c.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (failed.length) throw new Error(`${rows} metric rows; sync failed for ${failed.join("; ")}`);
    return `${rows} metric rows`;
  }

  /** Resync from the last synced day (bounded) so days missed while a sync failed are backfilled. */
  private async syncVenture(ctx: TickContext, v: Venture, today: string, until: string): Promise<number> {
    const last = this.store.metrics(v.id, (m) => m.cellId === null && m.geo === null && m.complete).map((m) => m.date).sort().at(-1);
    // Always restate the last week (late events, refunds); reach further back only to fill a gap.
    const recent = shiftDate(today, -METRIC_RESYNC_DAYS);
    const floor = shiftDate(today, -MAX_BACKFILL_DAYS);
    const fromLast = last ? shiftDate(last, 1) : floor;
    const since = [recent, fromLast < floor ? floor : fromLast].sort()[0] as string;
    const daily = await ctx.ports.metrics.daily({ bindings: v.bindings, ventureId: v.id, since, until });
    this.store.upsertMetrics(v.id, daily);
    this.ledger.syncRevenue(v.id, daily);
    for (const d of daily) {
      if (d.cellId !== null || d.geo !== null) continue;
      const sessions = d.counts.session ?? 0;
      if (sessions > 0) this.ledger.bookInference(v.id, d.date, Math.round(sessions * this.config.economics.inferenceCentsPerSession));
    }
    const cohorts = await ctx.ports.metrics.cohorts({ bindings: v.bindings, ventureId: v.id, cohortSince: shiftDate(today, -COHORT_WINDOW_DAYS), cohortUntil: until, maxAgeDays: COHORT_WINDOW_DAYS });
    this.store.upsertCohorts(v.id, cohorts);
    return daily.length + cohorts.length;
  }

  private async advanceVentures(
    ctx: TickContext,
    budgetHit: () => boolean,
    each: (ventures: Venture[], fn: (v: Venture) => Promise<string> | string) => Promise<string>,
  ): Promise<string> {
    const now = this.clock.iso();
    // A probe only matters while its venture is being built; leftovers are aborted and free their slot.
    for (const e of this.store.experiments.list((x) => x.status === "running" && x.stages[0] === "S0_attention")) {
      if (this.store.ventures.get(e.ventureId)?.stage !== "building") this.store.experiments.put({ ...e, status: "aborted", decidedAt: now });
    }
    const probesInFlight = () => this.store.experiments.count((e) => e.status === "running" && e.stages[0] === "S0_attention");
    return each(
      this.store.ventures.list((v) => isActive(v) && v.stage !== "screened").sort((a, b) => (a.id < b.id ? -1 : 1)),
      async (v) => {
        // Bier's disband rules: the time box (blocked time excluded) and test spend before S4 passes.
        if (timeboxExpired(v, now, this.config)) {
          proposeKill(ctx, v, `not validated within ${this.config.portfolio.maxDaysToValidate} days of testing`, "timebox");
          return "time box expired";
        }
        if (!v.ladder.validated.includes("S4_monetization") && ["live_test", "iterating", "building", "in_review"].includes(v.stage)) {
          const exposure = testExposureCents(ctx, v);
          if (exposure > this.config.budgets.maxTestSpendPerVentureCents) {
            proposeKill(ctx, v, `test spend and commitments of ${(exposure / 100).toFixed(0)} USD exceeded the cap before monetization validated`, "spend_cap");
            return "test spend cap reached";
          }
        }
        if (v.pendingVariant?.variableUnderTest === VARIANT_TO_PREPARE) {
          if (budgetHit()) return "variant waits for LLM budget";
          return retryPrepareVariant(ctx, this.deps, v);
        }
        switch (v.stage) {
          case "building": {
            if (budgetHit()) return "LLM budget reached";
            const step = await advanceBuilding(ctx, this.deps, v);
            const after = this.store.ventures.require(v.id);
            const hasProbe = this.store.experiments.count((e) => e.ventureId === v.id && e.stages[0] === "S0_attention") > 0;
            if (after.stage !== "building" || !after.spec) return step;
            if (!hasProbe && probesInFlight() >= this.config.portfolio.maxAttentionProbesInFlight) return step;
            return `${step}; ${await runAttentionProbe(ctx, this.deps, after)}`;
          }
          case "in_review":
            return advanceInReview(ctx, v);
          case "live_test":
          case "iterating": {
            if (ladderComplete(v)) return this.awaitScale(ctx, v, now);
            const settled = settleVariants(ctx, v);
            const current = this.store.ventures.require(v.id);
            if (current.stage === "building") return settled;
            if (budgetHit()) return `${settled}; LLM budget reached`;
            return `${settled}; ${await ensureExperiment(ctx, this.deps, current)}`;
          }
          default:
            return v.stage;
        }
      },
    );
  }

  /**
   * A validated venture waits for its scale decision. If the board declined it, the venture stops
   * testing after a cool-down (harvest, sunset or kill) instead of holding a portfolio slot forever.
   */
  private awaitScale(ctx: TickContext, v: Venture, now: string): string {
    const scale = this.store.actions.list((a) => a.ventureId === v.id && a.kind === "venture.scale").sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    if (scale.some((a) => OPEN_STATUSES.includes(a.status) || a.status === "executed")) return "validated; waiting for the scale decision";
    const declined = scale.at(-1);
    if (declined && (declined.status === "rejected" || declined.status === "cancelled" || declined.status === "failed")) {
      const at = declined.decidedAt ?? declined.createdAt;
      if ((new Date(now).getTime() - new Date(at).getTime()) / DAY_MS < SCALE_DECLINE_COOLDOWN_DAYS) return "validated; scale declined, cooling down";
      proposeKill(ctx, v, `validated, but the scale proposal was ${declined.status}`, "scale_declined");
      return "validated but not scaled; stopping tests";
    }
    return "validated; scale not proposed";
  }
}
