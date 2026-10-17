/**
 * Venture lifecycle: allowed transitions, the time box (excluding time blocked on humans)
 * and small helpers the tick phases share.
 */
import type { StudioConfig } from "../config/schema.ts";
import type { StudioStore } from "../core/store.ts";
import type { Clock } from "../core/ports.ts";
import type { Iso, JobOp, Venture, VentureStage } from "../core/types.ts";

const ALLOWED: Record<VentureStage, VentureStage[]> = {
  screened: ["building", "killed"],
  building: ["in_review", "killed"],
  in_review: ["live_test", "building", "killed"],
  live_test: ["iterating", "scaling", "killed", "sunsetting"],
  iterating: ["live_test", "in_review", "building", "killed", "sunsetting"],
  scaling: ["harvest", "sunsetting", "killed", "exited"],
  harvest: ["scaling", "sunsetting", "exited", "killed"],
  sunsetting: ["killed", "exited"],
  killed: [],
  exited: [],
};

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
