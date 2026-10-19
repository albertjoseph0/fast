import { generateKeyPairSync, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DryRunRecorder } from "../../../src/integrations/http.ts";
import { APPLE_ADS_API, APPLE_TOKEN_URL, AppleAdsClient, appleTime } from "../../../src/integrations/ads/appleAds.ts";
import { env0, fakeFetch, forbiddenFetch } from "../social/helpers.ts";
import type { FakeRoute } from "../social/helpers.ts";
import { campaignRequest } from "./fixtures.ts";

let keyPath: string;
let publicKey: KeyObject;
let ENV: Record<string, string>;

beforeAll(() => {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  publicKey = pair.publicKey;
  keyPath = join(mkdtempSync(join(tmpdir(), "appleads-test-")), "key.pem");
  writeFileSync(keyPath, pair.privateKey.export({ type: "pkcs8", format: "pem" }));
  ENV = { APPLE_ADS_CLIENT_ID: "SEARCHADS.abc", APPLE_ADS_TEAM_ID: "SEARCHADS.team", APPLE_ADS_KEY_ID: "kid-1", APPLE_ADS_PRIVATE_KEY_PATH: keyPath };
});

const tokenRoute: FakeRoute = { method: "POST", match: APPLE_TOKEN_URL, json: { access_token: "aat", token_type: "Bearer", expires_in: 3600, scope: "searchadsorg" } };

function setup(routes: FakeRoute[], env = ENV, dryRun = false) {
  const { config, store, clock } = env0();
  const fake = fakeFetch(routes);
  const apple = new AppleAdsClient({ config, store, clock, env, dryRun, fetch: fake.fetch });
  return { apple, fake };
}

const search = () =>
  campaignRequest({
    network: "apple",
    adAccountId: "4200001",
    type: "search",
    creatives: [],
    geos: ["US"],
    keywords: [
      { text: "astra app", match: "exact", bidCents: 150 },
      { text: "astrology", match: "broad", bidCents: 90 },
    ],
  });

