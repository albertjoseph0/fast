import { describe, expect, it } from "vitest";
import type { StudioDeps } from "../../src/orchestrator/deps.ts";
import { overlap } from "../../src/orchestrator/differentiation.ts";
import { promoteScreened, runDiscovery, ventureCapacity } from "../../src/orchestrator/discovery.ts";
import { SimBoard } from "../../src/orchestrator/simBoard.ts";
import { applyTaskOutcomes, openBootstrapTasks } from "../../src/orchestrator/tasks.ts";
import { taskDraft } from "../../src/playbook/setup.ts";
import { Rng } from "../../src/core/rng.ts";
import { IDEA, makeVenture, screening } from "../governance/fixtures.ts";
import { makeWorld, tickContext } from "./fixtures.ts";

function fakeDeps(over: Partial<StudioDeps["agents"]>): StudioDeps {
  return { agents: over as StudioDeps["agents"], renderApp: () => { throw new Error("unused"); }, outRoot: "", templateDir: "", mediaRoot: "", defaultFormatId: "slideshow_story", differentiationReport: async () => "" };
}

describe("discovery", () => {
  it("scales portfolio capacity with free cash up to the configured maximum", () => {
    const w = makeWorld();
    const ctx = tickContext(w);
    expect(ventureCapacity(ctx, 0)).toBe(0);
    expect(ventureCapacity(ctx, 800_000)).toBe(2);
    expect(ventureCapacity(ctx, 100_000_000)).toBe(w.config.portfolio.maxActiveVentures);
  });

  it("creates ventures for screened-in ideas, best score first, within free slots", async () => {
    const w = makeWorld({ config: { portfolio: { maxActiveVentures: 3 } } });
    let n = 0;
    const deps = fakeDeps({
      scanMarket: async () => [],
      generateIdeas: async () =>
        [
          ["Alpha", "Rates your golf swing from one video", "swing score with three fixes", "pose estimation coaching"],
          ["Beta", "Turns any song into guitar chords", "chord sheet in seconds", "music transcription"],
          ["Gamma", "Identifies houseplants and their problems", "plant name and care verdict", "image classification"],
        ].map(([title, oneLiner, verdictMoment, aiCapability]) => ({
          id: `idea_${title}`,
          idea: { ...IDEA, title: title as string, oneLiner: oneLiner as string, verdictMoment: verdictMoment as string, aiCapability: aiCapability as string },
          sourceSignalIds: [],
          createdAt: w.clock.iso(),
        })),
      screen: async (_ctx, record) => ({ ...screening([]), id: `scr_${++n}`, ideaId: record.id, score: record.idea.title === "Gamma" ? 90 : record.idea.title === "Alpha" ? 70 : 40, verdict: record.idea.title === "Beta" ? "reject" : "advance" }),
    });
    const ctx = tickContext(w, { tick: 1 });
    const out = await runDiscovery(ctx, deps, 5_000_000);
    expect(out).toMatch(/3 ideas, 2 advanced/);
    // One venture already exists in the fixture world, so two slots remain.
    const created = w.store.ventures.list((v) => v.stage === "screened").map((v) => v.name);
    expect(created).toEqual(["Gamma", "Alpha"]);
    expect(w.store.ventures.list((v) => v.name === "Gamma")[0]?.bindings.bundleId).toBe("com.faststudio.gamma");
  });

  it("skips an idea that re-runs an existing venture's concept under a new name", async () => {
    const w = makeWorld();
    let screened = 0;
    const deps = fakeDeps({
      scanMarket: async () => [],
      generateIdeas: async () => [{ id: "idea_astra_go", idea: { ...IDEA, title: "Astra Go" }, sourceSignalIds: [], createdAt: w.clock.iso() }],
      screen: async () => {
        screened++;
        return screening([]);
      },
    });
    const out = await runDiscovery(tickContext(w, { tick: 1 }), deps, 5_000_000);
    expect(screened).toBe(0);
    expect(out).toMatch(/0 advanced/);
    expect(w.store.recentEvents((e) => e.type === "idea.screened").at(-1)?.data["reasons"]).toEqual([expect.stringMatching(/near-duplicate of ven_000001/)]);
  });

  it("holds a flagged idea until a human approves it and respects build slots", () => {
    const w = makeWorld({ config: { portfolio: { maxBuildsInFlight: 1 } } });
    const ctx = tickContext(w);
    w.store.ventures.put(makeVenture({ id: "ven_000002", stage: "screened", screeningId: "scr_a" }));
    w.store.ventures.put(makeVenture({ id: "ven_000003", stage: "screened", screeningId: "scr_b" }));
    w.store.screenings.put({ ...screening([]), id: "scr_a", score: 95, verdict: "needs_human" });
    w.store.screenings.put({ ...screening([]), id: "scr_b", score: 70 });
    const review = w.gov.openTask(taskDraft("legal.review", "ven_000002"));
    expect(promoteScreened(ctx)).toEqual(["ven_000003"]);
    w.store.ventures.put({ ...w.store.ventures.require("ven_000003"), stage: "live_test" });
    w.gov.completeTask(review.id, { decision: "approved", reviewer: "counsel" }, "owner");
    expect(promoteScreened(ctx)).toEqual(["ven_000002"]);
  });
});

