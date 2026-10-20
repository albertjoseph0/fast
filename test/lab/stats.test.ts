import { describe, expect, it } from "vitest";
import {
  betaCdf,
  betaQuantile,
  binomialUpperTail,
  effectiveCounts,
  futilityStopProbability,
  gammaCdf,
  intraclassCorrelation,
  normalQuantile,
  passThresholdCount,
  poissonUpperTail,
  probAtLeast,
  proportionPosterior,
  ratePosterior,
  rateOverdispersion,
  requiredSamplePerCell,
} from "../../src/lab/stats.ts";
import { Rng } from "../../src/core/rng.ts";
import { PLANNING } from "../../src/lab/experiments.ts";

describe("special functions", () => {
  it("matches reference values", () => {
    expect(betaCdf(0.5, 2, 2)).toBeCloseTo(0.5, 10);
    expect(betaCdf(0.3, 2, 5)).toBeCloseTo(0.579825, 6);
    expect(betaQuantile(betaCdf(0.42, 7, 13), 7, 13)).toBeCloseTo(0.42, 6);
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 5);
    expect(gammaCdf(2, 3, 1)).toBeCloseTo(0.323324, 6);
    expect(gammaCdf(10, 9.5, 1)).toBeCloseTo(0.605422, 5); // numeric integration reference
    expect(binomialUpperTail(5, 10, 0.5)).toBeCloseTo(0.623047, 6);
    expect(poissonUpperTail(3, 2)).toBeCloseTo(0.323324, 6);
  });
});

describe("skeptical priors", () => {
  it("never passes a rare-event metric without data", () => {
    const post = proportionPosterior(0, 4, 0.0015);
    expect(probAtLeast(post, 0.0015)).toBeLessThan(0.05);
    expect(probAtLeast(proportionPosterior(0, 0, 0.12), 0.12)).toBeLessThan(0.5);
  });

  it("passes clear evidence above the floor", () => {
    expect(probAtLeast(proportionPosterior(80, 300, 0.12), 0.12)).toBeGreaterThan(0.99);
    expect(probAtLeast(ratePosterior(300, 200, 1.0), 1.0)).toBeGreaterThan(0.99);
  });
});

describe("clustering", () => {
  it("is near zero for homogeneous sources and large for heterogeneous ones", () => {
    const even = Array.from({ length: 10 }, () => ({ successes: 10, trials: 100 }));
    expect(intraclassCorrelation(even)).toBeCloseTo(0.01, 5);
    const uneven = [
      { successes: 50, trials: 100 },
      { successes: 5, trials: 100 },
      { successes: 20, trials: 100 },
    ];
    expect(intraclassCorrelation(uneven)).toBeGreaterThan(0.2);
  });

  it("treats a single source as one observation-sized cluster", () => {
    const eff = effectiveCounts({ successes: 30, trials: 300 }, { only: { successes: 30, trials: 300 } });
    expect(eff.rho).toBe(1);
    expect(eff.trials).toBeCloseTo(1, 5);
  });

  it("lets a viral post add bounded information instead of collapsing the cell", () => {
    // 451K in-geo views, every post converting at exactly the target 0.003.
    const bySource: Record<string, { successes: number; trials: number }> = { viral: { successes: 1_200, trials: 400_000 } };
    for (let i = 0; i < 17; i++) bySource[`p${i}`] = { successes: 9, trials: 3_000 };
    const total = { successes: 1_353, trials: 451_000 };
    const eff = effectiveCounts(total, bySource, { floor: PLANNING.viewRho });
    expect(eff.rho).toBeCloseTo(PLANNING.viewRho, 10);
    // The viral post counts for at most ~1/rho views; the 17 ordinary posts keep their information.
    expect(eff.trials).toBeGreaterThan(17 * 3_000 / (1 + 2_999 * PLANNING.viewRho));
    expect(eff.trials).toBeLessThan(17 * 3_000 + 1 / PLANNING.viewRho);
    expect(eff.successes / eff.trials).toBeCloseTo(0.003, 6);
    expect(probAtLeast(proportionPosterior(eff.successes, eff.trials, 0.0015), 0.0015)).toBeGreaterThan(0.99);
  });

  it("spreads successes no source owns at the average weight", () => {
    const eff = effectiveCounts({ successes: 60, trials: 1_000 }, { a: { successes: 20, trials: 500 }, b: { successes: 20, trials: 500 } }, { rho: 0.01 });
    expect(eff.successes / eff.trials).toBeCloseTo(0.06, 10);
  });

  it("measures overdispersion of rates even when per-source rates exceed 1", () => {
    // Half the sources invite at K=0.2, half at K=2.0 (pooled 1.1): the binary ICC pinned rho at its floor here.
    const het = Array.from({ length: 18 }, (_, i) => ({ trials: 15, successes: i % 2 ? 30 : 3 }));
    const bySource = Object.fromEntries(het.map((g, i) => [`s${i}`, g]));
    const eff = effectiveCounts({ successes: 297, trials: 270 }, bySource, { kind: "rate" });
    expect(eff.rho).toBeGreaterThan(0.5);
    expect(probAtLeast(ratePosterior(eff.successes, eff.trials, 1), 1)).toBeLessThan(0.9);
    const even = Array.from({ length: 18 }, () => ({ trials: 15, successes: 17 }));
    expect(rateOverdispersion(even)).toBeCloseTo(0.01, 10);
  });

  it("keeps K-factor false passes at the floor rare under source heterogeneity", () => {
    const rng = new Rng(11);
    for (const sigma of [0.3, 0.6, 0.9]) {
      let pass = 0;
      const T = 600;
      for (let t = 0; t < T; t++) {
        const bySource: Record<string, { successes: number; trials: number }> = {};
        let S = 0;
        let N = 0;
        for (let i = 0; i < 18; i++) {
          const users = Math.max(1, Math.round((261 / 18) * rng.lognormal(1, 0.8)));
          const invites = rng.poisson(users * (rng.lognormal(1, sigma) / Math.exp((sigma * sigma) / 2)));
          bySource[`s${i}`] = { successes: invites, trials: users };
          S += invites;
          N += users;
        }
        const eff = effectiveCounts({ successes: S, trials: N }, bySource, { kind: "rate" });
        if (probAtLeast(ratePosterior(eff.successes, eff.trials, 1), 1) >= 0.9) pass++;
      }
      // Per cell; all three storefronts must pass, so the test-level rate is this cubed.
      expect(pass / T).toBeLessThan(0.15);
    }
  });
});

