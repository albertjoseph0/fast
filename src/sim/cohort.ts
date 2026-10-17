/**
 * Install cohorts: every install of one venture on one day from one storefront, platform,
 * traffic source and flag-variant set, with its whole future sampled at creation.
 *
 * Events carry day offsets from the install, so any query "as of" a time only sees what
 * had happened by then. That gives cohort maturity, trial windows and renewal timing for
 * free, and keeps queries cheap: nothing is re-simulated when a metric is read.
 */
import type { Rng } from "../core/rng.ts";
import type { ChannelKind, StorePlatform } from "../core/types.ts";

const HOUR_MS = 3_600_000;
/** Renewals are simulated this many days past install; later charges are out of any read window. */
const HORIZON_DAYS = 400;

export interface Charge {
  day: number;
  count: number;
  kind: "conversion" | "renewal";
}

export interface Cohort {
  id: string;
  ventureId: string;
  date: string;
  /** Nominal install time (midday UTC of `date`) in epoch ms. */
  installAt: number;
  geo: string;
  platform: StorePlatform;
  channel: ChannelKind;
  sourceId: string;
  experimentId?: string;
  cellId?: string;
  /** Sticky flag variants the cohort was assigned at install. */
  variantIds: string[];
  installs: number;
  activated: number;
  d1: number;
  /** Trial starts (or direct purchases) by day offset 0..2. */
  trials: number[];
  kept24: number[];
  conversions: number[];
  shareFirst: number[];
  shares: number;
  /** Invite-driven installs this cohort's users caused, by day offset 0..6. */
  invites: number[];
  invitesSent: number;
  trialDays: number;
  periodDays: number;
  grossPerCharge: number;
  proceedsPerCharge: number;
  charges: Charge[];
  /** [dayOffset, count] */
  refunds: [number, number][];
  cancels: [number, number][];
  reviews: { day: number; rating: 1 | 2 | 3 | 4 | 5 }[];
  spendCents: number;
}

export interface FunnelRates {
  activation: number;
  trialStart: number;
  keep24: number;
  toPaidGivenKeep: number;
  firstRenewal: number;
  renewal: number;
  refund: number;
  share: number;
  kFactor: number;
  d1: number;
  oneStarShare: number;
  billingFailure: number;
}

export interface CohortProduct {
  trialDays: number;
  periodDays: number;
  grossCents: number;
  proceedsCents: number;
}

export interface CohortSeed {
  id: string;
  ventureId: string;
  date: string;
  geo: string;
  platform: StorePlatform;
  channel: ChannelKind;
  sourceId: string;
  experimentId?: string;
  cellId?: string;
  variantIds: string[];
  installs: number;
  spendCents: number;
}

const TRIAL_OFFSETS = [0.85, 0.1, 0.05];
const SHARE_OFFSETS = [0.7, 0.2, 0.1];
const INVITE_DAYS = [0.35, 0.2, 0.15, 0.1, 0.08, 0.07, 0.05];
/** Rating mix of non-one-star reviews (5, 4, 3, 2 stars). */
const RATING_MIX: [5 | 4 | 3 | 2, number][] = [
  [5, 0.62],
  [4, 0.22],
  [3, 0.1],
  [2, 0.06],
];
const REVIEW_RATE = 0.025;

/** Split n into len(weights) parts with sequential binomials (weights sum to 1). */
export function multinomial(n: number, weights: readonly number[], rng: Rng): number[] {
  const out: number[] = [];
  let left = n;
  let mass = 1;
  for (let i = 0; i < weights.length; i++) {
    const w = weights[i] as number;
    if (i === weights.length - 1) {
      out.push(left);
      break;
    }
    const k = mass > 0 ? rng.binomial(left, Math.min(1, w / mass)) : 0;
    out.push(k);
    left -= k;
    mass -= w;
  }
  return out;
}

function survival(periodDays: number, k: number, rates: FunnelRates, monthly: number, annual: number): number {
  if (periodDays <= 7) return k === 1 ? rates.firstRenewal : rates.renewal;
  if (periodDays <= 31) return monthly;
  return annual;
}

