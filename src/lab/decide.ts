/**
 * Reading experiments (Bier P5, P6).
 *
 * A cell is read once every required metric reaches its registered sample, or at the read
 * deadline, whichever comes first: pass iff P(p >= floor) >= confidence, otherwise a valid
 * failure ("if there's any uncertainty, it's not working"). Before that, the only early
 * stop is futility. A cell that breaks a validity precondition is invalid: a harness bug,
 * never evidence about the product.
 *
 * Experiment table over active cells:
 *   any pending                         -> continue
 *   all pass (and S4 economics hold)    -> pass
 *   none pass, and >= 2 fail or any futile -> variant failed
 *   mixed pass/fail(or futile)          -> fix_harness on flagged cells, else variant failed
 *   invalid cells, outcome undetermined -> fix_harness on those cells
 * A failed variant iterates until the step's iteration cap, then kills. Harness fixes past
 * their cap escalate to a human instead of looping.
 */
import type { PriceLadderEntry, StudioConfig } from "../config/schema.ts";
import type { Rng } from "../core/rng.ts";
import type {
  CellDecision,
  CellObservation,
  CellVerdict,
  ExperimentDecision,
  ExperimentOutcome,
  ExperimentPlan,
  Iso,
  MetricCounts,
  MetricSpec,
  MetricVerdict,
  StorePlatform,
  TestCell,
  ValidityCheckId,
  VentureLadder,
} from "../core/types.ts";
import { readDeadline } from "./experiments.ts";
import { cellEconomics, type CellEconomics } from "./ltv.ts";
import {
  credibleInterval,
  effectiveCounts,
  posteriorMean,
  probAtLeast,
  probBelow,
  proportionPosterior,
  ratePosterior,
  type Posterior,
} from "./stats.ts";

const EMPTY: MetricCounts = { successes: 0, trials: 0, bySource: {} };

function hoursBetween(a: Iso, b: Iso): number {
  return (new Date(b).getTime() - new Date(a).getTime()) / 3_600_000;
}

function posteriorFor(m: MetricSpec, counts: MetricCounts): { post: Posterior; nEffective: number } {
  // Per-view metrics join two sources (storefront installs over in-geo post views), so early on installs
  // can outrun counted views; the posterior caps successes at trials instead of treating that as breakage.
  const successes = m.kind === "proportion" ? Math.min(counts.successes, counts.trials) : counts.successes;
  const eff = effectiveCounts({ successes, trials: counts.trials }, counts.bySource);
  const post = m.kind === "rate" ? ratePosterior(eff.successes, eff.trials, m.floor) : proportionPosterior(eff.successes, eff.trials, m.floor);
  return { post, nEffective: eff.trials };
}

function sourceProblem(counts: MetricCounts, config: StudioConfig): { kind: "few_sources" | "concentrated"; detail: string } | null {
  const sources = Object.values(counts.bySource).filter((s) => s.trials > 0);
  if (sources.length < config.lab.minSources) return { kind: "few_sources", detail: `${sources.length} sources (< ${config.lab.minSources})` };
  const top = Math.max(...sources.map((s) => s.trials));
  const share = counts.trials > 0 ? top / counts.trials : 1;
  if (share > config.lab.maxSourceShare) return { kind: "concentrated", detail: `top source is ${(share * 100).toFixed(0)}% of the denominator` };
  return null;
}

/** Counts with the largest traffic source removed (leave-one-out robustness). */
function withoutTopSource(k: MetricCounts): MetricCounts {
  const entries = Object.entries(k.bySource);
  const top = entries.reduce<[string, { successes: number; trials: number }] | null>((best, e) => (!best || e[1].trials > best[1].trials ? e : best), null);
  if (!top) return k;
  const bySource = Object.fromEntries(entries.filter(([id]) => id !== top[0]));
  return { ...k, successes: Math.max(0, k.successes - top[1].successes), trials: Math.max(0, k.trials - top[1].trials), bySource };
}

