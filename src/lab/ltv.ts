/**
 * Net revenue per install for hard-paywall subscription apps.
 *
 *   RPI(H) = P(trial | install) x P(paid | trial) x E[charges within H days] x net price x (1 - refunds)
 *
 * P(paid | trial) comes from the 24h trial-keep proxy: since most cancellations of short
 * trials happen within a day (RevenueCat SOSA 2026), total cancel share is
 * (1 - keep24) / share_within_24h. Net price removes VAT for VAT-inclusive storefronts
 * and the store fee. Quantiles are Monte Carlo over the Beta posteriors with a seeded Rng.
 */
import type { PriceLadderEntry, StudioConfig } from "../config/schema.ts";
import type { Rng } from "../core/rng.ts";
import type { Cents, StorePlatform } from "../core/types.ts";
import { proportionPosterior } from "./stats.ts";

export function netPriceCents(usdCents: Cents, geo: string, platform: StorePlatform, config: StudioConfig): number {
  const vat = config.economics.vatInclusiveRateByGeo[geo] ?? 0;
  const fee = platform === "android" ? config.economics.storeFeeRate.android : config.economics.storeFeeRate.ios;
  return (usdCents / (1 + vat)) * (1 - fee);
}

/** Expected paid charges within `horizonDays` for a user who converts. */
export function chargesWithin(entry: PriceLadderEntry, horizonDays: number, config: StudioConfig): number {
  const e = config.economics;
  const periodDays = entry.period === "week" ? 7 : entry.period === "month" ? 30 : 365;
  let total = 0;
  for (let k = 0; ; k++) {
    const day = entry.trialDays + k * periodDays;
    if (day > horizonDays) break;
    let survival: number;
    if (k === 0) survival = 1;
    else if (entry.period === "week") survival = e.weeklyFirstRenewalPrior * e.weeklyRenewalPrior ** (k - 1);
    else if (entry.period === "month") survival = e.monthlyRenewalPrior ** k;
    else survival = e.annualRenewalPrior ** k;
    total += survival;
    if (survival < 1e-4) break;
  }
  return total;
}

/** P(paid | trial) from the 24h keep rate; 1 for products without a trial. */
export function conversionGivenTrial(keep24: number, entry: PriceLadderEntry, config: StudioConfig): number {
  if (entry.trialDays === 0) return 1;
  const e = config.economics;
  const cancelShare = (1 - keep24) / e.trialCancelWithin24hShare;
  return Math.max(0, Math.min(1, 1 - cancelShare)) * (1 - e.billingFailureRate);
}

export interface RpiInput {
  trialStartRate: number;
  keep24: number;
  entry: PriceLadderEntry;
  geo: string;
  platform: StorePlatform;
  horizonDays: number;
  config: StudioConfig;
}

/** Point estimate of net revenue per install in cents. */
export function predictNetRpiCents(i: RpiInput): number {
  const convert = conversionGivenTrial(i.keep24, i.entry, i.config);
  return (
    i.trialStartRate *
    convert *
    chargesWithin(i.entry, i.horizonDays, i.config) *
    netPriceCents(i.entry.usdCents, i.geo, i.platform, i.config) *
    (1 - i.config.economics.refundHaircutPrior)
  );
}

export interface RpiPosteriorInput {
  trialStart: { successes: number; trials: number; prior: number };
  keep24: { successes: number; trials: number; prior: number };
  entry: PriceLadderEntry;
  geo: string;
  platform: StorePlatform;
  horizonDays: number;
  config: StudioConfig;
  rng: Rng;
  draws?: number;
}

/** Posterior quantiles of net RPI by Monte Carlo. */
export function rpiQuantiles(i: RpiPosteriorInput, qs: number[]): number[] {
  const draws = i.draws ?? 2_000;
  const ts = proportionPosterior(i.trialStart.successes, i.trialStart.trials, i.trialStart.prior);
  const kp = proportionPosterior(i.keep24.successes, i.keep24.trials, i.keep24.prior);
  if (ts.kind !== "proportion" || kp.kind !== "proportion") throw new Error("unreachable");
  const values: number[] = [];
  for (let d = 0; d < draws; d++) {
    values.push(
      predictNetRpiCents({
        trialStartRate: i.rng.beta(ts.a, ts.b),
        keep24: i.rng.beta(kp.a, kp.b),
        entry: i.entry,
        geo: i.geo,
        platform: i.platform,
        horizonDays: i.horizonDays,
        config: i.config,
      }),
    );
  }
  values.sort((a, b) => a - b);
  return qs.map((q) => values[Math.min(values.length - 1, Math.max(0, Math.floor(q * values.length)))] as number);
}

export interface CellEconomics {
  predNetRpiD60P20Cents: Cents;
  cacCents: Cents;
  roasD60P20: number;
}

/** The S4 economic read: 20th-percentile predicted D60 net RPI over observed CAC. */
export function cellEconomics(i: Omit<RpiPosteriorInput, "horizonDays"> & { spendCents: Cents; installs: number }): CellEconomics {
  const [p20] = rpiQuantiles({ ...i, horizonDays: 60 }, [0.2]);
  const predNetRpiD60P20Cents = Math.round(p20 ?? 0);
  const cacCents = i.installs > 0 ? Math.round(i.spendCents / i.installs) : 0;
  const roasD60P20 = cacCents > 0 ? predNetRpiD60P20Cents / cacCents : predNetRpiD60P20Cents > 0 ? Infinity : 0;
  return { predNetRpiD60P20Cents, cacCents, roasD60P20 };
}
