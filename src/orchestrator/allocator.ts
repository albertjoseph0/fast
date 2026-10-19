/**
 * Money and lifecycle after validation: apply executed lifecycle decisions, plan daily
 * spend across scaling ventures (payback and cash-trough constrained, ramp limited),
 * and move mature ventures to harvest, sunset or an exit flag.
 */
import type { TickContext } from "../core/context.ts";
import type { Action, AllocationPlan, Cents, CohortMetrics, Venture } from "../core/types.ts";
import type { PriceLadderEntry } from "../config/schema.ts";
import type { LedgerSync } from "../governance/ledger.ts";
import { chargesWithin, netPriceCents } from "../lab/ltv.ts";
import { proportionPosterior, quantile } from "../lab/stats.ts";
import { ladderEntry, storeProductDefs } from "../playbook/product.ts";
import { isActive, isLiveOnStore, LIVE_STAGES, ORGANIC_CATEGORIES, transition, windDown } from "./lifecycle.ts";

const DAY_MS = 86_400_000;
/** Marginal CAC is assumed this much worse than average CAC when spend rises (conservative heuristic). */
const MARGINAL_CAC_PENALTY = 1.25;
const ECON_WINDOW_DAYS = 28;

function addDays(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() + days * DAY_MS).toISOString();
}

function daysBetween(a: string, b: string): number {
  return (new Date(b).getTime() - new Date(a).getTime()) / DAY_MS;
}

// ---------------------------------------------------------------------------
// Lifecycle decisions (venture.kill / venture.sunset / venture.scale)
// ---------------------------------------------------------------------------

/**
 * Turn executed lifecycle actions into stage transitions. Each transition's reason starts
 * with the action id, which makes this idempotent across ticks.
 */
