/**
 * Analyst: explains an experiment outcome. The facts (decision, per-cell estimates against
 * the floor, validity failures) are written by code; Claude adds one short interpretation.
 */
import type { AgentContext } from "../core/context.ts";
import type { CellVerdict, ExperimentOutcome, ExperimentPlan, MetricKey, MetricSpec } from "../core/types.ts";
import { rolePrompt, truncate } from "./shared.ts";

const NOTE_MAX = 600;

const SYSTEM = rolePrompt(
  "You are the analyst of an app studio that runs pre-registered, binary experiments on live apps in small test storefronts.",
  [
    "Explain results in plain language for a busy founder. Do not restate numbers already given.",
    "Name the most likely cause of the result and the single variable worth changing next.",
    "A failed or futile cell means the variant did not work; an invalid cell is a harness bug, not evidence about the product.",
    "Never call a mixed or inconclusive result a win.",
  ],
);

/** Deterministic outcome summary plus a short LLM note. */
export async function explainOutcome(ctx: AgentContext, opts: { plan: ExperimentPlan; outcome: ExperimentOutcome }): Promise<string> {
  const summary = outcomeSummary(opts.plan, opts.outcome);
  const note = await ctx.ports.llm.text({
    role: "analyst",
    system: SYSTEM,
    instructions: "In at most two sentences: what most likely explains this result, and what single variable should change next?",
    input: { summary, hypothesis: opts.plan.hypothesis, variableUnderTest: opts.plan.variableUnderTest, decision: opts.outcome.decision },
    ventureId: opts.plan.ventureId,
    purpose: "outcome_explanation",
    effort: "low",
  });
  const trimmed = truncate(note.trim(), NOTE_MAX);
  return trimmed ? `${summary}\n\nAnalyst note: ${trimmed}` : summary;
}

/** Decision, rationale, per-cell metric estimates vs floors, validity failures and unit economics. */
export function outcomeSummary(plan: ExperimentPlan, outcome: ExperimentOutcome): string {
  const specs = new Map<MetricKey, MetricSpec>(plan.metrics.map((m) => [m.key, m]));
  const cells = new Map(plan.cells.map((c) => [c.id, c]));
  const lines = [
    `Experiment ${plan.id} (${plan.stages.join(" + ")}; variable: ${plan.variableUnderTest}): ${outcome.decision.toUpperCase()}.`,
    outcome.rationale.trim(),
  ].filter(Boolean);

  for (const verdict of outcome.cells) {
    const cell = cells.get(verdict.cellId);
    const where = cell ? `${cell.geo}, ${cell.role}${cell.phase === 2 ? ", phase 2" : ""}` : "unregistered";
    lines.push(`- Cell ${verdict.cellId} (${where}): ${verdict.decision}.`);
    lines.push(...metricLines(verdict, specs));
    const failed = verdict.validity.filter((v) => !v.passed);
    if (failed.length > 0) lines.push(`  validity failed: ${failed.map((v) => `${v.id} (${v.detail})`).join("; ")}`);
  }
  if (outcome.diagnostics?.length) lines.push(`Diagnostics: ${outcome.diagnostics.map((d) => `${d.id}: ${d.detail}`).join("; ")}.`);
  if (outcome.rerunCellIds?.length) lines.push(`Re-run cells: ${outcome.rerunCellIds.join(", ")}.`);
  const ue = outcome.unitEconomics;
  if (ue) {
    lines.push(`Unit economics: p20 net D60 revenue per install ${cents(ue.predNetRpiD60P20Cents)} vs CAC ${cents(ue.cacCents)} (ROAS D60 p20 ${ue.roasD60P20.toFixed(2)}).`);
  }
  return lines.join("\n");
}

function metricLines(verdict: CellVerdict, specs: Map<MetricKey, MetricSpec>): string[] {
  const out: string[] = [];
  for (const [key, m] of Object.entries(verdict.perMetric) as [MetricKey, NonNullable<CellVerdict["perMetric"][MetricKey]>][]) {
    const spec = specs.get(key);
    const scale = spec?.displayScale ?? 1;
    const unit = scale === 1000 ? " per 1K" : "";
    const floor = spec ? ` vs floor ${num(spec.floor * scale)}${unit}` : "";
    out.push(
      `  ${spec?.label ?? key}: ${num(m.estimate * scale)}${unit}${floor} [${num(m.interval[0] * scale)}, ${num(m.interval[1] * scale)}], ` +
        `P(>= floor) ${m.pAtLeastFloor.toFixed(2)}, n_eff ${Math.round(m.nEffective)}: ${m.decision}`,
    );
  }
  return out;
}

function num(x: number): string {
  if (!Number.isFinite(x)) return String(x);
  return Number(x.toPrecision(3)).toString();
}

function cents(c: number): string {
  return `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toFixed(2)}`;
}
