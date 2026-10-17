import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProposeInput } from "../../src/core/context.ts";
import type { Action, ActionKind, ActionPayloads, ContentPiece, PolicyFinding } from "../../src/core/types.ts";
import { POLICY_VERSION, RULES, evaluateAction, statusFor } from "../../src/governance/policy.ts";
import {
  IDEA,
  START,
  account,
  adCampaign,
  campaign,
  creator,
  input,
  makeVenture,
  makeWorld,
  metricsRow,
  piece,
  publishInput,
  screening,
  submission,
  type World,
} from "./fixtures.ts";

function propose<K extends ActionKind>(w: World, i: ProposeInput<K>): Action<K> {
  return w.gov.propose(i);
}

function hits(a: Action, ruleId: string): PolicyFinding[] {
  return a.findings.filter((f) => f.ruleId === ruleId);
}

function severities(a: Action, ruleId: string): PolicyFinding["severity"][] {
  return hits(a, ruleId).map((f) => f.severity);
}

let seq = 0;
function key(): string {
  return `k${++seq}`;
}

/** An executed (or other status) action placed directly in the store, as history for a rule. */
function history<K extends ActionKind>(w: World, kind: K, payload: ActionPayloads[K], patch: Partial<Action> = {}): Action {
  const a = {
    id: w.store.nextId("action"),
    kind,
    ventureId: "ven_000001",
    summary: "",
    rationale: "",
    proposedBy: "orchestrator",
    payload,
    payloadHash: "h",
    idempotencyKey: key(),
    dedupeKey: key(),
    costCents: 0,
    findings: [],
    status: "executed",
    approvals: [],
    blockedByTaskIds: [],
    policyVersion: POLICY_VERSION,
    createdAt: START,
    executedAt: START,
    ...patch,
  } as Action;
  return w.store.governanceActions().put(a);
}

describe("rule registry", () => {
  it("every rule has a citation and unique id", () => {
    expect(new Set(RULES.map((r) => r.id)).size).toBe(RULES.length);
    for (const r of RULES) expect(r.citation.length).toBeGreaterThan(5);
  });
});

describe("statusFor", () => {
  const base = { blockedByTaskIds: [], approvals: [], payloadHash: "h1" } as unknown as Action;
  const nh: PolicyFinding = { ruleId: "x", severity: "needs_human", message: "" };
  const block: PolicyFinding = { ruleId: "y", severity: "block", message: "" };

  it("orders block > task > approval > approved", () => {
    expect(statusFor({ ...base, blockedByTaskIds: ["t"] }, [block, nh])).toBe("blocked");
    expect(statusFor({ ...base, blockedByTaskIds: ["t"] }, [nh])).toBe("awaiting_human_task");
    expect(statusFor(base, [nh])).toBe("awaiting_approval");
    expect(statusFor({ ...base, approvals: [{ approver: "owner", payloadHash: "h1", at: START, channel: "cli" }] }, [nh])).toBe("approved");
    expect(statusFor({ ...base, approvals: [{ approver: "owner", payloadHash: "old", at: START, channel: "cli" }] }, [nh])).toBe("awaiting_approval");
    expect(statusFor(base, [{ ruleId: "z", severity: "warn", message: "" }])).toBe("approved");
  });
});