export function applyLifecycleDecisions(ctx: TickContext): string[] {
  const applied: string[] = [];
  const executed = ctx.store.actions
    .list((a) => a.status === "executed" && (a.kind === "venture.kill" || a.kind === "venture.sunset" || a.kind === "venture.scale"))
    .sort((a, b) => ((a.executedAt ?? "") < (b.executedAt ?? "") ? -1 : 1));
  for (const a of executed) {
    if (!a.ventureId) continue;
    const v = ctx.store.ventures.get(a.ventureId);
    if (!v || v.history.some((h) => h.reason.startsWith(`${a.id}:`))) continue;
    try {
      applied.push(...applyDecision(ctx, a, v));
    } catch (err) {
      // One bad decision must not stop the others; the next tick retries it.
      applied.push(`${v.id} ${a.kind} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return applied;
}

function applyDecision(ctx: TickContext, a: Action, v: Venture): string[] {
  const applied: string[] = [];
  const clock = ctx.ports.clock;
  switch (a.kind) {
    case "venture.kill": {
      if (!isActive(v)) break;
      const reason = (a.payload as { reason: string }).reason;
      windDown(ctx, v, reason);
      if (isLiveOnStore(v)) {
        ctx.outbox.propose({ kind: "store.remove_from_sale", ventureId: v.id, payload: { platform: "ios", reason }, summary: `Remove ${v.name} from sale`, rationale: reason, proposedBy: "allocator", naturalKey: "ios" });
      }
      transition(ctx.store, clock, v, "killed", `${a.id}: ${reason}`);
      applied.push(`${v.id} killed`);
      break;
    }
    case "venture.sunset": {
      if (!isActive(v) || v.stage === "sunsetting") break;
      const reason = (a.payload as { reason: string }).reason;
      windDown(ctx, v, reason);
      // Stop new sales and renewals now; the backend serves paying users until their periods lapse.
      if (isLiveOnStore(v)) {
        ctx.outbox.propose({ kind: "store.remove_from_sale", ventureId: v.id, payload: { platform: "ios", reason: `sunset: ${reason}` }, summary: `Stop sales of ${v.name}`, rationale: "Sunset serves existing subscribers until their paid periods lapse", proposedBy: "allocator", naturalKey: "ios" });
      }
      transition(ctx.store, clock, v, "sunsetting", `${a.id}: ${reason}`);
      applied.push(`${v.id} sunsetting`);
      break;
    }
    case "venture.scale": {
      if (v.stage !== "live_test" && v.stage !== "iterating" && v.stage !== "harvest") break;
      const p = a.payload as { addTerritories: string[]; proposedDailyCents: Cents };
      transition(ctx.store, clock, v, "scaling", `${a.id}: validated, scaling at ${(p.proposedDailyCents / 100).toFixed(0)} USD/day`);
      expandTerritories(ctx, ctx.store.ventures.require(v.id), p.addTerritories);
      applied.push(`${v.id} scaling`);
      break;
    }
  }
  return applied;
}

/** Add scale storefronts: price the ladder there first, then widen availability. */
function expandTerritories(ctx: TickContext, v: Venture, add: string[]): void {
  const rec = v.stores.find((s) => s.platform === "ios");
  if (!rec || !v.spec) return;
  const territories = [...new Set([...rec.territories, ...add])].sort();
  if (territories.join(",") === rec.territories.join(",")) return;
  const base = { ventureId: v.id, proposedBy: "allocator" as const };
  ctx.outbox.propose({
    ...base,
    kind: "store.upsert_subscriptions",
    payload: { platform: "ios", groupName: `${v.spec.appName} Pro`, products: storeProductDefs(ctx.config, v.bindings.bundleId, territories) },
    naturalKey: `ios:${territories.join("-")}`,
    summary: `Price ${v.spec.appName} in ${add.join(", ")}`,
    rationale: "New storefronts need prices before availability",
  });
  ctx.outbox.propose({
    ...base,
    kind: "store.set_territories",
    payload: { platform: "ios", territories },
    naturalKey: `ios:${territories.join("-")}`,
    summary: `Open ${v.spec.appName} in ${add.join(", ")}`,
    rationale: "Validated in test storefronts and replicated (Bier P5)",
  });
}

// ---------------------------------------------------------------------------
// Unit economics from cohorts
// ---------------------------------------------------------------------------

export interface VentureUnitEconomics {
  installs: number;
  conversions: number;
  spendCents: Cents;
  cacCents: Cents;
  /** 20th percentile of predicted D60 net revenue per install. */
  predNetRpiD60P20Cents: Cents;
  roasD60P20: number;
  marginalRoasD60P20: number;
  paybackDaysPred: number | null;
}

/** Latest (oldest-age) row per cohort lane, restricted to cohorts old enough to have converted. */
function matureCohorts(rows: CohortMetrics[], minAgeDays: number, since: string): CohortMetrics[] {
  const best = new Map<string, CohortMetrics>();
  for (const r of rows) {
    if (r.cohortDate < since || r.ageDays < minAgeDays) continue;
    const key = `${r.cohortDate}|${r.lane}`;
    const cur = best.get(key);
    if (!cur || r.ageDays > cur.ageDays) best.set(key, r);
  }
  return [...best.values()];
}

function paybackDays(cacCents: Cents, convPerInstall: number, entry: PriceLadderEntry, netCents: number, refundHaircut: number, config: TickContext["config"]): number | null {
  if (cacCents <= 0) return 0;
  const periodDays = entry.period === "week" ? 7 : entry.period === "month" ? 30 : 365;
  for (let day = entry.trialDays; day <= 365; day += periodDays) {
    const cum = convPerInstall * chargesWithin(entry, day, config) * netCents * (1 - refundHaircut);
    if (cum >= cacCents) return day;
  }
  return null;
}

export function ventureEconomics(ctx: TickContext, v: Venture): VentureUnitEconomics | null {
  if (!v.spec) return null;
  const entry = ladderEntry(ctx.config, v.spec.paywall.highlightedProductId);
  const today = ctx.today;
  const since = addDays(`${today}T00:00:00.000Z`, -ECON_WINDOW_DAYS).slice(0, 10);
  const rows = matureCohorts(ctx.store.cohorts(v.id), entry.trialDays + 1, since);
  const installs = rows.reduce((s, r) => s + r.installs, 0);
  const conversions = rows.reduce((s, r) => s + r.conversions, 0);
  const cohortSpend = rows.reduce((s, r) => s + r.spendCents, 0);
  const ledgerSpend = -ctx.store.net({ ventureId: v.id, categories: ["creators", "ads"], since: `${since}T00:00:00.000Z` });
  const spendCents = Math.max(cohortSpend, ledgerSpend);
  if (installs === 0) return { installs, conversions, spendCents, cacCents: 0, predNetRpiD60P20Cents: 0, roasD60P20: 0, marginalRoasD60P20: 0, paybackDaysPred: null };
  const t = ctx.config.thresholds;
  const priorConv = t.trialStartRate.floor * 0.5;
  const post = proportionPosterior(conversions, installs, priorConv);
  const convP20 = quantile(post, 0.2);
  const geos = [...new Set(rows.map((r) => r.geo))];
  const geo = geos.length === 1 ? (geos[0] as string) : "US";
  const net = netPriceCents(entry.usdCents, geo, "ios", ctx.config);
  const haircut = ctx.config.economics.refundHaircutPrior;
  const predNetRpiD60P20Cents = Math.round(convP20 * chargesWithin(entry, 60, ctx.config) * net * (1 - haircut));
  const cacCents = Math.round(spendCents / installs);
  const roasD60P20 = cacCents > 0 ? predNetRpiD60P20Cents / cacCents : 0;
  const marginalRoasD60P20 = cacCents > 0 ? predNetRpiD60P20Cents / (cacCents * MARGINAL_CAC_PENALTY) : 0;
  return { installs, conversions, spendCents, cacCents, predNetRpiD60P20Cents, roasD60P20, marginalRoasD60P20, paybackDaysPred: paybackDays(cacCents * MARGINAL_CAC_PENALTY, convP20, entry, net, haircut, ctx.config) };
}

// ---------------------------------------------------------------------------
// Daily allocation
// ---------------------------------------------------------------------------

interface LanePlanRow {
  lane: string;
  ventureId: string;
  currentDailyCents: Cents;
  proposedDailyCents: Cents;
  changedAt: string;
}

/** The previous plan's daily budget per venture (allocation plans are event-sourced). */
function previousPlan(ctx: TickContext): Map<string, LanePlanRow> {
  const last = ctx.store.recentEvents((e) => e.type === "allocation.planned").at(-1);
  const rows = ((last?.data["lanes"] ?? []) as LanePlanRow[]).map((r) => [r.ventureId, r] as const);
  return new Map(rows);
}

function initialDaily(ctx: TickContext, v: Venture): Cents {
  const scale = ctx.store.actions.list((a) => a.kind === "venture.scale" && a.ventureId === v.id && a.status === "executed").at(-1);
  return scale ? (scale.payload as { proposedDailyCents: Cents }).proposedDailyCents : 0;
}

/**
 * Plan tomorrow's distribution spend per scaling venture.
 * - Up: marginal ROAS(D60, p20) >= 1 and predicted payback within the allowed window, at most
 *   +scaleRampMaxStepPct every scaleRampMinDaysBetweenSteps days.
 * - Down: marginal ROAS below the S4 bar; zero below half of it (the venture drifts to harvest).
 * - Constraints: the scale pool is the daily cap minus the share reserved for validation, and
 *   the cash committed until payback (sum of daily x payback days) must fit in free cash.
 */
export function planAllocation(ctx: TickContext, ledger: LedgerSync): AllocationPlan {
  const b = ctx.config.budgets;
  const now = ctx.ports.clock.iso();
  const freeCashCents = ledger.freeCash(now);
  const dailyCap = ledger.dailySpendCap(now);
  const testBudgetCents = Math.round(dailyCap * b.testBudgetShare);
  const scalePool = Math.max(0, dailyCap - testBudgetCents);
  const maxPayback = freeCashCents >= b.richFreeCashCents ? b.maxPaybackDaysWhenRich : b.maxPaybackDays;
  const prev = previousPlan(ctx);
  const s4Bar = ctx.config.lab.s4MinRoasD60P20;

  const rows: (AllocationPlan["lanes"][number] & { changedAt: string })[] = [];
  for (const v of ctx.store.ventures.list((x) => x.stage === "scaling")) {
    const econ = ventureEconomics(ctx, v);
    const before = prev.get(v.id);
    const current = before?.proposedDailyCents ?? initialDaily(ctx, v);
    const lastChange = before?.changedAt ?? now;
    let proposed = current;
    let reason = "hold";
    if (!econ || econ.installs < 50) {
      reason = "not enough mature installs to move the budget";
    } else if (econ.marginalRoasD60P20 >= 1 && econ.paybackDaysPred !== null && econ.paybackDaysPred <= maxPayback) {
      if (daysBetween(lastChange, now) >= b.scaleRampMinDaysBetweenSteps || !before) {
        proposed = Math.min(b.scaleDailyCapCents, Math.round(Math.max(current, 1_000) * (1 + b.scaleRampMaxStepPct)));
        reason = `marginal ROAS ${econ.marginalRoasD60P20.toFixed(2)}, payback ${econ.paybackDaysPred}d`;
      } else reason = "ramp cooling down";
    } else if (econ.marginalRoasD60P20 < s4Bar / 2) {
      proposed = 0;
      reason = `marginal ROAS ${econ.marginalRoasD60P20.toFixed(2)} below half the S4 bar`;
    } else if (econ.marginalRoasD60P20 < s4Bar) {
      proposed = Math.round(current * (1 - b.scaleRampMaxStepPct));
      reason = `marginal ROAS ${econ.marginalRoasD60P20.toFixed(2)} below the S4 bar`;
    }
    rows.push({
      lane: `${v.id}|creator_ugc|*|*`,
      ventureId: v.id,
      currentDailyCents: current,
      proposedDailyCents: proposed,
      marginalCacCents: econ ? Math.round(econ.cacCents * MARGINAL_CAC_PENALTY) : 0,
      predNetRpiD60P20Cents: econ?.predNetRpiD60P20Cents ?? 0,
      marginalRoasD60: econ?.marginalRoasD60P20 ?? 0,
      paybackDaysPred: econ?.paybackDaysPred ?? null,
      reason,
      changedAt: proposed !== current ? now : lastChange,
    });
  }

  // Scale pool: shrink every lane proportionally if the sum exceeds it.
  const total = rows.reduce((s, r) => s + r.proposedDailyCents, 0);
  if (total > scalePool && total > 0) {
    const f = scalePool / total;
    for (const r of rows) {
      r.proposedDailyCents = Math.floor(r.proposedDailyCents * f);
      r.reason += "; scaled to the daily pool";
    }
  }
  // Cash trough: spend committed until each lane pays back must fit in free cash.
  const committed = rows.reduce((s, r) => s + r.proposedDailyCents * (r.paybackDaysPred ?? maxPayback), 0);
  if (committed > freeCashCents && committed > 0) {
    const f = Math.max(0, freeCashCents) / committed;
    for (const r of rows) {
      r.proposedDailyCents = Math.floor(r.proposedDailyCents * f);
      r.reason += "; limited by the cash trough";
    }
  }
  const projectedTroughCents = freeCashCents - rows.reduce((s, r) => s + r.proposedDailyCents * (r.paybackDaysPred ?? maxPayback), 0);
  const plan: AllocationPlan = { date: ctx.today, freeCashCents, projectedTroughCents, testBudgetCents, lanes: rows.map(({ changedAt: _c, ...r }) => r) };
  ctx.log("allocation.planned", { ...plan, lanes: rows } as unknown as Record<string, unknown>);
  return plan;
}

// ---------------------------------------------------------------------------
// Mature ventures: harvest, sunset, exit flag
// ---------------------------------------------------------------------------

function weeklyProceeds(ctx: TickContext, ventureId: string): { week: string; cents: number }[] {
  const byWeek = new Map<string, number>();
  for (const r of ctx.store.metrics(ventureId, (m) => m.cellId === null && m.geo === null)) {
    const d = new Date(`${r.date}T00:00:00.000Z`);
    const monday = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY_MS).toISOString().slice(0, 10);
    byWeek.set(monday, (byWeek.get(monday) ?? 0) + r.proceedsCents);
  }
  return [...byWeek.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([week, cents]) => ({ week, cents }));
}

function activeSubscribers(ctx: TickContext, ventureId: string): number {
  const rows = ctx.store.metrics(ventureId, (m) => m.cellId === null && m.geo === null).sort((a, b) => (a.date < b.date ? -1 : 1));
  return rows.at(-1)?.activeSubscribers ?? 0;
}

/** Harvest decaying ventures, sunset money losers, flag ventures worth more sold than held. */
export function reviewMatureVentures(ctx: TickContext, plan: AllocationPlan): string[] {
  const out: string[] = [];
  const x = ctx.config.exit;
  const now = ctx.ports.clock.iso();
  for (const v of ctx.store.ventures.list((y) => y.stage === "scaling" || y.stage === "harvest" || y.stage === "sunsetting")) {
    const weeks = weeklyProceeds(ctx, v.id);
    const complete = weeks.slice(0, -1); // the current week is partial
    const peak = Math.max(0, ...complete.map((w) => w.cents));
    const last = complete.at(-1)?.cents ?? 0;
    const lane = plan.lanes.find((l) => l.ventureId === v.id);

    if (v.stage === "sunsetting") {
      if (activeSubscribers(ctx, v.id) > 0) continue;
      if (isLiveOnStore(v)) {
        ctx.outbox.propose({ kind: "store.remove_from_sale", ventureId: v.id, payload: { platform: "ios", reason: "sunset: no active subscribers remain" }, summary: `Remove ${v.name} from sale`, rationale: "Every paid period has lapsed", proposedBy: "allocator", naturalKey: "ios" });
      } else {
        transition(ctx.store, ctx.ports.clock, v, "killed", "sunset complete: no active subscribers remain");
        out.push(`${v.id} sunset complete`);
      }
      continue;
    }
    if (v.stage === "scaling" && lane && lane.proposedDailyCents === 0 && peak > 0 && last < peak * (1 - x.harvestBelowPeak)) {
      transition(ctx.store, ctx.ports.clock, v, "harvest", `paid growth no longer clears the bar; weekly proceeds ${(last / 100).toFixed(0)} vs peak ${(peak / 100).toFixed(0)} USD`);
      out.push(`${v.id} harvest`);
      continue;
    }
    if (v.stage === "harvest" && lane === undefined) {
      // Harvest is judged on what the app earns without growth spend (trailing payouts from its test
      // phase are sunk), month by month for sunsetNegativeContributionMonths months.
      const months = Array.from({ length: x.sunsetNegativeContributionMonths }, (_, m) =>
        ctx.store.net({ ventureId: v.id, categories: ORGANIC_CATEGORIES, since: addDays(now, -30 * (m + 1)), until: addDays(now, -30 * m) }),
      );
      const harvestedFor = (new Date(now).getTime() - new Date(v.history.findLast((h) => h.to === "harvest")?.at ?? now).getTime()) / DAY_MS;
      if (harvestedFor >= 30 * x.sunsetNegativeContributionMonths && months.every((c) => c < 0)) {
        ctx.outbox.propose({
          kind: "venture.sunset",
          ventureId: v.id,
          payload: { activeSubscribers: activeSubscribers(ctx, v.id), plan: "serve_until_lapse", reason: `negative organic contribution for ${x.sunsetNegativeContributionMonths} consecutive months` },
          summary: `Sunset ${v.name}`,
          rationale: "Harvest no longer covers its inference and tooling costs",
          proposedBy: "allocator",
          naturalKey: "sunset",
        });
        out.push(`${v.id} sunset proposed`);
      }
    }
    // Exit flag: the trailing twelve months' proceeds justify a sale conversation.
    const ttmProceeds = ctx.store.net({ ventureId: v.id, categories: ["revenue", "refunds"], since: addDays(now, -365) });
    const ttmContribution = ctx.store.net({ ventureId: v.id, since: addDays(now, -365) });
    const declining = complete.slice(-(x.decliningMonthsForFlag * 4));
    const isDeclining = declining.length >= x.decliningMonthsForFlag * 4 && (declining.at(-1)?.cents ?? 0) < (declining[0]?.cents ?? 0);
    if (ttmProceeds >= x.minTtmProceedsForExitFlagCents && isDeclining) {
      const saleEstimateCents = Math.round(Math.max(0, ttmContribution) * x.saleMultipleOfTtmContribution);
      const halfLife = x.harvestHalfLifeDays;
      const holdNpvCents = Math.round(Math.max(0, last) * (halfLife / 7) / Math.LN2);
      if (saleEstimateCents > holdNpvCents) {
        ctx.outbox.propose({
          kind: "venture.exit_flag",
          ventureId: v.id,
          payload: { holdNpvCents, saleEstimateCents, rationale: `TTM contribution ${(ttmContribution / 100).toFixed(0)} USD and declining for ${x.decliningMonthsForFlag} months` },
          summary: `Consider selling ${v.name}`,
          rationale: "Estimated sale value exceeds the value of holding a decaying app",
          proposedBy: "allocator",
          naturalKey: `exit:${ctx.today.slice(0, 7)}`,
        });
        out.push(`${v.id} exit flag`);
      }
    }
  }
  return out;
}

/** Live ventures that still count against the portfolio (for capacity and reporting). */
export function liveVentures(ctx: TickContext): Venture[] {
  return ctx.store.ventures.list((v) => LIVE_STAGES.includes(v.stage));
}

