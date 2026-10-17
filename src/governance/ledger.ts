/**
 * The studio ledger and cost meter. This is the only writer of store.book(); every
 * entry is idempotent on its sourceKey, so re-syncing overlapping windows never
 * duplicates money. Cash counts store proceeds only once they settle, and every spend
 * policy check reads free cash: cash minus what is already committed, owed or at risk.
 */
import type { StudioConfig } from "../config/schema.ts";
import { addDays } from "../core/clock.ts";
import type { Clock, CostEvent, CostMeter } from "../core/ports.ts";
import type { StudioStore } from "../core/store.ts";
import type {
  Action,
  AdCampaign,
  AdDailyStats,
  Cents,
  CreatorSubmission,
  DailyMetrics,
  Iso,
  LedgerCategory,
  LedgerEntry,
  Payout,
} from "../core/types.ts";
import { computePayout } from "./payouts.ts";

const DAY_MS = 86_400_000;
const FIXED_BURN: LedgerCategory[] = ["ai", "media", "infra", "tools"];
const DISTRIBUTION: LedgerCategory[] = ["creators", "ads"];

export class BudgetExceededError extends Error {
  constructor(
    readonly kind: CostEvent["kind"],
    readonly spentCents: Cents,
    readonly estimateCents: Cents,
    readonly limitCents: Cents,
  ) {
    super(`daily ${kind} budget exceeded: spent ${spentCents} + estimate ${estimateCents} > limit ${limitCents} cents`);
    this.name = "BudgetExceededError";
  }
}

function dayStart(date: string): Iso {
  return `${date.slice(0, 10)}T00:00:00.000Z`;
}

function shiftIso(iso: Iso, days: number): Iso {
  return new Date(new Date(iso).getTime() + days * DAY_MS).toISOString();
}

export class LedgerSync implements CostMeter {
  private readonly store: StudioStore;
  private readonly config: StudioConfig;
  private readonly clock: Clock;

  constructor(deps: { store: StudioStore; config: StudioConfig; clock: Clock }) {
    this.store = deps.store;
    this.config = deps.config;
    this.clock = deps.clock;
  }

  // -- cost meter (LLM + media) ------------------------------------------------

  assertBudget(kind: CostEvent["kind"], estimateCents: Cents): void {
    const spent = this.spentTodayOn(kind);
    const limit = this.limitFor(kind);
    if (spent + estimateCents > limit) throw new BudgetExceededError(kind, spent, estimateCents, limit);
  }

  charge(e: CostEvent): void {
    this.book(
      {
        sourceKey: `${e.kind}:${e.ref}`,
        category: e.kind === "llm" ? "ai" : "media",
        amountCents: -Math.abs(e.cents),
        memo: `${e.model} ${e.purpose}`,
        ...(e.ventureId ? { ventureId: e.ventureId } : {}),
      },
      false,
    );
  }

  remainingTodayCents(kind: CostEvent["kind"]): Cents {
    return Math.max(0, this.limitFor(kind) - this.spentTodayOn(kind));
  }

  // -- syncs -------------------------------------------------------------------

  /** Book venture-total revenue and refund rows (cellId and geo null). */
  syncRevenue(ventureId: string, rows: DailyMetrics[]): LedgerEntry[] {
    const out: LedgerEntry[] = [];
    const lag = this.config.economics.settlementLagDays.ios;
    for (const r of rows) {
      if (r.cellId !== null || r.geo !== null) continue;
      const revKey = `rev:${ventureId}:${r.date}`;
      if (r.grossRevenueCents !== 0 || r.proceedsCents !== 0 || this.has(revKey)) {
        const { feeCents, taxCents } = this.splitDeductions(r.grossRevenueCents, r.proceedsCents);
        out.push(
          this.book({
            sourceKey: revKey,
            ventureId,
            category: "revenue",
            amountCents: r.proceedsCents,
            grossCents: r.grossRevenueCents,
            feeCents,
            taxCents,
            settlesAt: dayStart(addDays(r.date, lag)),
            memo: `proceeds ${r.date}`,
            at: dayStart(r.date),
          }),
        );
      }
      const refundKey = `refund:${ventureId}:${r.date}`;
      if (r.refundsCents !== 0 || this.has(refundKey)) {
        out.push(
          this.book({
            sourceKey: refundKey,
            ventureId,
            category: "refunds",
            amountCents: -Math.abs(r.refundsCents),
            memo: `refunds ${r.date}`,
            at: dayStart(r.date),
          }),
        );
      }
    }
    return out;
  }

