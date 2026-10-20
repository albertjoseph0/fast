import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi, type Mock } from "vitest";
import { SimClock } from "../../src/core/clock.ts";
import type { WritePorts } from "../../src/core/ports.ts";
import { StudioStore } from "../../src/core/store.ts";
import { ActionKind, type Action, type HumanTaskDraft } from "../../src/core/types.ts";
import { Executor, HANDLERS, INTERRUPTED_ERROR } from "../../src/governance/executor.ts";
import { START, account, adCampaign, campaign, creator, fakeWrite, input, makeVenture, makeWorld, piece, publishInput, submission, type World } from "./fixtures.ts";

function executor(w: World, write: WritePorts, opts: { dryRun?: boolean; killSwitchPath?: string | null } = {}): Executor {
  return new Executor({
    store: w.store,
    config: w.config,
    clock: w.clock,
    write,
    ledger: w.ledger,
    governance: w.gov,
    dryRun: opts.dryRun ?? false,
    killSwitchPath: opts.killSwitchPath ?? null,
  });
}

/** Every vi.fn on the write ports. */
function portFns(write: WritePorts): Mock[] {
  return Object.values(write).flatMap((port) => Object.values(port as Record<string, unknown>).filter((f): f is Mock => vi.isMockFunction(f)));
}

function totalCalls(write: WritePorts): number {
  return portFns(write).reduce((n, f) => n + f.mock.calls.length, 0);
}

function readDisk(dir: string): { actions: Record<string, Action> } {
  return JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as { actions: Record<string, Action> };
}

const release = (naturalKey = "ios") => input("store.release", { platform: "ios", phased: true }, { naturalKey });

describe("HANDLERS", () => {
  it("has a handler for every action kind", () => {
    expect(Object.keys(HANDLERS).sort()).toEqual([...ActionKind.options].sort());
  });
});

describe("write-ahead execution", () => {
  it("commits status executing to disk before the port call, executed after", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fast-exec-"));
    const clock = new SimClock(START);
    const store = new StudioStore(dir, clock);
    const w = makeWorld({ store, clock });
    const write = fakeWrite();
    let actionId = "";
    const seen: { disk?: string; memory?: string } = {};
    (write.store.release as Mock).mockImplementation(async () => {
      seen.disk = readDisk(dir).actions[actionId]?.status;
      seen.memory = store.actions.get(actionId)?.status;
    });
    const a = w.gov.propose(release());
    actionId = a.id;
    expect(a.status).toBe("approved");

    clock.advanceHours(1);
    const [done] = await executor(w, write).runApproved();
    expect(seen).toEqual({ disk: "executing", memory: "executing" });
    expect(done).toMatchObject({ id: a.id, status: "executed", result: { released: true }, executedAt: clock.iso() });
    expect(readDisk(dir).actions[a.id]?.status).toBe("executed");
    expect(store.ventures.require("ven_000001").stores.find((s) => s.platform === "ios")?.status).toBe("live");
    expect(store.recentEvents((e) => e.type === "action.executed")[0]?.data).toMatchObject({ actionId: a.id });
    store.close();
  });

  it("marks the action failed with the port's error and keeps going", async () => {
    const w = makeWorld();
    const write = fakeWrite();
    (write.store.release as Mock).mockRejectedValueOnce(new Error("ASC 503"));
    const first = w.gov.propose(release());
    const second = w.gov.propose(input("store.set_territories", { platform: "ios", territories: ["CA"] }));
    const out = await executor(w, write).runApproved();
    expect(out.map((a) => [a.id, a.status])).toEqual([
      [first.id, "failed"],
      [second.id, "executed"],
    ]);
    expect(w.store.actions.require(first.id).error).toBe("ASC 503");
    expect(w.store.recentEvents((e) => e.type === "action.failed")[0]?.data).toMatchObject({ actionId: first.id, error: "ASC 503" });
    expect(w.store.ventures.require("ven_000001").stores[0]?.territories).toEqual(["CA"]);
  });

  it("runs approved actions oldest first and honours the limit", async () => {
    const w = makeWorld();
    const write = fakeWrite();
    const a = w.gov.propose(release());
    w.clock.advanceHours(1);
    const b = w.gov.propose(input("store.set_territories", { platform: "ios", territories: ["CA"] }));
    const ex = executor(w, write);
    expect((await ex.runApproved({ limit: 1 })).map((x) => x.id)).toEqual([a.id]);
    expect(w.store.actions.require(b.id).status).toBe("approved");
    expect((await ex.runApproved()).map((x) => x.id)).toEqual([b.id]);
  });

  it("re-checks policy before running: an approved action frozen since is not executed", async () => {
    const w = makeWorld();
    const write = fakeWrite();
    const a = w.gov.propose(release());
    w.store.freeze({ scope: "venture:ven_000001", reason: "tripwire", at: START, by: "owner" });
    const [out] = await executor(w, write).runApproved();
    expect(out?.status).toBe("blocked");
    expect(w.store.actions.require(a.id).status).toBe("blocked");
    expect(totalCalls(write)).toBe(0);
  });
});

