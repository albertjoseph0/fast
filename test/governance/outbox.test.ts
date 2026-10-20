import { describe, expect, it } from "vitest";
import type { HumanTaskDraft } from "../../src/core/types.ts";
import { payloadHash } from "../../src/governance/hash.ts";
import { Governance, REJECTION_COOLDOWN_DAYS } from "../../src/governance/outbox.ts";
import { POLICY_VERSION } from "../../src/governance/policy.ts";
import { START, input, makeWorld, metricsRow } from "./fixtures.ts";

const sunset = (reason = "decay") => input("venture.sunset", { activeSubscribers: 3, plan: "serve_until_lapse", reason });

const TASK: HumanTaskDraft = {
  kind: "apple.create_app",
  ventureId: "ven_000001",
  title: "Create the app in App Store Connect",
  instructions: "Open https://appstoreconnect.apple.com/apps and create Astra.",
  inputs: [
    { key: "ascAppId", label: "Apple ID", pattern: "\\d{9,10}" },
    { key: "appStoreUrl", label: "Store URL" },
  ],
};

describe("propose", () => {
  it("creates a fully populated action and emits action.proposed", () => {
    const { gov, store } = makeWorld();
    const a = gov.propose({
      ...input("ads.budget_change", { adCampaignId: "adc_1", fromDailyCents: 100, toDailyCents: 100, evidence: "" }),
      naturalKey: "adc_1:2026-03-02",
      commitment: { kind: "daily", amountCents: 100, maxTotalCents: 300, startsAt: START, endsAt: "2026-03-05T00:00:00.000Z" },
      experimentId: "exp_1",
    });
    expect(a).toMatchObject({
      id: "act_000001",
      idempotencyKey: "ads.budget_change:ven_000001:adc_1:2026-03-02",
      dedupeKey: "ads.budget_change:ven_000001:adc_1:2026-03-02",
      costCents: 300,
      policyVersion: POLICY_VERSION,
      createdAt: START,
      experimentId: "exp_1",
      approvals: [],
      blockedByTaskIds: [],
    });
    expect(a.payloadHash).toBe(payloadHash("ads.budget_change", "ven_000001", a.payload));
    expect(store.actions.get(a.id)).toEqual(a);
    expect(store.recentEvents((e) => e.type === "action.proposed")[0]?.data).toMatchObject({ actionId: a.id, status: a.status });
  });

  it("uses `studio` in keys for studio-level actions and explicit costCents over the commitment", () => {
    const { gov } = makeWorld();
    const a = gov.propose({ ...input("support.reply", { ticketId: "t1", reply: "AI assistant here: done.", aiDisclosed: true }), ventureId: undefined, naturalKey: "t1", costCents: 0 });
    expect(a.dedupeKey).toBe("support.reply:studio:t1");
    expect(a.ventureId).toBeUndefined();
    expect(a.status).toBe("approved");
    expect(a.decidedAt).toBe(START);
  });

  it("emits policy.blocked for blocked proposals", () => {
    const { gov, store } = makeWorld();
    const a = gov.propose(input("venture.kill", { reason: "x" }, { costCents: 999_999 }));
    expect(a.status).toBe("blocked");
    expect(store.recentEvents((e) => e.type === "policy.blocked")[0]?.data).toMatchObject({ actionId: a.id, findings: [expect.objectContaining({ ruleId: "hard_cap" })] });
  });

  it("dedupes open actions by key and allows a new one once closed", () => {
    const { gov, store } = makeWorld();
    const first = gov.propose(sunset("a"));
    const again = gov.propose(sunset("different payload"));
    expect(again).toBe(store.actions.get(first.id));
    expect(again.payload.reason).toBe("a");
    expect(store.actions.count()).toBe(1);
    gov.cancel(first.id, "superseded");
    const fresh = gov.propose(sunset("b"));
    expect(fresh.id).not.toBe(first.id);
    expect(fresh.idempotencyKey).toBe(first.idempotencyKey);
    expect(gov.propose({ ...sunset(), naturalKey: "other" }).id).not.toBe(fresh.id);
  });
});

