import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../../src/config/schema.ts";
import { SimClock } from "../../../src/core/clock.ts";
import { StudioStore } from "../../../src/core/store.ts";
import type { CreatorCampaign, CreatorSubmission, Venture, VentureBindings } from "../../../src/core/types.ts";
import type { CellMetricRequest } from "../../../src/core/ports.ts";
import { DryRunRecorder, MissingBindingError } from "../../../src/integrations/http.ts";
import { LiveMetricsPort, LiveRemoteConfigWrite, flagBody } from "../../../src/integrations/posthog/client.ts";
import { fake, noFetch, noSleep } from "./fakeFetch.ts";

const bindings: VentureBindings = {
  platforms: ["ios"],
  publisherAccountIds: {},
  bundleId: "com.fast.astro",
  androidPackage: "com.fast.astro",
  posthogProjectId: "4242",
  ownedAccountIds: {},
  adAccountIds: {},
  products: [],
};

function world(f: ReturnType<typeof fake> | null, opts: { dryRun?: boolean; key?: string | null; host?: string } = {}) {
  const clock = new SimClock("2026-10-10T12:00:00.000Z");
  const store = new StudioStore(null, clock);
  store.ventures.put({ id: "v1", slug: "astro", bindings } as unknown as Venture);
  const recorder = new DryRunRecorder(null);
  const env: Record<string, string | undefined> = { ...(opts.key === null ? {} : { POSTHOG_PERSONAL_API_KEY: opts.key ?? "phx_test" }), ...(opts.host ? { POSTHOG_HOST: opts.host } : {}) };
  const common = { config: defaultConfig(), store, env, dryRun: opts.dryRun ?? false, recorder, fetch: f?.fetch ?? noFetch, sleep: noSleep, clock };
  return { store, recorder, clock, metrics: new LiveMetricsPort(common), flags: new LiveRemoteConfigWrite(common) };
}

const req = (over: Partial<CellMetricRequest> = {}): CellMetricRequest => ({
  bindings,
  ventureId: "v1",
  experimentId: "exp1",
  cellId: "cellCA",
  geo: "CA",
  assignment: "geo",
  numerator: "activated",
  denominator: "install",
  maturityHours: 24,
  windowHours: 24,
  since: "2026-10-01T00:00:00.000Z",
  asOf: "2026-10-10T12:00:00.000Z",
  ...over,
});

describe("PostHog query API", () => {
  it("POSTs a HogQLQuery with values to the project's query endpoint and parses bySource", async () => {
    const f = fake([{ method: "POST", match: "/api/projects/4242/query/", json: { results: [["creator_a", 10, 6], ["unknown", 5, 1]] } }]);
    const { metrics } = world(f);
    const out = await metrics.cellMetric(req());
    expect(out).toEqual({ successes: 7, trials: 15, bySource: { creator_a: { successes: 6, trials: 10 }, unknown: { successes: 1, trials: 5 } } });
    const call = f.calls[0]!;
    expect(call.url).toBe("https://us.posthog.com/api/projects/4242/query/");
    expect(call.headers.authorization).toBe("Bearer phx_test");
    expect(call.json.query.kind).toBe("HogQLQuery");
    expect(call.json.query.query).toContain("FROM events");
    expect(call.json.query.values).toMatchObject({ v0: "2026-10-01 00:00:00" });
    expect(call.json.name).toBe("cell:exp1:cellCA:activated/install");
  });

  it("queries are reads: they run in dry-run and honor POSTHOG_HOST", async () => {
    const f = fake([{ method: "POST", match: "/query/", json: { results: [[3, 12]] } }]);
    const { metrics, recorder } = world(f, { dryRun: true, host: "https://eu.posthog.com/" });
    expect(await metrics.internalShare({ bindings, ventureId: "v1", cellId: "cellCA", geo: "CA", since: "2026-10-01", asOf: "2026-10-10T00:00:00Z" })).toBe(0.25);
    expect(f.calls[0]?.url).toBe("https://eu.posthog.com/api/projects/4242/query/");
    expect(recorder.list()).toHaveLength(0);
  });

  it("dry-run without a key never calls fetch and returns empty metrics", async () => {
    const { metrics } = world(null, { dryRun: true, key: null });
    expect(await metrics.cellMetric(req())).toEqual({ successes: 0, trials: 0, bySource: {} });
    expect(await metrics.internalShare({ bindings, ventureId: "v1", cellId: "c", geo: "CA", since: "2026-10-01", asOf: "2026-10-10T00:00:00Z" })).toBe(0);
  });

  it("requires a bound PostHog project", async () => {
    const { metrics } = world(fake());
    const missing = metrics.cellMetric(req({ bindings: { ...bindings, posthogProjectId: undefined } }));
    await expect(missing).rejects.toBeInstanceOf(MissingBindingError);
    await expect(missing).rejects.toMatchObject({ service: "posthog", binding: "posthogProjectId", message: expect.stringMatching(/integrations\.bind_projects/) });
  });
});

