import { describe, expect, it } from "vitest";
import type { CellMetricRequest } from "../../src/core/ports.ts";
import type { EventName } from "../../src/core/events.ts";
import type { Venture } from "../../src/core/types.ts";
import type { SimWorld } from "../../src/sim/world.ts";
import { addVenture, ARCHETYPES, BASE_IDEA, campaign, day, days, harness, type Harness, openCampaign } from "./fixtures.ts";

const SINCE = "2026-03-01T00:00:00.000Z";

function req(h: Harness, v: Venture, cellId: string, numerator: EventName, denominator: EventName, o: Partial<CellMetricRequest> = {}): CellMetricRequest {
  return {
    bindings: v.bindings,
    ventureId: v.id,
    experimentId: "exp_000001",
    cellId,
    geo: "CA",
    assignment: "geo",
    numerator,
    denominator,
    maturityHours: 0,
    since: SINCE,
    asOf: h.clock.iso(),
    ...o,
  };
}

/** A cell id the seed leaves free of planted confounds. */
function cleanCell(world: SimWorld, prefix: string): string {
  for (let i = 0; ; i++) {
    const id = `${prefix}_${i}`;
    const c = world.confounds(id);
    if (!c.instrumentation && !c.warm) return id;
  }
}

function confoundedCell(world: SimWorld, kind: "instrumentation" | "warm"): string {
  for (let i = 0; ; i++) {
    const id = `cell_conf_${i}`;
    const c = world.confounds(id);
    if (c[kind] && !c[kind === "warm" ? "instrumentation" : "warm"]) return id;
  }
}

/** A venture live in CA with an experiment campaign in CA, run for `n` days. */
async function liveInCa(seed: number, n: number, idea = BASE_IDEA): Promise<{ h: Harness; v: Venture }> {
  const h = harness(seed);
  const v = addVenture(h, 1, idea, ["CA"]);
  await openCampaign(h, campaign(h, v, 1, "CA", { experimentId: "exp_000001", cellId: "cell_000001" }));
  await days(h, n);
  return { h, v };
}

async function snapshot(h: Harness, v: Venture) {
  const m = h.ports.read.metrics;
  return {
    views: await m.cellMetric(req(h, v, "cell_000001", "install", "view", { maturityHours: 48 })),
    activation: await m.cellMetric(req(h, v, "cell_000001", "activated", "install", { maturityHours: 24, windowHours: 24 })),
    keep: await m.cellMetric(req(h, v, "cell_000001", "trial_kept_24h", "trial_matured_24h")),
    daily: await m.daily({ bindings: v.bindings, ventureId: v.id, since: "2026-03-01", until: "2026-04-30" }),
    cohorts: await m.cohorts({ bindings: v.bindings, ventureId: v.id, cohortSince: "2026-03-01", cohortUntil: "2026-04-30", maxAgeDays: 60 }),
    reviews: await h.ports.read.store.reviews({ bindings: v.bindings, platform: "ios", since: "2026-03-01" }),
  };
}

describe("SimWorld determinism", () => {
  it("gives identical metrics for the same seed and inputs, and different ones for another seed", async () => {
    const a = await liveInCa(5, 20);
    const b = await liveInCa(5, 20);
    const c = await liveInCa(6, 20);
    const sa = await snapshot(a.h, a.v);
    expect(sa.views.trials).toBeGreaterThan(0);
    expect(JSON.stringify(await snapshot(b.h, b.v))).toBe(JSON.stringify(sa));
    expect(JSON.stringify(await snapshot(c.h, c.v))).not.toBe(JSON.stringify(sa));
  });

  it("does not simulate the same day twice", async () => {
    const { h, v } = await liveInCa(5, 6);
    const before = JSON.stringify(h.world.cohortsOf(v.id));
    h.world.advanceDay();
    h.world.advanceDay();
    expect(JSON.stringify(h.world.cohortsOf(v.id))).not.toBe(before); // today had not been simulated yet
    const once = JSON.stringify(h.world.cohortsOf(v.id));
    h.world.advanceDay();
    expect(JSON.stringify(h.world.cohortsOf(v.id))).toBe(once);
  });
});