  /** Book daily ad spend for one campaign. */
  syncAds(campaign: AdCampaign, rows: AdDailyStats[]): LedgerEntry[] {
    return rows.map((r) =>
      this.book({
        sourceKey: `${adsKeyPrefix(campaign)}${r.date}`,
        ventureId: campaign.ventureId,
        category: "ads",
        amountCents: -Math.abs(r.spendCents),
        actionId: campaign.actionId,
        ...(campaign.experimentId ? { experimentId: campaign.experimentId } : {}),
        ...(campaign.cellId ? { cellId: campaign.cellId } : {}),
        memo: `${campaign.network} ${campaign.type} spend ${r.date}`,
        at: dayStart(r.date),
      }),
    );
  }

  onPayout(payout: Payout, ventureId: string): LedgerEntry {
    const sub = this.store.submissions.get(payout.submissionId);
    const campaign = sub ? this.store.campaigns.get(sub.campaignId) : undefined;
    return this.book({
      sourceKey: `payout:${payout.id}`,
      ventureId,
      category: "creators",
      amountCents: -Math.abs(payout.amountCents),
      ...(campaign?.experimentId ? { experimentId: campaign.experimentId } : {}),
      ...(campaign?.cellId ? { cellId: campaign.cellId } : {}),
      memo: `creator payout for ${payout.submissionId}`,
      at: payout.at,
    });
  }

  /** Book one venture-day of AI inference served by the verdict backend. */
  bookInference(ventureId: string, date: string, cents: Cents): LedgerEntry {
    return this.book({
      sourceKey: `inference:${ventureId}:${date}`,
      ventureId,
      category: "inference",
      amountCents: -Math.abs(cents),
      memo: `inference ${date}`,
      at: dayStart(date),
    });
  }

  // -- balances ----------------------------------------------------------------

  /** Starting cash plus every entry, except store proceeds that have not settled yet. */
  cash(asOf: Iso = this.clock.iso()): Cents {
    const sum = this.store
      .ledger((e) => !(e.category === "revenue" && e.settlesAt !== undefined && e.settlesAt > asOf))
      .reduce((s, e) => s + e.amountCents, 0);
    return this.config.budgets.startingCashCents + sum;
  }

  /** Money executed actions can still spend: daily budgets to their end, lifetime caps not yet used. */
  outstandingCommitments(asOf: Iso = this.clock.iso()): Cents {
    // A later executed action on the same campaign (a budget change) supersedes the earlier commitment.
    const latest = new Map<string, Action>();
    for (const a of this.store.actions.list((x) => x.status === "executed" && x.commitment !== undefined)) {
      const target = commitmentTarget(a);
      const prev = latest.get(target);
      if (!prev || (prev.executedAt ?? prev.createdAt) <= (a.executedAt ?? a.createdAt)) latest.set(target, a);
    }
    let total = 0;
    for (const a of latest.values()) total += this.remainingCommitment(a, asOf);
    return total;
  }

  /** Approved-but-unpaid creator submissions, at the amount the payout rule would compute. */
  accruedLiabilities(): Cents {
    let total = 0;
    for (const amount of this.accruals().values()) total += amount;
    return total;
  }

  /** The accrued liability for one submission (0 when none). */
  accruedFor(submissionId: string): Cents {
    return this.accruals().get(submissionId) ?? 0;
  }

  /** Expected refunds on recent gross revenue. */
  refundReserve(asOf: Iso = this.clock.iso()): Cents {
    const since = shiftIso(asOf, -this.config.economics.refundLagDays);
    const gross = this.store
      .ledger((e) => e.category === "revenue" && e.at >= since && e.at <= asOf)
      .reduce((s, e) => s + (e.grossCents ?? e.amountCents), 0);
    return Math.ceil(this.config.economics.refundHaircutPrior * Math.max(0, gross));
  }