describe("approvals", () => {
  it("only board members approve; the approval binds to the payload hash", () => {
    const { gov, store } = makeWorld({ config: { autonomy: { board: ["owner", "cfo"] } } });
    const a = gov.propose(sunset());
    expect(a.status).toBe("awaiting_approval");
    expect(() => gov.approve(a.id, "intern")).toThrow(/not on the board/);
    const approved = gov.approve(a.id, "cfo", { channel: "web", note: "ok" });
    expect(approved.status).toBe("approved");
    expect(approved.approvals).toEqual([{ approver: "cfo", payloadHash: a.payloadHash, at: START, channel: "web", coveredRuleIds: ["always_approve"], note: "ok" }]);
    expect(store.recentEvents((e) => e.type === "action.decided").at(-1)?.data).toMatchObject({ from: "awaiting_approval", status: "approved", approver: "cfo" });
  });

  it("a changed payload invalidates the approval", () => {
    const { gov, store } = makeWorld();
    const a = gov.approve(gov.propose(sunset()).id, "owner");
    expect(a.status).toBe("approved");
    const payload = { ...a.payload, plan: "stop_renewals_and_notify" as const };
    store.governanceActions().put({ ...a, status: "awaiting_approval", payload, payloadHash: payloadHash(a.kind, a.ventureId, payload) });
    expect(gov.reevaluateOpen().map((x) => x.id)).toEqual([]);
    expect(store.actions.require(a.id).status).toBe("awaiting_approval");
    expect(gov.approve(a.id, "owner").status).toBe("approved");
  });

  it("recomputes the hash, so editing the payload alone cannot ride on an old approval", () => {
    const { gov, store } = makeWorld();
    const a = gov.approve(gov.propose(sunset()).id, "owner");
    store.governanceActions().put({ ...a, status: "proposed", payload: { ...a.payload, reason: "edited" } });
    gov.reevaluateOpen();
    const after = store.actions.require(a.id);
    expect(after.status).toBe("awaiting_approval");
    expect(after.payloadHash).not.toBe(a.payloadHash);
  });

  it("approval does not clear a block", () => {
    const { gov } = makeWorld();
    const a = gov.propose(input("venture.sunset", { activeSubscribers: 1, plan: "serve_until_lapse", reason: "" }, { costCents: 300_000 }));
    expect(gov.approve(a.id, "owner").status).toBe("blocked");
  });

  it("reject and cancel close open actions only", () => {
    const { gov } = makeWorld();
    const a = gov.propose(sunset());
    const r = gov.reject(a.id, "owner", "not yet");
    expect(r.status).toBe("rejected");
    expect(r.findings.at(-1)).toMatchObject({ ruleId: "board.rejected", message: "owner: not yet" });
    expect(() => gov.approve(a.id, "owner")).toThrow(/rejected/);
    expect(() => gov.cancel(a.id, "x")).toThrow(/rejected/);
    const b = gov.propose({ ...sunset(), payload: { ...sunset().payload, reason: "changed" } });
    expect(gov.cancel(b.id, "obsolete").status).toBe("cancelled");
  });
});

describe("reevaluateOpen", () => {
  it("unblocks budget-blocked actions once cash settles", () => {
    const { gov, store, clock, ledger } = makeWorld({ config: { budgets: { startingCashCents: 760_000, reserveFloorCents: 750_000 } } });
    const a = gov.propose(input("creator.deal_offer", { dealId: "deal_1" }, { costCents: 15_000 }));
    expect(a.findings.map((f) => f.ruleId)).toEqual(["reserve"]);
    expect(a.status).toBe("blocked");
    ledger.syncRevenue("ven_000001", [metricsRow({ date: "2026-01-01", grossRevenueCents: 10_000, proceedsCents: 10_000 })]);
    clock.advanceHours(1);
    const changed = gov.reevaluateOpen();
    expect(changed.map((x) => [x.id, x.status])).toEqual([[a.id, "approved"]]);
    expect(store.actions.require(a.id)).toMatchObject({ findings: [], decidedAt: "2026-03-02T10:00:00.000Z" });
    expect(store.recentEvents((e) => e.type === "action.decided").at(-1)?.data).toMatchObject({ from: "blocked", status: "approved" });
  });

  it("leaves approved and terminal actions alone", () => {
    const { gov } = makeWorld();
    gov.propose(input("venture.exit_flag", { holdNpvCents: 1, saleEstimateCents: 1, rationale: "" }));
    expect(gov.reevaluateOpen()).toEqual([]);
  });
});