describe("task outcomes", () => {
  it("turns a connected brand account into an owned account bound to the venture", () => {
    const w = makeWorld();
    const ctx = tickContext(w);
    const t = w.gov.openTask(taskDraft("social.connect_account", w.venture.id));
    w.gov.completeTask(t.id, { platform: "instagram", handle: "@astra.app", tokenSecretRef: "IG_ASTRA_TOKEN" }, "owner");
    expect(applyTaskOutcomes(ctx)).toEqual(["ven_000001 connected instagram @astra.app"]);
    const v = w.store.ventures.require(w.venture.id);
    const acct = w.store.accounts.require(v.bindings.ownedAccountIds.instagram as string);
    expect(acct).toMatchObject({ handle: "astra.app", tokenSecretRef: "IG_ASTRA_TOKEN", bioDisclosesBrand: true, status: "active" });
    expect(applyTaskOutcomes(ctx)).toEqual([]);
  });

  it("opens studio setup once and shares the deployed backend with every venture", () => {
    const w = makeWorld();
    const ctx = tickContext(w);
    expect(openBootstrapTasks(ctx)).toHaveLength(3);
    expect(openBootstrapTasks(ctx)).toHaveLength(0);
    const backend = w.store.tasks.list((t) => t.kind === "backend.deploy")[0];
    w.gov.completeTask(backend?.id as string, { backendUrl: "https://verdict.example.com" }, "owner");
    applyTaskOutcomes(ctx);
    expect(w.store.ventures.require(w.venture.id).bindings.backendUrl).toBe("https://verdict.example.com");
  });

  it("proposes a kill when a human abandons a rejected submission", () => {
    const w = makeWorld();
    w.store.ventures.put({ ...w.venture, stage: "in_review" });
    const ctx = tickContext(w);
    const t = w.gov.openTask({ kind: "legal.review", ventureId: w.venture.id, title: "rejected", instructions: "", inputs: [{ key: "decision", label: "", pattern: "^(resubmit|abandon)$" }] });
    w.clock.advanceHours(1);
    w.gov.completeTask(t.id, { decision: "abandon" }, "owner");
    applyTaskOutcomes(ctx);
    expect(w.store.actions.list((a) => a.kind === "venture.kill")).toHaveLength(1);
  });
});

describe("sim board", () => {
  it("approves queued actions after its delay and completes tasks with valid outputs", () => {
    const w = makeWorld();
    const board = new SimBoard({ store: w.store, governance: w.gov, clock: w.clock, rng: new Rng(1), config: w.config });
    const a = w.gov.propose({ kind: "store.create_app", ventureId: w.venture.id, payload: { platform: "ios", bundleId: "com.faststudio.astra", name: "Astra", sku: "astra", primaryLocale: "en-US" }, summary: "create", rationale: "r", proposedBy: "orchestrator", naturalKey: "ios" });
    expect(a.status).toBe("awaiting_approval");
    const t = w.gov.openTask(taskDraft("apple.create_app", w.venture.id));
    expect(board.act().approved).toEqual([]);
    w.clock.advanceDays(2);
    const r = board.act();
    expect(r.approved).toEqual([a.id]);
    expect(r.tasksDone).toContain(t.id);
    expect(w.store.ventures.require(w.venture.id).bindings.ascAppId).toMatch(/^\d{10}$/);
  });
});

describe("differentiation overlap", () => {
  it("scores near-duplicates high and unrelated apps low", () => {
    expect(overlap("AI astrology compatibility reading for zodiac fans", "Zodiac compatibility astrology reading")).toBeGreaterThan(0.5);
    expect(overlap("AI astrology compatibility reading", "golf swing analyzer for weekend golfers")).toBe(0);
  });
});

describe("store console steps", () => {
  it("opens a task when a job needs a human and re-arms the job when it is done", async () => {
    const { pollDueJobs } = await import("../../src/orchestrator/jobs.ts");
    const w = makeWorld();
    const now = w.clock.iso();
    w.store.jobs.put({ id: "job_000001", op: "store.upsert_subscriptions", ventureId: w.venture.id, actionId: "act_x", externalRef: {}, status: "running", nextPollAt: now, deadlineAt: "2099-01-01T00:00:00.000Z", attempts: 0, createdAt: now });
    const store = { kind: "sim", poll: async () => ({ status: "needs_human" as const, error: "subscription needs a review screenshot" }) };
    const ctx = tickContext(w, { ports: { store: store as never } });
    await pollDueJobs(ctx);
    const task = w.store.tasks.list((t) => t.kind === "store.manual_step")[0];
    expect(task?.instructions).toMatch(/review screenshot/);
    expect(w.store.jobs.require("job_000001").status).toBe("needs_human");
    w.clock.advanceHours(2);
    w.gov.completeTask(task?.id as string, { confirmed: "yes" }, "owner");
    expect(applyTaskOutcomes(ctx)).toContain("job_000001 re-armed after " + task?.id);
    expect(w.store.jobs.require("job_000001").status).toBe("running");
  });
});
