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
/** Source-key prefix of a payout whose call may have paid: booked as spent until a human resolves it. */
const UNKNOWN_PAYOUT = "payout:unknown:";
/** Submission stages a closed campaign still carries to a payout. */
const IN_FLIGHT: readonly CreatorSubmission["stage"][] = ["draft_submitted", "draft_approved", "posted"];
/** Payout statuses that keep a submission's liability alive. */
const PAYOUT_LIVE: readonly Action["status"][] = ["proposed", "blocked", "awaiting_approval", "awaiting_human_task", "approved", "executing", "executed"];

/** A creator.payout whose outcome is unknown, booked as spent. */
export interface UnknownPayout {
  actionId: string;
  submissionId: string;
  amountCents: Cents;
  at: Iso;
}

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

  /** Derived figures cached for one store revision: every write invalidates them. */
  private memoRevision = -1;
  private readonly memo = new Map<string, unknown>();

  constructor(deps: { store: StudioStore; config: StudioConfig; clock: Clock }) {
    this.store = deps.store;
    this.config = deps.config;
    this.clock = deps.clock;
  }

  private cached<T>(key: string, compute: () => T): T {
    if (this.store.revision !== this.memoRevision) {
      this.memo.clear();
      this.memoRevision = this.store.revision;
    }
    if (this.memo.has(key)) return this.memo.get(key) as T;
    const value = compute();
    this.memo.set(key, value);
    return value;
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

  /**
   * Book a payout whose call failed or was interrupted after it may have reached the marketplace.
   * The money may have left, so it counts as paid against cash, the campaign and the creator until
   * a human checks the marketplace and releases it.
   */
  holdUnknownPayout(a: Action<"creator.payout">): LedgerEntry {
    const sub = this.store.submissions.get(a.payload.submissionId);
    const campaign = sub ? this.store.campaigns.get(sub.campaignId) : undefined;
    const ventureId = a.ventureId ?? campaign?.ventureId;
    return this.book({
      sourceKey: `${UNKNOWN_PAYOUT}${a.id}`,
      category: "creators",
      amountCents: -Math.abs(a.payload.amountCents),
      actionId: a.id,
      ...(ventureId ? { ventureId } : {}),
      ...(campaign?.experimentId ? { experimentId: campaign.experimentId } : {}),
      ...(campaign?.cellId ? { cellId: campaign.cellId } : {}),
      memo: `creator payout for ${a.payload.submissionId} outcome unknown (${a.id}): verify with the marketplace`,
    });
  }

  /** Release a held payout the marketplace shows was never sent: the submission is owed again. */
  releaseUnknownPayout(actionId: string): LedgerEntry {
    const held = this.store.ledgerEntry(`${UNKNOWN_PAYOUT}${actionId}`);
    if (!held) throw new Error(`no unknown payout is held for ${actionId}`);
    const { id: _id, ...entry } = held;
    return this.book({ ...entry, amountCents: 0, memo: `${held.memo}; released: not sent` });
  }

  /** Held payouts that still count as paid. */
  unknownPayouts(): UnknownPayout[] {
    return this.cached("unknownPayouts", () =>
      this.store
        .ledger((e) => e.sourceKey.startsWith(UNKNOWN_PAYOUT) && e.amountCents !== 0)
        .flatMap((e) => {
          const a = e.actionId ? this.store.actions.get(e.actionId) : undefined;
          const submissionId = (a?.payload as { submissionId?: unknown } | undefined)?.submissionId;
          return typeof submissionId === "string" && a ? [{ actionId: a.id, submissionId, amountCents: -e.amountCents, at: e.at }] : [];
        }),
    );
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
    return this.cached(`cash|${asOf}`, () => {
    const sum = this.store
      .ledger((e) => !(e.category === "revenue" && e.settlesAt !== undefined && e.settlesAt > asOf))
      .reduce((s, e) => s + e.amountCents, 0);
    return this.config.budgets.startingCashCents + sum;
    });
  }

  /** Money executed actions can still spend: daily budgets to their end, lifetime caps not yet used. */
  outstandingCommitments(asOf: Iso = this.clock.iso()): Cents {
    return this.cached(`commitments|${asOf}`, () => {
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
    });
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

  /** Expected refunds on recent gross revenue, less the refunds on it already booked (they left cash). */
  refundReserve(asOf: Iso = this.clock.iso()): Cents {
    return this.cached(`refunds|${asOf}`, () => {
    const since = shiftIso(asOf, -this.config.economics.refundLagDays);
    let gross = 0;
    let refunded = 0;
    for (const e of this.store.ledger((x) => (x.category === "revenue" || x.category === "refunds") && x.at >= since && x.at <= asOf)) {
      if (e.category === "revenue") gross += e.grossCents ?? e.amountCents;
      else refunded += -(e.grossCents ?? e.amountCents);
    }
    return Math.max(0, Math.ceil(this.config.economics.refundHaircutPrior * Math.max(0, gross)) - Math.max(0, refunded));
    });
  }

  /** Cash the studio never spends: max(floor, fixedBurnDays x trailing 30-day fixed burn per day). */
  reserve(asOf: Iso = this.clock.iso()): Cents {
    return this.cached(`reserve|${asOf}`, () => {
    const since = shiftIso(asOf, -30);
    const burn = -this.store
      .ledger((e) => FIXED_BURN.includes(e.category) && e.at >= since && e.at <= asOf)
      .reduce((s, e) => s + e.amountCents, 0);
    const perDay = Math.max(0, burn) / 30;
    return Math.max(this.config.budgets.reserveFloorCents, Math.ceil(this.config.budgets.reserveFixedBurnDays * perDay));
    });
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
    const before = this.store.ledgerEntry(entry.sourceKey);
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
    return this.store.ledgerEntry(sourceKey) !== undefined;
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
    if (!c) return 0;
    const spent = this.spentAgainst(a);
    const capLeft = c.maxTotalCents > 0 ? Math.max(0, c.maxTotalCents - spent) : Number.POSITIVE_INFINITY;
    if (this.targetClosed(a)) return this.inFlightOnClosedCampaign(a, capLeft);
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

  /** A closed creator campaign still owes its in-flight submissions up to the per-video cap each. */
  private inFlightOnClosedCampaign(a: Action, capLeft: Cents): Cents {
    const campaignId = (a.payload as { campaignId?: unknown }).campaignId;
    const campaign = typeof campaignId === "string" ? this.store.campaigns.get(campaignId) : undefined;
    if (!campaign) return 0;
    const inFlight = (this.submissionsByCampaign().get(campaign.id) ?? []).filter((s) => IN_FLIGHT.includes(s.stage)).length;
    return Math.min(capLeft, inFlight * campaign.maxPayoutPerVideoCents);
  }

  private spentAgainst(a: Action): Cents {
    const p = a.payload as { adCampaignId?: unknown; campaignId?: unknown };
    if (typeof p.adCampaignId === "string") {
      const campaign = this.store.adCampaigns.get(p.adCampaignId);
      if (!campaign) return 0;
      return -(this.ledgerSums().byPrefix.get(adsKeyPrefix(campaign)) ?? 0);
    }
    if (typeof p.campaignId === "string") {
      // Accrued liabilities are counted separately, so they also use up the campaign's commitment.
      return this.paidOnCampaign(p.campaignId) + (this.accruedByCampaign().get(p.campaignId) ?? 0);
    }
    return -(this.ledgerSums().byAction.get(a.id) ?? 0);
  }

  /** Creator payouts booked against a creator campaign, held unknown payouts included (positive cents). */
  paidOnCampaign(campaignId: string): Cents {
    return this.paidByCampaign().get(campaignId) ?? 0;
  }

  /** Submissions grouped by campaign (one scan per store revision). */
  private submissionsByCampaign(): Map<string, CreatorSubmission[]> {
    return this.cached("submissionsByCampaign", () => {
      const out = new Map<string, CreatorSubmission[]>();
      for (const s of this.store.submissions.list()) {
        const list = out.get(s.campaignId);
        if (list) list.push(s);
        else out.set(s.campaignId, [s]);
      }
      return out;
    });
  }

  private accruedByCampaign(): Map<string, Cents> {
    return this.cached("accruedByCampaign", () => {
      const out = new Map<string, Cents>();
      for (const [submissionId, amount] of this.accruals()) {
        const campaignId = this.store.submissions.get(submissionId)?.campaignId;
        if (campaignId) out.set(campaignId, (out.get(campaignId) ?? 0) + amount);
      }
      return out;
    });
  }

  private paidByCampaign(): Map<string, Cents> {
    return this.cached("paidByCampaign", () => {
      const campaignOf = new Map(this.store.submissions.list().map((s) => [s.id, s.campaignId]));
      const out = new Map<string, Cents>();
      const add = (submissionId: string, cents: Cents) => {
        const campaignId = campaignOf.get(submissionId);
        if (campaignId) out.set(campaignId, (out.get(campaignId) ?? 0) + cents);
      };
      for (const p of this.store.payouts.list()) {
        const entry = this.store.ledgerEntry(`payout:${p.id}`);
        if (entry) add(p.submissionId, -entry.amountCents);
      }
      for (const u of this.unknownPayouts()) add(u.submissionId, u.amountCents);
      return out;
    });
  }

  /** Booked amounts summed by source-key prefix (up to the last ':') and by action id. */
  private ledgerSums(): { byPrefix: Map<string, Cents>; byAction: Map<string, Cents> } {
    return this.cached("ledgerSums", () => {
      const byPrefix = new Map<string, Cents>();
      const byAction = new Map<string, Cents>();
      for (const e of this.store.ledger()) {
        const prefix = e.sourceKey.slice(0, e.sourceKey.lastIndexOf(":") + 1);
        byPrefix.set(prefix, (byPrefix.get(prefix) ?? 0) + e.amountCents);
        if (e.actionId) byAction.set(e.actionId, (byAction.get(e.actionId) ?? 0) + e.amountCents);
      }
      return { byPrefix, byAction };
    });
  }

  private accruals(): Map<string, Cents> {
    return this.cached("accruals", () => {
    const out = new Map<string, Cents>();
    const remaining = new Map<string, Cents>();
    // A held unknown payout is already booked as spent; a payout the board rejected is not owed.
    const held = new Set(this.unknownPayouts().map((u) => u.submissionId));
    const payoutStatuses = new Map<string, Action["status"][]>();
    for (const a of this.store.actions.list((x) => x.kind === "creator.payout")) {
      const id = (a.payload as { submissionId: string }).submissionId;
      payoutStatuses.set(id, [...(payoutStatuses.get(id) ?? []), a.status]);
    }
    const declined = (id: string) => {
      const statuses = payoutStatuses.get(id) ?? [];
      return statuses.includes("rejected") && !statuses.some((st) => PAYOUT_LIVE.includes(st));
    };
    const subs = this.store.submissions
      .list((s) => s.stage === "post_approved" && !held.has(s.id) && !declined(s.id))
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
    });
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