describe("global rules", () => {
  it("kill switch blocks everything", () => {
    const dir = mkdtempSync(join(tmpdir(), "gov-ks-"));
    const path = join(dir, "STOP");
    const w = makeWorld({ killSwitchPath: path });
    expect(propose(w, input("venture.exit_flag", { holdNpvCents: 1, saleEstimateCents: 1, rationale: "r" })).status).toBe("approved");
    writeFileSync(path, "stop");
    const a = propose(w, input("venture.exit_flag", { holdNpvCents: 1, saleEstimateCents: 1, rationale: "r" }, { naturalKey: key() }));
    expect(a.status).toBe("blocked");
    expect(severities(a, "kill_switch")).toEqual(["block"]);
  });

  it("freezes block actions in their scope only", () => {
    const w = makeWorld();
    w.store.freeze({ scope: "platform:tiktok", reason: "strike", at: START, by: "owner" });
    w.store.accounts.put(account({ platform: "tiktok" }));
    const tiktok = piece({ platform: "tiktok" });
    w.store.content.put(tiktok);
    const blocked = propose(w, { ...publishInput(tiktok, account({ platform: "tiktok" }), START), payload: { ...publishInput(tiktok, account({ platform: "tiktok" }), START).payload, mode: "inbox_draft" } });
    expect(severities(blocked, "freeze")).toEqual(["block"]);
    expect(severities(propose(w, input("store.release", { platform: "ios", phased: true })), "freeze")).toEqual([]);
    w.store.freeze({ scope: "venture:ven_000001", reason: "tripwire", at: START, by: "owner" });
    expect(severities(propose(w, input("store.release", { platform: "ios", phased: true }, { naturalKey: key() })), "freeze")).toEqual(["block"]);
  });

  it("requires a known venture for venture-scoped kinds", () => {
    const w = makeWorld();
    expect(severities(propose(w, input("venture.kill", { reason: "r" }, { ventureId: "ven_999999" })), "venture.exists")).toEqual(["block"]);
    expect(severities(propose(w, input("store.release", { platform: "ios", phased: false }, { ventureId: undefined })), "venture.exists")).toEqual(["block"]);
    expect(severities(propose(w, input("support.reply", { ticketId: "t", reply: "Hi, this is an AI assistant.", aiDisclosed: true }, { ventureId: undefined })), "venture.exists")).toEqual([]);
  });

  it("hard cap blocks costs above the cap", () => {
    const w = makeWorld();
    const over = propose(w, input("venture.scale", { evidence: "e", experimentIds: [], proposedDailyCents: 1, addTerritories: [] }, { costCents: 250_001 }));
    expect(severities(over, "hard_cap")).toEqual(["block"]);
    const at = propose(w, input("venture.scale", { evidence: "e", experimentIds: [], proposedDailyCents: 1, addTerritories: [] }, { costCents: 250_000, naturalKey: key() }));
    expect(severities(at, "hard_cap")).toEqual([]);
  });

  it("reserve blocks money actions above free cash minus reserve", () => {
    const w = makeWorld({ config: { budgets: { startingCashCents: 800_000, reserveFloorCents: 750_000 } } });
    const ok = propose(w, input("ads.budget_change", { adCampaignId: "adc_000001", fromDailyCents: 1, toDailyCents: 1, evidence: "" }, { costCents: 50_000 }));
    expect(severities(ok, "reserve")).toEqual([]);
    const over = propose(w, input("ads.budget_change", { adCampaignId: "adc_000001", fromDailyCents: 1, toDailyCents: 1, evidence: "" }, { costCents: 50_001, naturalKey: key() }));
    expect(severities(over, "reserve")).toEqual(["block"]);
    expect(severities(propose(w, input("venture.kill", { reason: "r" }, { costCents: 999_999 })), "reserve")).toEqual([]);
  });

  it("reserve does not double count the liability a payout settles", () => {
    const w = makeWorld({ config: { budgets: { startingCashCents: 750_000 + 7_500, reserveFloorCents: 750_000 } } });
    w.store.campaigns.put(campaign());
    w.store.submissions.put(submission());
    w.store.creators.put(creator({ firstPaidAt: START }));
    expect(w.ledger.freeCash(START) - w.ledger.reserve(START)).toBe(0);
    const pay = propose(w, payoutInput());
    expect(severities(pay, "reserve")).toEqual([]);
  });

  it("daily cap blocks daily and same-day one-time commitments over the cap", () => {
    const w = makeWorld();
    const cap = w.ledger.dailySpendCap(START);
    expect(cap).toBe(150_000);
    w.store.book({ sourceKey: "payout:x", category: "creators", amountCents: -100_000, memo: "", at: START });
    const commit = (kind: "daily" | "one_time", amount: number, startsAt = START) => ({ kind, amountCents: amount, maxTotalCents: amount, startsAt });
    const under = propose(w, input("ads.budget_change", { adCampaignId: "a", fromDailyCents: 1, toDailyCents: 1, evidence: "" }, { commitment: commit("daily", 50_000), costCents: 0 }));
    expect(severities(under, "daily_cap")).toEqual([]);
    const over = propose(w, input("ads.budget_change", { adCampaignId: "a", fromDailyCents: 1, toDailyCents: 1, evidence: "" }, { commitment: commit("daily", 50_001), costCents: 0, naturalKey: key() }));
    expect(severities(over, "daily_cap")).toEqual(["block"]);
    const today = propose(w, input("creator.deal_offer", { dealId: "d" }, { commitment: commit("one_time", 60_000), costCents: 0 }));
    expect(severities(today, "daily_cap")).toEqual(["block"]);
    const later = propose(w, input("creator.deal_offer", { dealId: "d" }, { commitment: commit("one_time", 60_000, "2026-03-09T00:00:00.000Z"), costCents: 0, naturalKey: key() }));
    expect(severities(later, "daily_cap")).toEqual([]);
  });

  it("always-approve kinds need a human", () => {
    const w = makeWorld();
    const a = propose(w, input("venture.sunset", { activeSubscribers: 3, plan: "serve_until_lapse", reason: "decay" }));
    expect(severities(a, "always_approve")).toEqual(["needs_human"]);
    expect(a.status).toBe("awaiting_approval");
    expect(severities(propose(w, input("venture.exit_flag", { holdNpvCents: 1, saleEstimateCents: 1, rationale: "" })), "always_approve")).toEqual([]);
  });

  it("auto-approve thresholds use the per-kind value, else the default", () => {
    const w = makeWorld();
    const kill = (cost: number) => propose(w, input("venture.kill", { reason: "r" }, { costCents: cost, naturalKey: key() }));
    expect(severities(kill(25_000), "auto_approve_threshold")).toEqual([]);
    expect(severities(kill(25_001), "auto_approve_threshold")).toEqual(["needs_human"]);
    const adBudget = (cost: number) => propose(w, input("ads.budget_change", { adCampaignId: "a", fromDailyCents: 1, toDailyCents: 1, evidence: "" }, { costCents: cost, naturalKey: key() }));
    expect(severities(adBudget(20_000), "auto_approve_threshold")).toEqual([]);
    expect(severities(adBudget(20_001), "auto_approve_threshold")).toEqual(["needs_human"]);
  });
});

