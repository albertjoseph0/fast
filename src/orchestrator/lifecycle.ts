/**
 * Venture lifecycle: allowed transitions, the time box (excluding time blocked on humans)
 * and small helpers the tick phases share.
 */
import type { StudioConfig } from "../config/schema.ts";
import type { TickContext } from "../core/context.ts";
import type { StudioStore } from "../core/store.ts";
import type { Clock } from "../core/ports.ts";
import type { ActionKind, Iso, JobOp, LedgerCategory, Venture, VentureStage } from "../core/types.ts";
import { OPEN_STATUSES } from "../governance/outbox.ts";

const ALLOWED: Record<VentureStage, VentureStage[]> = {
  screened: ["building", "killed"],
  // A live app shipping a variant build is back in building or in_review; it can still be sunset or
  // harvested. Harvest is open to any live app whose organic contribution is positive.
  building: ["in_review", "killed", "sunsetting", "harvest"],
  in_review: ["live_test", "building", "killed", "sunsetting", "harvest"],
  live_test: ["iterating", "scaling", "killed", "sunsetting", "harvest"],
  iterating: ["live_test", "in_review", "building", "killed", "sunsetting", "harvest"],
  scaling: ["harvest", "sunsetting", "killed", "exited"],
  harvest: ["scaling", "sunsetting", "exited", "killed"],
  sunsetting: ["killed", "exited"],
  killed: [],
  exited: [],
};

/** What an app earns or costs once growth spending stops (no creator or ad spend, no content generation). */
export const ORGANIC_CATEGORIES: LedgerCategory[] = ["revenue", "refunds", "inference", "infra", "tools"];

export const TERMINAL_STAGES: readonly VentureStage[] = ["killed", "exited"];
export const TESTING_STAGES: readonly VentureStage[] = ["building", "in_review", "live_test", "iterating"];
export const LIVE_STAGES: readonly VentureStage[] = ["live_test", "iterating", "scaling", "harvest", "sunsetting"];

export function isActive(v: Venture): boolean {
  return !TERMINAL_STAGES.includes(v.stage);
}

export function transition(store: StudioStore, clock: Clock, v: Venture, to: VentureStage, reason: string): Venture {
  const current = store.ventures.require(v.id);
  if (current.stage === to) return current;
  if (!ALLOWED[current.stage].includes(to)) throw new Error(`illegal transition ${current.stage} -> ${to} for ${v.id}`);
  const now = clock.iso();
  const next: Venture = {
    ...current,
    stage: to,
    history: [...current.history, { from: current.stage, to, at: now, reason }],
    updatedAt: now,
    ...(TERMINAL_STAGES.includes(to) ? { endedReason: reason } : {}),
    ...(to === "building" && current.timeboxStartedAt === null ? { timeboxStartedAt: now } : {}),
  };
  store.ventures.put(next);
  store.emit("venture.stage_changed", { from: current.stage, to, reason }, v.id);
  return next;
}

export function patch(store: StudioStore, clock: Clock, v: Venture, changes: Partial<Venture>): Venture {
  return store.ventures.put({ ...store.ventures.require(v.id), ...changes, updatedAt: clock.iso() });
}

/** Days spent validating, excluding time blocked on human tasks (Bier's disband rule). */
export function testingDays(v: Venture, now: Iso): number {
  if (!v.timeboxStartedAt) return 0;
  return Math.max(0, (new Date(now).getTime() - new Date(v.timeboxStartedAt).getTime() - v.blockedMs) / 86_400_000);
}

export function timeboxExpired(v: Venture, now: Iso, config: StudioConfig): boolean {
  return TESTING_STAGES.includes(v.stage) && testingDays(v, now) > config.portfolio.maxDaysToValidate;
}

/** Latest job of an op for a venture, if any. */
export function latestJob(store: StudioStore, ventureId: string, op: JobOp) {
  return store.jobs
    .list((j) => j.ventureId === ventureId && j.op === op)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1))
    .at(-1);
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "app"
  );
}

const KEEP_ON_WIND_DOWN = new Set<ActionKind>(["venture.kill", "venture.sunset", "store.remove_from_sale", "creator.campaign_close", "ads.pause", "creator.payout", "creator.review_post"]);

/**
 * Stop spending on a venture: cancel open spend and build actions, close creator campaigns, pause
 * ads, abort experiments and creative batches. Payouts owed for posts already made still go out.
 */
export function windDown(ctx: TickContext, v: Venture, reason: string): void {
  for (const a of ctx.store.actions.list((x) => x.ventureId === v.id && OPEN_STATUSES.includes(x.status) && !KEEP_ON_WIND_DOWN.has(x.kind) && x.status !== "executing")) {
    ctx.outbox.cancel(a.id, `venture wind-down: ${reason}`);
  }
  for (const c of ctx.store.campaigns.list((x) => x.ventureId === v.id && (x.status === "open" || x.status === "paused") && Boolean(x.externalId))) {
    ctx.outbox.propose({ kind: "creator.campaign_close", ventureId: v.id, payload: { campaignId: c.id }, summary: `Close ${c.id}`, rationale: reason, proposedBy: "allocator", naturalKey: c.id });
  }
  for (const c of ctx.store.adCampaigns.list((x) => x.ventureId === v.id && x.status === "active")) {
    ctx.outbox.propose({ kind: "ads.pause", ventureId: v.id, payload: { adCampaignId: c.id, reason }, summary: `Pause ${c.id}`, rationale: reason, proposedBy: "allocator", naturalKey: c.id });
  }
  const now = ctx.ports.clock.iso();
  for (const e of ctx.store.experiments.list((x) => x.ventureId === v.id && (x.status === "running" || x.status === "registered"))) {
    ctx.store.experiments.put({ ...e, status: "aborted", decidedAt: now });
  }
  for (const b of ctx.store.batches.list((x) => x.ventureId === v.id && x.status === "open")) {
    ctx.store.batches.put({ ...b, status: "closed" });
  }
  const current = ctx.store.ventures.require(v.id);
  if (current.ladder.currentExperimentId) patch(ctx.store, ctx.ports.clock, current, { ladder: { ...current.ladder, currentExperimentId: null } });
}

export function isLiveOnStore(v: Venture): boolean {
  return v.stores.some((s) => s.status === "live" || s.status === "pending_release");
}