describe("installsPer1kViews from verified views", () => {
  it("uses in-geo views of mature cell posts as trials and in-storefront installs as successes", async () => {
    const f = fake([{ method: "POST", match: "/query/", json: { results: [["cr1", 9, 9], ["unknown", 3, 3]] } }]);
    const { metrics, store } = world(f);
    store.campaigns.put({ id: "camp1", ventureId: "v1", experimentId: "exp1", cellId: "cellCA", targetCountries: ["CA"], creatorAudienceCountryMinPct: 0.5 } as CreatorCampaign);
    store.creators.put({ id: "cr1", audienceGeo: { CA: 0.5 } } as never);
    const sub = (id: string, postedAt: string, views: number): CreatorSubmission =>
      ({
        id,
        externalId: id,
        campaignId: "camp1",
        creatorId: "cr1",
        stage: "post_approved",
        postedAt,
        verification: { fetchedAt: postedAt, postIsPublic: true, authorHandleMatches: true, platformDisclosureLabel: true, viewsFromPlatform: views, audienceGeo: { CA: 0.8 } },
      }) as unknown as CreatorSubmission;
    store.submissions.put(sub("s1", "2026-10-05T10:00:00.000Z", 10_000));
    store.submissions.put(sub("s2", "2026-10-09T18:00:00.000Z", 50_000)); // younger than 48h: not counted
    const out = await metrics.cellMetric(req({ numerator: "install", denominator: "view", maturityHours: 48, windowHours: undefined }));
    expect(out.trials).toBe(8_000);
    expect(out.successes).toBe(12);
    expect(out.bySource).toEqual({ cr1: { successes: 9, trials: 8_000 }, unknown: { successes: 3, trials: 0 } });
    expect(f.calls[0]?.json.query.values).toMatchObject({ v0: "2026-10-05 00:00:00" });
  });

  it("counts current views, and a geo-only campaign's required audience share when no geo was measured", async () => {
    const f = fake([{ method: "POST", match: "/query/", json: { results: [["cr1", 30, 30]] } }]);
    const { metrics, store } = world(f);
    store.campaigns.put({ id: "camp1", ventureId: "v1", experimentId: "exp1", cellId: "cellCA", targetCountries: ["CA"], creatorAudienceCountryMinPct: 0.6 } as CreatorCampaign);
    store.campaigns.put({ id: "camp2", ventureId: "v1", experimentId: "exp1", cellId: "cellCA", targetCountries: ["CA", "AU"], creatorAudienceCountryMinPct: 0.6 } as CreatorCampaign);
    store.creators.put({ id: "cr1", audienceGeo: {} } as never);
    store.creators.put({ id: "cr2", audienceGeo: {} } as never);
    const verification = { fetchedAt: "2026-10-08T00:00:00.000Z", postIsPublic: true, authorHandleMatches: true, platformDisclosureLabel: true, viewsFromPlatform: 120_000 };
    // Locked early at 1,500 views; the platform now reports 120,000.
    store.submissions.put({ id: "s1", externalId: "s1", campaignId: "camp1", creatorId: "cr1", stage: "post_approved", postedAt: "2026-10-05T10:00:00.000Z", viewsAtLock: 1_500, verification } as unknown as CreatorSubmission);
    store.submissions.put({ id: "s2", externalId: "s2", campaignId: "camp2", creatorId: "cr2", stage: "post_approved", postedAt: "2026-10-05T10:00:00.000Z", verification } as unknown as CreatorSubmission);
    const out = await metrics.cellMetric(req({ numerator: "install", denominator: "view", maturityHours: 48, windowHours: undefined }));
    expect(out.trials).toBe(72_000);
    expect(out.bySource).toEqual({ cr1: { successes: 30, trials: 72_000 } });
  });

  it("no mature post means no unit and no query", async () => {
    const { metrics } = world(null);
    expect(await metrics.cellMetric(req({ numerator: "install", denominator: "view", maturityHours: 48 }))).toEqual({ successes: 0, trials: 0, bySource: {} });
  });
});

