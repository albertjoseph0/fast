/**
 * The simulated creator market: a deterministic pool per niche and platform. Each
 * creator has a home storefront holding 45-70% of their audience, US leakage on top,
 * lognormal median views around 15K, an under-18 share, and a few bad actors.
 */
import { hashString, Rng } from "../core/rng.ts";
import type { Platform } from "../core/types.ts";

export interface SimCreator {
  externalId: string;
  platform: Platform;
  handle: string;
  niche: string;
  followers: number;
  medianViews30d: number;
  audienceGeo: Record<string, number>;
  audienceUnder18Share: number | null;
  /** Posts without the platform's paid-partnership label. */
  undisclosed: boolean;
  /** Posts from a different account than the one that applied. */
  reposter: boolean;
  /** Deletes or privates posts a few days after posting. */
  deleter: boolean;
}

const POOL_SIZE = 140;
const HOME_GEOS: [string, number][] = [
  ["US", 0.3],
  ["CA", 0.2],
  ["AU", 0.2],
  ["NZ", 0.12],
  ["GB", 0.12],
  ["IE", 0.06],
];
const SPILL_GEOS = ["US", "CA", "AU", "NZ", "GB", "IE", "IN", "PH", "DE"];
const SYLLABLES = ["ka", "zo", "mi", "ra", "lu", "ve", "no", "sa", "ti", "be", "jo", "li", "ry", "xa", "qu", "el", "an", "or"];

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 10) || "niche";
}

function pickWeighted(rng: Rng, items: [string, number][]): string {
  let u = rng.next();
  for (const [item, w] of items) {
    if (u < w) return item;
    u -= w;
  }
  return (items.at(-1) as [string, number])[0];
}

function audience(rng: Rng): Record<string, number> {
  const home = pickWeighted(rng, HOME_GEOS);
  const geo: Record<string, number> = { [home]: rng.uniform(0.45, 0.7) };
  if (home !== "US") geo.US = rng.uniform(0.1, 0.3);
  let left = 1 - Object.values(geo).reduce((a, b) => a + b, 0);
  const spill = rng.shuffle(SPILL_GEOS.filter((g) => !(g in geo))).slice(0, 3);
  for (const [i, g] of spill.entries()) {
    const share = i === spill.length - 1 ? left : left * rng.uniform(0.3, 0.6);
    geo[g] = share;
    left -= share;
  }
  return Object.fromEntries(Object.entries(geo).map(([g, s]) => [g, Math.round(s * 1000) / 1000]));
}

const cache = new Map<string, SimCreator[]>();

/** The deterministic creator pool for a niche on one platform. */
export function creatorPool(niche: string, platform: Platform, seed: number): SimCreator[] {
  const key = `${seed}|${niche}|${platform}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const rng = new Rng(hashString(`${seed}:pool:${niche}:${platform}`));
  const tag = slug(niche);
  const pool: SimCreator[] = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    const name = Array.from({ length: 2 + rng.int(0, 1) }, () => rng.pick(SYLLABLES)).join("");
    const medianViews30d = Math.round(Math.min(2_000_000, Math.max(500, rng.lognormal(15_000, 1))));
    const under18 = rng.chance(0.1) ? null : Math.round(Math.min(0.6, rng.lognormal(0.12, 0.6)) * 1000) / 1000;
    pool.push({
      externalId: `simc_${platform}_${((hashString(key) >>> 0) % 100_000).toString(36)}_${i}`,
      platform,
      handle: `${name}.${tag}${i}`,
      niche,
      followers: Math.round(medianViews30d * rng.lognormal(6, 0.6)),
      medianViews30d,
      audienceGeo: audience(rng),
      audienceUnder18Share: under18,
      undisclosed: rng.chance(0.05),
      reposter: rng.chance(0.01),
      deleter: rng.chance(0.01),
    });
  }
  cache.set(key, pool);
  return pool;
}
