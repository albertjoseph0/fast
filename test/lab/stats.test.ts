import { describe, expect, it } from "vitest";
import {
  betaCdf,
  betaQuantile,
  binomialUpperTail,
  effectiveCounts,
  gammaCdf,
  intraclassCorrelation,
  normalQuantile,
  passThresholdCount,
  poissonUpperTail,
  probAtLeast,
  proportionPosterior,
  ratePosterior,
  requiredSamplePerCell,
} from "../../src/lab/stats.ts";

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

  it("finds the smallest passing count", () => {
    const n = 300;
    const k = passThresholdCount(n, 0.12, 0.9);
    expect(probAtLeast(proportionPosterior(k, n, 0.12), 0.12)).toBeGreaterThanOrEqual(0.9);
    expect(probAtLeast(proportionPosterior(k - 1, n, 0.12), 0.12)).toBeLessThan(0.9);
  });
});
