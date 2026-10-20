import { describe, expect, it } from "vitest";
import { applyLifecycleDecisions, planAllocation, ventureEconomics } from "../../src/orchestrator/allocator.ts";
import { cohort, makeWorld, markExecuted, openActions, tickContext, withSpec } from "./fixtures.ts";
import { campaign } from "../governance/fixtures.ts";

describe("applyLifecycleDecisions", () => {
  it("kills a venture once its kill executed, winding down spend and pulling a live app", () => {
    const w = makeWorld();
    w.store.campaigns.put(campaign({ id: "ccmp_000001", status: "open", externalId: "ext_1" }));
    const ctx = tickContext(w);
    const kill = w.gov.propose({ kind: "venture.kill", ventureId: w.venture.id, payload: { reason: "S1 futile" }, summary: "Kill", rationale: "S1 futile", proposedBy: "lab", naturalKey: "kill" });
    markExecuted(w, kill);

    expect(applyLifecycleDecisions(ctx)).toEqual(["ven_000001 killed"]);
    const v = w.store.ventures.require(w.venture.id);
    expect(v.stage).toBe("killed");
    expect(v.history.at(-1)?.reason).toMatch(new RegExp(`^${kill.id}:`));
    expect(openActions(w, "creator.campaign_close")).toHaveLength(1);
    expect(openActions(w, "store.remove_from_sale")).toHaveLength(1);
    // Idempotent: the same executed action is not applied twice.
    expect(applyLifecycleDecisions(ctx)).toEqual([]);
  });

  it("moves a validated venture to scaling and prices the scale storefronts before opening them", () => {
    const w = makeWorld();
    withSpec(w);
    const ctx = tickContext(w);
    const scale = w.gov.propose({
      kind: "venture.scale",
      ventureId: w.venture.id,
      payload: { evidence: "S1+S4 replicated", experimentIds: [], proposedDailyCents: 10_000, addTerritories: ["US"] },
      summary: "Scale",
      rationale: "validated",
      proposedBy: "lab",
      naturalKey: "scale",
    });
    markExecuted(w, scale);
    applyLifecycleDecisions(ctx);
    expect(w.store.ventures.require(w.venture.id).stage).toBe("scaling");
    const [subs] = openActions(w, "store.upsert_subscriptions");
    const [territories] = openActions(w, "store.set_territories");
    expect((territories?.payload as { territories: string[] }).territories).toEqual(["CA", "US"]);
    expect((subs?.createdAt ?? "") <= (territories?.createdAt ?? "")).toBe(true);
  });

  it("does not let a sunset venture be revived by an old scale action", () => {
    const w = makeWorld();
    w.store.ventures.put({ ...w.venture, stage: "sunsetting" });
    const scale = w.gov.propose({ kind: "venture.scale", ventureId: w.venture.id, payload: { evidence: "", experimentIds: [], proposedDailyCents: 1, addTerritories: [] }, summary: "s", rationale: "r", proposedBy: "lab", naturalKey: "scale" });
    markExecuted(w, scale);
    expect(applyLifecycleDecisions(tickContext(w))).toEqual([]);
    expect(w.store.ventures.require(w.venture.id).stage).toBe("sunsetting");
  });
});

describe("ventureEconomics and planAllocation", () => {
  const setup = (conversions: number) => {
    const w = makeWorld();
    withSpec(w);
    w.store.ventures.put({ ...w.store.ventures.require(w.venture.id), stage: "scaling" });
    w.clock.advanceDays(10);
    w.store.upsertCohorts(w.venture.id, [cohort({ conversions, cohortDate: "2026-02-25" })]);
    return w;
  };

  it("computes a skeptical D60 revenue per install from mature cohorts", () => {
    const w = setup(80);
    const econ = ventureEconomics(tickContext(w), w.store.ventures.require(w.venture.id));
    expect(econ?.installs).toBe(1000);
    expect(econ?.cacCents).toBe(50);
    // p20 conversion is below the observed 8%, so the prediction is conservative.
    const naive = 0.08 * 699 * (1 - 0.15);
    expect(econ?.predNetRpiD60P20Cents).toBeGreaterThan(naive * 0.5);
    expect(econ?.paybackDaysPred).not.toBeNull();
  });

  it("ramps a profitable venture by at most the configured step and cuts an unprofitable one", () => {
    const good = setup(80);
    const plan = planAllocation(tickContext(good), good.ledger);
    const lane = plan.lanes[0];
    expect(lane?.marginalRoasD60).toBeGreaterThan(1);
    expect(lane?.proposedDailyCents).toBeGreaterThan(lane?.currentDailyCents ?? 0);
    expect(lane?.proposedDailyCents).toBeLessThanOrEqual(Math.round(Math.max(lane?.currentDailyCents ?? 0, 1000) * 1.25) + 1);

    const bad = setup(2);
    const badPlan = planAllocation(tickContext(bad), bad.ledger);
    expect(badPlan.lanes[0]?.proposedDailyCents).toBe(0);
    expect(badPlan.lanes[0]?.reason).toMatch(/below half the S4 bar/);
  });

  it("keeps a cut and the ramp cool-down across processes: the last plan lives on the venture", () => {
    const bad = setup(2);
    planAllocation(tickContext(bad), bad.ledger);
    expect(bad.store.ventures.require("ven_000001").budget).toMatchObject({ dailyCents: 0 });
    // A new process has no in-memory events; the cut still holds instead of reverting to the scale payload.
    bad.store.ventures.put({ ...bad.store.ventures.require("ven_000001") });
    expect(planAllocation(tickContext(bad), bad.ledger).lanes[0]?.currentDailyCents).toBe(0);

    const good = setup(80);
    const first = planAllocation(tickContext(good), good.ledger).lanes[0];
    const second = planAllocation(tickContext(good), good.ledger).lanes[0];
    expect(second?.currentDailyCents).toBe(first?.proposedDailyCents);
    expect(second?.reason).toBe("ramp cooling down");
  });

  it("keeps committed spend until payback within the free cash validation does not hold", () => {
    const w = setup(80);
    const plan = planAllocation(tickContext(w), w.ledger);
    expect(plan.projectedTroughCents).toBeGreaterThanOrEqual(Math.floor(w.ledger.freeCash() * w.config.budgets.testBudgetShare) - 1);
    expect(plan.lanes.reduce((s, l) => s + l.proposedDailyCents, 0)).toBeLessThanOrEqual(w.ledger.dailySpendCap() - plan.testBudgetCents);
  });
});

describe("time box", () => {
  it("does not expire for a venture that completed its ladder and awaits a scale decision", async () => {
    const { timeboxExpired } = await import("../../src/orchestrator/lifecycle.ts");
    const w = makeWorld();
    const v = w.store.ventures.require(w.venture.id);
    const later = new Date(new Date(v.timeboxStartedAt as string).getTime() + 90 * 86_400_000).toISOString();
    expect(timeboxExpired(v, later, w.config)).toBe(true);
    const done = { ...v, ladder: { ...v.ladder, stepIndex: v.ladder.steps.length, validated: ["S1_distribution", "S1_activation", "S4_monetization"] as typeof v.ladder.validated } };
    expect(timeboxExpired(done, later, w.config)).toBe(false);
  });
});