/** Sample the full life of one cohort. */
export function sampleCohort(seed: CohortSeed, rates: FunnelRates, product: CohortProduct, renewals: { monthly: number; annual: number }, rng: Rng): Cohort {
  const n = seed.installs;
  const activated = rng.binomial(n, rates.activation);
  // Trials happen after the value preview, so they are a subset of activated users.
  const trialGivenActive = activated > 0 ? Math.min(0.95, rates.trialStart / Math.max(rates.activation, 1e-6)) : 0;
  const trials = multinomial(rng.binomial(activated, trialGivenActive), TRIAL_OFFSETS, rng);
  const hasTrial = product.trialDays > 0;
  const kept24 = trials.map((t) => (hasTrial ? rng.binomial(t, rates.keep24) : t));
  const conversions = kept24.map((k) => (hasTrial ? rng.binomial(k, rates.toPaidGivenKeep * (1 - rates.billingFailure)) : k));

  const charges: Charge[] = [];
  const refunds: [number, number][] = [];
  const cancels: [number, number][] = [];
  for (let o = 0; o < trials.length; o++) {
    const t = trials[o] as number;
    const k = kept24[o] as number;
    const c = conversions[o] as number;
    if (t - k > 0) cancels.push([o, t - k]);
    if (k - c > 0) cancels.push([o + Math.max(0, product.trialDays - 1), k - c]);
    if (c === 0) continue;
    let alive = c;
    let day = o + product.trialDays;
    charges.push({ day, count: alive, kind: "conversion" });
    for (let period = 1; ; period++) {
      day += product.periodDays;
      if (day > HORIZON_DAYS) break;
      alive = rng.binomial(alive, survival(product.periodDays, period, rates, renewals.monthly, renewals.annual));
      if (alive === 0) break;
      charges.push({ day, count: alive, kind: "renewal" });
    }
  }
  for (const ch of charges) {
    const r = rng.binomial(ch.count, rates.refund);
    if (r > 0) refunds.push([ch.day + Math.min(30, Math.floor(-Math.log(1 - rng.next()) * 4)), r]);
  }

  const shareFirst = multinomial(rng.binomial(activated, rates.share), SHARE_OFFSETS, rng);
  const firstShares = shareFirst.reduce((a, b) => a + b, 0);
  const inviteTotal = rates.kFactor > 0 ? rng.poisson(activated * rates.kFactor) : 0;
  const invites = multinomial(inviteTotal, INVITE_DAYS, rng);

  const reviews: Cohort["reviews"] = [];
  const reviewCount = rng.binomial(activated, REVIEW_RATE);
  for (let i = 0; i < reviewCount; i++) {
    const day = 1 + rng.int(0, 3);
    if (rng.chance(rates.oneStarShare)) {
      reviews.push({ day, rating: 1 });
      continue;
    }
    let u = rng.next();
    let rating: 5 | 4 | 3 | 2 = 5;
    for (const [r, w] of RATING_MIX) {
      if (u < w) {
        rating = r;
        break;
      }
      u -= w;
    }
    reviews.push({ day, rating });
  }

  return {
    ...seed,
    installAt: new Date(`${seed.date}T12:00:00.000Z`).getTime(),
    activated,
    d1: rng.binomial(n, rates.d1),
    trials,
    kept24,
    conversions,
    shareFirst,
    shares: firstShares + rng.poisson(firstShares * 0.6),
    invites,
    invitesSent: Math.round(inviteTotal / 0.3),
    trialDays: product.trialDays,
    periodDays: product.periodDays,
    grossPerCharge: product.grossCents,
    proceedsPerCharge: product.proceedsCents,
    charges,
    refunds,
    cancels,
    reviews,
  };
}

// ---------------------------------------------------------------------------
// As-of counting (cohort maturity and windows)
// ---------------------------------------------------------------------------