export interface CellEvalInput {
  plan: ExperimentPlan;
  cell: TestCell;
  obs?: CellObservation;
  config: StudioConfig;
  now: Iso;
  /** When this cell's exposure SLA started (plan.startedAt, or the replication time for phase 2). */
  clockStart: Iso;
}

export function evaluateCell(i: CellEvalInput): CellVerdict {
  const { plan, cell, obs, config, now } = i;
  const c = config.lab.confidence;
  const validity: CellVerdict["validity"] = [];
  const verdict = (decision: CellDecision, perMetric: CellVerdict["perMetric"] = {}): CellVerdict => ({
    cellId: cell.id,
    decision,
    perMetric,
    validity,
  });

  if (!cell.firstExposureAt) {
    const late = hoursBetween(i.clockStart, now) > plan.maxHoursToFirstExposure;
    validity.push({ id: "exposure_delivered", passed: !late, detail: late ? `no exposure ${plan.maxHoursToFirstExposure}h after start` : "awaiting first exposure" });
    return verdict(late ? "invalid" : "pending");
  }
  validity.push({ id: "exposure_delivered", passed: true, detail: `first exposure ${cell.firstExposureAt}` });

  const deadline = readDeadline(plan, cell) as Iso;
  const atDeadline = now >= deadline;
  const counts = (m: MetricSpec) => obs?.metrics[m.key] ?? EMPTY;
  const required = plan.metrics.filter((m) => m.role === "required");
  const sampleReached = required.every((m) => counts(m).trials >= (plan.minSamplePerCell[m.key] ?? 1));
  const decideNow = atDeadline || (required.length > 0 && sampleReached);

  // Instrumentation is checked continuously: impossible counts are never a product signal.
  const broken = plan.metrics.filter((m) => {
    const k = counts(m);
    return k.successes < 0 || k.trials < 0 || (m.kind === "proportion" && m.unit === "user" && k.successes > k.trials);
  });
  validity.push({
    id: "instrumentation",
    passed: broken.length === 0,
    detail: broken.length ? `impossible counts for ${broken.map((m) => m.key).join(", ")}` : "consistent",
  });
  if (broken.length) return verdict("invalid");

  const perMetric: CellVerdict["perMetric"] = {};
  let futile = false;
  for (const m of plan.metrics) {
    const k = counts(m);
    const minN = plan.minSamplePerCell[m.key] ?? 1;
    const { post, nEffective } = posteriorFor(m, k);
    const pAtLeastFloor = probAtLeast(post, m.floor);
    const isFutile =
      m.role !== "informational" && k.trials >= 0.5 * minN && (pAtLeastFloor < 0.05 || probBelow(post, m.futility) >= c);
    let decision: CellDecision;
    if (isFutile) decision = "futile";
    else if (!decideNow) decision = "pending";
    else if (m.role === "futility_only") decision = "pass";
    else decision = pAtLeastFloor >= c ? "pass" : "fail";
    if (isFutile) futile = true;
    const mv: MetricVerdict = {
      decision,
      estimate: posteriorMean(post),
      interval: credibleInterval(post, 2 * c - 1),
      pAtLeastFloor,
      nEffective,
    };
    perMetric[m.key] = mv;
  }

  if (!decideNow && !futile) return verdict("pending", perMetric);

  // Preconditions that only make sense once the cell is being read.
  const internal = obs?.internalShare ?? 0;
  validity.push({ id: "cold_traffic", passed: internal <= 0.05, detail: `internal share ${(internal * 100).toFixed(1)}%` });
  const spend = obs?.spendCents ?? 0;
  const overBudget = cell.budgetCents > 0 && spend > cell.budgetCents * 1.1;
  validity.push({ id: "budget_not_exceeded", passed: !overBudget, detail: `spend ${spend}c of ${cell.budgetCents}c` });
  // Virality makes one post carry most of a cell's traffic. That only invalidates the read when the
  // verdict depends on it: drop the top source and check the pass/fail call is unchanged.
  const concentration = required
    .map((m) => {
      const k = counts(m);
      const problem = sourceProblem(k, config);
      if (!problem || problem.kind === "few_sources") return [m.key, problem?.detail ?? null] as const;
      const passes = (x: MetricCounts) => probAtLeast(posteriorFor(m, x).post, m.floor) >= c;
      return [m.key, passes(k) === passes(withoutTopSource(k)) ? null : `${problem.detail} and the read depends on it`] as const;
    })
    .filter(([, p]) => p);
  validity.push({
    id: "source_concentration",
    passed: concentration.length === 0,
    detail: concentration.length ? concentration.map(([k, p]) => `${k}: ${p}`).join("; ") : "diverse",
  });
  // A metric short of its planned sample still decides at the deadline when its posterior is conclusive
  // (P6: under-delivered traffic is a harness problem only when it leaves the answer open). A conclusive
  // fail counts at any sample; a pass needs at least half the planned sample so winners stay well powered.
  const minN = (m: MetricSpec) => plan.minSamplePerCell[m.key] ?? 1;
  const isShort = (m: MetricSpec) => counts(m).trials < minN(m);
  const conclusiveFail = (m: MetricSpec) => probBelow(posteriorFor(m, counts(m)).post, m.floor) >= c;
  const conclusive = (m: MetricSpec) => ((perMetric[m.key]?.pAtLeastFloor ?? 0) >= c && counts(m).trials >= 0.5 * minN(m)) || conclusiveFail(m);
  const short = futile ? [] : required.filter(isShort);
  const open = short.filter((m) => !conclusive(m));
  const decidedFail = required.some((m) => (isShort(m) ? conclusiveFail(m) : perMetric[m.key]?.decision === "fail"));
  validity.push({
    id: "min_sample",
    passed: open.length === 0 || decidedFail,
    detail: short.length ? `${short.map((m) => `${m.key} ${counts(m).trials}/${plan.minSamplePerCell[m.key]}`).join(", ")}${open.length ? "" : " (conclusive)"}` : "reached",
  });

  if (internal > 0.05 || overBudget || concentration.length) return verdict("invalid", perMetric);
  if (futile) return verdict("futile", perMetric);
  if (decidedFail) return verdict("fail", perMetric);
  if (open.length) return verdict("invalid", perMetric);
  const requiredDecisions = required.map((m) => perMetric[m.key]?.decision);
  if (requiredDecisions.every((d) => d === "pass")) return verdict("pass", perMetric);
  return verdict("fail", perMetric);
}