function decode(part: string): any {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

describe("AppleAdsClient auth", () => {
  it("exchanges an ES256 client secret for an access token and caches it", async () => {
    const { apple, fake } = setup([tokenRoute]);
    expect(await apple.accessToken()).toBe("aat");
    expect(await apple.accessToken()).toBe("aat");
    expect(fake.calls).toHaveLength(1);
    const form = new URLSearchParams(fake.calls[0]?.body);
    expect(fake.calls[0]?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("scope")).toBe("searchadsorg");
    expect(form.get("client_id")).toBe("SEARCHADS.abc");
    const [head, body, sig] = (form.get("client_secret") as string).split(".") as [string, string, string];
    expect(decode(head)).toEqual({ alg: "ES256", typ: "JWT", kid: "kid-1" });
    const now = Date.parse("2026-10-19T12:00:00.000Z") / 1000;
    expect(decode(body)).toEqual({ sub: "SEARCHADS.abc", aud: "https://appleid.apple.com", iat: now, exp: now + 86_400, iss: "SEARCHADS.team" });
    expect(verify("sha256", Buffer.from(`${head}.${body}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url"))).toBe(true);
  });
});

describe("AppleAdsClient.createCampaign", () => {
  const routes = (): FakeRoute[] => [
    tokenRoute,
    { method: "POST", match: `${APPLE_ADS_API}/campaigns`, json: { result: { id: 444555666 } } },
    { method: "POST", match: `${APPLE_ADS_API}/adgroups`, json: { result: { id: 555666777 } } },
    {
      method: "POST",
      match: "keywords/bulk-create",
      json: { result: [{ correlationId: 0, operation: "CREATE", success: true, result: { id: 1 } }, { correlationId: 1, operation: "CREATE", success: true, result: { id: 2 } }] },
    },
    { method: "PUT", match: "campaigns/444555666", json: { result: { id: 444555666, status: "ENABLED" } } },
  ];

  it("creates a paused search campaign, ad group and keywords, then enables it", async () => {
    const { apple, fake } = setup(routes());
    const { campaignExternalId } = await apple.createCampaign(search());
    expect(campaignExternalId).toBe("4200001:444555666");
    const api = fake.calls.filter((c) => c.url.startsWith(APPLE_ADS_API));
    expect(api.map((c) => `${c.method} ${c.url.replace(APPLE_ADS_API, "")}`)).toEqual(["POST /campaigns", "POST /adgroups", "POST /keywords/bulk-create", "PUT /campaigns/444555666"]);
    for (const c of api) expect(c.headers).toMatchObject({ authorization: "Bearer aat", "x-ap-context": "adAccountId=4200001" });
    expect(api[0]?.json).toEqual({
      name: "astra-creative-adc_000001",
      adAccountId: 4200001,
      startTime: "2026-10-20T00:00:00.000",
      endTime: "2026-10-23T00:00:00.000",
      status: "PAUSED",
      billingEvent: "TAPS",
      promotedObjectType: "APPSTORE_APP",
      promotedObjectId: "6700000001",
      dailyBudget: { value: { amount: "25.00", currency: "USD" } },
      targeting: { countryOrRegion: { include: ["US"] }, supplyPlacement: { include: ["APPSTORE_SEARCH_RESULTS"] } },
      bidStrategy: { bidStrategyType: "MANUAL_CPT", bidStrategyGoal: "TAP" },
    });
    expect(api[1]?.json).toEqual({
      name: "astra-creative-adc_000001-adgroup",
      campaignId: 444555666,
      pricingModel: "CPT",
      status: "ENABLED",
      startTime: "2026-10-20T00:00:00.000",
      endTime: "2026-10-23T00:00:00.000",
      automatedKeywordsOptIn: false,
      bidStrategy: { bidStrategyType: "MANUAL_CPT", bidStrategyGoal: "TAP", bid: { amount: "1.50", currency: "USD" } },
      targeting: { deviceClass: { include: ["IPHONE", "IPAD"] } },
    });
    expect(api[2]?.json).toEqual({
      items: [
        { correlationId: 0, data: { adGroupId: 555666777, text: "astra app", matchType: "EXACT", bid: { amount: "1.50", currency: "USD" }, status: "ENABLED" } },
        { correlationId: 1, data: { adGroupId: 555666777, text: "astrology", matchType: "BROAD", bid: { amount: "0.90", currency: "USD" }, status: "ENABLED" } },
      ],
    });
    expect(api[3]?.json).toEqual({ status: "ENABLED" });
  });

  it("leaves the campaign paused when keywords are rejected", async () => {
    const r = routes();
    r[3] = { method: "POST", match: "keywords/bulk-create", json: { result: [{ correlationId: 0, success: true }, { correlationId: 1, success: false, errors: [{ message: "invalid" }] }] } };
    const { apple, fake } = setup(r);
    await expect(apple.createCampaign(search())).rejects.toThrow(/rejected.*astrology/);
    expect(fake.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("refuses creative, android, keyword-less and open-ended campaigns", async () => {
    const { apple, fake } = setup([]);
    await expect(apple.createCampaign({ ...search(), type: "creative" })).rejects.toThrow(/custom product pages/);
    await expect(apple.createCampaign({ ...search(), os: "android" })).rejects.toThrow(/App Store/);
    await expect(apple.createCampaign({ ...search(), keywords: [] })).rejects.toThrow(/need keywords/);
    await expect(apple.createCampaign({ ...search(), endAt: "2026-10-19T00:00:00.000Z" })).rejects.toThrow(/endAt/);
    expect(fake.calls).toHaveLength(0);
  });

  it("dry-run records every write with no fetch calls at all", async () => {
    const { config, store, clock } = env0();
    const recorder = new DryRunRecorder(null);
    const apple = new AppleAdsClient({ config, store, clock, env: ENV, dryRun: true, recorder, fetch: forbiddenFetch });
    const { campaignExternalId } = await apple.createCampaign(search());
    expect(campaignExternalId).toMatch(/^4200001:dry_applecampaign_/);
    expect(recorder.list().map((r) => r.method)).toEqual(["POST", "POST", "POST", "PUT"]);
    expect(recorder.list()[0]?.headers["x-ap-context"]).toBe("adAccountId=4200001");
    await apple.setDailyBudget(campaignExternalId, 1_999);
    await apple.pause(campaignExternalId);
    expect(recorder.list().slice(-2).map((r) => r.json)).toEqual([{ dailyBudget: { value: { amount: "19.99", currency: "USD" } } }, { status: "PAUSED" }]);
    expect(await apple.stats(campaignExternalId, "2026-10-01", "2026-10-02")).toEqual([]);
  });
});

describe("AppleAdsClient budget, pause, stats", () => {
  it("updates budget and status with PUT", async () => {
    const { apple, fake } = setup([tokenRoute, { method: "PUT", match: "campaigns/9", json: { result: {} } }]);
    await apple.setDailyBudget("4200001:9", 3_000);
    await apple.pause("4200001:9");
    const puts = fake.calls.filter((c) => c.method === "PUT");
    expect(puts.map((c) => [c.url, c.json])).toEqual([
      [`${APPLE_ADS_API}/campaigns/9`, { dailyBudget: { value: { amount: "30.00", currency: "USD" } } }],
      [`${APPLE_ADS_API}/campaigns/9`, { status: "PAUSED" }],
    ]);
    await expect(apple.pause("9")).rejects.toThrow(/<account>:<campaign>/);
  });

  it("maps the daily campaign report", async () => {
    const { apple, fake } = setup([
      tokenRoute,
      {
        method: "POST",
        match: "reports/apps/campaigns/query",
        json: {
          result: {
            rows: [
              {
                metadata: { id: 9 },
                granularMetrics: [
                  { date: "2026-10-18", localSpend: { amount: "18.40", currency: "USD" }, impressions: 1850, taps: 92, tapInstalls: 22, totalInstalls: 25 },
                  { date: "2026-10-16", localSpend: { amount: "5.00", currency: "USD" }, impressions: 400, taps: 20, tapInstalls: 6 },
                ],
              },
            ],
          },
        },
      },
    ]);
    const stats = await apple.stats("4200001:9", "2026-10-16", "2026-10-18");
    const report = fake.calls.find((c) => c.url.includes("reports"));
    expect(report?.json).toEqual({
      pagination: { offset: 0, pageSize: 1000 },
      filters: [{ field: "campaignId", operator: "EQUALS", value: "9" }],
      timeRange: { start: "2026-10-16", end: "2026-10-18", timeZone: "UTC", granularity: "DAILY" },
    });
    expect(stats).toEqual([
      { date: "2026-10-16", spendCents: 500, impressions: 400, taps: 20, installs: 6, conversions: null, revenueCents: null, attributionComplete: true },
      { date: "2026-10-18", spendCents: 1840, impressions: 1850, taps: 92, installs: 25, conversions: null, revenueCents: null, attributionComplete: false },
    ]);
  });

  it("asks single days without granularity and reads totals", async () => {
    const { apple, fake } = setup([
      tokenRoute,
      { method: "POST", match: "reports", json: { result: { rows: [{ totalMetrics: { localSpend: { amount: "2.00", currency: "USD" }, impressions: 10, taps: 1, tapInstalls: 1 } }] } } },
    ]);
    const stats = await apple.stats("4200001:9", "2026-10-10", "2026-10-10");
    expect(fake.calls.find((c) => c.url.includes("reports"))?.json.timeRange).toEqual({ start: "2026-10-10", end: "2026-10-10", timeZone: "UTC" });
    expect(stats).toEqual([{ date: "2026-10-10", spendCents: 200, impressions: 10, taps: 1, installs: 1, conversions: null, revenueCents: null, attributionComplete: true }]);
  });

  it("formats times without a zone suffix", () => {
    expect(appleTime("2026-10-20T05:06:07.000Z")).toBe("2026-10-20T05:06:07.000");
  });
});