describe("dry run", () => {
  it("records dry_run without any port call or domain mutation", async () => {
    const w = makeWorld();
    const write = fakeWrite();
    const territories = w.gov.propose(input("store.set_territories", { platform: "ios", territories: ["CA", "AU"] }));
    w.store.campaigns.put(campaign({ status: "draft" }));
    const camp = w.gov.propose(input("creator.campaign_create", { campaignId: "ccmp_000001" }));
    expect(camp.status).toBe("approved");
    const before = structuredClone({ venture: w.store.ventures.require("ven_000001"), campaign: w.store.campaigns.require("ccmp_000001") });

    const out = await executor(w, write, { dryRun: true }).runApproved();
    expect(out.map((a) => a.status)).toEqual(["dry_run", "dry_run"]);
    expect(out[0]).toMatchObject({ id: territories.id, result: { dryRun: true }, executedAt: START });
    expect(totalCalls(write)).toBe(0);
    expect(w.store.ventures.require("ven_000001")).toEqual(before.venture);
    expect(w.store.campaigns.require("ccmp_000001")).toEqual(before.campaign);
    expect(w.store.jobs.count()).toBe(0);
    expect(w.store.recentEvents((e) => e.type === "action.executed").map((e) => e.data["dryRun"])).toEqual([true, true]);
  });

  it("commits each dry-run result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fast-dry-"));
    const clock = new SimClock(START);
    const store = new StudioStore(dir, clock);
    const w = makeWorld({ store, clock });
    const a = w.gov.propose(release());
    await executor(w, fakeWrite(), { dryRun: true }).runApproved();
    expect(readDisk(dir).actions[a.id]?.status).toBe("dry_run");
    store.close();
  });
});

describe("reconcile", () => {
  it("fails actions left executing by a crash and emits action.failed", async () => {
    const w = makeWorld();
    const write = fakeWrite();
    const a = w.gov.propose(release());
    w.store.governanceActions().put({ ...w.store.actions.require(a.id), status: "executing" });
    const untouched = w.gov.propose(input("store.set_territories", { platform: "ios", territories: ["CA"] }));
    const ex = executor(w, write);

    const failed = ex.reconcile();
    expect(failed.map((x) => [x.id, x.status, x.error])).toEqual([[a.id, "failed", INTERRUPTED_ERROR]]);
    expect(w.store.actions.require(untouched.id).status).toBe("approved");
    expect(w.store.recentEvents((e) => e.type === "action.failed")[0]?.data).toMatchObject({ actionId: a.id, error: INTERRUPTED_ERROR });
    expect(ex.reconcile()).toEqual([]);
    // A failed action is never re-run automatically.
    await ex.runApproved();
    expect(write.store.release).not.toHaveBeenCalled();
  });
});