describe("store rules", () => {
  const submit = (extra: Partial<ActionPayloads["store.submit_review"]> = {}) =>
    input("store.submit_review", { platform: "ios", storeBuildId: "b1", notesForReviewer: "n", ...extra }, { naturalKey: key() });

  it("first submission and resubmission after rejection need a human", () => {
    const w = makeWorld();
    expect(severities(propose(w, submit()), "store.first_submission")).toEqual(["needs_human"]);
    history(w, "store.submit_review", { platform: "ios", storeBuildId: "b0", notesForReviewer: "" });
    expect(severities(propose(w, submit()), "store.first_submission")).toEqual([]);
    w.store.ventures.put(makeVenture({ stores: [{ ...makeVenture().stores[0]!, status: "rejected", rejectionReasons: ["4.3 spam"] }] }));
    const resubmit = propose(w, submit());
    expect(severities(resubmit, "store.first_submission")).toEqual(["needs_human"]);
    expect(hits(resubmit, "store.first_submission")[0]?.message).toMatch(/4\.3 spam/);
    w.store.ventures.put(makeVenture({ stores: [{ ...makeVenture().stores[0]!, status: "waiting_for_review", rejectionReasons: ["old"] }] }));
    expect(severities(propose(w, submit()), "store.first_submission")).toEqual(["needs_human"]);
  });

  it("significant changes need a human; copy-only updates do not", () => {
    const w = makeWorld();
    expect(severities(propose(w, submit({ changedAreas: ["copy", "other"] })), "store.significant_change")).toEqual([]);
    expect(severities(propose(w, submit({ changedAreas: ["copy", "monetization"] })), "store.significant_change")).toEqual(["needs_human"]);
  });

  it("territories outside test geos need a human; EU/UK block unless enabled", () => {
    const w = makeWorld();
    const terr = (t: string[]) => propose(w, input("store.set_territories", { platform: "ios", territories: t }, { naturalKey: key() }));
    expect(terr(["CA", "AU", "NZ"]).findings).toEqual([]);
    expect(severities(terr(["CA", "US"]), "store.territories")).toEqual(["needs_human"]);
    expect(severities(terr(["GB"]), "store.territories")).toEqual(["needs_human", "block"]);
    expect(severities(terr(["DE"]), "store.territories")).toContain("block");
    w.store.ventures.put(makeVenture({ stage: "scaling" }));
    expect(severities(terr(["CA", "US"]), "store.territories")).toEqual([]);
    const eu = makeWorld({ config: { privacy: { euUkEnabled: true } } });
    expect(severities(eu.gov.propose(input("store.set_territories", { platform: "ios", territories: ["GB"] })), "store.territories")).toEqual(["needs_human"]);
  });

  const listing = (patch: Partial<ActionPayloads["store.update_listing"]["listing"]> = {}) => ({
    locale: "en-US",
    name: "Astra",
    subtitle: "Compatibility verdicts",
    description: "Get a verdict on any match.",
    keywords: "astrology,compatibility",
    promotionalText: "New readings daily",
    supportUrl: "https://astra.example.com/support",
    privacyUrl: "https://astra.example.com/privacy",
    ...patch,
  });

  it("listing needs bound legal URLs and claim-free copy", () => {
    const w = makeWorld();
    const update = (l = listing()) => propose(w, input("store.update_listing", { platform: "ios", listing: l, screenshotPaths: [] }, { naturalKey: key() }));
    expect(update().findings).toEqual([]);
    const linted = update(listing({ description: "The #1 astrology app with 2 million users" }));
    expect(linted.findings.map((f) => f.ruleId)).toEqual(expect.arrayContaining(["copy.unverified_count", "copy.unverified_ranking"]));
    expect(linted.status).toBe("blocked");
    expect(severities(update(listing({ privacyUrl: "" })), "store.listing")).toEqual(["block"]);
    w.store.ventures.put(makeVenture({ bindings: { ...makeVenture().bindings, supportUrl: undefined } }));
    expect(severities(update(), "store.listing")).toEqual(["block"]);
  });

  it("approved claims are exempt from listing lint", () => {
    const w = makeWorld();
    w.store.claims.put({
      id: "clm_000001",
      ventureId: "ven_000001",
      kind: "user_count",
      text: "2 million users",
      evidence: { source: "metrics", value: 2_000_000, asOf: START },
      expiresAt: "2026-12-01T00:00:00.000Z",
      approvedBy: "owner",
    });
    const a = propose(w, input("store.update_listing", { platform: "ios", listing: listing({ description: "Loved by 2 million users" }), screenshotPaths: [] }));
    expect(a.findings).toEqual([]);
  });

  it("create_app needs an active bound publisher account", () => {
    const w = makeWorld();
    const create = (platform: "ios" | "android") =>
      propose(w, input("store.create_app", { platform, bundleId: "b", name: "Astra", sku: "astra", primaryLocale: "en-US" }, { naturalKey: key() }));
    expect(severities(create("ios"), "store.publisher")).toEqual([]);
    w.store.publishers.put({ ...w.store.publishers.require("pub_android"), status: "suspended" });
    expect(severities(create("android"), "store.publisher")).toEqual(["block"]);
    w.store.ventures.put(makeVenture({ bindings: { ...makeVenture().bindings, publisherAccountIds: {} } }));
    expect(severities(create("ios"), "store.publisher")).toEqual(["block"]);
  });
});