describe("funnel", () => {
  it("is monotone within every cohort and cumulative over age", async () => {
    const { h, v } = await liveInCa(9, 30);
    const cohorts = h.world.cohortsOf(v.id);
    expect(cohorts.length).toBeGreaterThan(20);
    const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
    for (const c of cohorts) {
      expect(c.activated).toBeLessThanOrEqual(c.installs);
      expect(c.d1).toBeLessThanOrEqual(c.installs);
      expect(sum(c.trials)).toBeLessThanOrEqual(c.activated);
      c.kept24.forEach((k, o) => expect(k).toBeLessThanOrEqual(c.trials[o] as number));
      c.conversions.forEach((n, o) => expect(n).toBeLessThanOrEqual(c.kept24[o] as number));
      expect(sum(c.shareFirst)).toBeLessThanOrEqual(c.activated);
    }
    const rows = await h.ports.read.metrics.cohorts({ bindings: v.bindings, ventureId: v.id, cohortSince: "2026-03-01", cohortUntil: "2026-04-30", maxAgeDays: 60 });
    const byLane = new Map<string, typeof rows>();
    for (const r of rows) byLane.set(`${r.cohortDate}|${r.lane}`, [...(byLane.get(`${r.cohortDate}|${r.lane}`) ?? []), r]);
    for (const lane of byLane.values()) {
      for (let i = 1; i < lane.length; i++) {
        const [prev, cur] = [lane[i - 1], lane[i]] as [(typeof rows)[number], (typeof rows)[number]];
        expect(cur.ageDays).toBeGreaterThan(prev.ageDays);
        expect(cur.installs).toBe(prev.installs);
        for (const k of ["trialStarts", "trialCancels", "conversions", "renewals", "grossRevenueCents", "proceedsCents", "refundsCents"] as const) {
          expect(cur[k]).toBeGreaterThanOrEqual(prev[k]);
        }
        expect(cur.conversions).toBeLessThanOrEqual(cur.trialStarts);
      }
    }
    const cell = cleanCell(h.world, "cell_mono");
    const m = h.ports.read.metrics;
    const act = await m.cellMetric(req(h, v, cell, "activated", "install", { maturityHours: 72 }));
    const trial = await m.cellMetric(req(h, v, cell, "trial_start", "install", { maturityHours: 72 }));
    const keep = await m.cellMetric(req(h, v, cell, "trial_kept_24h", "trial_matured_24h"));
    const paid = await m.cellMetric(req(h, v, cell, "conversion", "trial_matured"));
    expect(act.trials).toBe(trial.trials);
    expect(act.successes).toBeGreaterThanOrEqual(trial.successes);
    expect(trial.successes).toBeGreaterThan(0);
    expect(keep.successes).toBeLessThanOrEqual(keep.trials);
    expect(paid.successes).toBeLessThanOrEqual(keep.successes);
  });

  it("keeps funnel order on average across archetypes: strong ideas convert views to trials better", async () => {
    const strong = await liveInCa(13, 14, BASE_IDEA);
    const weak = await liveInCa(13, 14, (ARCHETYPES.sustained as (i: typeof BASE_IDEA) => typeof BASE_IDEA)(BASE_IDEA));
    const rate = async ({ h, v }: { h: Harness; v: Venture }) => {
      const act = await h.ports.read.metrics.cellMetric(req(h, v, cleanCell(h.world, "c"), "activated", "install", { maturityHours: 24 }));
      return act.successes / Math.max(1, act.trials);
    };
    expect(await rate(weak)).toBeLessThan((await rate(strong)) * 0.7);
  });
});