describe("kill switch", () => {
  it("stops before any port call when the switch file exists", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "fast-kill-")), "KILL");
    const w = makeWorld();
    const write = fakeWrite();
    const a = w.gov.propose(release());
    writeFileSync(path, "stop");
    expect(await executor(w, write, { killSwitchPath: path }).runApproved()).toEqual([]);
    expect(totalCalls(write)).toBe(0);
    expect(w.store.actions.require(a.id).status).toBe("approved");
  });

  it("halts the rest of the queue when the switch is thrown mid-run", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "fast-kill-")), "KILL");
    const w = makeWorld();
    const write = fakeWrite();
    (write.store.release as Mock).mockImplementation(async () => writeFileSync(path, "stop"));
    const first = w.gov.propose(release());
    const second = w.gov.propose(input("store.set_territories", { platform: "ios", territories: ["CA"] }));
    const out = await executor(w, write, { killSwitchPath: path }).runApproved();
    expect(out.map((a) => a.id)).toEqual([first.id]);
    expect(write.store.setTerritories).not.toHaveBeenCalled();
    expect(w.store.actions.require(second.id).status).toBe("approved");
  });

  it("also honours the governance kill switch", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "fast-kill-")), "KILL");
    const w = makeWorld({ killSwitchPath: path });
    const write = fakeWrite();
    const a = w.gov.propose(release());
    writeFileSync(path, "stop");
    expect(await executor(w, write).runApproved()).toEqual([]);
    expect(totalCalls(write)).toBe(0);
    expect(w.store.actions.require(a.id).status).toBe("approved");
  });
});

describe("jobs", () => {
  it("stores an ExternalJob from a returned JobRef under the result's job id", async () => {
    const w = makeWorld();
    const write = fakeWrite();
    const a = w.gov.propose(input("store.submit_review", { platform: "ios", storeBuildId: "build_1", notesForReviewer: "Demo account: none needed." }));
    expect(a.status).toBe("awaiting_approval");
    w.gov.approve(a.id, "owner");
    const [done] = await executor(w, write).runApproved();
    const jobId = (done?.result as { jobId: string }).jobId;
    expect(jobId).toMatch(/^job_\d{6}$/);
    expect(w.store.jobs.require(jobId)).toEqual({
      id: jobId,
      op: "store.review",
      ventureId: "ven_000001",
      actionId: a.id,
      externalRef: { id: "ext" },
      status: "running",
      nextPollAt: "2026-03-02T09:01:00.000Z",
      deadlineAt: "2026-03-09T09:00:00.000Z",
      attempts: 0,
      createdAt: START,
    });
    expect(w.store.ventures.require("ven_000001").stores[0]).toMatchObject({ status: "waiting_for_review", storeBuildId: "build_1" });
    expect(w.store.recentEvents((e) => e.type === "job.updated")[0]?.data).toMatchObject({ jobId, actionId: a.id });
  });

  it("content.publish schedules the piece with its derived disclosure and a social job", async () => {
    const w = makeWorld();
    const write = fakeWrite();
    const acct = w.store.accounts.put(account());
    const p = w.store.content.put(piece());
    const a = w.gov.propose(publishInput(p, acct, START));
    expect(a.status).toBe("approved");
    const [done] = await executor(w, write).runApproved();
    expect(done?.status).toBe("executed");
    expect(write.social.publish).toHaveBeenCalledWith(expect.objectContaining({ account: acct, platform: "instagram", mode: "direct", labels: a.payload.labels }));
    expect(w.store.content.require(p.id)).toMatchObject({ status: "scheduled", accountId: acct.id, disclosure: { aiGenerated: true, commercial: "own_brand" } });
    const job = w.store.jobs.require((done?.result as { jobId: string }).jobId);
    expect(job).toMatchObject({ op: "social.publish", externalRef: { container: "c1" }, nextPollAt: "2026-03-02T09:00:30.000Z" });
  });
});

