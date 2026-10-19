import { describe, expect, it } from "vitest";
import { addDays } from "../../src/core/clock.ts";
import { addVenture, ARCHETYPES, BASE_IDEA, campaign, day, harness, openCampaign } from "./fixtures.ts";

describe("SimWorld performance", () => {
  it("simulates 120 days of ~15 ventures and dozens of campaigns in under 10 s", async () => {
    const h = harness(31);
    const geos = ["CA", "AU", "NZ"];
    const makers = Object.values(ARCHETYPES);
    const ventures = Array.from({ length: 15 }, (_, i) => addVenture(h, i + 1, { ...(makers[i % makers.length] as (x: typeof BASE_IDEA) => typeof BASE_IDEA)(BASE_IDEA), title: `App${i}` }, geos));
    for (const v of ventures.slice(0, 5)) {
      await h.ports.write.remoteConfig.setFlag({ bindings: v.bindings, key: "paywall", variants: [{ id: `${v.id}_a`, rolloutPct: 50, payload: {} }, { id: `${v.id}_b`, rolloutPct: 50, payload: {} }] });
      await h.ports.write.ads.createCampaign({ bindings: v.bindings, network: "meta", adAccountId: "act_sim", os: "ios", type: "creative", dailyBudgetCents: 10_000, startAt: h.clock.iso(), endAt: addDays(h.clock.today(), 90), geos, creatives: [], keywords: [], name: v.id });
    }
    const started = performance.now();
    let n = 0;
    for (let d = 0; d < 120; d++) {
      if (d % 30 === 0) for (const [i, v] of ventures.entries()) await openCampaign(h, campaign(h, v, ++n, geos[(i + d) % 3] as string, { experimentId: `exp_${n}`, cellId: `cell_${n}` }));
      await day(h);
    }
    for (const v of ventures) {
      await h.ports.read.metrics.daily({ bindings: v.bindings, ventureId: v.id, since: "2026-03-01", until: "2026-07-31" });
      await h.ports.read.metrics.cohorts({ bindings: v.bindings, ventureId: v.id, cohortSince: "2026-03-01", cohortUntil: "2026-07-31", maxAgeDays: 120 });
    }
    const ms = performance.now() - started;
    expect(n).toBe(60);
    expect(ventures.reduce((s, v) => s + h.world.cohortsOf(v.id).length, 0)).toBeGreaterThan(5_000);
    expect(ms).toBeLessThan(10_000);
  }, 60_000);
});
