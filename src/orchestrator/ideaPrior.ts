/**
 * Learning from outcomes: which kinds of idea have worked for this studio.
 *
 * An idea's family is its core need x wedge kind (e.g. love:interest_community). Each finished
 * venture is a success (it completed the validation ladder) or a failure (killed or sunset
 * before validating). Outcomes are discounted by age (trends decay) and shrunk toward the
 * studio's overall success rate, so a family with two results barely moves and one with ten
 * moves a lot. Ranking draws one Thompson sample per family, so promising but uncertain
 * families still get tried.
 */
import type { Rng } from "../core/rng.ts";
import type { Idea, Iso, Venture } from "../core/types.ts";
import { ladderComplete } from "./lifecycle.ts";

/** Pseudo-observations behind the prior: how much evidence a family needs before it moves. */
export const PRIOR_STRENGTH = 4;
/** Monthly weight decay of an outcome. */
export const MONTHLY_DISCOUNT = 0.9;
const DAY_MS = 86_400_000;

export function ideaFamily(idea: Pick<Idea, "coreNeed" | "wedge">): string {
  return `${idea.coreNeed}:${idea.wedge.kind}`;
}

export interface FamilyOutcome {
  family: string;
  success: boolean;
  at: Iso;
}

/** Ventures that have resolved one way or the other; ones still testing say nothing yet. */
export function ventureOutcomes(ventures: Venture[], familyOf: (v: Venture) => string | undefined): FamilyOutcome[] {
  const out: FamilyOutcome[] = [];
  for (const v of ventures) {
    const family = familyOf(v);
    if (!family) continue;
    const validated = ladderComplete(v) || v.stage === "scaling" || v.stage === "exited" || v.history.some((h) => h.to === "scaling");
    if (validated) out.push({ family, success: true, at: v.history.find((h) => h.to === "scaling")?.at ?? v.updatedAt });
    else if (v.stage === "killed" || v.stage === "sunsetting" || v.stage === "harvest") out.push({ family, success: false, at: v.updatedAt });
  }
  return out;
}

export interface FamilyPosterior {
  family: string;
  alpha: number;
  beta: number;
  /** Discounted successes and failures behind it. */
  successes: number;
  failures: number;
}

/** Studio-wide discounted success rate, starting from 1 success in 5. */
export function baseRate(outcomes: FamilyOutcome[], now: Date): number {
  let s = 1;
  let n = 5;
  for (const o of outcomes) {
    const w = weight(o.at, now);
    if (o.success) s += w;
    n += w;
  }
  return s / n;
}

export function familyPosterior(family: string, outcomes: FamilyOutcome[], now: Date, rate = baseRate(outcomes, now)): FamilyPosterior {
  let successes = 0;
  let failures = 0;
  for (const o of outcomes) {
    if (o.family !== family) continue;
    const w = weight(o.at, now);
    if (o.success) successes += w;
    else failures += w;
  }
  return { family, alpha: PRIOR_STRENGTH * rate + successes, beta: PRIOR_STRENGTH * (1 - rate) + failures, successes, failures };
}

/**
 * One Thompson draw of how much better (or worse) than the studio's average this family does,
 * as a multiplier: 1 means average. Draw once per family per cycle so ideas in a family share it.
 */
export function sampleFamilyLift(p: FamilyPosterior, rate: number, rng: Rng): number {
  return rng.beta(p.alpha, p.beta) / Math.max(1e-6, rate);
}

function weight(at: Iso, now: Date): number {
  const ageMonths = Math.max(0, (now.getTime() - Date.parse(at)) / (30 * DAY_MS));
  return Number.isFinite(ageMonths) ? MONTHLY_DISCOUNT ** ageMonths : 0;
}
