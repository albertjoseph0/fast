/**
 * Always-on creative optimization (Vert's batch culling), separate from the validation
 * ladder. Arms are `${formatId}:${hookId}`; each batch allocates posts by Thompson
 * sampling on installs per view, culls arms that are clearly not the best, and keeps a
 * fixed share for exploration. Rates are deflated by a per-post design effect so one viral
 * post cannot crown an arm on its own.
 */
import type { Rng } from "../core/rng.ts";
import { PLANNING } from "./experiments.ts";

export interface ArmStats {
  arm: string;
  posts: number;
  views: number;
  installs: number;
}

function gammaSample(rng: Rng, shape: number, rate: number): number {
  return rng.gamma(shape) / rate;
}

/** Probability that each arm has the highest installs-per-view rate. */
export function probabilityBest(arms: ArmStats[], rng: Rng, draws = 4_000): Record<string, number> {
  const pooled = arms.reduce((s, a) => s + a.installs, 0) / Math.max(1, arms.reduce((s, a) => s + a.views, 0));
  const prior = Math.max(1e-6, pooled);
  const params = arms.map((a) => {
    const perPost = a.posts > 0 ? a.views / a.posts : 0;
    const de = 1 + Math.max(0, perPost - 1) * PLANNING.viewRho;
    return { arm: a.arm, shape: 0.5 + a.installs / de, rate: 0.5 / prior + a.views / de };
  });
  const wins: Record<string, number> = Object.fromEntries(arms.map((a) => [a.arm, 0]));
  for (let d = 0; d < draws; d++) {
    let best = "";
    let bestValue = -1;
    for (const p of params) {
      const v = gammaSample(rng, p.shape, p.rate);
      if (v > bestValue) {
        bestValue = v;
        best = p.arm;
      }
    }
    wins[best] = (wins[best] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(wins).map(([k, v]) => [k, v / draws]));
}

/** Next batch's share of posts per arm: exploit by P(best), explore uniformly. */
export function allocate(pBest: Record<string, number>, exploreShare: number): Record<string, number> {
  const arms = Object.keys(pBest);
  if (arms.length === 0) return {};
  return Object.fromEntries(arms.map((a) => [a, (1 - exploreShare) * (pBest[a] ?? 0) + exploreShare / arms.length]));
}

/** Arms with enough posts whose chance of being best is negligible. */
export function armsToCull(arms: ArmStats[], pBest: Record<string, number>, opts: { cullMinPosts: number; cullProbBest: number }): string[] {
  return arms.filter((a) => a.posts >= opts.cullMinPosts && (pBest[a.arm] ?? 0) < opts.cullProbBest).map((a) => a.arm);
}

/** Split `total` posts across arms by share, largest remainders first; deterministic. */
export function postsPerArm(allocation: Record<string, number>, total: number): Record<string, number> {
  const entries = Object.entries(allocation).sort(([a], [b]) => (a < b ? -1 : 1));
  const raw = entries.map(([arm, share]) => ({ arm, exact: share * total }));
  const out: Record<string, number> = Object.fromEntries(raw.map((r) => [r.arm, Math.floor(r.exact)]));
  let left = total - Object.values(out).reduce((s, n) => s + n, 0);
  for (const r of [...raw].sort((a, b) => b.exact - Math.floor(b.exact) - (a.exact - Math.floor(a.exact)))) {
    if (left <= 0) break;
    out[r.arm] = (out[r.arm] ?? 0) + 1;
    left--;
  }
  return out;
}
