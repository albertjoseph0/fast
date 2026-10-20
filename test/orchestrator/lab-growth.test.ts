import { describe, expect, it } from "vitest";
import type { CreatorRead } from "../../src/core/ports.ts";
import type { Action, ExternalSubmission, SubmissionVerification } from "../../src/core/types.ts";
import type { StudioDeps } from "../../src/orchestrator/deps.ts";
import { syncCreatorSubmissions } from "../../src/orchestrator/growth.ts";
import { proposeKill, retryPrepareVariant, testExposureCents, VARIANT_TO_PREPARE } from "../../src/orchestrator/labPhase.ts";
import { campaign, creator, input, submission } from "../governance/fixtures.ts";
import { makeWorld, tickContext, type World } from "./fixtures.ts";

function fakeDeps(agents: Partial<StudioDeps["agents"]> = {}): StudioDeps {
  return { agents: agents as StudioDeps["agents"], renderApp: () => { throw new Error("unused"); }, outRoot: "", templateDir: "", mediaRoot: "", defaultFormatId: "slideshow_story", differentiationReport: async () => "" };
}

const GOOD: Omit<SubmissionVerification, "fetchedAt"> = { postIsPublic: true, authorHandleMatches: true, platformDisclosureLabel: true, viewsFromPlatform: 40_000 };

/** A marketplace that lists the given submissions as posted and verifies every post as clean. */
function marketplace(w: World, subs: Partial<ExternalSubmission>[], views = 40_000): CreatorRead {
  return {
    kind: "live",
    searchCreators: async () => [],
    listSubmissions: async () =>
      subs.map((s) => ({ externalId: "ss_sub_1", campaignExternalId: "ext_c1", creatorExternalId: "ss_1", creatorHandle: "@stargazer", platform: "tiktok", untrustedCaption: "so accurate", stage: "posted", submittedAt: "2026-02-19T09:00:00.000Z", postUrl: "https://tiktok.com/@stargazer/video/1", ...s }) as ExternalSubmission),
    verifyPost: async () => ({ ...GOOD, viewsFromPlatform: views, fetchedAt: w.clock.iso() }),
  } as unknown as CreatorRead;
}

