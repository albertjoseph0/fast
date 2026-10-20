import { describe, expect, it } from "vitest";
import type { Action, AdDailyStats } from "../../src/core/types.ts";
import { BudgetExceededError } from "../../src/governance/ledger.ts";
import { START, adCampaign, campaign, makeWorld, metricsRow, submission } from "./fixtures.ts";

function executed(patch: Partial<Action>): Action {
  return {
    id: "act_900001",
    kind: "ads.campaign_create",
    ventureId: "ven_000001",
    summary: "",
    rationale: "",
    proposedBy: "allocator",
    payload: { adCampaignId: "adc_000001" },
    payloadHash: "h",
    idempotencyKey: "k",
    dedupeKey: "k",
    costCents: 0,
    findings: [],
    status: "executed",
    approvals: [],
    blockedByTaskIds: [],
    policyVersion: "t",
    createdAt: START,
    executedAt: START,
    ...patch,
  } as Action;
}

function adRow(date: string, spendCents: number): AdDailyStats {
  return { date, spendCents, impressions: 1000, taps: 10, installs: 2, conversions: null, revenueCents: null, attributionComplete: true };
}

describe("cost meter", () => {
  it("charges ai/media spend, tracks remaining and throws past the daily budget", () => {
    const { ledger, store } = makeWorld({ config: { llm: { maxDailyCents: 100 }, media: { maxDailyCents: 50 } } });
    ledger.charge({ kind: "llm", cents: 60, model: "claude", purpose: "ideas", ref: "call_1" });
    ledger.charge({ kind: "llm", cents: 60, model: "claude", purpose: "ideas", ref: "call_1" });
    expect(store.ledger()).toHaveLength(1);
    expect(store.ledger()[0]).toMatchObject({ sourceKey: "llm:call_1", category: "ai", amountCents: -60 });
    expect(ledger.remainingTodayCents("llm")).toBe(40);
    expect(ledger.remainingTodayCents("media")).toBe(50);
    expect(() => ledger.assertBudget("llm", 40)).not.toThrow();
    expect(() => ledger.assertBudget("llm", 41)).toThrow(BudgetExceededError);
    ledger.charge({ kind: "media", cents: 50, model: "img", purpose: "slides", ref: "m1", ventureId: "ven_000001" });
    expect(store.ledger()[1]).toMatchObject({ category: "media", ventureId: "ven_000001" });
    expect(() => ledger.assertBudget("media", 1)).toThrow(/media budget exceeded/);
  });

  it("resets the budget the next day", () => {
    const { ledger, clock } = makeWorld({ config: { llm: { maxDailyCents: 100 } } });
    ledger.charge({ kind: "llm", cents: 100, model: "m", purpose: "p", ref: "a" });
    expect(ledger.remainingTodayCents("llm")).toBe(0);
    clock.advanceDays(1);
    expect(ledger.remainingTodayCents("llm")).toBe(100);
  });
});

describe("revenue sync", () => {
  it("books venture-total rows only, idempotently, with fee/tax split and settlement lag", () => {
    const { ledger, store, config } = makeWorld();
    const rows = [
      metricsRow({ date: "2026-03-01", grossRevenueCents: 11_000, proceedsCents: 8_500, refundsCents: 700 }),
      metricsRow({ date: "2026-03-01", geo: "CA", grossRevenueCents: 5_000, proceedsCents: 4_000 }),
      metricsRow({ date: "2026-03-01", cellId: "cell_1", grossRevenueCents: 5_000, proceedsCents: 4_000 }),
    ];
    ledger.syncRevenue("ven_000001", rows);
    ledger.syncRevenue("ven_000001", rows);
    expect(store.ledger()).toHaveLength(2);
    const rev = store.ledger((e) => e.sourceKey === "rev:ven_000001:2026-03-01")[0];
    expect(rev).toMatchObject({ category: "revenue", amountCents: 8_500, grossCents: 11_000, settlesAt: "2026-04-15T00:00:00.000Z", at: "2026-03-01T00:00:00.000Z" });
    // proceeds = (gross - tax) x (1 - 15%): net of tax 10_000, fee 1_500, tax 1_000.
    expect(rev?.feeCents).toBe(1_500);
    expect(rev?.taxCents).toBe(1_000);
    expect(config.economics.settlementLagDays.ios).toBe(45);
    expect(store.ledger((e) => e.sourceKey === "refund:ven_000001:2026-03-01")[0]).toMatchObject({ category: "refunds", amountCents: -700 });
  });

  it("restates a day in place instead of duplicating", () => {
    const { ledger, store } = makeWorld();
    ledger.syncRevenue("ven_000001", [metricsRow({ grossRevenueCents: 1_000, proceedsCents: 850 })]);
    ledger.syncRevenue("ven_000001", [metricsRow({ grossRevenueCents: 2_000, proceedsCents: 1_700 })]);
    expect(store.ledger()).toHaveLength(1);
    expect(store.ledger()[0]?.amountCents).toBe(1_700);
    expect(store.recentEvents((e) => e.type === "ledger.booked")).toHaveLength(2);
  });

  it("counts proceeds in cash only after they settle", () => {
    const { ledger, config } = makeWorld();
    ledger.syncRevenue("ven_000001", [metricsRow({ date: "2026-03-01", grossRevenueCents: 10_000, proceedsCents: 8_000, refundsCents: 500 })]);
    const start = config.budgets.startingCashCents;
    expect(ledger.cash("2026-03-02T00:00:00.000Z")).toBe(start - 500);
    expect(ledger.cash("2026-04-14T23:59:59.000Z")).toBe(start - 500);
    expect(ledger.cash("2026-04-15T00:00:00.000Z")).toBe(start - 500 + 8_000);
  });
});