describe("human tasks from createApp", () => {
  const TASK: HumanTaskDraft = {
    kind: "apple.create_app",
    title: "Create Astra in App Store Connect",
    instructions: "Open https://appstoreconnect.apple.com/apps and create the app.",
    inputs: [{ key: "ascAppId", label: "Apple ID", pattern: "\\d{9,10}" }],
  };

  it("opens the task, waits on it, then executes without calling createApp again", async () => {
    const w = makeWorld();
    w.store.ventures.put(makeVenture({ stores: [] }));
    const write = fakeWrite();
    (write.store.createApp as Mock).mockResolvedValue({ humanTask: TASK });
    const a = w.gov.propose(input("store.create_app", { platform: "ios", bundleId: "com.faststudio.astra", name: "Astra", sku: "astra", primaryLocale: "en-US" }));
    expect(a.status).toBe("awaiting_approval");
    w.gov.approve(a.id, "owner");
    const ex = executor(w, write);

    const [waiting] = await ex.runApproved();
    const task = w.store.tasks.list()[0];
    expect(task).toMatchObject({ kind: "apple.create_app", ventureId: "ven_000001", status: "open", blocksActionIds: [a.id] });
    expect(waiting).toMatchObject({ status: "awaiting_human_task", blockedByTaskIds: [task?.id] });
    expect(w.store.ventures.require("ven_000001").blockedOn).toEqual([task?.id]);
    expect(w.store.recentEvents((e) => e.type === "task.opened")).toHaveLength(1);
    expect(await ex.runApproved()).toEqual([]);

    expect(() => w.gov.completeTask(task!.id, { ascAppId: "not-a-number" }, "owner")).toThrow(/does not match/);
    expect(() => w.gov.completeTask(task!.id, { ascAppId: "6450000001" }, "stranger")).toThrow(/not on the board/);
    w.gov.completeTask(task!.id, { ascAppId: "6450000001" }, "owner");
    expect(w.store.actions.require(a.id)).toMatchObject({ status: "approved", blockedByTaskIds: [] });

    const [done] = await ex.runApproved();
    expect(done).toMatchObject({ status: "executed", result: { appId: "6450000001" } });
    expect(write.store.createApp).toHaveBeenCalledTimes(1);
    const v = w.store.ventures.require("ven_000001");
    expect(v.bindings.ascAppId).toBe("6450000001");
    expect(v.blockedOn).toEqual([]);
    expect(v.stores.find((s) => s.platform === "ios")).toMatchObject({ appId: "6450000001", status: "draft", publisherAccountId: "pub_ios" });
  });

  it("records the app id directly when the store creates the app", async () => {
    const w = makeWorld();
    w.store.ventures.put(makeVenture({ stores: [] }));
    const write = fakeWrite();
    const a = w.gov.propose(input("store.create_app", { platform: "android", bundleId: "com.faststudio.astra", name: "Astra", sku: "astra", primaryLocale: "en-US" }));
    w.gov.approve(a.id, "owner");
    const [done] = await executor(w, write).runApproved();
    expect(done).toMatchObject({ status: "executed", result: { appId: "app_1" } });
    expect(w.store.tasks.count()).toBe(0);
    expect(w.store.ventures.require("ven_000001").stores[0]).toMatchObject({ platform: "android", appId: "app_1", bundleId: "com.faststudio.astra" });
  });
});

describe("creator payout handler", () => {
  it("records the Payout, books the ledger, marks the submission paid and sets firstPaidAt", async () => {
    const w = makeWorld();
    const write = fakeWrite();
    w.store.creators.put(creator());
    w.store.campaigns.put(campaign({ externalId: "ss_cmp_1", experimentId: "exp_1", cellId: "cell_1" }));
    w.store.submissions.put(submission());
    const basis = { views: 40_000, viewsAsOf: START, flatFeeCents: 1_500, cpmCents: 150, capCents: 15_000 };
    const a = w.gov.propose(input("creator.payout", { submissionId: "sub_000001", amountCents: 7_500, basis }, { naturalKey: "sub_000001", costCents: 7_500 }));
    expect(a.status).toBe("awaiting_approval");
    w.gov.approve(a.id, "owner");
    w.clock.advanceHours(2);

    const [done] = await executor(w, write).runApproved();
    expect(done?.status).toBe("executed");
    expect(write.creators.payout).toHaveBeenCalledWith({ submissionExternalId: "ss_sub_1", amountCents: 7_500, idempotencyKey: a.idempotencyKey, basis });
    const payout = w.store.payouts.require((done?.result as { payoutId: string }).payoutId);
    expect(payout).toEqual({ id: payout.id, submissionId: "sub_000001", amountCents: 7_500, idempotencyKey: a.idempotencyKey, externalId: "ss_pay_1", basis, at: w.clock.iso() });
    expect(w.store.ledger((e) => e.sourceKey === `payout:${payout.id}`)).toEqual([
      expect.objectContaining({ category: "creators", amountCents: -7_500, ventureId: "ven_000001", experimentId: "exp_1", cellId: "cell_1" }),
    ]);
    expect(w.store.submissions.require("sub_000001")).toMatchObject({ stage: "paid", payoutCents: 7_500 });
    expect(w.store.creators.require("cre_000001")).toMatchObject({ firstPaidAt: w.clock.iso(), stats: { paidCents: 7_500 } });
    expect(w.ledger.accruedLiabilities()).toBe(0);
  });
});