  /** Cash the studio never spends: max(floor, fixedBurnDays x trailing 30-day fixed burn per day). */
  reserve(asOf: Iso = this.clock.iso()): Cents {
    const since = shiftIso(asOf, -30);
    const burn = -this.store
      .ledger((e) => FIXED_BURN.includes(e.category) && e.at >= since && e.at <= asOf)
      .reduce((s, e) => s + e.amountCents, 0);
    const perDay = Math.max(0, burn) / 30;
    return Math.max(this.config.budgets.reserveFloorCents, Math.ceil(this.config.budgets.reserveFixedBurnDays * perDay));
  }

  freeCash(asOf: Iso = this.clock.iso()): Cents {
    return this.cash(asOf) - this.outstandingCommitments(asOf) - this.accruedLiabilities() - this.refundReserve(asOf);
  }

  /** Creator and ad spend booked on a date (positive cents). */
  spentToday(today: string = this.clock.today()): Cents {
    const day = today.slice(0, 10);
    const net = this.store.ledger((e) => DISTRIBUTION.includes(e.category) && e.at.slice(0, 10) === day).reduce((s, e) => s + e.amountCents, 0);
    return Math.max(0, -net);
  }

  dailySpendCap(asOf: Iso = this.clock.iso()): Cents {
    const b = this.config.budgets;
    return Math.min(b.dailySpendCapCents, Math.floor(b.dailySpendCapShareOfFreeCash * Math.max(0, this.freeCash(asOf))));
  }

  // -- internals ---------------------------------------------------------------

  private book(entry: Omit<LedgerEntry, "id" | "at"> & { at?: string }, emit = true): LedgerEntry {
    const before = this.store.ledger((e) => e.sourceKey === entry.sourceKey)[0];
    const row = this.store.book(entry);
    if (emit && (!before || before.amountCents !== row.amountCents)) {
      this.store.emit(
        "ledger.booked",
        { sourceKey: row.sourceKey, category: row.category, amountCents: row.amountCents, restated: before !== undefined },
        row.ventureId,
      );
    }
    return row;
  }

  private has(sourceKey: string): boolean {
    return this.store.ledger((e) => e.sourceKey === sourceKey).length > 0;
  }

  private limitFor(kind: CostEvent["kind"]): Cents {
    return kind === "llm" ? this.config.llm.maxDailyCents : this.config.media.maxDailyCents;
  }

  private spentTodayOn(kind: CostEvent["kind"]): Cents {
    const day = this.clock.today();
    const category: LedgerCategory = kind === "llm" ? "ai" : "media";
    const net = this.store.ledger((e) => e.category === category && e.at.slice(0, 10) === day).reduce((s, e) => s + e.amountCents, 0);
    return Math.max(0, -net);
  }

  /**
   * Split gross - proceeds into VAT and store fee: proceeds = (gross - tax) x (1 - fee),
   * so net-of-tax = proceeds / (1 - fee) and the rest of the deduction is tax.
   */
  private splitDeductions(gross: Cents, proceeds: Cents): { feeCents: Cents; taxCents: Cents } {
    const deductions = Math.max(0, gross - proceeds);
    const feeRate = this.config.economics.storeFeeRate.ios;
    const netOfTax = feeRate < 1 ? Math.round(proceeds / (1 - feeRate)) : gross;
    const taxCents = Math.min(deductions, Math.max(0, gross - netOfTax));
    return { feeCents: deductions - taxCents, taxCents };
  }