function payouts(w: World): Action[] {
  return w.store.actions.list((a) => a.kind === "creator.payout").sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

function fail(w: World, a: Action, error = "creator payout setup incomplete"): void {
  w.store.governanceActions().put({ ...a, status: "failed", error });
}

describe("test exposure", () => {
  it("counts booked spend, what live and pending campaigns can still spend, and what closed ones still owe", () => {
    const w = makeWorld();
    const ctx = tickContext(w);
    w.store.campaigns.put(campaign({ id: "c_open", budgetCents: 100_000, status: "open" }));
    w.store.submissions.put(submission({ id: "s_paid", campaignId: "c_open", stage: "paid", payoutCents: 15_000 }));
    w.ledger.onPayout({ id: "pay_1", submissionId: "s_paid", amountCents: 15_000, idempotencyKey: "k1", basis: { views: 40_000, viewsAsOf: w.clock.iso(), flatFeeCents: 1_500, cpmCents: 150, capCents: 15_000 }, at: w.clock.iso() }, "ven_000001");
    // A draft whose create is still waiting counts in full; one whose create was rejected counts nothing.
    w.store.campaigns.put(campaign({ id: "c_pending", budgetCents: 50_000, status: "draft" }));
    w.gov.propose(input("creator.campaign_create", { campaignId: "c_pending" }, { naturalKey: "c_pending", commitment: { kind: "lifetime_cap", amountCents: 50_000, maxTotalCents: 50_000, startsAt: w.clock.iso() } }));
    w.store.campaigns.put(campaign({ id: "c_rejected", budgetCents: 50_000, status: "draft" }));
    const rejected = w.gov.propose(input("creator.campaign_create", { campaignId: "c_rejected" }, { naturalKey: "c_rejected" }));
    w.store.governanceActions().put({ ...rejected, status: "rejected" });
    // A closed campaign still owes its approved, unlocked post at its current views: 1,500 + 150 x 40.
    w.store.campaigns.put(campaign({ id: "c_closed", budgetCents: 100_000, status: "closed" }));
    w.store.submissions.put(submission({ id: "s_owed", campaignId: "c_closed", stage: "post_approved", viewsAtLock: undefined }));
    expect(testExposureCents(ctx, w.venture)).toBe(15_000 + 85_000 + 50_000 + 7_500);
  });
});

describe("stop decisions", () => {
  it("records why a kill was proposed, so a time-box stop can be withdrawn if the venture validates", () => {
    const w = makeWorld();
    proposeKill(tickContext(w), w.venture, "not validated within 42 days of testing", "timebox");
    const kill = w.store.actions.list((a) => a.kind === "venture.kill")[0];
    expect(kill?.payload).toMatchObject({ reason: "not validated within 42 days of testing", cause: "timebox" });
  });

  it("clears a to-prepare variant marker whose parent experiment is gone instead of retrying forever", async () => {
    const w = makeWorld();
    const v = w.store.ventures.put({ ...w.venture, stage: "iterating", pendingVariant: { variableUnderTest: VARIANT_TO_PREPARE, variant: {}, hypothesis: "", deliveryMode: "content_only", parentExperimentId: "exp_missing" } });
    expect(await retryPrepareVariant(tickContext(w), fakeDeps(), v)).toMatch(/cleared/);
    expect(w.store.ventures.require(v.id).pendingVariant).toBeUndefined();
  });
});

describe("creator payouts", () => {
  function setup(): { w: World; run: () => Promise<void> } {
    const w = makeWorld();
    w.store.creators.put(creator({ firstPaidAt: "2026-01-01T00:00:00.000Z" }));
    w.store.campaigns.put(campaign({ id: "ccmp_000001", externalId: "ext_c1", status: "open" }));
    // Posted ten days ago and approved, not yet locked.
    w.store.submissions.put(submission({ viewsAtLock: undefined, lockedAt: undefined, postedAt: "2026-02-20T09:00:00.000Z" }));
    const ctx = () => tickContext(w, { ports: { creators: marketplace(w, [{}]) } });
    return { w, run: () => syncCreatorSubmissions(ctx(), fakeDeps()) };
  }

  it("locks views once and keeps the lock when a payout fails", async () => {
    const { w, run } = setup();
    await run();
    expect(w.store.submissions.require("sub_000001")).toMatchObject({ viewsAtLock: 40_000 });
    const [first] = payouts(w);
    expect(first?.payload).toMatchObject({ amountCents: 7_500 });
    fail(w, first as Action);
    w.clock.advanceDays(1);
    await run();
    // A re-proposal pays the same locked views under a fresh idempotency key.
    const second = payouts(w)[1];
    expect(second?.payload).toMatchObject({ amountCents: 7_500, basis: { views: 40_000 } });
    expect(second?.dedupeKey.endsWith(":attempt2")).toBe(true);
  });

  it("waits a day between attempts and asks a human after three refusals", async () => {
    const { w, run } = setup();
    await run();
    for (let attempt = 1; attempt <= 3; attempt++) {
      fail(w, payouts(w).at(-1) as Action);
      await run(); // same day: no retry yet
      expect(payouts(w)).toHaveLength(attempt);
      w.clock.advanceDays(1);
      await run();
    }
    expect(payouts(w)).toHaveLength(3);
    const task = w.store.tasks.list((t) => t.kind === "creators.payout_failed")[0];
    expect(task?.blocksActionIds).toHaveLength(3);
    expect(task?.instructions).toContain("creator payout setup incomplete");
  });

  it("never pays again while a payout of unknown outcome is held, and asks a human to check", async () => {
    const { w, run } = setup();
    await run();
    const held = payouts(w)[0] as Action<"creator.payout">;
    fail(w, held, "socket hang up");
    w.ledger.holdUnknownPayout(held);
    w.clock.advanceDays(2);
    await run();
    expect(payouts(w)).toHaveLength(1);
    expect(w.store.tasks.list((t) => t.kind === "creators.verify_payout")[0]?.blocksActionIds).toEqual([held.id]);
  });
});

describe("creator post review", () => {
  it("rejects a post whose live caption makes a claim, even when the reviewer approves it", async () => {
    const w = makeWorld();
    w.store.creators.put(creator());
    w.store.campaigns.put(campaign({ id: "ccmp_000001", externalId: "ext_c1", status: "open" }));
    w.store.submissions.put(submission({ stage: "draft_approved", verification: undefined, viewsAtLock: undefined, lockedAt: undefined, postedAt: undefined }));
    const ctx = tickContext(w, { ports: { creators: marketplace(w, [{ untrustedPostCaption: "10,000 people use this every day" }]) } });
    const reviewed: string[] = [];
    const approveAll: StudioDeps["agents"]["reviewSubmission"] = async (_c, o) => {
      reviewed.push(o.submission.untrustedCaption);
      return { approve: true, meetsBrief: true, injectionAttempt: false, policyIssues: [], formatIdUsed: null, hookUsedVerbatim: false, appRevealSecond: 3, subscriptionDisclosed: true, note: "looks good" };
    };
    await syncCreatorSubmissions(ctx, fakeDeps({ reviewSubmission: approveAll }));
    // The changed caption is reviewed again, and the copy rules veto it.
    expect(reviewed).toEqual(["10,000 people use this every day"]);
    const post = w.store.actions.list((a) => a.kind === "creator.review_post")[0];
    expect(post?.payload).toMatchObject({ approve: false });
    expect(String((post?.payload as { note: string }).note)).toMatch(/caption/);
  });

  it("refreshes an unlocked post's views from the marketplace so reads price what was seen", async () => {
    const w = makeWorld();
    w.store.creators.put(creator());
    w.store.campaigns.put(campaign({ id: "ccmp_000001", externalId: "ext_c1", status: "open" }));
    w.store.submissions.put(submission({ viewsAtLock: undefined, lockedAt: undefined, postedAt: "2026-02-28T09:00:00.000Z", verification: { ...GOOD, viewsFromPlatform: 1_500, fetchedAt: "2026-02-28T12:00:00.000Z" } }));
    const ctx = tickContext(w, { ports: { creators: marketplace(w, [{ views: 120_000, postedAt: "2026-02-28T09:00:00.000Z" }]) } });
    await syncCreatorSubmissions(ctx, fakeDeps());
    expect(w.store.submissions.require("sub_000001").verification?.viewsFromPlatform).toBe(120_000);
    expect(w.store.submissions.require("sub_000001").viewsAtLock).toBeUndefined();
  });
});
