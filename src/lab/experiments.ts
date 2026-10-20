/**
 * Experiment design and registration (Bier P1, P4, P5, P6).
 *
 * A plan is registered before any spend: hypothesis, one variable, metrics with
 * floor/target/futility, a power-based sample per cell, validity requirements, a budget
 * that must be able to buy that sample, and a hash that freezes all of it.
 */
import { createHash } from "node:crypto";
import type { StudioConfig } from "../config/schema.ts";
import type { AudienceExposure } from "../core/store.ts";
import type {
  CellAssignment,
  ChannelKind,
  DeliveryMode,
  ExperimentPlan,
  Idea,
  Iso,
  MetricKey,
  MetricSpec,
  Platform,
  TestCell,
  ValidationStage,
  ValidityRequirement,
  Venture,
} from "../core/types.ts";
import { assertDisjoint, pickTestGeos } from "./audiences.ts";
import { METRICS, stageMetrics } from "./metrics.ts";
import { futilityStopProbability, requiredSamplePerCell } from "./stats.ts";

/** Hours between registration and first possible exposure, by how the variable ships. */
export const LEAD_HOURS: Record<DeliveryMode, number> = {
  content_only: 0,
  remote_config: 1,
  ota_update: 1,
  store_metadata: 48,
  native_build: 72,
};

