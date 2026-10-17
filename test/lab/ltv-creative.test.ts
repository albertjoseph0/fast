import { describe, expect, it } from "vitest";
import { Rng } from "../../src/core/rng.ts";
import { assertDisjoint, exposureKey, isBurned, pickTestGeos, testGeosFor } from "../../src/lab/audiences.ts";
import { allocate, armsToCull, postsPerArm, probabilityBest } from "../../src/lab/creative.ts";
import { cellEconomics, chargesWithin, conversionGivenTrial, netPriceCents, predictNetRpiCents, rpiQuantiles } from "../../src/lab/ltv.ts";
import { config } from "./fixtures.ts";

const weekly = { id: "week_699_t3", period: "week" as const, usdCents: 699, trialDays: 3 };

describe("ltv", () => {
  it("removes VAT for inclusive storefronts and the store fee", () => {
    expect(netPriceCents(699, "US", "ios", config)).toBeCloseTo(699 * 0.85, 6);
    expect(netPriceCents(699, "GB", "ios", config)).toBeCloseTo((699 / 1.2) * 0.85, 6);
  });

  it("counts weekly charges with first-renewal and steady-state survival", () => {
    // days 3, 10, 17 within 20 days: 1 + 0.65 + 0.65*0.88
    expect(chargesWithin(weekly, 20, config)).toBeCloseTo(1 + 0.65 + 0.65 * 0.88, 6);
    expect(chargesWithin({ ...weekly, period: "year", trialDays: 0 }, 60, config)).toBe(1);
  });

  it("maps the 24h keep rate to trial-to-paid", () => {
    expect(conversionGivenTrial(1, weekly, config)).toBeCloseTo(0.95, 6);
    expect(conversionGivenTrial(0.16, weekly, config)).toBe(0);
    expect(conversionGivenTrial(0.4, { ...weekly, trialDays: 0 }, config)).toBe(1);
  });

  it("produces a sensible D60 RPI for a median hard-paywall app", () => {
    // RevenueCat SOSA 2026 puts the median hard-paywall D60 RPI around $3 gross.
    const rpi = predictNetRpiCents({ trialStartRate: 0.12, keep24: 0.45, entry: weekly, geo: "US", platform: "ios", horizonDays: 60, config });
    expect(rpi).toBeGreaterThan(50);
    expect(rpi).toBeLessThan(400);
  });

  it("is deterministic for a seed and reads ROAS against CAC", () => {
    const input = {
      trialStart: { successes: 60, trials: 300, prior: 0.12 },
      keep24: { successes: 30, trials: 60, prior: 0.41 },
      entry: weekly,
      geo: "CA",
      platform: "ios" as const,
      horizonDays: 60,
      config,
    };
    const a = rpiQuantiles({ ...input, rng: new Rng(3) }, [0.2, 0.5]);
    const b = rpiQuantiles({ ...input, rng: new Rng(3) }, [0.2, 0.5]);
    expect(a).toEqual(b);
    expect(a[0]!).toBeLessThan(a[1]!);
    const econ = cellEconomics({ ...input, rng: new Rng(3), spendCents: 30_000, installs: 300 });
    expect(econ.cacCents).toBe(100);
    expect(econ.roasD60P20).toBeCloseTo(econ.predNetRpiD60P20Cents / 100, 6);
  });
});

describe("creative bandit", () => {
  const arms = [
    { arm: "slideshow:h1", posts: 10, views: 200_000, installs: 600 },
    { arm: "slideshow:h2", posts: 10, views: 200_000, installs: 200 },
    { arm: "pov:h3", posts: 2, views: 10_000, installs: 25 },
  ];

  it("prefers the strong arm, keeps exploring, and culls only well-sampled losers", () => {
    const p = probabilityBest(arms, new Rng(11));
    expect(p["slideshow:h1"]!).toBeGreaterThan(p["slideshow:h2"]!);
    const alloc = allocate(p, 0.2);
    expect(Object.values(alloc).reduce((s, x) => s + x, 0)).toBeCloseTo(1, 6);
    expect(alloc["pov:h3"]!).toBeGreaterThanOrEqual(0.2 / 3 - 1e-9);
    const culled = armsToCull(arms, p, { cullMinPosts: 6, cullProbBest: 0.05 });
    expect(culled).toContain("slideshow:h2");
    expect(culled).not.toContain("pov:h3");
  });

  it("does not let one viral post decide", () => {
    const viral = [
      { arm: "a", posts: 1, views: 1_000_000, installs: 3_000 },
      { arm: "b", posts: 12, views: 240_000, installs: 600 },
    ];
    const p = probabilityBest(viral, new Rng(5));
    expect(p.a!).toBeLessThan(0.95);
  });

  it("splits posts exactly", () => {
    const split = postsPerArm({ a: 0.5, b: 0.3, c: 0.2 }, 10);
    expect(Object.values(split).reduce((s, n) => s + n, 0)).toBe(10);
    expect(split.a).toBe(5);
  });
});

describe("audiences", () => {
  it("keeps EU/UK storefronts out unless enabled and never tests in the scale market", () => {
    const withGb = { ...config, lab: { ...config.lab, testGeos: ["CA", "GB", "US", "AU"] } };
    expect(testGeosFor("en-US", withGb)).toEqual(["CA", "AU"]);
    const enabled = { ...withGb, privacy: { ...withGb.privacy, euUkEnabled: true } };
    expect(testGeosFor("en-GB", enabled)).toEqual(["CA", "GB", "AU"]);
  });

  it("applies the long cooldown across ventures and the short one within a venture", () => {
    const key = exposureKey("w", "creator_ugc", "app", "CA");
    const exposures = [{ key, wedge: "w", ventureId: "ven_a", experimentId: "e", at: "2026-01-01T00:00:00.000Z" }];
    const now = "2026-01-10T00:00:00.000Z";
    expect(isBurned({ key, ventureId: "ven_b", exposures, now, config })).toBe(true);
    expect(isBurned({ key, ventureId: "ven_a", exposures, now, config })).toBe(false);
    expect(pickTestGeos({ wedge: "w", locale: "en-US", channel: "creator_ugc", count: 3, ventureId: "ven_b", config, exposures, now })).toEqual(["AU", "NZ"]);
  });

  it("detects shared storefronts and units", () => {
    const base = { phase: 1 as const, role: "primary" as const, platform: "app" as const, channel: "creator_ugc" as const, locale: "en-US", assignment: "geo" as const, attribution: "storefront_geo" as const, variant: {}, budgetCents: 0 };
    const problems = assertDisjoint([
      { ...base, id: "c1", geo: "CA", audienceUnits: ["cre_1"] },
      { ...base, id: "c2", geo: "CA", audienceUnits: ["cre_1"] },
    ]);
    expect(problems.length).toBe(2);
  });
});