describe("storefront geography", () => {
  it("installs only where the app is live while creator views leak to other countries", async () => {
    const { h, v } = await liveInCa(3, 12);
    const rows = await h.ports.read.metrics.daily({ bindings: v.bindings, ventureId: v.id, since: "2026-03-01", until: "2026-03-31" });
    const byGeo = (geo: string, ev: EventName) => rows.filter((r) => r.geo === geo).reduce((s, r) => s + (r.counts[ev] ?? 0), 0);
    expect(byGeo("CA", "install")).toBeGreaterThan(0);
    expect(byGeo("US", "view")).toBeGreaterThan(0);
    expect(byGeo("US", "install")).toBe(0);
    expect(h.world.cohortsOf(v.id).every((c) => c.geo === "CA")).toBe(true);

    // Opening AU later: AU installs start only after the territory change.
    const opened = h.clock.today();
    await h.ports.write.store.setTerritories({ bindings: v.bindings, platform: "ios", territories: ["CA", "AU"] });
    await openCampaign(h, campaign(h, v, 2, "AU", { experimentId: "exp_000002", cellId: "cell_000002" }));
    await days(h, 8);
    const au = h.world.cohortsOf(v.id).filter((c) => c.geo === "AU");
    expect(au.length).toBeGreaterThan(0);
    expect(au.every((c) => c.date >= opened)).toBe(true);
  });

  it("geo cells count organic leakage like live, and nothing before a cell post is mature", async () => {
    const h = harness(4);
    const v = addVenture(h, 1, BASE_IDEA, ["CA"]);
    await days(h, 3); // organic search installs only
    const before = await h.ports.read.metrics.cellMetric(req(h, v, "cell_000001", "install", "view", { maturityHours: 48 }));
    expect(before).toEqual({ successes: 0, trials: 0, bySource: {} });
    const organic = await h.ports.read.metrics.cellMetric(req(h, v, cleanCell(h.world, "o"), "activated", "install"));
    expect(organic.trials).toBeGreaterThan(0);
    expect(Object.keys(organic.bySource)).toContain("organic");
    expect(Object.keys(organic.bySource).every((s) => ["organic", "share", "invite"].includes(s))).toBe(true);

    await openCampaign(h, campaign(h, v, 1, "CA", { experimentId: "exp_000001", cellId: "cell_000001" }));
    await days(h, 10);
    const views = await h.ports.read.metrics.cellMetric(req(h, v, "cell_000001", "install", "view", { maturityHours: 48 }));
    expect(views.trials).toBeGreaterThan(views.successes);
    expect(views.successes).toBeGreaterThan(0);
    const sources = Object.keys(views.bySource);
    expect(sources.filter((s) => s.startsWith("simcmp_")).length).toBeGreaterThanOrEqual(5);
    expect(views.bySource.organic?.trials ?? 0).toBe(0);
  });
});

describe("cohort maturity", () => {
  it("excludes cohorts younger than maturityHours", async () => {
    const { h, v } = await liveInCa(8, 10);
    const m = h.ports.read.metrics;
    const cell = cleanCell(h.world, "mat");
    const at = (maturityHours: number) => m.cellMetric(req(h, v, cell, "activated", "install", { maturityHours }));
    const asOf = new Date(h.clock.iso()).getTime();
    const expected = (hours: number) =>
      h.world
        .cohortsOf(v.id)
        .filter((c) => c.installAt + hours * 3_600_000 <= asOf)
        .reduce((s, c) => s + c.installs, 0);
    const [m0, m24, m96] = [await at(0), await at(24), await at(96)];
    expect(m24.trials).toBe(expected(24));
    expect(m0.trials).toBeGreaterThan(m24.trials);
    expect(m24.trials).toBeGreaterThan(m96.trials);
    expect((await at(10_000)).trials).toBe(0);
    // Trials count as matured only 24h after they start.
    const keep = await m.cellMetric(req(h, v, cell, "trial_kept_24h", "trial_matured_24h"));
    const started = await m.cellMetric(req(h, v, cell, "trial_start", "install"));
    expect(keep.trials).toBeLessThan(started.successes);
  });
});

