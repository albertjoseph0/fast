import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/config/schema.ts";
import { Rng } from "../../src/core/rng.ts";
import { truthFor, variantMultiplier, type VentureTruth } from "../../src/sim/truth.ts";
import { addVenture, ARCHETYPES, BAD, BASE_IDEA, campaign, days, GOOD, harness, openCampaign } from "./fixtures.ts";

const config = defaultConfig();
const t = config.thresholds;

/** Expected creator CAC in cents at the default deal ($15 + $1.50 CPM, $150 cap), by Monte Carlo over creators and posts. */
function creatorCac(rate: number, appeal: number, rng: Rng): number {
  let cost = 0;
  let installs = 0;
  for (let k = 0; k < 300; k++) {
    const median = Math.min(2e6, Math.max(500, rng.lognormal(15_000, 1)));
    const views = median * rng.lognormal(1, 1.2) * Math.min(3, appeal ** 0.35);
    cost += Math.min(15_000, 1_500 + (150 * views) / 1000);
    installs += views * 0.57 * rate * 1.13;
  }
  return cost / Math.max(1e-9, installs);
}

/** D60 net revenue per install for week_699_t3 in Canada, the same model as lab/ltv. */
function rpiD60(trialStart: number, keep24: number): number {
  const e = config.economics;
  const convert = Math.max(0, 1 - (1 - keep24) / e.trialCancelWithin24hShare) * (1 - e.billingFailureRate);
  let charges = 0;
  for (let k = 0; 3 + 7 * k <= 60; k++) charges += k === 0 ? 1 : e.weeklyFirstRenewalPrior * e.weeklyRenewalPrior ** (k - 1);
  return trialStart * convert * charges * (699 / 1.13) * 0.85 * (1 - e.refundHaircutPrior);
}

/** Whether a venture with this truth should clear S1 + S4 at the default thresholds (p20 ROAS >= 0.8 ~ point ROAS >= 1). */
function clears(truth: VentureTruth, rng: Rng): boolean {
  const trialStart = truth.trialStartRate * 0.9; // creator audiences include some under-18 viewers who cannot pay
  return (
    truth.installsPer1kViews >= t.installsPer1kViews.floor * 1.2 &&
    truth.activationRate >= t.activationRate.floor * 1.05 &&
    trialStart >= t.trialStartRate.floor * 1.12 &&
    truth.trialKeep24h > t.trialKeep24h.futility * 1.15 &&
    rpiD60(trialStart, truth.trialKeep24h) / creatorCac(truth.installsPer1kViews, truth.appeal, rng) >= config.lab.s4MinRoasD60P20 / 0.8
  );
}