  private remainingCommitment(a: Action, asOf: Iso): Cents {
    const c = a.commitment;
    if (!c || this.targetClosed(a)) return 0;
    const spent = this.spentAgainst(a);
    const capLeft = c.maxTotalCents > 0 ? Math.max(0, c.maxTotalCents - spent) : Number.POSITIVE_INFINITY;
    if (c.kind === "daily") {
      if (!c.endsAt) return Number.isFinite(capLeft) ? capLeft : 0;
      const from = Math.max(new Date(asOf).getTime(), new Date(c.startsAt).getTime());
      const days = Math.max(0, Math.ceil((new Date(c.endsAt).getTime() - from) / DAY_MS));
      return Math.min(c.amountCents * days, capLeft);
    }
    if (c.kind === "lifetime_cap") return Number.isFinite(capLeft) ? capLeft : 0;
    return 0;
  }

  private targetClosed(a: Action): boolean {
    const p = a.payload as { adCampaignId?: unknown; campaignId?: unknown };
    if (typeof p.adCampaignId === "string") {
      const status = this.store.adCampaigns.get(p.adCampaignId)?.status;
      return status === "paused" || status === "ended";
    }
    if (typeof p.campaignId === "string") return this.store.campaigns.get(p.campaignId)?.status === "closed";
    return false;
  }

  private spentAgainst(a: Action): Cents {
    const p = a.payload as { adCampaignId?: unknown; campaignId?: unknown };
    if (typeof p.adCampaignId === "string") {
      const campaign = this.store.adCampaigns.get(p.adCampaignId);
      if (!campaign) return 0;
      const prefix = adsKeyPrefix(campaign);
      return -this.store.ledger((e) => e.sourceKey.startsWith(prefix)).reduce((s, e) => s + e.amountCents, 0);
    }
    if (typeof p.campaignId === "string") {
      // Accrued liabilities are counted separately, so they also use up the campaign's commitment.
      const campaignId = p.campaignId;
      const subIds = new Set(this.store.submissions.list((s) => s.campaignId === campaignId).map((s) => s.id));
      let accrued = 0;
      for (const [subId, amount] of this.accruals()) if (subIds.has(subId)) accrued += amount;
      return this.paidOnCampaign(campaignId) + accrued;
    }
    return -this.store.ledger((e) => e.actionId === a.id).reduce((s, e) => s + e.amountCents, 0);
  }

  /** Creator payouts already booked against a creator campaign (positive cents). */
  paidOnCampaign(campaignId: string): Cents {
    const subIds = new Set(this.store.submissions.list((s) => s.campaignId === campaignId).map((s) => s.id));
    const keys = new Set(this.store.payouts.list((p) => subIds.has(p.submissionId)).map((p) => `payout:${p.id}`));
    return -this.store.ledger((e) => keys.has(e.sourceKey)).reduce((s, e) => s + e.amountCents, 0);
  }

  private accruals(): Map<string, Cents> {
    const out = new Map<string, Cents>();
    const remaining = new Map<string, Cents>();
    const subs = this.store.submissions
      .list((s) => s.stage === "post_approved")
      .sort((x, y) => (x.id < y.id ? -1 : 1));
    for (const s of subs) {
      const campaign = this.store.campaigns.get(s.campaignId);
      if (!campaign) continue;
      const left = remaining.get(campaign.id) ?? Math.max(0, campaign.budgetCents - this.paidOnCampaign(campaign.id));
      const amount = computePayout(
        { flatFeeCents: campaign.flatFeeCents, cpmCents: campaign.cpmCents, maxPayoutCents: campaign.maxPayoutPerVideoCents },
        { viewsAtLock: lockedViews(s), campaignRemainingCents: left },
      );
      remaining.set(campaign.id, left - amount);
      out.set(s.id, amount);
    }
    return out;
  }
}

function adsKeyPrefix(c: AdCampaign): string {
  return `ads:${c.network}:${c.externalId ?? c.id}:`;
}

function commitmentTarget(a: Action): string {
  const p = a.payload as { adCampaignId?: unknown; campaignId?: unknown };
  if (typeof p.adCampaignId === "string") return `adc:${p.adCampaignId}`;
  if (typeof p.campaignId === "string") return `ccmp:${p.campaignId}`;
  return `act:${a.id}`;
}

function lockedViews(s: CreatorSubmission): number {
  return s.viewsAtLock ?? s.verification?.viewsFromPlatform ?? 0;
}