describe("content.publish rules", () => {
  function setup(p: ContentPiece = piece(), acctPatch = {}) {
    const w = makeWorld();
    const acct = w.store.accounts.put(account({ platform: p.platform, ...acctPatch }));
    w.store.content.put(p);
    return { w, acct, p };
  }

  it("passes with an active consented account and derived labels", () => {
    const { w, acct, p } = setup();
    const a = propose(w, publishInput(p, acct, START));
    expect(a.findings).toEqual([]);
    expect(a.status).toBe("approved");
  });

  it("blocks inactive, unconsented or mismatched accounts", () => {
    const expired = setup(piece(), { standingConsent: { scopes: [], grantedAt: START, expiresAt: START, grantedBy: "owner" } });
    expect(severities(propose(expired.w, publishInput(expired.p, expired.acct, START)), "content.account")).toEqual(["block"]);
    const restricted = setup(piece(), { status: "restricted" });
    expect(severities(propose(restricted.w, publishInput(restricted.p, restricted.acct, START)), "content.account")).toEqual(["block"]);
    const { w, p } = setup();
    const missing = propose(w, { ...publishInput(p, account(), START), payload: { ...publishInput(p, account(), START).payload, accountId: "acct_x" } });
    expect(severities(missing, "content.account")).toEqual(["block"]);
  });

  it("blocks labels that differ from derived disclosure, and swapped media", () => {
    const { w, acct, p } = setup();
    const good = publishInput(p, acct, START);
    const bad = propose(w, { ...good, payload: { ...good.payload, labels: { instagram: { is_ai_generated: false, is_paid_partnership: false } } } });
    expect(severities(bad, "content.labels")).toEqual(["block"]);
    const swapped = propose(w, { ...good, naturalKey: key(), payload: { ...good.payload, mediaSha256: ["other"] } });
    expect(severities(swapped, "content.labels")).toEqual(["block"]);
  });

  it("blocks direct TikTok posting until audited", () => {
    const { w, acct, p } = setup(piece({ platform: "tiktok" }));
    const direct = propose(w, publishInput(p, acct, START));
    expect(severities(direct, "content.tiktok_audit")).toEqual(["block"]);
    const draft = publishInput(p, acct, START, key());
    expect(severities(propose(w, { ...draft, payload: { ...draft.payload, mode: "inbox_draft" } }), "content.tiktok_audit")).toEqual([]);
    const audited = makeWorld({ config: { distribution: { tiktokAudited: true } } });
    audited.store.accounts.put(acct);
    audited.store.content.put(p);
    expect(severities(audited.gov.propose(publishInput(p, acct, START)), "content.tiktok_audit")).toEqual([]);
  });

  it("enforces per-day caps and minimum spacing", () => {
    const { w, acct, p } = setup();
    const post = (at: string, status: Action["status"] = "executed") =>
      history(w, "content.publish", { ...publishInput(p, acct, START).payload, contentId: "cnt_other" }, { executedAt: at, status });
    post("2026-03-01T10:00:00.000Z");
    post("2026-03-02T04:00:00.000Z", "dry_run");
    const probe = propose(w, publishInput(p, acct, START, key()));
    expect(probe.findings).toEqual([]);
    // An approved post counts against the cap until it is cancelled.
    expect(hits(propose(w, publishInput(p, acct, START, key())), "content.post_caps")).toHaveLength(2);
    w.gov.cancel(probe.id, "test");
    post("2026-03-02T08:00:00.000Z");
    post("2026-03-02T07:00:00.000Z", "failed");
    expect(hits(propose(w, publishInput(p, acct, START, key())), "content.post_caps").map((f) => f.message)).toEqual([
      expect.stringMatching(/3 posts in 24h already reach the cap of 3/),
      expect.stringMatching(/60 minutes ago; minimum is 120/),
    ]);
    w.clock.advanceHours(2);
    expect(propose(w, publishInput(p, acct, w.clock.iso(), key())).findings).toEqual([]);
  });

  it("caps near-duplicates per account per 7 days", () => {
    const { w, acct, p } = setup();
    w.store.content.put(piece({ id: "cnt_dup1" }));
    w.store.content.put(piece({ id: "cnt_dup2" }));
    const prior = (contentId: string, at: string) => history(w, "content.publish", { ...publishInput(p, acct, START).payload, contentId }, { executedAt: at });
    prior("cnt_dup1", "2026-02-25T09:00:00.000Z");
    expect(severities(propose(w, publishInput(p, acct, START, key())), "content.near_duplicate")).toEqual([]);
    prior("cnt_dup2", "2026-02-26T09:00:00.000Z");
    expect(severities(propose(w, publishInput(p, acct, START, key())), "content.near_duplicate")).toEqual(["block"]);
    w.clock.advanceDays(5);
    expect(severities(propose(w, publishInput(p, acct, w.clock.iso(), key())), "content.near_duplicate")).toEqual([]);
  });

  it("lints hook, caption and slide text", () => {
    const p = piece();
    p.draft.slides = [{ text: "Rated 4.9 stars", imagePrompt: "glyphs", isAppReveal: true }];
    p.draft.caption = "Only $4.99 a week";
    const { w, acct } = setup(p);
    const a = propose(w, publishInput(p, acct, START));
    expect(a.findings.map((f) => f.ruleId).sort()).toEqual(["copy.currency_literal", "copy.unverified_rating"]);
    expect(a.findings[0]?.message).toMatch(/draft\./);
  });
});

