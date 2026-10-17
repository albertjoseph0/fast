/**
 * The single registry of experiment metrics: event pairs, kinds, sampling units and
 * maturity. Thresholds come from config; everything else is fixed here so the simulator,
 * the PostHog adapter and the lab can never disagree on a definition.
 */
import type { StudioConfig } from "../config/schema.ts";
import { EV, type EventName } from "../core/events.ts";
import type { MetricKey, MetricKind, MetricSpec, ValidationStage } from "../core/types.ts";

export interface MetricDefinition {
  label: string;
  kind: MetricKind;
  numerator: EventName;
  denominator: EventName;
  unit: "user" | "post";
  maturityHours: number;
  windowHours?: number;
  displayScale?: number;
}

export const METRICS: Record<MetricKey, MetricDefinition> = {
  attentionHitRate: {
    label: `Owned posts reaching the attention threshold`,
    kind: "proportion",
    numerator: EV.postHit,
    denominator: EV.post,
    unit: "post",
    maturityHours: 48,
  },
  installsPer1kViews: {
    label: "In-storefront installs per 1K in-geo views",
    kind: "proportion",
    numerator: EV.install,
    denominator: EV.view,
    unit: "post",
    maturityHours: 48,
    displayScale: 1000,
  },
  activationRate: {
    label: "Installs reaching the value preview",
    kind: "proportion",
    numerator: EV.activated,
    denominator: EV.install,
    unit: "user",
    maturityHours: 24,
    windowHours: 24,
  },
  trialStartRate: {
    label: "Installs starting a trial or buying",
    kind: "proportion",
    numerator: EV.trialStart,
    denominator: EV.install,
    unit: "user",
    maturityHours: 24,
    windowHours: 72,
  },
  trialKeep24h: {
    label: "Trials still auto-renewing 24h after start",
    kind: "proportion",
    numerator: EV.trialKept24h,
    denominator: EV.trialMatured24h,
    unit: "user",
    maturityHours: 0,
  },
  trialToPaid: {
    label: "Matured trials converting to paid",
    kind: "proportion",
    numerator: EV.conversion,
    denominator: EV.trialMatured,
    unit: "user",
    maturityHours: 0,
  },
  shareRate: {
    label: "Activated users who shared the artifact",
    kind: "proportion",
    numerator: EV.shareFirst,
    denominator: EV.activated,
    unit: "user",
    maturityHours: 24,
    windowHours: 72,
  },
  kFactor: {
    label: "Invite-driven installs per activated user (7d)",
    kind: "rate",
    numerator: EV.inviteInstall,
    denominator: EV.activated,
    unit: "user",
    maturityHours: 168,
    windowHours: 168,
  },
  d1Retention: {
    label: "Day-1 retention",
    kind: "proportion",
    numerator: EV.d1Retained,
    denominator: EV.d1Eligible,
    unit: "user",
    maturityHours: 0,
  },
};

type Role = MetricSpec["role"];

/** Metrics measured by each validation stage, with their role in the decision. */
export const STAGE_METRICS: Record<ValidationStage, { key: MetricKey; role: Role }[]> = {
  S0_attention: [{ key: "attentionHitRate", role: "futility_only" }],
  S1_distribution: [{ key: "installsPer1kViews", role: "required" }],
  S1_activation: [
    { key: "activationRate", role: "required" },
    { key: "d1Retention", role: "informational" },
  ],
  S2_sharing: [{ key: "shareRate", role: "required" }],
  S3_cross_cell: [{ key: "kFactor", role: "required" }],
  S4_monetization: [
    { key: "trialStartRate", role: "required" },
    { key: "trialKeep24h", role: "futility_only" },
    { key: "trialToPaid", role: "informational" },
  ],
};

export function metricSpec(key: MetricKey, role: Role, config: StudioConfig): MetricSpec {
  const def = METRICS[key];
  const t = config.thresholds[key];
  const spec: MetricSpec = {
    key,
    label: def.label,
    kind: def.kind,
    numerator: def.numerator,
    denominator: def.denominator,
    unit: def.unit,
    maturityHours: def.maturityHours,
    role,
    floor: t.floor,
    target: t.target,
    futility: t.futility,
  };
  if (def.windowHours !== undefined) spec.windowHours = def.windowHours;
  if (def.displayScale !== undefined) spec.displayScale = def.displayScale;
  return spec;
}

/** All metric specs for a set of stages, de-duplicated by key (strongest role wins). */
export function stageMetrics(stages: ValidationStage[], config: StudioConfig): MetricSpec[] {
  const rank: Record<Role, number> = { required: 3, futility_only: 2, informational: 1 };
  const chosen = new Map<MetricKey, Role>();
  for (const stage of stages) {
    for (const { key, role } of STAGE_METRICS[stage]) {
      const current = chosen.get(key);
      if (!current || rank[role] > rank[current]) chosen.set(key, role);
    }
  }
  return [...chosen.entries()].map(([key, role]) => metricSpec(key, role, config));
}
