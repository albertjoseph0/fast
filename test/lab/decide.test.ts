import { describe, expect, it } from "vitest";
import { Rng } from "../../src/core/rng.ts";
import type { CellObservation, CellVerdict, ExperimentPlan, MetricKey } from "../../src/core/types.ts";
import { decideExperiment, diagnose, evaluateCell } from "../../src/lab/decide.ts";
import { designAttentionProbe, designExperiment, isFrozenIntact, planHash } from "../../src/lab/experiments.ts";
import { astraIdea, config, counts, observation, venture } from "./fixtures.ts";

const NOW = "2026-01-05T09:00:00.000Z";
const LATER = "2026-01-12T09:00:00.000Z";

function plan(stages: ExperimentPlan["stages"] = ["S1_distribution", "S1_activation", "S4_monetization"]): ExperimentPlan {
  const r = designExperiment({
    experimentId: "exp_000001",
    cellIds: ["cell_000001", "cell_000002", "cell_000003"],
    venture: venture(),
    idea: astraIdea(),
    stages,
    hypothesis: "Creators drive installs that start trials",
    variableUnderTest: "baseline",
    variant: { baseline: "v1" },
    deliveryMode: "native_build",
    config,
    now: NOW,
    exposures: [],
  });
  if (!r.ok) throw new Error(r.reason);
  const p = r.plan;
  p.status = "running";
  p.startedAt = NOW;
  for (const c of p.cells) c.firstExposureAt = NOW;
  return p;
}

/** Observation that meets every sample with the given true rates. */
function obsAt(p: ExperimentPlan, cellId: string, rates: Partial<Record<MetricKey, number>>, extra: Partial<CellObservation> = {}): CellObservation {
  const metrics: CellObservation["metrics"] = {};
  for (const m of p.metrics) {
    const n = p.minSamplePerCell[m.key] ?? 100;
    const rate = rates[m.key] ?? m.target;
    metrics[m.key] = counts(Math.round(n * rate), n, m.denominator === "view" ? 20 : 18);
  }
  return observation(cellId, metrics, extra);
}

function verdicts(p: ExperimentPlan, obs: Map<string, CellObservation>, now = LATER): CellVerdict[] {
  return p.cells.map((cell) => evaluateCell({ plan: p, cell, obs: obs.get(cell.id), config, now, clockStart: p.startedAt as string }));
}

const PRICING = { entry: { id: "week_699_t3", period: "week" as const, usdCents: 699, trialDays: 3 }, platform: "ios" as const };

function decide(p: ExperimentPlan, obs: Map<string, CellObservation>, ladder = venture().ladder) {
  return decideExperiment({ plan: p, verdicts: verdicts(p, obs), observations: obs, ladder, config, now: LATER, previousOutcomes: [], pricing: PRICING, rng: new Rng(7) });
}

describe("registration", () => {
  it("registers a frozen, budget-feasible plan over three fresh storefronts", () => {
    const p = plan();
    expect(p.cells.map((c) => c.geo)).toEqual(["AU", "CA", "NZ"]);
    expect(new Set(p.cells.map((c) => c.geo)).size).toBe(3);
    expect(p.metrics.find((m) => m.key === "trialStartRate")?.role).toBe("required");
    expect(p.metrics.find((m) => m.key === "trialKeep24h")?.role).toBe("futility_only");
    expect(p.minSamplePerCell.trialStartRate).toBeGreaterThan(250);
    expect(p.cells[0]!.budgetCents).toBeLessThanOrEqual(config.budgets.maxCellBudgetCents);
    const fresh = structuredClone(p);
    fresh.status = "registered";
    delete fresh.startedAt;
    for (const c of fresh.cells) delete c.firstExposureAt;
    expect(planHash(fresh)).toBe(p.registrationHash);
    expect(isFrozenIntact(p)).toBe(true);
    p.metrics[0]!.floor = 0.0001;
    expect(isFrozenIntact(p)).toBe(false);
  });

  it("refuses infeasible budgets and multi-variable variants", () => {
    const tight = { ...config, budgets: { ...config.budgets, maxCellBudgetCents: 1_000 } };
    const r = designExperiment({
      experimentId: "e", cellIds: ["a", "b", "c"], venture: venture(), idea: astraIdea(), stages: ["S4_monetization"],
      hypothesis: "h", variableUnderTest: "paywall", variant: { paywall: "v2" }, deliveryMode: "remote_config", config: tight, now: NOW, exposures: [],
    });
    expect(r.ok).toBe(false);
    const r2 = designExperiment({
      experimentId: "e", cellIds: ["a", "b", "c"], venture: venture(), idea: astraIdea(), stages: ["S4_monetization"],
      hypothesis: "h", variableUnderTest: "paywall", variant: { paywall: "v2", hooks: "x" }, deliveryMode: "remote_config", config, now: NOW, exposures: [],
    });
    expect(r2.ok).toBe(false);
  });

  it("skips storefronts in cooldown for the same wedge", () => {
    const exposures = ["AU", "CA"].map((geo) => ({ key: `Gen Z astrology fans on TikTok|creator_ugc|app|${geo}`, wedge: "Gen Z astrology fans on TikTok", ventureId: "ven_other", experimentId: "x", at: NOW }));
    const r = designExperiment({
      experimentId: "e", cellIds: ["a", "b", "c"], venture: venture(), idea: astraIdea(), stages: ["S1_activation"],
      hypothesis: "h", variableUnderTest: "baseline", variant: { baseline: "v1" }, deliveryMode: "native_build", config, now: NOW, exposures,
    });
    expect(r.ok).toBe(false);
  });
});