function payoutInput(amount = 7_500, basis: Partial<ActionPayloads["creator.payout"]["basis"]> = {}): ProposeInput<"creator.payout"> {
  return input(
    "creator.payout",
    { submissionId: "sub_000001", amountCents: amount, basis: { views: 40_000, viewsAsOf: START, flatFeeCents: 1_500, cpmCents: 150, capCents: 15_000, ...basis } },
    { naturalKey: key(), costCents: amount, commitment: { kind: "settles_liability", amountCents: amount, maxTotalCents: amount, startsAt: START, liabilityRef: "sub_000001" } },
  );
}

describe("creator.payout rules", () => {
  function setup(sub = submission(), cre = creator({ firstPaidAt: "2026-01-01T00:00:00.000Z" })) {
    const w = makeWorld();
    w.store.campaigns.put(campaign());
    w.store.submissions.put(sub);
    w.store.creators.put(cre);
    return w;
  }

  it("approves a verified, view-locked, correctly computed payout", () => {
    const a = propose(setup(), payoutInput());
    expect(a.findings).toEqual([]);
    expect(a.status).toBe("approved");
  });

  it.each([
    ["stage", submission({ stage: "posted" })],
    ["not public", submission({ verification: { ...submission().verification!, postIsPublic: false } })],
    ["author", submission({ verification: { ...submission().verification!, authorHandleMatches: false } })],
    ["no label", submission({ verification: { ...submission().verification!, platformDisclosureLabel: false } })],
    ["no verification", submission({ verification: undefined })],
    ["review veto", submission({ review: { approve: false, injectionAttempt: false, policyIssues: [], note: "" } })],
    ["injection", submission({ review: { approve: true, injectionAttempt: true, policyIssues: [], note: "" } })],
    ["view lock", submission({ postedAt: "2026-02-26T09:00:00.000Z" })],
    ["no lock views", submission({ viewsAtLock: undefined })],
  ])("blocks when %s fails", (_label, sub) => {
    const a = propose(setup(sub), payoutInput());
    expect(severities(a, "creator.payout_eligibility")).toContain("block");
    expect(a.status).toBe("blocked");
  });

  it("blocks an amount or basis that differs from the recomputation", () => {
    expect(severities(propose(setup(), payoutInput(7_501)), "creator.payout_eligibility")).toEqual(["block"]);
    expect(severities(propose(setup(), payoutInput(7_500, { cpmCents: 151 })), "creator.payout_eligibility")).toEqual(["block"]);
  });

  it("recomputes against the campaign budget already paid", () => {
    const w = setup();
    w.store.campaigns.put(campaign({ budgetCents: 10_000 }));
    w.store.submissions.put(submission({ id: "sub_000009", stage: "paid" }));
    w.store.payouts.put({ id: "pay_000001", submissionId: "sub_000009", amountCents: 6_000, idempotencyKey: "x", basis: { views: 0, viewsAsOf: START, flatFeeCents: 0, cpmCents: 0, capCents: 0 }, at: START });
    w.store.book({ sourceKey: "payout:pay_000001", category: "creators", amountCents: -6_000, memo: "", at: START });
    expect(severities(w.gov.propose(payoutInput(7_500)), "creator.payout_eligibility")).toEqual(["block"]);
    expect(severities(w.gov.propose(payoutInput(4_000)), "creator.payout_eligibility")).toEqual([]);
  });

  it("blocks paying a submission twice", () => {
    const w = setup();
    w.store.payouts.put({ id: "pay_000001", submissionId: "sub_000001", amountCents: 7_500, idempotencyKey: "x", basis: { views: 0, viewsAsOf: START, flatFeeCents: 0, cpmCents: 0, capCents: 0 }, at: START });
    expect(hits(w.gov.propose(payoutInput()), "creator.payout_eligibility").map((f) => f.message)).toContain("Submission was already paid");
  });

  it("first payout to a new creator needs a human", () => {
    const a = propose(setup(submission(), creator()), payoutInput());
    expect(severities(a, "creator.first_payout")).toEqual(["needs_human"]);
    expect(a.status).toBe("awaiting_approval");
    const off = makeWorld({ config: { creators: { firstPayoutToNewCreatorNeedsHuman: false } } });
    off.store.campaigns.put(campaign());
    off.store.submissions.put(submission());
    off.store.creators.put(creator());
    expect(severities(off.gov.propose(payoutInput()), "creator.first_payout")).toEqual([]);
  });

  it("payouts over the 30-day per-creator cap need a human", () => {
    const w = setup();
    w.store.submissions.put(submission({ id: "sub_000002", stage: "paid" }));
    const paid = (at: string, amount: number, id: string) =>
      w.store.payouts.put({ id, submissionId: "sub_000002", amountCents: amount, idempotencyKey: id, basis: { views: 0, viewsAsOf: at, flatFeeCents: 0, cpmCents: 0, capCents: 0 }, at });
    paid("2026-01-15T00:00:00.000Z", 40_000, "pay_old");
    expect(severities(w.gov.propose(payoutInput()), "creator.payout_30d_cap")).toEqual([]);
    paid("2026-02-20T00:00:00.000Z", 42_501, "pay_new");
    expect(severities(w.gov.propose(payoutInput()), "creator.payout_30d_cap")).toEqual(["needs_human"]);
  });
});