describe("domain updates", () => {
  it("ads.campaign_create stores the external id and activates the campaign", async () => {
    const w = makeWorld();
    const write = fakeWrite();
    w.store.content.put(piece({ economics: { attributedInstalls: 40, predNetRpmD60Cents: 900, effectiveCpmCents: 300, provenAt: START } }));
    w.store.adCampaigns.put(adCampaign());
    const a = w.gov.propose(input("ads.campaign_create", { adCampaignId: "adc_000001" }));
    w.gov.approve(a.id, "owner");
    const [done] = await executor(w, write).runApproved();
    expect(done).toMatchObject({ status: "executed", result: { externalId: "meta_cmp_1" } });
    expect(write.ads.createCampaign).toHaveBeenCalledWith(expect.objectContaining({ network: "meta", adAccountId: "act_meta", endAt: "2026-03-05T00:00:00.000Z" }));
    expect(w.store.adCampaigns.require("adc_000001")).toMatchObject({ externalId: "meta_cmp_1", status: "active" });
  });

  it("creator.campaign_create stores the external id and opens the campaign", async () => {
    const w = makeWorld();
    const write = fakeWrite();
    w.store.campaigns.put(campaign({ status: "draft" }));
    w.gov.propose(input("creator.campaign_create", { campaignId: "ccmp_000001" }));
    await executor(w, write).runApproved();
    expect(w.store.campaigns.require("ccmp_000001")).toMatchObject({ externalId: "ss_cmp_1", status: "open" });
  });

  it("venture lifecycle kinds record only, with no external call", async () => {
    const w = makeWorld({ config: { autonomy: { alwaysApprove: [] } } });
    const write = fakeWrite();
    w.gov.propose(input("venture.kill", { reason: "failed S1" }));
    w.gov.propose(input("venture.exit_flag", { holdNpvCents: 1, saleEstimateCents: 2, rationale: "r" }));
    w.gov.propose(input("venture.sunset", { activeSubscribers: 0, plan: "serve_until_lapse", reason: "r" }));
    w.gov.propose(input("venture.scale", { evidence: "e", experimentIds: [], proposedDailyCents: 0, addTerritories: [] }));
    const out = await executor(w, write).runApproved();
    expect(out.map((a) => [a.kind, a.status, a.result])).toEqual([
      ["venture.kill", "executed", { killed: true }],
      ["venture.exit_flag", "executed", { flagged: true }],
      ["venture.sunset", "executed", { started: true }],
      ["venture.scale", "executed", { approved: true }],
    ]);
    expect(totalCalls(write)).toBe(0);
  });
});