describe("cell reads", () => {
  it("is pending before exposure and invalid when exposure never arrives", () => {
    const p = plan();
    const cell = { ...p.cells[0]! };
    delete cell.firstExposureAt;
    expect(evaluateCell({ plan: p, cell, config, now: "2026-01-06T09:00:00.000Z", clockStart: NOW }).decision).toBe("pending");
    expect(evaluateCell({ plan: p, cell, config, now: LATER, clockStart: NOW }).decision).toBe("invalid");
  });

  it("passes at target, fails just under the floor, and stops early for futility", () => {
    const p = plan();
    const id = p.cells[0]!.id;
    expect(evaluateCell({ plan: p, cell: p.cells[0]!, obs: obsAt(p, id, { trialStartRate: 0.2 }), config, now: LATER, clockStart: NOW }).decision).toBe("pass");
    expect(evaluateCell({ plan: p, cell: p.cells[0]!, obs: obsAt(p, id, { trialStartRate: 0.11 }), config, now: LATER, clockStart: NOW }).decision).toBe("fail");
    // Futility: half the sample at a dismal rate, before the deadline.
    const half = Math.ceil((p.minSamplePerCell.trialStartRate ?? 0) * 0.6);
    const early = observation(id, { ...obsAt(p, id, {}).metrics, trialStartRate: counts(Math.round(half * 0.02), half, 18) });
    expect(evaluateCell({ plan: p, cell: p.cells[0]!, obs: early, config, now: "2026-01-06T09:00:00.000Z", clockStart: NOW }).decision).toBe("futile");
  });

  it("marks impossible counts, warm traffic and concentrated sources invalid", () => {
    const p = plan();
    const id = p.cells[0]!.id;
    const impossible = obsAt(p, id, {});
    impossible.metrics.activationRate = { successes: 500, trials: 100, bySource: {} };
    expect(evaluateCell({ plan: p, cell: p.cells[0]!, obs: impossible, config, now: LATER, clockStart: NOW }).decision).toBe("invalid");
    expect(evaluateCell({ plan: p, cell: p.cells[0]!, obs: obsAt(p, id, {}, { internalShare: 0.2 }), config, now: LATER, clockStart: NOW }).decision).toBe("invalid");
    const concentrated = obsAt(p, id, {});
    const n = p.minSamplePerCell.trialStartRate ?? 300;
    concentrated.metrics.trialStartRate = counts(Math.round(n * 0.2), n, 1);
    expect(evaluateCell({ plan: p, cell: p.cells[0]!, obs: concentrated, config, now: LATER, clockStart: NOW }).decision).toBe("invalid");
  });

  it("is invalid when the deadline passes without the registered sample", () => {
    const p = plan();
    const id = p.cells[0]!.id;
    const small = obsAt(p, id, {});
    small.metrics.trialStartRate = counts(20, 100, 18);
    expect(evaluateCell({ plan: p, cell: p.cells[0]!, obs: small, config, now: LATER, clockStart: NOW }).decision).toBe("invalid");
  });
});