/** Planning priors for clustering and unit costs (recalibrated from the studio's own history). */
export const PLANNING = {
  /** Between-source correlation for user-level metrics. */
  userRho: 0.02,
  /** Between-post correlation for per-view metrics (views are extremely clustered). */
  viewRho: 0.0003,
  /** Expected in-geo views per creator post (median views x minimum geo share). */
  inGeoViewsPerPost: 7_500,
  cellsPerExperiment: 3,
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** sha256 over everything that defines the test; operational fields are excluded. */
export function planHash(plan: ExperimentPlan): string {
  const { status: _s, startedAt: _a, decidedAt: _d, registrationHash: _h, ...rest } = plan;
  const frozen = { ...rest, cells: plan.cells.map(({ firstExposureAt: _f, audienceUnits: _u, ...c }) => c) };
  return createHash("sha256").update(canonical(frozen)).digest("hex");
}

export function isFrozenIntact(plan: ExperimentPlan): boolean {
  return planHash(plan) === plan.registrationHash;
}

function addHours(iso: Iso, hours: number): Iso {
  return new Date(new Date(iso).getTime() + hours * 3_600_000).toISOString();
}

/** Read deadline for a cell: first exposure + the plan's read window. */
export function readDeadline(plan: ExperimentPlan, cell: TestCell): Iso | null {
  return cell.firstExposureAt ? addHours(cell.firstExposureAt, plan.readHours) : null;
}

/** Denominator units each cell needs per metric, with a clustering design effect. */
export function sampleSizes(metrics: MetricSpec[], config: StudioConfig): { perMetric: Partial<Record<MetricKey, number>>; powerAtTarget: number; falsePassAtFloor: number } {
  const perMetric: Partial<Record<MetricKey, number>> = {};
  let powerAtTarget = 1;
  let falsePassAtFloor = 0;
  const sources = config.lab.creatorBatch.creatorsPerCell * config.lab.creatorBatch.postsPerCreator;
  for (const m of metrics) {
    const floorUnits = config.lab.minSampleFloor[m.key] ?? 1;
    if (m.role !== "required") {
      perMetric[m.key] = m.unit === "post" && m.denominator === "view" ? floorUnits * PLANNING.inGeoViewsPerPost : floorUnits;
      continue;
    }
    const power = requiredSamplePerCell({
      kind: m.kind,
      floor: m.floor,
      target: m.target,
      cells: PLANNING.cellsPerExperiment,
      confidence: config.lab.confidence,
      power: config.lab.power,
    });
    powerAtTarget = Math.min(powerAtTarget, power.powerAtTarget);
    falsePassAtFloor = Math.max(falsePassAtFloor, power.falsePassAtFloor);
    let n: number;
    if (m.denominator === "view") {
      const designEffect = 1 + (PLANNING.inGeoViewsPerPost - 1) * PLANNING.viewRho;
      n = Math.max(Math.ceil(power.n * designEffect), floorUnits * PLANNING.inGeoViewsPerPost);
    } else if (m.unit === "post") {
      n = Math.max(power.n, floorUnits);
    } else {
      const perSource = power.n / sources;
      const designEffect = 1 + Math.max(0, perSource - 1) * PLANNING.userRho;
      n = Math.max(Math.ceil(power.n * designEffect), floorUnits);
    }
    perMetric[m.key] = n;
  }
  return { perMetric, powerAtTarget, falsePassAtFloor };
}

/** Planning cost of one denominator unit, in cents. */
export function costPerUnitCents(m: MetricSpec, channel: ChannelKind, config: StudioConfig): number {
  const cpi = config.economics.cpiPriorCents[channel] ?? config.economics.cpiPriorCents.creator_ugc ?? 120;
  const deal = config.creators.defaultDeal;
  switch (m.denominator) {
    case "view":
      return deal.cpmCents / 1000 + deal.flatFeeCents / PLANNING.inGeoViewsPerPost;
    case "post":
      return 0;
    case "install":
    case "d1_eligible":
      return cpi;
    case "activated":
      return cpi / Math.max(0.05, config.thresholds.activationRate.target);
    default:
      // trial-based denominators
      return cpi / Math.max(0.02, config.thresholds.trialStartRate.target);
  }
}

export interface DesignInput {
  experimentId: string;
  /** Pre-generated globally unique cell ids (at least 3). */
  cellIds: string[];
  venture: Venture;
  idea: Idea;
  stages: ValidationStage[];
  hypothesis: string;
  variableUnderTest: string;
  variant: Record<string, string | number | boolean>;
  deliveryMode: DeliveryMode;
  config: StudioConfig;
  now: Iso;
  exposures: AudienceExposure[];
  channel?: ChannelKind;
  /** Re-run in specific storefronts (fix_harness). */
  geos?: string[];
  parentExperimentId?: string;
}

export type DesignResult = { ok: true; plan: ExperimentPlan } | { ok: false; reason: string };

/** Register a parallel three-storefront experiment for a ladder step. */
export function designExperiment(input: DesignInput): DesignResult {
  const { config, venture, idea } = input;
  const channel = input.channel ?? "creator_ugc";
  if (!Object.keys(input.variant).includes(input.variableUnderTest) || Object.keys(input.variant).length !== 1) {
    return { ok: false, reason: `variant must contain exactly the variable under test (${input.variableUnderTest})` };
  }
  const metrics = stageMetrics(input.stages, config);
  const cellsNeeded = PLANNING.cellsPerExperiment;
  const geos =
    input.geos ??
    pickTestGeos({
      wedge: idea.wedge.name,
      locale: idea.wedge.locale,
      channel,
      count: cellsNeeded,
      ventureId: venture.id,
      config,
      exposures: input.exposures,
      now: input.now,
    });
  if (geos.length < cellsNeeded && !input.geos) {
    return { ok: false, reason: `only ${geos.length} fresh test storefronts for ${idea.wedge.locale}; need ${cellsNeeded}` };
  }
  if (input.cellIds.length < geos.length) return { ok: false, reason: "not enough cell ids" };

  const sizes = sampleSizes(metrics, config);
  const required = metrics.filter((m) => m.role === "required");
  const costs = required.map((m) => (sizes.perMetric[m.key] ?? 0) * costPerUnitCents(m, channel, config));
  const binding = Math.max(0, ...costs);
  const cellBudgetCents = Math.ceil(binding * 1.25);
  if (cellBudgetCents > config.budgets.maxCellBudgetCents) {
    return { ok: false, reason: `infeasible: a cell needs ~${cellBudgetCents}c for its sample, above maxCellBudgetCents ${config.budgets.maxCellBudgetCents}c` };
  }
  const bindingMetric = required[costs.indexOf(binding)] ?? required[0];

  const assignment: CellAssignment = "geo";
  const cells: TestCell[] = geos.map((geo, i) => ({
    id: input.cellIds[i] as string,
    phase: 1,
    role: i === 0 ? "primary" : "replication",
    platform: "app" as Platform | "app",
    channel,
    geo,
    locale: idea.wedge.locale,
    assignment,
    attribution: "storefront_geo",
    audienceUnits: [],
    variant: input.variant,
    budgetCents: cellBudgetCents,
  }));
  const disjoint = assertDisjoint(cells);
  if (disjoint.length) return { ok: false, reason: disjoint.join("; ") };

  // Creator posts go up across a posting window and what they bring needs to mature before it counts
  // (views, installs, invites), so a creator-staffed read covers the whole window (otherwise only the
  // first posts decide).
  const maturity = Math.max(0, ...metrics.map((m) => m.maturityHours));
  const postingWindow = channel === "creator_ugc" ? config.lab.creatorPostingWindowHours + maturity : 0;
  const readHours = Math.max(postingWindow, ...input.stages.map((s) => config.lab.readHours[s] ?? 96));
  const validity: ValidityRequirement[] = [
    { id: "exposure_delivered", description: "Each cell starts receiving traffic within the exposure SLA", threshold: config.lab.maxHoursToFirstExposure },
    { id: "min_sample", description: "Each required metric reaches its registered sample by the read deadline" },
    { id: "instrumentation", description: "Numerators never exceed denominators; funnel events present" },
    { id: "cold_traffic", description: "Internal/test sessions at most 5% of sessions", threshold: 0.05 },
    { id: "source_concentration", description: `At least ${config.lab.minSources} sources, none above ${config.lab.maxSourceShare * 100}% of the denominator`, threshold: config.lab.maxSourceShare },
    { id: "budget_not_exceeded", description: "Cell spend at most 110% of its budget", threshold: 1.1 },
    { id: "audience_disjoint", description: "Cells share no storefront or audience unit" },
  ];

  const plan: ExperimentPlan = {
    id: input.experimentId,
    ventureId: venture.id,
    stages: input.stages,
    hypothesis: input.hypothesis,
    variableUnderTest: input.variableUnderTest,
    baseline: venture.baseline,
    metrics,
    cells,
    mode: "parallel",
    minSamplePerCell: sizes.perMetric,
    operatingCharacteristics: { powerAtTarget: sizes.powerAtTarget, falsePassAtFloor: sizes.falsePassAtFloor },
    readHours,
    maxHoursToFirstExposure: config.lab.maxHoursToFirstExposure,
    maxBudgetCents: cellBudgetCents * cells.length,
    expectedCostPerUnitCents: bindingMetric ? costPerUnitCents(bindingMetric, channel, config) : 0,
    validity,
    deliveryMode: input.deliveryMode,
    startNotBefore: addHours(input.now, LEAD_HOURS[input.deliveryMode]),
    status: "registered",
    registeredAt: input.now,
    registrationHash: "",
  };
  if (input.parentExperimentId) plan.parentExperimentId = input.parentExperimentId;
  plan.registrationHash = planHash(plan);
  return { ok: true, plan };
}

/**
 * S0 attention probe: one owned brand account posting trial reels while the app is built.
 * Kill-only: a futile hit rate kills the concept; anything else lets the build continue. Its
 * operating characteristics are survival probabilities under the futility rule with a look at
 * every matured post: powerAtTarget = P(not killed | target), falsePassAtFloor = P(not killed | floor).
 */
export function designAttentionProbe(input: {
  experimentId: string;
  cellId: string;
  venture: Venture;
  idea: Idea;
  accountId: string;
  config: StudioConfig;
  now: Iso;
}): ExperimentPlan {
  const metrics = stageMetrics(["S0_attention"], input.config);
  const posts = input.config.lab.attentionProbe.posts;
  const hit = input.config.thresholds.attentionHitRate;
  const survives = (p: number) =>
    1 - futilityStopProbability({ p, n: posts, firstLook: Math.ceil(0.5 * posts), floor: hit.floor, futility: hit.futility, confidence: input.config.lab.confidence });
  const plan: ExperimentPlan = {
    id: input.experimentId,
    ventureId: input.venture.id,
    stages: ["S0_attention"],
    hypothesis: `Hooks for ${input.idea.title} earn attention from cold ${input.idea.wedge.name} audiences`,
    variableUnderTest: "hooks",
    baseline: input.venture.baseline,
    metrics,
    cells: [
      {
        id: input.cellId,
        phase: 1,
        role: "primary",
        platform: "instagram",
        channel: "owned_social",
        geo: input.config.lab.testGeos[0] ?? "CA",
        locale: input.idea.wedge.locale,
        assignment: "geo",
        attribution: "campaign_link",
        audienceUnits: [input.accountId],
        variant: { hooks: "baseline" },
        budgetCents: 0,
      },
    ],
    mode: "sequential",
    minSamplePerCell: { attentionHitRate: posts },
    operatingCharacteristics: { powerAtTarget: survives(hit.target), falsePassAtFloor: survives(hit.floor) },
    readHours: input.config.lab.readHours.S0_attention ?? 72,
    maxHoursToFirstExposure: input.config.lab.maxHoursToFirstExposure,
    maxBudgetCents: 0,
    expectedCostPerUnitCents: 0,
    validity: [
      { id: "exposure_delivered", description: "Posts go live within the exposure SLA", threshold: input.config.lab.maxHoursToFirstExposure },
      { id: "min_sample", description: `${posts} posts published` },
    ],
    deliveryMode: "content_only",
    startNotBefore: input.now,
    status: "registered",
    registeredAt: input.now,
    registrationHash: "",
  };
  plan.registrationHash = planHash(plan);
  return plan;
}

/** Definition lookup re-exported for callers that only hold a MetricSpec. */
export function metricDefinition(key: MetricKey) {
  return METRICS[key];
}