describe("ads, payouts and inference", () => {
  it("syncs ad spend idempotently", () => {
    const { ledger, store } = makeWorld();
    const c = adCampaign({ externalId: "m1", status: "active", actionId: "act_000009" });
    ledger.syncAds(c, [adRow("2026-03-01", 4_000), adRow("2026-03-02", 3_000)]);
    ledger.syncAds(c, [adRow("2026-03-02", 3_500)]);
    expect(store.ledger().map((e) => [e.sourceKey, e.amountCents, e.category, e.actionId])).toEqual([
      ["ads:meta:m1:2026-03-01", -4_000, "ads", "act_000009"],
      ["ads:meta:m1:2026-03-02", -3_500, "ads", "act_000009"],
    ]);
  });

  it("books payouts and inference", () => {
    const { ledger, store } = makeWorld();
    store.campaigns.put(campaign({ cellId: "cell_1" }));
    store.submissions.put(submission());
    ledger.onPayout({ id: "pay_000001", submissionId: "sub_000001", amountCents: 7_500, idempotencyKey: "k", basis: { views: 40_000, viewsAsOf: START, flatFeeCents: 1_500, cpmCents: 150, capCents: 15_000 }, at: START }, "ven_000001");
    ledger.onPayout({ id: "pay_000001", submissionId: "sub_000001", amountCents: 7_500, idempotencyKey: "k", basis: { views: 40_000, viewsAsOf: START, flatFeeCents: 1_500, cpmCents: 150, capCents: 15_000 }, at: START }, "ven_000001");
    ledger.bookInference("ven_000001", "2026-03-01", 300);
    expect(store.ledger().map((e) => [e.sourceKey, e.category, e.amountCents])).toEqual([
      ["payout:pay_000001", "creators", -7_500],
      ["inference:ven_000001:2026-03-01", "inference", -300],
    ]);
    expect(store.ledger()[0]?.cellId).toBe("cell_1");
  });
});