describe("human tasks", () => {
  it("opens one task per kind and venture, blocking actions", () => {
    const { gov, store } = makeWorld();
    const a = gov.approve(gov.propose(input("store.create_app", { platform: "ios", bundleId: "b", name: "Astra", sku: "astra", primaryLocale: "en-US" })).id, "owner");
    const b = gov.propose(sunset());
    const t1 = gov.openTask(TASK, [a.id]);
    const t2 = gov.openTask(TASK, [b.id]);
    expect(t2.id).toBe(t1.id);
    expect(t2.blocksActionIds).toEqual([a.id, b.id]);
    expect(store.actions.require(a.id)).toMatchObject({ status: "awaiting_human_task", blockedByTaskIds: [t1.id] });
    expect(store.actions.require(b.id).status).toBe("awaiting_human_task");
    expect(store.ventures.require("ven_000001").blockedOn).toEqual([t1.id]);
    expect(store.recentEvents((e) => e.type === "task.opened")).toHaveLength(1);
    expect(gov.openTask({ ...TASK, kind: "apple.privacy_labels" }).id).not.toBe(t1.id);
  });

  it("validates inputs, writes bindings back and re-evaluates blocked actions", () => {
    const { gov, store } = makeWorld();
    const a = gov.approve(gov.propose(input("store.create_app", { platform: "ios", bundleId: "b", name: "Astra", sku: "astra", primaryLocale: "en-US" })).id, "owner");
    const unapproved = gov.propose(sunset());
    const task = gov.openTask(TASK, [a.id, unapproved.id]);
    expect(() => gov.completeTask(task.id, { ascAppId: "6400000000", appStoreUrl: "u" }, "intern")).toThrow(/board/);
    expect(() => gov.completeTask(task.id, { ascAppId: "12ab", appStoreUrl: "u" }, "owner")).toThrow(/ascAppId does not match/);
    expect(() => gov.completeTask(task.id, { ascAppId: "6400000000" }, "owner")).toThrow(/appStoreUrl is required/);
    expect(() => gov.completeTask(task.id, { ascAppId: "64000000001", appStoreUrl: "u" }, "owner")).toThrow(/does not match/);

    const done = gov.completeTask(task.id, { ascAppId: "6400000000", appStoreUrl: "https://apps.apple.com/app/id6400000000" }, "owner");
    expect(done).toMatchObject({ status: "done", completedBy: "owner", completedAt: START, outputs: { ascAppId: "6400000000" } });
    expect(() => gov.completeTask(task.id, { ascAppId: "6400000000", appStoreUrl: "u" }, "owner")).toThrow(/done/);
    const v = store.ventures.require("ven_000001");
    expect(v.bindings.ascAppId).toBe("6400000000");
    expect(v.bindings.appStoreUrl).toBe("https://apps.apple.com/app/id6400000000");
    expect(v.blockedOn).toEqual([]);
    expect(store.actions.require(a.id)).toMatchObject({ status: "approved", blockedByTaskIds: [] });
    expect(store.actions.require(unapproved.id).status).toBe("awaiting_approval");
    expect(store.recentEvents((e) => e.type === "task.completed")).toHaveLength(1);
    expect(gov.tasks({ status: ["open"] })).toEqual([]);
  });
});

describe("list", () => {
  it("filters by status, venture and kind, oldest first", () => {
    const { gov, clock } = makeWorld();
    const a = gov.propose(sunset());
    clock.advanceHours(1);
    const b = gov.propose(input("venture.exit_flag", { holdNpvCents: 1, saleEstimateCents: 1, rationale: "" }));
    expect(gov.list().map((x) => x.id)).toEqual([a.id, b.id]);
    expect(gov.list({ status: ["approved"] }).map((x) => x.id)).toEqual([b.id]);
    expect(gov.list({ kind: ["venture.sunset"] }).map((x) => x.id)).toEqual([a.id]);
    expect(gov.list({ ventureId: "ven_other" })).toEqual([]);
  });
});

describe("review regressions", () => {
  it("#33 a board rejection of the same payload stands for the cool-down", () => {
    const { gov, clock } = makeWorld();
    const first = gov.propose(sunset());
    gov.reject(first.id, "owner", "keep running it");
    const again = gov.propose(sunset());
    expect(again.id).toBe(first.id);
    expect(again.status).toBe("rejected");
    // A changed payload is a new question.
    const changed = gov.propose(sunset("subscribers dropped"));
    expect(changed.id).not.toBe(first.id);
    gov.cancel(changed.id, "test");
    clock.advanceHours(REJECTION_COOLDOWN_DAYS * 24 + 1);
    const later = gov.propose(sunset());
    expect(later.id).not.toBe(first.id);
    expect(later.status).toBe("awaiting_approval");
  });

  it("#29 while dry-run is on, a dry run of the same payload holds its dedupe key", () => {
    const { store, config, clock, ledger } = makeWorld();
    const dry = new Governance({ store, config, clock, ledger, killSwitchPath: null, dryRun: true });
    const site = (localPath = "/tmp/site/index.html") => input("web.publish_site", { files: [{ path: "index.html", localPath }] });
    const first = dry.propose(site());
    store.governanceActions().put({ ...store.actions.require(first.id), status: "dry_run" });
    expect(dry.propose(site()).id).toBe(first.id);
    expect(dry.propose(site("/tmp/site/v2.html")).id).not.toBe(first.id);
    // Once dry-run is off the real action is proposed.
    const live = new Governance({ store, config, clock, ledger, killSwitchPath: null });
    const real = live.propose(site());
    expect(real.id).not.toBe(first.id);
    expect(real.status).toBe("approved");
  });
});