describe("feature flags (remote config)", () => {
  const variants = [
    { id: "pw_a", rolloutPct: 50, payload: { headline: "A" } },
    { id: "pw_b", rolloutPct: 50, payload: { headline: "B" } },
  ];

  it("builds a sticky multivariate flag with JSON payloads", () => {
    expect(flagBody("paywall", variants)).toEqual({
      key: "paywall",
      name: "Studio experiment flag: paywall",
      active: true,
      ensure_experience_continuity: true,
      filters: {
        groups: [{ properties: [], rollout_percentage: 100, variant: null }],
        multivariate: { variants: [{ key: "pw_a", name: "pw_a", rollout_percentage: 50 }, { key: "pw_b", name: "pw_b", rollout_percentage: 50 }] },
        payloads: { pw_a: '{"headline":"A"}', pw_b: '{"headline":"B"}' },
      },
    });
    expect(() => flagBody("paywall", [{ id: "a", rolloutPct: 60, payload: null }])).toThrow(/sum to 60/);
    expect(() => flagBody("paywall", [{ id: "bad key", rolloutPct: 100, payload: null }])).toThrow(/variant key/);
  });

  it("creates the flag in the venture's project when it does not exist", async () => {
    const f = fake([
      { method: "GET", match: "/api/projects/4242/feature_flags/", json: { results: [] } },
      { method: "POST", match: "/api/projects/4242/feature_flags/", json: (c) => ({ id: 7, ...c.json }) },
    ]);
    const { flags } = world(f);
    expect(await flags.setFlag({ bindings, key: "paywall", variants })).toEqual({ flagKey: "paywall" });
    expect(f.calls[0]?.url).toBe("https://us.posthog.com/api/projects/4242/feature_flags/?key=paywall&limit=100");
    expect(f.writes()[0]?.json).toEqual(flagBody("paywall", variants));
  });

  it("updates an existing flag with the same key", async () => {
    const f = fake([
      { method: "GET", match: "/feature_flags/", json: { results: [{ id: 9, key: "paywall-old" }, { id: 7, key: "paywall" }] } },
      { method: "PATCH", match: "/api/projects/4242/feature_flags/7/", json: { id: 7 } },
    ]);
    const { flags } = world(f);
    await flags.setFlag({ bindings, key: "paywall", variants });
    expect(f.writes().map((c) => [c.method, c.url])).toEqual([["PATCH", "https://us.posthog.com/api/projects/4242/feature_flags/7/"]]);
  });

  it("only accepts the keys the app reads", async () => {
    const { flags } = world(fake());
    await expect(flags.setFlag({ bindings, key: "pricing", variants })).rejects.toThrow(/paywall, onboarding, share, core/);
  });

  it("dry-run records the flag write without calling fetch for it", async () => {
    const f = fake([{ method: "GET", match: "/feature_flags/", json: { results: [] } }]);
    const { flags, recorder } = world(f, { dryRun: true });
    await flags.setFlag({ bindings, key: "onboarding", variants: [{ id: "ob_a", rolloutPct: 100, payload: { steps: 8 } }] });
    expect(f.writes()).toHaveLength(0);
    expect(recorder.list()).toHaveLength(1);
    expect(recorder.list()[0]).toMatchObject({ service: "posthog", method: "POST", json: { key: "onboarding" } });
  });
});