describe("creator.campaign_create rules", () => {
  function create(w: World) {
    return w.gov.propose(input("creator.campaign_create", { campaignId: "ccmp_000001" }, { naturalKey: key(), costCents: 10_000 }));
  }

  it("passes for test-geo campaigns with a disclosed, claim-free brief", () => {
    const w = makeWorld();
    w.store.campaigns.put(campaign());
    expect(create(w).findings).toEqual([]);
  });

  it("blocks target countries outside the test geos unless the venture is scaling", () => {
    const w = makeWorld();
    w.store.campaigns.put(campaign({ targetCountries: ["CA", "US"] }));
    expect(severities(create(w), "creator.campaign_geo")).toEqual(["block"]);
    w.store.ventures.put(makeVenture({ stage: "harvest" }));
    expect(severities(create(w), "creator.campaign_geo")).toEqual([]);
    w.store.campaigns.put(campaign({ targetCountries: [] }));
    expect(severities(create(w), "creator.campaign_geo")).toEqual(["block"]);
  });

  it("lints the brief and requires the paid-partnership label", () => {
    const w = makeWorld();
    const c = campaign();
    w.store.campaigns.put({ ...c, brief: { ...c.brief, hooks: ["Guaranteed to find your soulmate"], mustInclude: ["Show the app"] } });
    const a = create(w);
    expect(severities(a, "copy.efficacy_claim")).toEqual(["needs_human"]);
    expect(severities(a, "creator.brief")).toEqual(["block"]);
    w.store.campaigns.put({ ...c, brief: { ...c.brief, mustInclude: ["Put #ad at the start of the caption"] } });
    expect(create(w).findings).toEqual([]);
  });
});