describe("confounds", () => {
  it("plants instrumentation faults in ~4% and warm traffic in ~3% of cells", async () => {
    const { world } = harness(2);
    let instrumentation = 0;
    let warm = 0;
    const n = 20_000;
    for (let i = 0; i < n; i++) {
      const c = world.confounds(`cell_${i}`);
      instrumentation += c.instrumentation ? 1 : 0;
      warm += c.warm ? 1 : 0;
    }
    expect(instrumentation / n).toBeGreaterThan(0.035);
    expect(instrumentation / n).toBeLessThan(0.045);
    expect(warm / n).toBeGreaterThan(0.025);
    expect(warm / n).toBeLessThan(0.035);
  });

  it("drops 70% of activated events on faulty cells and reports 15% internal sessions on warm ones", async () => {
    const { h, v } = await liveInCa(10, 14);
    const m = h.ports.read.metrics;
    const read = (cellId: string) => m.cellMetric(req(h, v, cellId, "activated", "install", { maturityHours: 24 }));
    const clean = await read(cleanCell(h.world, "clean"));
    const faulty = await read(confoundedCell(h.world, "instrumentation"));
    const warmCell = confoundedCell(h.world, "warm");
    const warm = await read(warmCell);
    expect(faulty.trials).toBe(clean.trials);
    expect(faulty.successes / clean.successes).toBeGreaterThan(0.25);
    expect(faulty.successes / clean.successes).toBeLessThan(0.35);
    expect(warm.successes).toBeGreaterThan(clean.successes);
    const share = (cellId: string) => m.internalShare({ bindings: v.bindings, ventureId: v.id, cellId, geo: "CA", since: SINCE, asOf: h.clock.iso() });
    expect(Math.abs((await share(warmCell)) - 0.15)).toBeLessThanOrEqual(0.011);
    expect(await share(cleanCell(h.world, "clean"))).toBeLessThanOrEqual(0.02);
  });
});

describe("user-random cells", () => {
  it("splits new users by sticky flag variants and reads cells by variant id", async () => {
    const h = harness(12);
    const v = addVenture(h, 1, BASE_IDEA, ["CA"]);
    await h.ports.write.remoteConfig.setFlag({
      bindings: v.bindings,
      key: "paywall",
      variants: [
        { id: "cell_a", rolloutPct: 50, payload: { highlightedProductId: "week_699_t3" } },
        { id: "cell_b", rolloutPct: 50, payload: { highlightedProductId: "week_999_t7" } },
      ],
    });
    await openCampaign(h, campaign(h, v, 1, "CA", { budgetCents: 300_000 }));
    await days(h, 12);
    const m = h.ports.read.metrics;
    const read = (cellId: string) => m.cellMetric(req(h, v, cellId, "trial_start", "install", { assignment: "user_random", maturityHours: 24 }));
    const [a, b] = [await read("cell_a"), await read("cell_b")];
    const total = (await m.cellMetric(req(h, v, cleanCell(h.world, "all"), "trial_start", "install", { maturityHours: 24 }))).trials;
    expect(a.trials + b.trials).toBe(total);
    expect(a.trials / total).toBeGreaterThan(0.4);
    expect(a.trials / total).toBeLessThan(0.6);
    expect(h.world.cohortsOf(v.id).every((c) => c.variantIds.length === 1)).toBe(true);
  });
});

describe("daily economics", () => {
  it("books proceeds net of store fee and VAT and marks recent days incomplete", async () => {
    const { h, v } = await liveInCa(14, 20);
    const rows = await h.ports.read.metrics.daily({ bindings: v.bindings, ventureId: v.id, since: "2026-03-01", until: "2026-04-30" });
    const ca = rows.filter((r) => r.geo === "CA" && r.complete && r.grossRevenueCents > 0);
    expect(ca.length).toBeGreaterThan(0);
    const fee = h.config.economics.storeFeeRate.ios;
    const vat = h.config.economics.vatInclusiveRateByGeo.CA ?? 0;
    for (const r of ca) expect(r.proceedsCents / r.grossRevenueCents).toBeCloseTo((1 - fee) / (1 + vat), 2);
    const totals = rows.filter((r) => r.geo === null);
    expect(totals.at(-1)?.complete).toBe(false);
    expect(totals.at(-1)?.date).toBe("2026-03-21");
    expect(totals.some((r) => (r.counts.session ?? 0) > 0)).toBe(true);
  });
});