describe("experiment decisions", () => {
  it("passes when all three storefronts pass and economics hold", () => {
    const p = plan();
    const obs = new Map(p.cells.map((c) => [c.id, obsAt(p, c.id, { trialStartRate: 0.22, trialKeep24h: 0.6 }, { spendCents: 20_000 })]));
    const out = decide(p, obs);
    expect(out.decision).toBe("pass");
    expect(out.unitEconomics?.roasD60P20).toBeGreaterThan(config.lab.s4MinRoasD60P20);
  });

  it("fails the variant when conversion passes but unit economics do not", () => {
    const p = plan();
    // Spend at the full cell budget: CAC ~1.25x the planning CPI against a mediocre keep rate.
    const obs = new Map(p.cells.map((c) => [c.id, obsAt(p, c.id, { trialStartRate: 0.2, trialKeep24h: 0.38 }, { spendCents: c.budgetCents })]));
    const out = decide(p, obs);
    expect(out.decision).toBe("iterate");
    expect(out.rationale).toMatch(/unit economics/);
  });

  it("fails in three communities -> iterate, then kill at the cap", () => {
    const p = plan();
    const obs = new Map(p.cells.map((c) => [c.id, obsAt(p, c.id, { trialStartRate: 0.1 })]));
    expect(decide(p, obs).decision).toBe("iterate");
    const atCap = { ...venture().ladder, iteration: config.lab.maxIterationsPerStep - 1 };
    expect(decide(p, obs, atCap).decision).toBe("kill");
  });

  it("re-runs a confounded cell on a mixed result and escalates when fixes run out", () => {
    const p = plan(["S1_activation"]);
    const [a, b, c] = p.cells.map((x) => x.id) as [string, string, string];
    const obs = new Map([
      [a, obsAt(p, a, { activationRate: 0.6 })],
      [b, obsAt(p, b, { activationRate: 0.6 })],
      [c, obsAt(p, c, { activationRate: 0.1 })], // dropped activation events
    ]);
    const out = decide(p, obs);
    expect(out.decision).toBe("fix_harness");
    expect(out.rerunCellIds).toEqual([c]);
    const exhausted = { ...venture().ladder, harnessFixes: config.lab.maxHarnessFixesPerStep };
    expect(decide(p, obs, exhausted).decision).toBe("escalate");
    expect(diagnose(p, verdicts(p, obs), obs).map((f) => f.cellId)).toContain(c);
  });

  it("treats a mixed result without a confound as not working", () => {
    const p = plan(["S1_activation"]);
    const [a, b, c] = p.cells.map((x) => x.id) as [string, string, string];
    const obs = new Map([
      [a, obsAt(p, a, { activationRate: 0.62 })],
      [b, obsAt(p, b, { activationRate: 0.43 })],
      [c, obsAt(p, c, { activationRate: 0.42 })],
    ]);
    expect(decide(p, obs).decision).toBe("iterate");
  });

  it("continues while any cell is pending", () => {
    const p = plan();
    const early = "2026-01-06T09:00:00.000Z";
    const small = new Map(p.cells.map((c) => [c.id, observation(c.id, { trialStartRate: counts(8, 40, 18) })]));
    const vs = p.cells.map((cell) => evaluateCell({ plan: p, cell, obs: small.get(cell.id), config, now: early, clockStart: NOW }));
    expect(decideExperiment({ plan: p, verdicts: vs, observations: small, ladder: venture().ladder, config, now: early, previousOutcomes: [], rng: new Rng(1) }).decision).toBe("continue");
  });

  it("attention probe can only kill", () => {
    const probe = designAttentionProbe({ experimentId: "exp_probe", cellId: "cell_probe", venture: venture(), idea: astraIdea(), accountId: "acct_1", config, now: NOW });
    probe.cells[0]!.firstExposureAt = NOW;
    const posts = config.lab.attentionProbe.posts;
    const bySource = (hits: number) => Object.fromEntries(Array.from({ length: posts }, (_, i) => [`post_${i}`, { successes: i < hits ? 1 : 0, trials: 1 }]));
    const run = (hits: number) => {
      const obs = new Map([[probe.cells[0]!.id, observation(probe.cells[0]!.id, { attentionHitRate: { successes: hits, trials: posts, bySource: bySource(hits) } })]]);
      return decideExperiment({ plan: probe, verdicts: verdicts(probe, obs), observations: obs, ladder: venture().ladder, config, now: LATER, previousOutcomes: [], rng: new Rng(1) }).decision;
    };
    expect(run(0)).toBe("kill");
    expect(run(5)).toBe("pass");
  });
});

describe("operating characteristics", () => {
  // Simulate the full rule (3 cells, binary read at sample) many times.
  function passRate(trueRate: number, trials: number): number {
    const p = plan(["S1_activation"]);
    const rng = new Rng(2026);
    let passes = 0;
    for (let t = 0; t < trials; t++) {
      const obs = new Map(
        p.cells.map((c) => {
          const n = p.minSamplePerCell.activationRate ?? 200;
          const bySource: Record<string, { successes: number; trials: number }> = {};
          let s = 0;
          for (let src = 0; src < 18; src++) {
            const nt = Math.floor(n / 18) + (src < n % 18 ? 1 : 0);
            const ns = rng.binomial(nt, trueRate);
            s += ns;
            bySource[`p${src}`] = { successes: ns, trials: nt };
          }
          const d1 = p.minSamplePerCell.d1Retention ?? 120;
          return [c.id, observation(c.id, { activationRate: { successes: s, trials: n, bySource }, d1Retention: counts(Math.round(d1 * 0.35), d1, 18) })];
        }),
      );
      if (decide(p, obs).decision === "pass") passes++;
    }
    return passes / trials;
  }

  it("delivers the registered power at target and rarely passes at the floor", () => {
    const atTarget = passRate(config.thresholds.activationRate.target, 150);
    const atFloor = passRate(config.thresholds.activationRate.floor, 150);
    expect(atTarget).toBeGreaterThan(0.65);
    expect(atFloor).toBeLessThan(0.05);
  });
});
