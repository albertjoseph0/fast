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
import { Governance } from "../governance/outbox.ts";
import { LlmError } from "../llm/errors.ts";
import { applyLifecycleDecisions, planAllocation, reviewMatureVentures } from "./allocator.ts";
import type { StudioDeps } from "./deps.ts";
import { promoteScreened, runDiscovery } from "./discovery.ts";
import { publishOwnedContent, runAttentionProbe, runCreativeLoop, syncContentStats, syncCreatorSubmissions } from "./growth.ts";
import { pollDueJobs } from "./jobs.ts";
import { ensureExperiment, proposeKill, runExperiments, settleVariants } from "./labPhase.ts";
import { isActive, LIVE_STAGES, patch, timeboxExpired } from "./lifecycle.ts";
import { advanceBuilding, advanceInReview } from "./pipeline.ts";
import { applyTaskOutcomes, openBootstrapTasks } from "./tasks.ts";
import { boardMemo, renderReport, type TickSummary, ventureLines, writeReport } from "./report.ts";

const DAY_MS = 86_400_000;
const METRIC_RESYNC_DAYS = 7;
const COHORT_WINDOW_DAYS = 120;

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
    this.governance = new Governance({ store: o.store, config: o.config, clock: o.clock, ledger: this.ledger, killSwitchPath });
    const dryRun = o.config.mode === "live" && o.config.dryRun;
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
      return [...opened.map((id) => `opened ${id}`), ...applied].join(", ") || "no task outcomes";
    });
    await run("lifecycle", () => applyLifecycleDecisions(ctx).join(", ") || "no decisions");
    await run("lab", async () => {
      const outcomes = await runExperiments(ctx, this.deps);
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

  /** Time blocked on human tasks does not count against a venture's time box. */
  private accountBlockedTime(lastTickDate: string | null, today: string): string {
    if (!lastTickDate) return "first tick";
    const elapsed = Math.max(0, new Date(`${today}T00:00:00.000Z`).getTime() - new Date(`${lastTickDate}T00:00:00.000Z`).getTime());
    let n = 0;
    for (const v of this.store.ventures.list((x) => isActive(x) && x.blockedOn.length > 0)) {
      const open = v.blockedOn.filter((id) => this.store.tasks.get(id)?.status === "open");
      patch(this.store, this.clock, v, { blockedOn: open, blockedMs: v.blockedMs + (open.length ? elapsed : 0) });
      if (open.length) n++;
    }
    return `${n} ventures blocked on humans`;
  }

  /** Pull analytics, cohorts and ad stats; book revenue, refunds, inference and ad spend. */
  private async syncMetrics(ctx: TickContext): Promise<string> {
    const today = ctx.today;
    const until = shiftDate(today, -1);
    let rows = 0;
    for (const v of this.store.ventures.list((x) => LIVE_STAGES.includes(x.stage) || (x.stage === "killed" && x.stores.some((s) => s.status === "live")))) {
      const since = shiftDate(today, -METRIC_RESYNC_DAYS);
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
      rows += daily.length + cohorts.length;
    }
    for (const c of this.store.adCampaigns.list((x) => Boolean(x.externalId) && x.status !== "pending")) {
      const stats = await ctx.ports.ads.stats({ network: c.network, campaignExternalId: c.externalId as string, since: c.startAt.slice(0, 10), until: today });
      this.ledger.syncAds(c, stats);
    }
    return `${rows} metric rows`;
  }

  private async advanceVentures(
    ctx: TickContext,
    budgetHit: () => boolean,
    each: (ventures: Venture[], fn: (v: Venture) => Promise<string> | string) => Promise<string>,
  ): Promise<string> {
    const now = this.clock.iso();
    const probesInFlight = () => this.store.experiments.count((e) => e.status === "running" && e.stages[0] === "S0_attention");
    return each(
      this.store.ventures.list((v) => isActive(v) && v.stage !== "screened").sort((a, b) => (a.id < b.id ? -1 : 1)),
      async (v) => {
        // Bier's disband rules: the time box (blocked time excluded) and test spend before S4 passes.
        if (timeboxExpired(v, now, this.config)) {
          proposeKill(ctx, v, `not validated within ${this.config.portfolio.maxDaysToValidate} days of testing`);
          return "time box expired";
        }
        if (!v.ladder.validated.includes("S4_monetization") && ["live_test", "iterating", "building", "in_review"].includes(v.stage)) {
          const spent = -this.store.net({ ventureId: v.id, categories: ["creators", "ads"] });
          if (spent > this.config.budgets.maxTestSpendPerVentureCents) {
            proposeKill(ctx, v, `test spend ${(spent / 100).toFixed(0)} USD exceeded the cap before monetization validated`);
            return "test spend cap reached";
          }
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
            const settled = settleVariants(ctx, v);
            const current = this.store.ventures.require(v.id);
            if (current.stage === "building") return settled;
            if (budgetHit()) return `${settled}; LLM budget reached`;
            return `${settled}; ${await ensureExperiment(ctx, this.deps, current)}`;
          }
          case "scaling":
          case "harvest":
          case "sunsetting":
            return v.stage;
          default:
            return v.stage;
        }
      },
    );
  }
}