/** Look for confounds behind a mixed result: cells that differ from their peers for non-product reasons. */
export function diagnose(plan: ExperimentPlan, verdicts: CellVerdict[], observations: Map<string, CellObservation>): { id: ValidityCheckId; cellId: string; detail: string }[] {
  const flags: { id: ValidityCheckId; cellId: string; detail: string }[] = [];
  const cells = verdicts.map((v) => v.cellId);
  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
  };
  for (const m of plan.metrics.filter((x) => x.role === "required" && x.unit === "user")) {
    const rates = cells.map((id) => {
      const k = observations.get(id)?.metrics[m.key];
      return k && k.trials > 0 ? k.successes / k.trials : 0;
    });
    cells.forEach((id, idx) => {
      const others = rates.filter((_, j) => j !== idx);
      const ref = median(others);
      if (ref > 0 && (rates[idx] as number) < 0.3 * ref) {
        flags.push({ id: "instrumentation", cellId: id, detail: `${m.key} ${(rates[idx] as number).toFixed(3)} vs peers ${ref.toFixed(3)}` });
      }
    });
    const trials = cells.map((id) => observations.get(id)?.metrics[m.key]?.trials ?? 0);
    const max = Math.max(...trials);
    cells.forEach((id, idx) => {
      if (max > 0 && (trials[idx] as number) < 0.4 * max) flags.push({ id: "exposure_delivered", cellId: id, detail: `${m.key} sample ${trials[idx]} vs max ${max}` });
    });
  }
  for (const id of cells) {
    const internal = observations.get(id)?.internalShare ?? 0;
    if (internal > 0.03) flags.push({ id: "cold_traffic", cellId: id, detail: `internal share ${(internal * 100).toFixed(1)}%` });
  }
  const seen = new Set<string>();
  return flags.filter((f) => {
    const key = `${f.id}:${f.cellId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Pool S4 counts across cells and read predicted D60 ROAS at the 20th percentile. */
export function experimentEconomics(opts: {
  plan: ExperimentPlan;
  observations: Map<string, CellObservation>;
  cellIds: string[];
  pricing: { entry: PriceLadderEntry; platform: StorePlatform };
  config: StudioConfig;
  rng: Rng;
}): CellEconomics {
  const sum = (key: "trialStartRate" | "trialKeep24h") =>
    opts.cellIds.reduce(
      (acc, id) => {
        const k = opts.observations.get(id)?.metrics[key];
        return { successes: acc.successes + (k?.successes ?? 0), trials: acc.trials + (k?.trials ?? 0) };
      },
      { successes: 0, trials: 0 },
    );
  const ts = sum("trialStartRate");
  const keep = sum("trialKeep24h");
  const spend = opts.cellIds.reduce((s, id) => s + (opts.observations.get(id)?.spendCents ?? 0), 0);
  const geo = opts.plan.cells.find((c) => c.id === opts.cellIds[0])?.geo ?? "US";
  return cellEconomics({
    trialStart: { ...ts, prior: opts.config.thresholds.trialStartRate.floor },
    keep24: { ...keep, prior: opts.config.thresholds.trialKeep24h.floor },
    entry: opts.pricing.entry,
    geo,
    platform: opts.pricing.platform,
    config: opts.config,
    rng: opts.rng,
    spendCents: spend,
    installs: ts.trials,
  });
}

export interface DecideInput {
  plan: ExperimentPlan;
  verdicts: CellVerdict[];
  observations: Map<string, CellObservation>;
  ladder: VentureLadder;
  config: StudioConfig;
  now: Iso;
  previousOutcomes: ExperimentOutcome[];
  /** Required for S4 economics; when absent the economic read is skipped and noted. */
  pricing?: { entry: PriceLadderEntry; platform: StorePlatform };
  rng: Rng;
}

/** Cells taking part in the current read (sequential plans hold phase 2 until replication). */
export function activeCells(plan: ExperimentPlan, previousOutcomes: ExperimentOutcome[]): TestCell[] {
  const replicated = previousOutcomes.some((o) => o.decision === "replicate");
  return plan.mode === "sequential" && !replicated ? plan.cells.filter((c) => c.phase === 1) : plan.cells;
}

export function decideExperiment(i: DecideInput): ExperimentOutcome {
  const { plan, config, ladder } = i;
  const active = new Set(activeCells(plan, i.previousOutcomes).map((c) => c.id));
  const verdicts = i.verdicts.filter((v) => active.has(v.cellId));
  const outcome = (decision: ExperimentDecision, rationale: string, extra: Partial<ExperimentOutcome> = {}): ExperimentOutcome => ({
    experimentId: plan.id,
    decision,
    cells: i.verdicts,
    rationale,
    decidedAt: i.now,
    ...extra,
  });
  const failVariant = (why: string, extra: Partial<ExperimentOutcome> = {}) =>
    ladder.iteration + 1 >= config.lab.maxIterationsPerStep
      ? outcome("kill", `${why}; iteration cap (${config.lab.maxIterationsPerStep}) reached`, extra)
      : outcome("iterate", why, extra);
  const fixHarness = (cellIds: string[], why: string, diagnostics?: ExperimentOutcome["diagnostics"]) =>
    ladder.harnessFixes + 1 > config.lab.maxHarnessFixesPerStep
      ? outcome("escalate", `${why}; harness fixes exhausted, a human must look`, { rerunCellIds: cellIds, ...(diagnostics ? { diagnostics } : {}) })
      : outcome("fix_harness", why, { rerunCellIds: cellIds, ...(diagnostics ? { diagnostics } : {}) });

  if (verdicts.some((v) => v.decision === "pending")) return outcome("continue", "cells still collecting data");

  const invalid = verdicts.filter((v) => v.decision === "invalid");
  const valid = verdicts.filter((v) => v.decision !== "invalid");
  const passed = valid.filter((v) => v.decision === "pass");
  const futile = valid.filter((v) => v.decision === "futile");
  const failed = valid.filter((v) => v.decision === "fail" || v.decision === "futile");

  // S0 attention probe: kill-only.
  if (plan.stages.length === 1 && plan.stages[0] === "S0_attention") {
    if (futile.length) return outcome("kill", "hooks earned no attention from cold audiences (S0 futility)");
    if (invalid.length) return fixHarness(invalid.map((v) => v.cellId), "attention probe could not be read");
    return outcome("pass", "attention probe found no reason to stop");
  }

  // Sequential plans: a phase-1 pass releases the pre-registered replication cells.
  const hasPhase2 = plan.cells.some((c) => c.phase === 2);
  if (plan.mode === "sequential" && hasPhase2 && !i.previousOutcomes.some((o) => o.decision === "replicate")) {
    if (invalid.length) return fixHarness(invalid.map((v) => v.cellId), "primary cell invalid");
    if (passed.length === verdicts.length) return outcome("replicate", "primary cell passed; activating replication cells");
    return failVariant("primary cell did not pass");
  }

  if (invalid.length === 0 && passed.length === verdicts.length && verdicts.length > 0) {
    if (plan.stages.includes("S4_monetization")) {
      if (!i.pricing) return outcome("pass", "all cells passed (economics not evaluated: no pricing given)");
      const econ = experimentEconomics({ plan, observations: i.observations, cellIds: [...active], pricing: i.pricing, config, rng: i.rng });
      const unitEconomics = { predNetRpiD60P20Cents: econ.predNetRpiD60P20Cents, cacCents: econ.cacCents, roasD60P20: econ.roasD60P20 };
      if (econ.roasD60P20 < config.lab.s4MinRoasD60P20) {
        return failVariant(
          `conversion passed but unit economics did not: p20 D60 ROAS ${econ.roasD60P20.toFixed(2)} < ${config.lab.s4MinRoasD60P20}`,
          { unitEconomics },
        );
      }
      return outcome("pass", `all ${verdicts.length} cells passed; p20 D60 ROAS ${econ.roasD60P20.toFixed(2)}`, { unitEconomics });
    }
    return outcome("pass", `all ${verdicts.length} cells passed`);
  }

  // Futility only fails fast when no peer passed; futility next to a pass is a confound signal.
  if (passed.length === 0 && (failed.length >= 2 || futile.length > 0)) {
    return failVariant(futile.length ? `futility in ${futile.map((v) => v.cellId).join(", ")}` : `failed in ${failed.length} matched storefronts`);
  }

  if (passed.length > 0 && failed.length > 0) {
    const flags = diagnose(plan, valid, i.observations);
    if (flags.length) {
      return fixHarness([...new Set(flags.map((f) => f.cellId))], "mixed result with confounds; re-running flagged cells", flags.map((f) => ({ id: f.id, detail: `${f.cellId}: ${f.detail}` })));
    }
    return failVariant("mixed result without a confound: uncertainty means it is not working");
  }

  if (invalid.length) return fixHarness(invalid.map((v) => v.cellId), `${invalid.length} cell(s) invalid`);
  return failVariant("no cell passed");
}