describe("review regressions", () => {
  const basis = { views: 40_000, viewsAsOf: START, flatFeeCents: 1_500, cpmCents: 150, capCents: 15_000 };
  function payoutWorld(): { w: World; a: Action } {
    const w = makeWorld();
    w.store.creators.put(creator({ firstPaidAt: START }));
    w.store.campaigns.put(campaign({ externalId: "ss_cmp_1" }));
    w.store.submissions.put(submission());
    const a = w.gov.propose(input("creator.payout", { submissionId: "sub_000001", amountCents: 7_500, basis }, { naturalKey: "sub_000001", costCents: 7_500 }));
    expect(a.status).toBe("approved");
    return { w, a };
  }

  it("#10 a dry-run response from a write port is recorded as dry_run, never as executed", async () => {
    const w = makeWorld();
    const write = fakeWrite();
    (write.creators.createCampaign as Mock).mockResolvedValue({ externalId: "dry_ss_abc123" });
    (write.web.putAsset as Mock).mockResolvedValue({ publicUrl: "https://dry_run.blob.invalid/a.png", sha256: "sha_a" });
    (write.store.registerBundleId as Mock).mockResolvedValue({ dryRun: true });
    w.store.campaigns.put(campaign({ status: "draft" }));
    w.store.content.put(piece());
    w.gov.propose(input("creator.campaign_create", { campaignId: "ccmp_000001" }));
    w.gov.propose(input("web.put_asset", { localPath: "/tmp/a.png", contentType: "image/png" }));
    w.gov.propose(input("store.register_bundle", { platform: "ios", bundleId: "com.faststudio.astra", capabilities: [] }));
    const out = await executor(w, write).runApproved();
    expect(out.map((a) => [a.kind, a.status])).toEqual([
      ["creator.campaign_create", "dry_run"],
      ["web.put_asset", "dry_run"],
      ["store.register_bundle", "dry_run"],
    ]);
    expect(w.store.campaigns.require("ccmp_000001")).toMatchObject({ status: "draft" });
    expect(w.store.campaigns.require("ccmp_000001").externalId).toBeUndefined();
    expect(w.store.content.require("cnt_000001").media[0]?.publicUrl).toBeUndefined();
    // No lifetime commitment is held for a campaign that was never opened.
    expect(w.ledger.outstandingCommitments()).toBe(0);
  });

  it("#2 a payout whose port call fails is held as possibly paid", async () => {
    const { w, a } = payoutWorld();
    const write = fakeWrite();
    (write.creators.payout as Mock).mockRejectedValue(new Error("socket hang up"));
    const [done] = await executor(w, write).runApproved();
    expect(done).toMatchObject({ id: a.id, status: "failed", error: "socket hang up" });
    expect(w.ledger.unknownPayouts()).toEqual([{ actionId: a.id, submissionId: "sub_000001", amountCents: 7_500, at: START }]);
    expect(w.ledger.paidOnCampaign("ccmp_000001")).toBe(7_500);
  });

  it("#2 a payout interrupted mid-call is held as possibly paid on reconcile", () => {
    const { w, a } = payoutWorld();
    w.store.governanceActions().put({ ...w.store.actions.require(a.id), status: "executing" });
    executor(w, fakeWrite()).reconcile();
    expect(w.store.actions.require(a.id).error).toBe(INTERRUPTED_ERROR);
    expect(w.ledger.unknownPayouts().map((u) => u.actionId)).toEqual([a.id]);
  });

  it("#2 a payout that fails before its port call is not held", async () => {
    const { w, a } = payoutWorld();
    vi.spyOn(w.store.campaigns, "require").mockImplementation(() => {
      throw new Error("campaign missing");
    });
    const write = fakeWrite();
    const [done] = await executor(w, write).runApproved();
    expect(done).toMatchObject({ id: a.id, status: "failed", error: "campaign missing" });
    expect(write.creators.payout).not.toHaveBeenCalled();
    expect(w.ledger.unknownPayouts()).toEqual([]);
  });

  it("#29 lifecycle decisions execute in dry-run: they have no external effect", async () => {
    const w = makeWorld({ config: { autonomy: { alwaysApprove: [] } } });
    const write = fakeWrite();
    w.gov.propose(input("venture.kill", { reason: "time box" }));
    w.gov.propose(release());
    const out = await executor(w, write, { dryRun: true }).runApproved();
    expect(out.map((a) => [a.kind, a.status])).toEqual([
      ["venture.kill", "executed"],
      ["store.release", "dry_run"],
    ]);
    expect(totalCalls(write)).toBe(0);
  });
});