describe("free cash", () => {
  it("subtracts daily commitments to their end and lifetime caps net of spend", () => {
    const { ledger, store } = makeWorld();
    store.adCampaigns.put(adCampaign({ externalId: "m1", status: "active" }));
    store.adCampaigns.put(adCampaign({ id: "adc_000002", externalId: "m2", status: "active" }));
    const actions = store.governanceActions();
    actions.put(
      executed({
        id: "act_000001",
        commitment: { kind: "daily", amountCents: 5_000, maxTotalCents: 15_000, startsAt: "2026-03-02T00:00:00.000Z", endsAt: "2026-03-05T00:00:00.000Z" },
      }),
    );
    actions.put(
      executed({
        id: "act_000002",
        payload: { adCampaignId: "adc_000002" },
        commitment: { kind: "lifetime_cap", amountCents: 0, maxTotalCents: 30_000, startsAt: START },
      }),
    );
    ledger.syncAds(adCampaign({ id: "adc_000002", externalId: "m2" }), [adRow("2026-03-01", 10_000)]);
    // 3 days remain on act_000001 from 09:00 on 03-02 to 03-05 (ceil 2.6 days = 3) -> 15_000; 30_000 - 10_000 on act_000002.
    expect(ledger.outstandingCommitments(START)).toBe(15_000 + 20_000);
    expect(ledger.outstandingCommitments("2026-03-04T12:00:00.000Z")).toBe(5_000 + 20_000);
    expect(ledger.outstandingCommitments("2026-03-06T00:00:00.000Z")).toBe(20_000);
  });

  it("lets a later budget change supersede and ignores paused campaigns and non-executed actions", () => {
    const { ledger, store } = makeWorld();
    store.adCampaigns.put(adCampaign({ externalId: "m1", status: "active" }));
    const actions = store.governanceActions();
    const daily = (amount: number) => ({ kind: "daily" as const, amountCents: amount, maxTotalCents: 0, startsAt: START, endsAt: "2026-03-04T09:00:00.000Z" });
    actions.put(executed({ id: "act_000001", commitment: daily(5_000), executedAt: START }));
    actions.put(executed({ id: "act_000002", kind: "ads.budget_change", commitment: daily(6_000), executedAt: "2026-03-02T10:00:00.000Z" }));
    actions.put(executed({ id: "act_000003", status: "dry_run", payload: { adCampaignId: "adc_x" }, commitment: daily(9_999) }));
    expect(ledger.outstandingCommitments(START)).toBe(12_000);
    store.adCampaigns.put(adCampaign({ externalId: "m1", status: "paused" }));
    expect(ledger.outstandingCommitments(START)).toBe(0);
  });

  it("accrues approved, unpaid creator submissions within the campaign budget", () => {
    const { ledger, store } = makeWorld();
    store.campaigns.put(campaign({ budgetCents: 10_000 }));
    store.submissions.put(submission({ id: "sub_000001", viewsAtLock: 40_000 }));
    store.submissions.put(submission({ id: "sub_000002", viewsAtLock: undefined, verification: { fetchedAt: START, postIsPublic: true, authorHandleMatches: true, platformDisclosureLabel: true, viewsFromPlatform: 10_000 } }));
    store.submissions.put(submission({ id: "sub_000003", stage: "posted" }));
    // 7_500 for sub 1, then 1_500 + 1_500 = 3_000 capped at the 2_500 left.
    expect(ledger.accruedFor("sub_000001")).toBe(7_500);
    expect(ledger.accruedFor("sub_000002")).toBe(2_500);
    expect(ledger.accruedFor("sub_000003")).toBe(0);
    expect(ledger.accruedLiabilities()).toBe(10_000);
  });

  it("does not double count a creator campaign commitment and its accruals", () => {
    const { ledger, store } = makeWorld();
    store.campaigns.put(campaign({ budgetCents: 50_000 }));
    store.submissions.put(submission());
    store.governanceActions().put(
      executed({ kind: "creator.campaign_create", payload: { campaignId: "ccmp_000001" }, commitment: { kind: "lifetime_cap", amountCents: 0, maxTotalCents: 50_000, startsAt: START } }),
    );
    expect(ledger.accruedLiabilities() + ledger.outstandingCommitments(START)).toBe(50_000);
  });

  it("nets refunds already booked out of the refund reserve: they have left cash", () => {
    const { ledger } = makeWorld();
    ledger.syncRevenue("ven_000001", [metricsRow({ date: "2026-02-20", grossRevenueCents: 100_000, proceedsCents: 80_000, refundsCents: 3_000 })]);
    expect(ledger.refundReserve(START)).toBe(Math.ceil(0.083 * 100_000) - 3_000);
    ledger.syncRevenue("ven_000001", [metricsRow({ date: "2026-02-21", grossRevenueCents: 0, proceedsCents: 0, refundsCents: 9_000 })]);
    expect(ledger.refundReserve(START)).toBe(0);
  });

  it("computes refund reserve, burn reserve, free cash and the daily cap", () => {
    const { ledger, store, config } = makeWorld({ config: { budgets: { startingCashCents: 2_000_000, reserveFloorCents: 100_000, reserveFixedBurnDays: 90 } } });
    ledger.syncRevenue("ven_000001", [metricsRow({ date: "2026-02-20", grossRevenueCents: 100_000, proceedsCents: 80_000 })]);
    ledger.syncRevenue("ven_000001", [metricsRow({ date: "2025-10-01", grossRevenueCents: 900_000, proceedsCents: 700_000 })]);
    expect(ledger.refundReserve(START)).toBe(Math.ceil(0.083 * 100_000));
    expect(ledger.reserve(START)).toBe(100_000);
    store.book({ sourceKey: "infra:feb", category: "infra", amountCents: -60_000, memo: "hosting", at: "2026-02-15T00:00:00.000Z" });
    // 60_000 / 30 days x 90 days.
    expect(ledger.reserve(START)).toBe(180_000);
    const cash = ledger.cash(START);
    expect(cash).toBe(2_000_000 + 700_000 - 60_000);
    expect(ledger.freeCash(START)).toBe(cash - 8_300);
    expect(ledger.dailySpendCap(START)).toBe(Math.min(config.budgets.dailySpendCapCents, Math.floor(0.07 * (cash - 8_300))));
  });

  it("reports distribution spend booked today", () => {
    const { ledger, store } = makeWorld();
    ledger.syncAds(adCampaign({ externalId: "m1" }), [adRow("2026-03-02", 4_000), adRow("2026-03-01", 9_000)]);
    store.book({ sourceKey: "payout:x", category: "creators", amountCents: -1_000, memo: "", at: "2026-03-02T10:00:00.000Z" });
    store.book({ sourceKey: "llm:x", category: "ai", amountCents: -999, memo: "", at: "2026-03-02T10:00:00.000Z" });
    expect(ledger.spentToday("2026-03-02")).toBe(5_000);
  });

  it("caps the daily spend by free cash share and never goes negative", () => {
    const { ledger } = makeWorld({ config: { budgets: { startingCashCents: 0 } } });
    expect(ledger.dailySpendCap(START)).toBe(0);
  });
});