describe("daily and cohorts", () => {
  it("reads subscriptions past PostHog's 50k row cap, so the newest purchases still count", async () => {
    const old = Array.from({ length: 50_000 }, (_, i) => [`old${i}`, "CAN", "2025-11-01 00:00:00", "2025-12-01T00:00:00Z"]);
    const recent = [["p1", "CAN", "2026-10-08 10:00:00", "2026-10-15T10:00:00Z"], ["p2", "CAN", "2026-10-08 11:00:00", "2026-10-15T11:00:00Z"]];
    const f = fake([
      {
        method: "POST",
        match: "/query/",
        json: (c) => (String(c.json.name).startsWith("daily") ? { results: [] } : { results: String(c.json.query.query).endsWith("OFFSET 0") ? old : recent }),
      },
    ]);
    const { metrics } = world(f);
    const rows = await metrics.daily({ bindings, ventureId: "v1", since: "2026-10-08", until: "2026-10-09" });
    expect(rows.find((r) => r.date === "2026-10-09" && r.geo === null)?.activeSubscribers).toBe(2);
    const subs = f.calls.filter((c) => String(c.json.name).startsWith("subscriptions")).map((c) => String(c.json.query.query).match(/LIMIT \d+ OFFSET \d+$/)?.[0]);
    expect(subs).toEqual(["LIMIT 50000 OFFSET 0", "LIMIT 50000 OFFSET 50000"]);
  });

  it("assembles daily rows from event counts, revenue and active subscriptions", async () => {
    const f = fake([
      {
        method: "POST",
        match: "/query/",
        json: (c) =>
          String(c.json.name).startsWith("daily")
            ? {
                results: [
                  ["2026-10-08", "CAN", "ios", "install", 10, 0],
                  ["2026-10-08", "CAN", "ios", "conversion", 1, 6.99],
                  ["2026-10-08", "", "ios", "session", 4, 0],
                  ["2026-10-09", "AU", "android", "refund", 1, -6.99],
                ],
              }
            : { results: [["p1", "CAN", "2026-10-08 10:00:00", "2026-10-15T10:00:00Z"]] },
      },
    ]);
    const { metrics } = world(f);
    const rows = await metrics.daily({ bindings, ventureId: "v1", since: "2026-10-08", until: "2026-10-09" });
    const total8 = rows.find((r) => r.date === "2026-10-08" && r.geo === null)!;
    expect(total8.counts).toEqual({ install: 10, conversion: 1, session: 4 });
    expect(total8.grossRevenueCents).toBe(699);
    expect(total8.proceedsCents).toBe(Math.round((699 / 1.13) * 0.85));
    expect(total8.activeSubscribers).toBe(1);
    expect(total8.complete).toBe(false); // within revenueLagDays (3) of 2026-10-10
    const ca8 = rows.find((r) => r.date === "2026-10-08" && r.geo === "CA")!;
    expect(ca8.counts.install).toBe(10);
    const total9 = rows.find((r) => r.date === "2026-10-09" && r.geo === null)!;
    expect(total9.refundsCents).toBe(699);
    expect(total9.complete).toBe(false);
  });

  it("builds cumulative cohort rows per lane", async () => {
    const f = fake([
      {
        method: "POST",
        match: "/query/",
        json: {
          results: [
            ["p1", "2026-10-05 09:00:00", "CAN", "ios", "cr1", "", "exp1", "cellCA", "trial_start", "2026-10-05 09:10:00", 0, ""],
            ["p1", "2026-10-05 09:00:00", "CAN", "ios", "cr1", "", "exp1", "cellCA", "conversion", "2026-10-08 09:10:00", 6.99, "2026-10-15T09:10:00Z"],
            ["p2", "2026-10-05 11:00:00", "CAN", "ios", "cr1", "", "exp1", "cellCA", "", "", 0, ""],
          ],
        },
      },
    ]);
    const { metrics } = world(f);
    const rows = await metrics.cohorts({ bindings, ventureId: "v1", cohortSince: "2026-10-01", cohortUntil: "2026-10-09", maxAgeDays: 90 });
    expect(rows.map((r) => r.ageDays)).toEqual([0, 1, 2, 3, 4]);
    const d0 = rows[0]!;
    expect(d0).toMatchObject({ lane: "v1|creator_ugc|CA|cr1", geo: "CA", installs: 2, trialStarts: 1, conversions: 0, experimentId: "exp1", cellId: "cellCA" });
    const d3 = rows[3]!;
    expect(d3).toMatchObject({ conversions: 1, grossRevenueCents: 699, activeSubscribers: 1 });
  });
});

describe("attentionHitRate from owned posts", () => {
  it("counts mature owned posts of the experiment and hits at the configured view threshold", async () => {
    const { metrics, store } = world(null);
    const piece = (id: string, postedAt: string, views: number) =>
      ({ id, ventureId: "v1", experimentId: "exp1", status: "posted", postedAt, stats: { asOf: postedAt, views } }) as never;
    store.content.put(piece("c1", "2026-10-01T00:00:00.000Z", 6_000));
    store.content.put(piece("c2", "2026-10-02T00:00:00.000Z", 100));
    store.content.put(piece("c3", "2026-10-10T00:00:00.000Z", 9_000)); // younger than 48h
    const out = await metrics.cellMetric(req({ numerator: "post_hit", denominator: "post", maturityHours: 48, windowHours: undefined }));
    expect(out).toEqual({ successes: 1, trials: 2, bySource: { c1: { successes: 1, trials: 1 }, c2: { successes: 0, trials: 1 } } });
  });
});