describe("truthFor", () => {
  it("is deterministic for the same idea and stream", () => {
    expect(truthFor(BASE_IDEA, new Rng(5).fork("truth:a"))).toEqual(truthFor(BASE_IDEA, new Rng(5).fork("truth:a")));
    expect(truthFor(BASE_IDEA, new Rng(5).fork("truth:a"))).not.toEqual(truthFor(BASE_IDEA, new Rng(5).fork("truth:b")));
  });

  it("makes hits rare: 15-25% of a mixed archetype batch clears S1 + S4", () => {
    const rng = new Rng(11);
    let n = 0;
    let passed = 0;
    for (const [name, make] of Object.entries(ARCHETYPES)) {
      for (let i = 0; i < 120; i++) {
        n++;
        if (clears(truthFor(make(BASE_IDEA), rng.fork(`${name}:${i}`)), rng.fork(`cac:${name}:${i}`))) passed++;
      }
    }
    expect(passed / n).toBeGreaterThanOrEqual(0.15);
    expect(passed / n).toBeLessThanOrEqual(0.25);
  });

  it("lets features move the odds the way the principles say", () => {
    const rng = new Rng(3);
    const mean = (name: string, key: keyof VentureTruth) => {
      let s = 0;
      for (let i = 0; i < 300; i++) s += truthFor((ARCHETYPES[name] as (i: typeof BASE_IDEA) => typeof BASE_IDEA)(BASE_IDEA), rng.fork(`${name}:${i}`))[key];
      return s / 300;
    };
    expect(mean("sustained", "activationRate")).toBeLessThan(mean("verdict_love", "activationRate") * 0.5);
    expect(mean("audio", "activationRate")).toBeLessThan(mean("verdict_love", "activationRate"));
    expect(mean("social_unseeded", "activationRate")).toBeLessThan(mean("social_seeded", "activationRate") * 0.5);
    expect(mean("slow_heavy", "appeal")).toBeLessThan(mean("verdict_love", "appeal"));
    expect(mean("self_improvement", "appeal")).toBeLessThan(mean("verdict_love", "appeal"));
    expect(mean("freemium", "trialStartRate")).toBeLessThan(mean("verdict_love", "trialStartRate") * 0.5);
    expect(mean("social_unseeded", "kFactor")).toBeGreaterThan(mean("verdict_love", "kFactor") * 5);
    const noShare = { ...BASE_IDEA, secondaryChannels: ["owned_social" as const] };
    let withLoop = 0;
    let without = 0;
    for (let i = 0; i < 300; i++) {
      withLoop += truthFor(BASE_IDEA, rng.fork(`s:${i}`)).shareRate;
      without += truthFor(noShare, rng.fork(`s:${i}`)).shareRate;
    }
    expect(withLoop).toBeGreaterThan(without * 1.5);
    const sensitive = { ...BASE_IDEA, sensitiveDomains: ["astrology_fortune" as const] };
    expect(truthFor(sensitive, new Rng(1)).refundRate).toBeGreaterThan(truthFor(BASE_IDEA, new Rng(1)).refundRate);
    const soft = { ...BASE_IDEA, monetization: { ...BASE_IDEA.monetization, model: "soft_paywall" as const } };
    expect(truthFor(BASE_IDEA, new Rng(1)).oneStarShare).toBeGreaterThan(truthFor(soft, new Rng(1)).oneStarShare);
  });

  it("better ideas outperform worse ones in truth and in the simulated funnel", async () => {
    const h = harness(21);
    const ventures: { good: boolean; id: string }[] = [];
    for (let i = 0; i < 40; i++) {
      const good = i % 2 === 0;
      const names = good ? GOOD : BAD;
      const make = ARCHETYPES[names[i % names.length] as string] as (x: typeof BASE_IDEA) => typeof BASE_IDEA;
      const v = addVenture(h, i + 1, { ...make(BASE_IDEA), title: `App${i}` }, ["CA"]);
      await openCampaign(h, campaign(h, v, i + 1, "CA", { experimentId: `exp_${i}`, cellId: `cell_${i}` }));
      ventures.push({ good, id: v.id });
    }
    await days(h, 14);
    const asOf = h.clock.iso();
    const score = async (id: string, i: number) => {
      const v = h.store.ventures.require(id);
      const base = { bindings: v.bindings, ventureId: id, experimentId: `exp_${i}`, cellId: `cell_${i}`, geo: "CA", assignment: "geo" as const, since: "2026-03-01T00:00:00.000Z", asOf };
      const views = await h.ports.read.metrics.cellMetric({ ...base, numerator: "install", denominator: "view", maturityHours: 48 });
      const trials = await h.ports.read.metrics.cellMetric({ ...base, numerator: "trial_start", denominator: "install", maturityHours: 24, windowHours: 72 });
      return views.trials > 0 ? trials.successes / views.trials : 0;
    };
    let good = 0;
    let bad = 0;
    let goodAppeal = 0;
    let badAppeal = 0;
    for (const [i, x] of ventures.entries()) {
      const s = await score(x.id, i);
      const appeal = h.world.truth(x.id)?.appeal ?? 0;
      if (x.good) {
        good += s;
        goodAppeal += appeal;
      } else {
        bad += s;
        badAppeal += appeal;
      }
    }
    expect(goodAppeal).toBeGreaterThan(badAppeal);
    expect(good).toBeGreaterThan(bad * 1.5);
  });
});

describe("variantMultiplier", () => {
  it("is a deterministic lognormal(0, 0.15)", () => {
    expect(variantMultiplier("ven_1", "paywall", "v2", 7)).toBe(variantMultiplier("ven_1", "paywall", "v2", 7));
    expect(variantMultiplier("ven_1", "paywall", "v2", 7)).not.toBe(variantMultiplier("ven_1", "paywall", "v3", 7));
    const logs = Array.from({ length: 4000 }, (_, i) => Math.log(variantMultiplier("ven_1", "hook", `h${i}`, 7)));
    const mean = logs.reduce((a, b) => a + b, 0) / logs.length;
    const sd = Math.sqrt(logs.reduce((a, b) => a + (b - mean) ** 2, 0) / logs.length);
    expect(Math.abs(mean)).toBeLessThan(0.01);
    expect(sd).toBeGreaterThan(0.13);
    expect(sd).toBeLessThan(0.17);
  });
});
