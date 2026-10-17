/**
 * The daily report (deterministic markdown) and the weekly board memo (LLM, role ceo).
 * Reports are written under <dataDir>/reports; nothing here has external side effects.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BoardMemo } from "../agents/schemas.ts";
import type { TickContext } from "../core/context.ts";
import type { AllocationPlan, Venture } from "../core/types.ts";
import type { LedgerSync } from "../governance/ledger.ts";
import type { StudioDeps } from "./deps.ts";
import { testingDays } from "./lifecycle.ts";

const usd = (cents: number) => `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

export interface TickSummary {
  date: string;
  tick: number;
  skipped: boolean;
  phases: { name: string; detail: string; ms: number; error?: string }[];
  cashCents: number;
  freeCashCents: number;
  ventures: { id: string; name: string; stage: string; detail: string }[];
  proposed: number;
  executed: number;
  awaitingApproval: number;
  openTasks: number;
  errors: string[];
  reportPath?: string;
  memo?: BoardMemo;
}

function ventureDetail(ctx: TickContext, v: Venture): string {
  const parts: string[] = [];
  const step = v.ladder.steps[v.ladder.stepIndex];
  if (step) parts.push(`step ${v.ladder.stepIndex + 1}/${v.ladder.steps.length} ${step.join("+")}`);
  else if (v.ladder.steps.length) parts.push("ladder complete");
  if (v.ladder.iteration) parts.push(`iteration ${v.ladder.iteration}`);
  if (v.ladder.currentExperimentId) {
    const plan = ctx.store.experiments.get(v.ladder.currentExperimentId);
    const last = ctx.store.outcomes(v.ladder.currentExperimentId).at(-1);
    parts.push(`${v.ladder.currentExperimentId}${plan ? ` (${plan.cells.length} cells)` : ""}${last ? `: ${last.decision}` : ""}`);
  }
  const rec = v.stores.find((s) => s.platform === "ios");
  if (rec) parts.push(`store ${rec.status}${rec.territories.length ? ` [${rec.territories.join(",")}]` : ""}`);
  if (v.blockedOn.length) parts.push(`blocked on ${v.blockedOn.join(",")}`);
  if (v.timeboxStartedAt) parts.push(`${testingDays(v, ctx.ports.clock.iso()).toFixed(0)}d in test`);
  const net = ctx.store.net({ ventureId: v.id });
  if (net !== 0) parts.push(`net ${usd(net)}`);
  if (v.endedReason) parts.push(`ended: ${v.endedReason}`);
  return parts.join(" · ");
}

export function ventureLines(ctx: TickContext): TickSummary["ventures"] {
  return ctx.store.ventures
    .list()
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((v) => ({ id: v.id, name: v.name, stage: v.stage, detail: ventureDetail(ctx, v) }));
}

/** Render the daily report as markdown. */
export function renderReport(ctx: TickContext, summary: TickSummary, plan: AllocationPlan | undefined, ledger: LedgerSync): string {
  const now = ctx.ports.clock.iso();
  const lines: string[] = [];
  lines.push(`# ${ctx.config.name} — day ${summary.tick} (${summary.date})`, "");
  lines.push(`Cash ${usd(summary.cashCents)} · free cash ${usd(summary.freeCashCents)} · reserve ${usd(ledger.reserve(now))} · spent today ${usd(ledger.spentToday(ctx.today))} of ${usd(ledger.dailySpendCap(now))}`, "");
  lines.push("## Ventures", "", "| id | name | stage | detail |", "|---|---|---|---|");
  for (const v of summary.ventures) lines.push(`| ${v.id} | ${v.name} | ${v.stage} | ${v.detail.replace(/\|/g, "/")} |`);
  if (plan?.lanes.length) {
    lines.push("", "## Allocation", "", "| venture | daily now | proposed | ROAS D60 p20 (marginal) | payback | reason |", "|---|---|---|---|---|---|");
    for (const l of plan.lanes) lines.push(`| ${l.ventureId} | ${usd(l.currentDailyCents)} | ${usd(l.proposedDailyCents)} | ${l.marginalRoasD60.toFixed(2)} | ${l.paybackDaysPred ?? "—"}d | ${l.reason} |`);
    lines.push("", `Projected cash trough ${usd(plan.projectedTroughCents)}; validation budget ${usd(plan.testBudgetCents)}/day.`);
  }
  const decided = ctx.store.recentEvents((e) => e.type === "experiment.decided" && e.at.slice(0, 10) === summary.date);
  if (decided.length) {
    lines.push("", "## Experiment decisions", "");
    for (const e of decided) lines.push(`- ${e.ventureId ?? ""} ${String(e.data["experimentId"])}: **${String(e.data["decision"])}** — ${String(e.data["rationale"] ?? "")}`);
  }
  const awaiting = ctx.store.actions.list((a) => a.status === "awaiting_approval");
  if (awaiting.length) {
    lines.push("", "## Waiting for approval", "");
    for (const a of awaiting.slice(0, 30)) lines.push(`- \`${a.id}\` ${a.kind} — ${a.summary}${a.findings.length ? ` (${a.findings.map((f) => f.ruleId).join(", ")})` : ""}`);
  }
  const tasks = ctx.store.tasks.list((t) => t.status === "open");
  if (tasks.length) {
    lines.push("", "## Human tasks", "");
    for (const t of tasks.slice(0, 30)) lines.push(`- \`${t.id}\` ${t.kind}${t.ventureId ? ` (${t.ventureId})` : ""} — ${t.title}`);
  }
  lines.push("", "## Tick phases", "");
  for (const p of summary.phases) lines.push(`- ${p.name} (${p.ms} ms): ${p.error ? `ERROR ${p.error}` : p.detail}`);
  if (summary.memo) {
    lines.push("", "## Board memo", "", `**${summary.memo.headline}**`, "", summary.memo.summary);
    for (const [title, items] of [["Wins", summary.memo.wins], ["Concerns", summary.memo.concerns], ["Decisions needed", summary.memo.decisionsNeeded]] as const) {
      if (items.length) lines.push("", `### ${title}`, "", ...items.map((i) => `- ${i}`));
    }
  }
  return `${lines.join("\n")}\n`;
}

export function writeReport(dataDir: string, date: string, markdown: string): string {
  const dir = join(dataDir, "reports");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${date}.md`);
  writeFileSync(path, markdown);
  writeFileSync(join(dir, "latest.md"), markdown);
  return path;
}

/** Weekly LLM board memo over the deterministic summary. */
export async function boardMemo(ctx: TickContext, deps: StudioDeps, summary: TickSummary): Promise<BoardMemo> {
  const decisions = ctx.store
    .recentEvents((e) => (e.type === "experiment.decided" || e.type === "venture.stage_changed") && e.at >= new Date(new Date(ctx.ports.clock.iso()).getTime() - 7 * 86_400_000).toISOString())
    .slice(-30)
    .map((e) => `${e.ventureId ?? ""} ${e.type}: ${JSON.stringify(e.data).slice(0, 200)}`);
  return deps.agents.writeBoardMemo(ctx, {
    date: summary.date,
    cashCents: summary.cashCents,
    freeCashCents: summary.freeCashCents,
    ventures: summary.ventures,
    decisions,
    pendingApprovals: summary.awaitingApproval,
    openHumanTasks: summary.openTasks,
  });
}