describe("power", () => {
  it("reproduces the design-review worked values (3 cells, c=0.9, power 0.8)", () => {
    const trialStart = requiredSamplePerCell({ kind: "proportion", floor: 0.12, target: 0.18, cells: 3, confidence: 0.9, power: 0.8 });
    expect(trialStart.n).toBeGreaterThan(220);
    expect(trialStart.n).toBeLessThan(330);
    expect(trialStart.powerAtTarget).toBeGreaterThanOrEqual(0.8);
    expect(trialStart.falsePassAtFloor).toBeLessThan(0.01);
    const activation = requiredSamplePerCell({ kind: "proportion", floor: 0.45, target: 0.55, cells: 3, confidence: 0.9, power: 0.8 });
    expect(activation.n).toBeGreaterThan(150);
    expect(activation.n).toBeLessThan(240);
  });

  it("handles rare events and rates", () => {
    const views = requiredSamplePerCell({ kind: "proportion", floor: 0.0015, target: 0.003, cells: 3, confidence: 0.9, power: 0.8 });
    expect(views.n).toBeGreaterThan(4_000);
    expect(views.falsePassAtFloor).toBeLessThan(0.01);
    const k = requiredSamplePerCell({ kind: "rate", floor: 1.0, target: 1.2, cells: 3, confidence: 0.9, power: 0.8 });
    expect(k.n).toBeGreaterThan(100);
    expect(k.powerAtTarget).toBeGreaterThanOrEqual(0.8);
  });

  it("computes the futility stop probability exactly", () => {
    // Brute force over every hit sequence of 8 looks, stopping from look 4.
    const opts = { n: 8, firstLook: 4, floor: 0.15, futility: 0.05, confidence: 0.9 };
    const p = 0.3;
    let stopped = 0;
    for (let mask = 0; mask < 1 << opts.n; mask++) {
      let hits = 0;
      let prob = 1;
      let stop = false;
      for (let look = 1; look <= opts.n; look++) {
        const hit = (mask >> (look - 1)) & 1;
        hits += hit;
        prob *= hit ? p : 1 - p;
        const post = proportionPosterior(hits, look, opts.floor);
        if (!stop && look >= opts.firstLook && (probAtLeast(post, opts.floor) < 0.05 || 1 - probAtLeast(post, opts.futility) >= opts.confidence)) stop = true;
      }
      if (stop) stopped += prob;
    }
    expect(futilityStopProbability({ ...opts, p })).toBeCloseTo(stopped, 12);
  });

  it("finds the smallest passing count", () => {
    const n = 300;
    const k = passThresholdCount(n, 0.12, 0.9);
    expect(probAtLeast(proportionPosterior(k, n, 0.12), 0.12)).toBeGreaterThanOrEqual(0.9);
    expect(probAtLeast(proportionPosterior(k - 1, n, 0.12), 0.12)).toBeLessThan(0.9);
  });
});
