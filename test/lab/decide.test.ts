import { describe, expect, it } from "vitest";
import { Rng } from "../../src/core/rng.ts";
import type { CellObservation, CellVerdict, ExperimentPlan, MetricCounts, MetricKey } from "../../src/core/types.ts";
import { decideExperiment, diagnose, evaluateCell, experimentEconomics } from "../../src/lab/decide.ts";
import { designAttentionProbe, designExperiment, isFrozenIntact, planHash } from "../../src/lab/experiments.ts";
import { mixedNetPriceCents } from "../../src/lab/ltv.ts";
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

  it("covers the creator posting window plus the slowest metric's maturity for every creator plan", () => {
    const window = config.lab.creatorPostingWindowHours;
    expect(plan(["S2_sharing"]).readHours).toBe(window + 24);
    expect(plan(["S3_cross_cell"]).readHours).toBe(window + 168);
    expect(plan(["S4_monetization"]).readHours).toBe(window + 24);
    const owned = designExperiment({
      experimentId: "e", cellIds: ["a", "b", "c"], venture: venture(), idea: astraIdea(), stages: ["S2_sharing"], channel: "owned_social",
      hypothesis: "h", variableUnderTest: "baseline", variant: { baseline: "v1" }, deliveryMode: "native_build", config, now: NOW, exposures: [],
    });
    expect(owned.ok && owned.plan.readHours).toBe(config.lab.readHours.S2_sharing);
  });

  it("registers the attention probe's real kill rates", () => {
    const probe = designAttentionProbe({ experimentId: "exp_probe", cellId: "cell_probe", venture: venture(), idea: astraIdea(), accountId: "acct_1", config, now: NOW });
    probe.cells[0]!.firstExposureAt = NOW;
    // Daily looks with one more matured post each time, through the real read and decision.
    const killRate = (p: number, trials: number) => {
      const rng = new Rng(9);
      let killed = 0;
      for (let t = 0; t < trials; t++) {
        let hits = 0;
        for (let n = 1; n <= config.lab.attentionProbe.posts; n++) {
          hits += rng.chance(p) ? 1 : 0;
          const obs = observation("cell_probe", { attentionHitRate: { successes: hits, trials: n, bySource: {} } });
          const now = new Date(Date.parse(NOW) + n * 6 * 3_600_000).toISOString();
          const v = evaluateCell({ plan: probe, cell: probe.cells[0]!, obs, config, now, clockStart: NOW });
          const o = decideExperiment({ plan: probe, verdicts: [v], observations: new Map([["cell_probe", obs]]), ladder: venture().ladder, config, now, previousOutcomes: [], rng });
          if (o.decision === "kill") killed++;
          if (o.decision !== "continue") break;
        }
      }
      return killed / trials;
    };
    const oc = probe.operatingCharacteristics;
    expect(oc.powerAtTarget).toBeLessThan(1);
    expect(1 - oc.powerAtTarget).toBeCloseTo(killRate(config.thresholds.attentionHitRate.target, 4_000), 1);
    expect(1 - oc.falsePassAtFloor).toBeCloseTo(killRate(config.thresholds.attentionHitRate.floor, 4_000), 1);
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
    const pastSla = new Date(new Date(NOW).getTime() + (p.maxHoursToFirstExposure + 1) * 3_600_000).toISOString();
    expect(evaluateCell({ plan: p, cell, config, now: pastSla, clockStart: NOW }).decision).toBe("invalid");
  });

  it("keeps a concentrated cell valid when its verdict survives dropping the top source", () => {
    const p = plan(["S1_activation"]);
    const id = p.cells[0]!.id;
    const n = (p.minSamplePerCell.activationRate ?? 200) * 2;
    const bySource: Record<string, { successes: number; trials: number }> = { viral: { successes: Math.round(n * 0.6 * 0.7), trials: Math.round(n * 0.6) } };
    for (let s = 0; s < 8; s++) bySource[`p${s}`] = { successes: Math.round((n * 0.05) * 0.7), trials: Math.round(n * 0.05) };
    const total = Object.values(bySource).reduce((a, x) => ({ successes: a.successes + x.successes, trials: a.trials + x.trials }), { successes: 0, trials: 0 });
    const obs = obsAt(p, id, {});
    obs.metrics.activationRate = { ...total, bySource };
    const v = evaluateCell({ plan: p, cell: p.cells[0]!, obs, config, now: LATER, clockStart: NOW });
    expect(v.validity.find((x) => x.id === "source_concentration")?.passed).toBe(true);
    expect(v.decision).toBe("pass");
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

  it("still fails a short cell at the deadline when the shortfall cannot change the answer", () => {
    const p = plan();
    const id = p.cells[0]!.id;
    const n = Math.ceil((p.minSamplePerCell.trialStartRate ?? 300) * 0.4);
    const weak = obsAt(p, id, {});
    weak.metrics.trialStartRate = counts(Math.round(n * 0.03), n, 18);
    const v = evaluateCell({ plan: p, cell: p.cells[0]!, obs: weak, config, now: LATER, clockStart: NOW });
    expect(v.decision).toBe("fail");
    expect(v.validity.find((x) => x.id === "min_sample")?.passed).toBe(true);
  });

  it("reads a uniformly converting viral cell on its rate, not on the viral post's size", () => {
    const p = plan(["S1_distribution"]);
    const viral = (rate: number, topRate = rate): MetricCounts => {
      const m: MetricCounts = { successes: 0, trials: 0, bySource: {} };
      const add = (id: string, views: number, r: number) => {
        const k = Math.round(views * r);
        m.bySource[id] = { successes: k, trials: views };
        m.successes += k;
        m.trials += views;
      };
      add("viral", 400_000, topRate);
      for (let i = 0; i < 17; i++) add(`p${i}`, 3_000, rate);
      return m;
    };
    const read = (m: MetricCounts) => evaluateCell({ plan: p, cell: p.cells[0]!, obs: observation(p.cells[0]!.id, { installsPer1kViews: m }), config, now: LATER, clockStart: NOW });
    // At target: was a valid fail with P(p >= floor) = 0.43 under the 0.01 clustering floor.
    expect(read(viral(0.003)).decision).toBe("pass");
    // At 1.5x target: dropping the viral post used to sharpen the read and flip the call (invalid).
    const v = read(viral(0.0045));
    expect(v.validity.find((x) => x.id === "source_concentration")?.passed).toBe(true);
    expect(v.decision).toBe("pass");
    // An outlying viral post cannot carry a failing rest, and it invalidates a read it tips over the bar.
    expect(read(viral(0.0004, 0.006)).decision).not.toBe("pass");
    const tipped = read(viral(0.002, 0.006));
    expect(tipped.validity.find((x) => x.id === "source_concentration")?.passed).toBe(false);
    expect(tipped.decision).toBe("invalid");
  });

  it("waits for the creator posting window before an early read", () => {
    const p = plan(["S1_activation"]);
    const cell = p.cells[0]!;
    const obs = obsAt(p, cell.id, { activationRate: 0.6 });
    const at = (hours: number) => new Date(Date.parse(NOW) + hours * 3_600_000).toISOString();
    expect(evaluateCell({ plan: p, cell, obs, config, now: at(48), clockStart: NOW }).decision).toBe("pending");
    expect(evaluateCell({ plan: p, cell, obs, config, now: at(config.lab.creatorPostingWindowHours), clockStart: NOW }).decision).toBe("pass");
    // Futility still stops early, and cells without a posting window read as soon as the sample is in.
    const dismal = obsAt(p, cell.id, { activationRate: 0.1 });
    expect(evaluateCell({ plan: p, cell, obs: dismal, config, now: at(48), clockStart: NOW }).decision).toBe("futile");
    expect(evaluateCell({ plan: p, cell: { ...cell, channel: "owned_social" }, obs, config, now: at(48), clockStart: NOW }).decision).toBe("pass");
  });

  it("does not treat installs outrunning counted views as broken instrumentation", () => {
    const p = plan();
    const id = p.cells[0]!.id;
    const early = obsAt(p, id, {});
    early.metrics.installsPer1kViews = { successes: 40, trials: 10, bySource: {} };
    expect(evaluateCell({ plan: p, cell: p.cells[0]!, obs: early, config, now: NOW, clockStart: NOW }).validity.find((x) => x.id === "instrumentation")?.passed).toBe(true);
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

  it("nets each storefront's own VAT when pooling S4 economics", () => {
    const p = plan();
    const installs = [100, 300, 600];
    const obs = new Map(p.cells.map((c, i) => [c.id, observation(c.id, { trialStartRate: counts(Math.round(installs[i]! * 0.2), installs[i]!, 18), trialKeep24h: counts(30, 50, 18) }, { spendCents: 10_000 })]));
    const econ = (cellIds: string[]) => experimentEconomics({ plan: p, observations: obs, cellIds, pricing: PRICING, config, rng: new Rng(3) });
    const ids = p.cells.map((c) => c.id);
    // Pooled reads cannot depend on which storefront is listed first.
    expect(econ(ids)).toEqual(econ([...ids].reverse()));
    const mix = Object.fromEntries(p.cells.map((c, i) => [c.geo, installs[i]!]));
    const blended = mixedNetPriceCents(PRICING.entry.usdCents, mix, "ios", config);
    const total = installs.reduce((a, b) => a + b, 0);
    const expected = p.cells.reduce((s, c, i) => s + (PRICING.entry.usdCents / (1 + (config.economics.vatInclusiveRateByGeo[c.geo] ?? 0))) * 0.85 * (installs[i]! / total), 0);
    expect(blended).toBeCloseTo(expected, 6);
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

  // S1 per-view reads with realistic virality: 18 creator posts per cell, lognormal in-geo views
  // (median 3,750) and lognormal per-post conversion around the true rate.
  function perViewPassRate(trueRate: number, trials: number, seed: number): number {
    const p = plan(["S1_distribution"]);
    const rng = new Rng(seed);
    let passes = 0;
    for (let t = 0; t < trials; t++) {
      const obs = new Map(
        p.cells.map((c) => {
          const m: MetricCounts = { successes: 0, trials: 0, bySource: {} };
          for (let i = 0; i < 18; i++) {
            const views = Math.round(3_750 * rng.lognormal(1, 1.2));
            const installs = rng.poisson((views * trueRate * rng.lognormal(1, 0.5)) / Math.exp(0.125));
            m.bySource[`post_${i}`] = { successes: installs, trials: views };
            m.successes += installs;
            m.trials += views;
          }
          return [c.id, observation(c.id, { installsPer1kViews: m })];
        }),
      );
      if (decide(p, obs).decision === "pass") passes++;
    }
    return passes / trials;
  }

  it("passes viral per-view cells at target and rarely at the floor", () => {
    expect(perViewPassRate(config.thresholds.installsPer1kViews.target, 300, 42)).toBeGreaterThanOrEqual(0.7);
    expect(perViewPassRate(config.thresholds.installsPer1kViews.floor, 300, 43)).toBeLessThanOrEqual(0.05);
  });
});