describe("ads rules", () => {
  function setup(patch = {}, opts: Parameters<typeof makeWorld>[0] = {}) {
    const w = makeWorld(opts);
    w.store.adCampaigns.put(adCampaign(patch));
    w.store.content.put(piece({ economics: { attributedInstalls: 80, predNetRpmD60Cents: 3_000, effectiveCpmCents: 1_000, provenAt: START } }));
    return w;
  }
  const create = (w: World) => w.gov.propose(input("ads.campaign_create", { adCampaignId: "adc_000001" }, { naturalKey: key() }));

  it("needs a human for the first campaign per network, then passes", () => {
    const w = setup();
    const first = create(w);
    expect(first.findings.map((f) => [f.ruleId, f.severity])).toEqual([["ads.first_per_network", "needs_human"]]);
    w.store.adCampaigns.put(adCampaign({ id: "adc_000002", network: "meta" }));
    history(w, "ads.campaign_create", { adCampaignId: "adc_000002" });
    expect(create(w).findings).toEqual([]);
    w.store.adCampaigns.put(adCampaign({ network: "tiktok" }));
    expect(severities(create(w), "ads.first_per_network")).toEqual(["needs_human"]);
  });

  it("requires an end date after the start", () => {
    expect(severities(create(setup({ endAt: "2026-03-01T00:00:00.000Z" })), "ads.campaign_shape")).toEqual(["block"]);
    expect(severities(create(setup({ endAt: "" })), "ads.campaign_shape")).toEqual(["block"]);
    expect(severities(create(makeWorld()), "ads.campaign_shape")).toEqual(["block"]);
  });

  it("requires proven creatives; search is allowed unproven only under the brand-defense cap", () => {
    const w = setup();
    w.store.content.put(piece());
    expect(severities(create(w), "ads.proven_creatives")).toEqual(["block"]);
    expect(severities(create(setup({ creatives: [] })), "ads.proven_creatives")).toEqual(["block"]);
    expect(severities(create(setup({ type: "search", creatives: [], dailyBudgetCents: 2_000 })), "ads.proven_creatives")).toEqual([]);
    expect(severities(create(setup({ type: "search", creatives: [], dailyBudgetCents: 2_001 })), "ads.proven_creatives")).toEqual(["block"]);
  });

  it("requires a live store listing on the campaign os", () => {
    expect(severities(create(setup({ os: "android" })), "ads.store_live")).toEqual(["block"]);
  });

  it("keeps ad geos inside the allowed storefronts", () => {
    expect(severities(create(setup({ geos: ["US"] })), "ads.geo")).toEqual(["block"]);
    expect(severities(create(setup({ geos: ["FR"] })), "ads.geo")).toEqual(["block", "block"]);
  });

  it("limits budget increases to the ramp step and spacing, and rejects stale proposals", () => {
    const w = setup({ dailyBudgetCents: 10_000 });
    const change = (from: number, to: number) => w.gov.propose(input("ads.budget_change", { adCampaignId: "adc_000001", fromDailyCents: from, toDailyCents: to, evidence: "" }, { naturalKey: key() }));
    expect(change(10_000, 12_500).findings).toEqual([]);
    expect(severities(change(10_000, 12_501), "ads.budget_ramp")).toEqual(["block"]);
    expect(severities(change(9_000, 9_500), "ads.budget_ramp")).toEqual(["block"]);
    expect(change(10_000, 5_000).findings).toEqual([]);
    history(w, "ads.budget_change", { adCampaignId: "adc_000001", fromDailyCents: 8_000, toDailyCents: 10_000, evidence: "" }, { executedAt: "2026-03-01T09:00:00.000Z" });
    expect(hits(change(10_000, 12_000), "ads.budget_ramp").map((f) => f.message)).toEqual([expect.stringMatching(/less than 3 days/)]);
    expect(change(10_000, 9_000).findings).toEqual([]);
  });
});

describe("monetization rules", () => {
  const paywall = (ids: string[]) =>
    input("remote_config.set", { key: "paywall", variants: [{ id: "cell_a", rolloutPct: 100, payload: { productIds: ids, highlightedProductId: ids[0] } }] }, { naturalKey: key() });

  it("allows approved products inside the grid and trial set", () => {
    const w = makeWorld();
    expect(w.gov.propose(paywall(["week_699_t3", "year_3999_t0"])).findings).toEqual([]);
    expect(w.gov.propose(input("remote_config.set", { key: "onboarding", variants: [{ id: "a", rolloutPct: 100, payload: { productIds: ["nope"] } }] })).findings).toEqual([]);
  });

  it("blocks unbound or unapproved products", () => {
    const w = makeWorld();
    expect(severities(w.gov.propose(paywall(["week_999_t7"])), "monetization.products")).toEqual(["block"]);
    const v = makeVenture();
    w.store.ventures.put({ ...v, bindings: { ...v.bindings, products: [{ ...v.bindings.products[0]!, status: "in_review" }] } });
    expect(severities(w.gov.propose(paywall(["week_699_t3"])), "monetization.products")).toEqual(["block"]);
    const configure = w.gov.propose(input("monetization.configure", { productIds: ["com.faststudio.astra.week_699_t3"], entitlementId: "pro" }));
    expect(severities(configure, "monetization.products")).toEqual(["block"]);
  });

  it("blocks prices outside the grid and disallowed trials", () => {
    const grid = makeWorld({ config: { monetization: { priceGrid: { week: [499, 599], month: [999, 1999], year: [2999, 5999] } } } });
    expect(hits(grid.gov.propose(paywall(["week_699_t3"])), "monetization.products")[0]?.message).toMatch(/outside the week grid/);
    const trials = makeWorld({ config: { monetization: { allowedTrialDays: [0] } } });
    expect(hits(trials.gov.propose(paywall(["week_699_t3"])), "monetization.products")[0]?.message).toMatch(/Trial of 3 days/);
  });

  it("changing paywall products with paying subscribers needs a human", () => {
    const w = makeWorld();
    w.store.upsertMetrics("ven_000001", [metricsRow({ date: "2026-02-28", activeSubscribers: 0 }), metricsRow({ date: "2026-03-01", activeSubscribers: 12 })]);
    expect(severities(w.gov.propose(paywall(["week_699_t3"])), "monetization.subscriber_change")).toEqual(["needs_human"]);
    history(w, "remote_config.set", { key: "paywall", variants: [{ id: "x", rolloutPct: 100, payload: { productIds: ["week_699_t3"], highlightedProductId: "week_699_t3" } }] });
    expect(severities(w.gov.propose(paywall(["week_699_t3"])), "monetization.subscriber_change")).toEqual([]);
    expect(severities(w.gov.propose(paywall(["year_3999_t0"])), "monetization.subscriber_change")).toEqual(["needs_human"]);
  });
});