function sum(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

function sumWhere(xs: readonly number[], keep: (offset: number) => boolean): number {
  let s = 0;
  for (let o = 0; o < xs.length; o++) if (keep(o)) s += xs[o] as number;
  return s;
}

/** Whether an event `hours` after install has happened by `asOf`. */
function happened(c: Cohort, hours: number, asOf: number): boolean {
  return c.installAt + hours * HOUR_MS <= asOf;
}

export interface PairCounts {
  successes: number;
  trials: number;
}

/**
 * Numerator and denominator units of one cohort as of a time. The denominator counts
 * only units at least `maturityHours` old; the numerator counts events of those units
 * that happened within `windowHours` of the unit's start and before `asOf`.
 * `activated` overrides the cohort's activated count (instrumentation faults).
 */
export function countPair(
  c: Cohort,
  numerator: string,
  denominator: string,
  asOf: number,
  maturityHours: number,
  windowHours: number | undefined,
  activated: number = c.activated,
): PairCounts {
  const win = windowHours ?? Number.POSITIVE_INFINITY;
  const ageHours = (asOf - c.installAt) / HOUR_MS;
  const inWindow = (o: number) => o * 24 <= win && happened(c, o * 24, asOf);

  switch (denominator) {
    case "install":
    case "activated":
    case "d1_eligible": {
      const minAge = denominator === "d1_eligible" ? Math.max(48, maturityHours) : maturityHours;
      if (ageHours < minAge) return { successes: 0, trials: 0 };
      const trials = denominator === "activated" ? activated : c.installs;
      let successes = 0;
      switch (numerator) {
        case "activated":
          successes = activated;
          break;
        case "trial_start":
          successes = sumWhere(c.trials, inWindow);
          break;
        case "conversion":
          successes = sumWhere(c.conversions, (o) => (o + c.trialDays) * 24 <= win && happened(c, (o + c.trialDays) * 24, asOf));
          break;
        case "share_first":
          successes = sumWhere(c.shareFirst, inWindow);
          break;
        case "invite_install":
          successes = sumWhere(c.invites, (d) => d * 24 < win && happened(c, d * 24, asOf));
          break;
        case "d1_retained":
          successes = c.d1;
          break;
        default:
          successes = 0;
      }
      // Rates (invites per activated user) may exceed the denominator; proportions may not.
      return { successes: numerator === "invite_install" ? successes : Math.min(successes, trials), trials };
    }
    case "trial_start":
    case "trial_matured_24h":
    case "trial_matured": {
      const lag = denominator === "trial_start" ? 0 : denominator === "trial_matured_24h" ? 24 : c.trialDays * 24;
      const matured = (o: number) => happened(c, o * 24 + Math.max(lag, maturityHours), asOf);
      const trials = sumWhere(c.trials, matured);
      let successes = 0;
      if (numerator === "trial_kept_24h") successes = sumWhere(c.kept24, matured);
      else if (numerator === "conversion") successes = sumWhere(c.conversions, (o) => matured(o) && happened(c, (o + c.trialDays) * 24, asOf));
      return { successes: Math.min(successes, trials), trials };
    }
    default:
      return { successes: 0, trials: 0 };
  }
}

/** Cumulative economics of a cohort through `ageDays` (events on day offsets <= ageDays). */
export function cumulativeAt(c: Cohort, ageDays: number) {
  let conversions = 0;
  let renewals = 0;
  let charged = 0;
  let activeSubscribers = 0;
  for (const ch of c.charges) {
    if (ch.day > ageDays) continue;
    charged += ch.count;
    if (ch.kind === "conversion") conversions += ch.count;
    else renewals += ch.count;
    if (ageDays < ch.day + c.periodDays) activeSubscribers += ch.count;
  }
  let refunded = 0;
  for (const [day, n] of c.refunds) if (day <= ageDays) refunded += n;
  let trialCancels = 0;
  for (const [day, n] of c.cancels) if (day <= ageDays) trialCancels += n;
  return {
    installs: c.installs,
    trialStarts: sumWhere(c.trials, (o) => o <= ageDays),
    trialCancels,
    conversions,
    renewals,
    activeSubscribers,
    grossRevenueCents: charged * c.grossPerCharge,
    proceedsCents: charged * c.proceedsPerCharge,
    refundsCents: refunded * c.proceedsPerCharge,
  };
}

export function totalTrials(c: Cohort): number {
  return sum(c.trials);
}