describe("review regressions", () => {
  const campaignCreate = (maxTotalCents: number) =>
    executed({ kind: "creator.campaign_create", payload: { campaignId: "ccmp_000001" }, commitment: { kind: "lifetime_cap", amountCents: maxTotalCents, maxTotalCents, startsAt: START } });
  const payout = (patch: Partial<Action> = {}) =>
    executed({
      id: "act_000010",
      kind: "creator.payout",
      payload: { submissionId: "sub_000001", amountCents: 7_500, basis: { views: 40_000, viewsAsOf: START, flatFeeCents: 1_500, cpmCents: 150, capCents: 15_000 } },
      status: "failed",
      ...patch,
    }) as Action<"creator.payout">;

  it("#5 a closed creator campaign keeps the commitment its in-flight submissions may still earn", () => {
    const { ledger, store } = makeWorld();
    store.campaigns.put(campaign({ budgetCents: 75_000, status: "closed" }));
    store.governanceActions().put(campaignCreate(75_000));
    store.submissions.put(submission({ id: "sub_000001", stage: "draft_approved" }));
    store.submissions.put(submission({ id: "sub_000002", stage: "posted" }));
    store.submissions.put(submission({ id: "sub_000003", stage: "rejected" }));
    // Two in flight at up to 15,000 each.
    expect(ledger.outstandingCommitments(START)).toBe(30_000);
    store.submissions.put(submission({ id: "sub_000002", stage: "rejected" }));
    expect(ledger.outstandingCommitments(START)).toBe(15_000);
    store.submissions.put(submission({ id: "sub_000001", stage: "rejected" }));
    expect(ledger.outstandingCommitments(START)).toBe(0);
  });

  it("#5 the in-flight hold never exceeds what the campaign has left", () => {
    const { ledger, store } = makeWorld();
    store.campaigns.put(campaign({ budgetCents: 20_000, status: "closed" }));
    store.governanceActions().put(campaignCreate(20_000));
    store.submissions.put(submission({ id: "sub_000001", stage: "post_approved" }));
    for (const id of ["sub_000002", "sub_000003"]) store.submissions.put(submission({ id, stage: "posted" }));
    // 7,500 accrued on sub 1 leaves 12,500 of the cap for the two in-flight posts.
    expect(ledger.outstandingCommitments(START)).toBe(12_500);
  });

  it("#2 a payout of unknown outcome is booked as paid until released", () => {
    const { ledger, store } = makeWorld();
    store.campaigns.put(campaign());
    store.submissions.put(submission());
    const a = store.governanceActions().put(payout()) as Action<"creator.payout">;
    const before = ledger.freeCash(START);
    const cash = ledger.cash(START);
    expect(ledger.accruedFor("sub_000001")).toBe(7_500);
    ledger.holdUnknownPayout(a);
    expect(ledger.cash(START)).toBe(cash - 7_500);
    expect(ledger.paidOnCampaign("ccmp_000001")).toBe(7_500);
    expect(ledger.accruedFor("sub_000001")).toBe(0);
    expect(ledger.freeCash(START)).toBe(before);
    expect(ledger.spentToday()).toBe(7_500);
    expect(ledger.unknownPayouts()).toEqual([{ actionId: a.id, submissionId: "sub_000001", amountCents: 7_500, at: START }]);
    ledger.releaseUnknownPayout(a.id);
    expect(ledger.cash(START)).toBe(cash);
    expect(ledger.paidOnCampaign("ccmp_000001")).toBe(0);
    expect(ledger.accruedFor("sub_000001")).toBe(7_500);
    expect(ledger.unknownPayouts()).toEqual([]);
  });

  it("#9 a submission whose payout the board rejected is no longer accrued", () => {
    const { ledger, store } = makeWorld();
    store.campaigns.put(campaign());
    store.submissions.put(submission());
    store.governanceActions().put(payout({ status: "rejected" }));
    expect(ledger.accruedFor("sub_000001")).toBe(0);
    // A new open payout for it makes the liability live again.
    store.governanceActions().put(payout({ id: "act_000011", status: "awaiting_approval" }));
    expect(ledger.accruedFor("sub_000001")).toBe(7_500);
  });
});