describe("venture and audience rules", () => {
  it("blocks killing a venture with paying subscribers", () => {
    const w = makeWorld();
    expect(w.gov.propose(input("venture.kill", { reason: "fail" })).findings).toEqual([]);
    w.store.upsertMetrics("ven_000001", [metricsRow({ activeSubscribers: 4 })]);
    const a = w.gov.propose(input("venture.kill", { reason: "fail" }, { naturalKey: key() }));
    expect(hits(a, "venture.kill_with_subscribers")[0]?.message).toMatch(/venture\.sunset/);
  });

  it("minors need a human on submission, creator campaigns and ads", () => {
    const w = makeWorld();
    w.store.campaigns.put(campaign());
    w.store.adCampaigns.put(adCampaign());
    const kinds = () => [
      w.gov.propose(input("store.submit_review", { platform: "ios", storeBuildId: "b", notesForReviewer: "" }, { naturalKey: key() })),
      w.gov.propose(input("creator.campaign_create", { campaignId: "ccmp_000001" }, { naturalKey: key() })),
      w.gov.propose(input("ads.campaign_create", { adCampaignId: "adc_000001" }, { naturalKey: key() })),
    ];
    expect(kinds().flatMap((a) => severities(a, "minors"))).toEqual([]);
    w.store.ideas.put({ id: "idea_000001", idea: { ...IDEA, wedge: { ...IDEA.wedge, minAge: 16 } }, sourceSignalIds: [], createdAt: START });
    expect(kinds().flatMap((a) => severities(a, "minors"))).toEqual(["needs_human", "needs_human", "needs_human"]);
    w.store.ideas.put({ id: "idea_000001", idea: IDEA, sourceSignalIds: [], createdAt: START });
    w.store.screenings.put({ ...screening(["minors"], "2026-03-02T09:30:00.000Z"), id: "scr_later" });
    expect(kinds().flatMap((a) => severities(a, "minors"))).toEqual(["needs_human", "needs_human", "needs_human"]);
  });

  it("sensitive domains need a human on the first submission and every ad campaign", () => {
    const w = makeWorld();
    w.store.adCampaigns.put(adCampaign());
    w.store.screenings.put({ ...screening(["biometric"], "2026-03-02T09:30:00.000Z"), id: "scr_later" });
    const submit = () => w.gov.propose(input("store.submit_review", { platform: "ios", storeBuildId: "b", notesForReviewer: "" }, { naturalKey: key() }));
    expect(severities(submit(), "sensitive_domains")).toEqual(["needs_human"]);
    history(w, "store.submit_review", { platform: "ios", storeBuildId: "a", notesForReviewer: "" });
    expect(severities(submit(), "sensitive_domains")).toEqual([]);
    expect(severities(w.gov.propose(input("ads.campaign_create", { adCampaignId: "adc_000001" })), "sensitive_domains")).toEqual(["needs_human"]);
    expect(severities(submit(), "red_category")).toEqual([]);
  });

  it("red categories need a human on every submission and ad campaign", () => {
    const w = makeWorld();
    w.store.screenings.put({ ...screening(["astrology_fortune"], "2026-03-02T09:30:00.000Z"), id: "scr_later" });
    history(w, "store.submit_review", { platform: "ios", storeBuildId: "a", notesForReviewer: "" });
    const a = w.gov.propose(input("store.submit_review", { platform: "ios", storeBuildId: "b", notesForReviewer: "" }));
    expect(severities(a, "red_category")).toEqual(["needs_human"]);
    expect(severities(a, "sensitive_domains")).toEqual([]);
  });

  it("support replies must disclose AI and pass support lint", () => {
    const w = makeWorld();
    const reply = (text: string, aiDisclosed: boolean) => w.gov.propose(input("support.reply", { ticketId: "t", reply: text, aiDisclosed }, { naturalKey: key() }));
    expect(reply("Hi! I'm the AI assistant; I've cancelled it for you.", true).findings).toEqual([]);
    expect(severities(reply("Done.", false), "support.ai_disclosure")).toEqual(["block"]);
    expect(reply("We guarantee a refund", true).findings.map((f) => f.ruleId)).toEqual(["copy.efficacy_claim"]);
  });
});

describe("evaluateAction", () => {
  it("only runs applicable rules", () => {
    const w = makeWorld();
    const a = w.gov.propose(input("venture.exit_flag", { holdNpvCents: 1, saleEstimateCents: 2, rationale: "" }));
    expect(evaluateAction(a, w.gov.policyContext())).toEqual([]);
  });
});
