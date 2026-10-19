import { describe, expect, it } from "vitest";
import { DryRunRecorder } from "../../../src/integrations/http.ts";
import { TIKTOK_ADS_API, TikTokAdsClient, locationIds, tiktokTime } from "../../../src/integrations/ads/tiktok.ts";
import { env0, fakeFetch, forbiddenFetch } from "../social/helpers.ts";
import type { FakeRoute } from "../social/helpers.ts";
import { campaignRequest } from "./fixtures.ts";

const ADV = "7000000000000000001";
const ok = (data: unknown) => ({ code: 0, message: "OK", request_id: "r1", data });
const spark = { kind: "spark_code" as const, contentId: "content_000002", code: "#AUTHCODE123", expiresAt: "2026-11-15T00:00:00.000Z" };

function setup(routes: FakeRoute[], env: Record<string, string> = { TIKTOK_ADS_TOKEN: "adtok" }, dryRun = false) {
  const { config, store, clock } = env0();
  const fake = fakeFetch(routes);
  const tt = new TikTokAdsClient({ config, store, clock, env, dryRun, fetch: fake.fetch });
  return { tt, fake };
}

const createRoutes = (): FakeRoute[] => [
  { method: "POST", match: "tt_video/authorize/", json: ok({}) },
  { method: "GET", match: "tt_video/info/", text: `{"code":0,"message":"OK","data":{"item_info":{"item_id":7311111111111111111},"user_info":{"identity_id":"idn_42"}}}` },
  { method: "GET", match: "app/list/", json: ok({ apps: [{ app_id: "app_9", download_url: "https://apps.apple.com/us/app/astra/id6700000001" }] }) },
  { method: "POST", match: "campaign/create/", json: ok({ campaign_id: "1800000000000000001" }) },
  { method: "POST", match: "adgroup/create/", json: ok({ adgroup_id: "1800000000000000002" }) },
  { method: "POST", match: "ad/create/", json: ok({ ad_ids: ["1800000000000000003"] }) },
  { method: "POST", match: "campaign/status/update/", json: ok({}) },
];

describe("TikTokAdsClient.createCampaign", () => {
  it("creates an APP_PROMOTION campaign with a Spark Ad from an auth code", async () => {
    const { tt, fake } = setup(createRoutes());
    const { campaignExternalId } = await tt.createCampaign(campaignRequest({ network: "tiktok", adAccountId: ADV, creatives: [spark] }));
    expect(campaignExternalId).toBe(`${ADV}:1800000000000000001`);
    const paths = fake.calls.map((c) => `${c.method} ${c.url.replace(TIKTOK_ADS_API, "").split("?")[0]}`);
    expect(paths).toEqual(["POST /tt_video/authorize/", "GET /tt_video/info/", "GET /app/list/", "POST /campaign/create/", "POST /adgroup/create/", "POST /ad/create/", "POST /campaign/status/update/"]);
    for (const c of fake.calls) expect(c.headers["access-token"]).toBe("adtok");
    const body = (p: string) => fake.calls.find((c) => c.url.includes(p))?.json;
    expect(body("tt_video/authorize/")).toEqual({ advertiser_id: ADV, auth_code: "#AUTHCODE123" });
    expect(body("campaign/create/")).toEqual({
      advertiser_id: ADV,
      campaign_name: "astra-creative-adc_000001",
      objective_type: "APP_PROMOTION",
      app_promotion_type: "APP_INSTALL",
      budget_mode: "BUDGET_MODE_DAY",
      budget: 25,
      operation_status: "DISABLE",
    });
    expect(body("adgroup/create/")).toEqual({
      advertiser_id: ADV,
      campaign_id: "1800000000000000001",
      adgroup_name: "astra-creative-adc_000001-adgroup",
      promotion_type: "APP_IOS",
      app_id: "app_9",
      operating_systems: ["IOS"],
      placement_type: "PLACEMENT_TYPE_NORMAL",
      placements: ["PLACEMENT_TIKTOK"],
      location_ids: ["6252001", "6251999"],
      budget_mode: "BUDGET_MODE_INFINITE",
      schedule_type: "SCHEDULE_START_END",
      schedule_start_time: "2026-10-20 00:00:00",
      schedule_end_time: "2026-10-23 00:00:00",
      optimization_goal: "INSTALL",
      billing_event: "OCPM",
      bid_type: "BID_TYPE_NO_BID",
      pacing: "PACING_MODE_SMOOTH",
      operation_status: "ENABLE",
    });
    expect(body("ad/create/")).toEqual({
      advertiser_id: ADV,
      adgroup_id: "1800000000000000002",
      creatives: [
        {
          ad_name: "astra-creative-adc_000001-ad-1",
          ad_format: "SINGLE_VIDEO",
          identity_type: "AUTH_CODE",
          identity_id: "idn_42",
          tiktok_item_id: "7311111111111111111",
          call_to_action: "DOWNLOAD_NOW",
          operation_status: "ENABLE",
        },
      ],
    });
    expect(body("campaign/status/update/")).toEqual({ advertiser_id: ADV, campaign_ids: ["1800000000000000001"], operation_status: "ENABLE" });
  });

  it("boosts owned posts through the linked TT_USER identity", async () => {
    const { tt, fake } = setup(createRoutes().slice(2), { TIKTOK_ADS_TOKEN: "adtok", TIKTOK_ADS_IDENTITY_ID: "tt_user_1", TIKTOK_ADS_APP_ID: "app_env" });
    await tt.createCampaign(campaignRequest({ network: "tiktok", adAccountId: ADV, creatives: [{ kind: "owned_post", contentId: "c3", platform: "tiktok", externalId: "7322222222222222222" }] }));
    expect(fake.calls.some((c) => c.url.includes("app/list"))).toBe(false);
    const ad = fake.calls.find((c) => c.url.includes("ad/create/"))?.json;
    expect(ad.creatives[0]).toMatchObject({ identity_type: "TT_USER", identity_id: "tt_user_1", tiktok_item_id: "7322222222222222222" });
  });

  it("surfaces non-zero codes and refuses unknown geos, expired codes and search", async () => {
    const { tt } = setup([...createRoutes().slice(0, 3), { method: "POST", match: "campaign/create/", json: { code: 40002, message: "budget too low", request_id: "r9" } }]);
    await expect(tt.createCampaign(campaignRequest({ network: "tiktok", adAccountId: ADV, creatives: [spark] }))).rejects.toThrow(/40002 budget too low/);
    expect(() => locationIds(["US", "ZZ"])).toThrow(/ZZ/);
    const { tt: t2, fake } = setup([]);
    await expect(t2.createCampaign(campaignRequest({ network: "tiktok", adAccountId: ADV, creatives: [{ ...spark, expiresAt: "2026-10-01T00:00:00.000Z" }] }))).rejects.toThrow(/expired/);
    await expect(t2.createCampaign(campaignRequest({ network: "tiktok", type: "search" }))).rejects.toThrow(/no search/);
    expect(fake.calls).toHaveLength(0);
  });

  it("dry-run without a token makes no fetch calls", async () => {
    const { config, store, clock } = env0();
    const recorder = new DryRunRecorder(null);
    const tt = new TikTokAdsClient({ config, store, clock, env: {}, dryRun: true, recorder, fetch: forbiddenFetch });
    const { campaignExternalId } = await tt.createCampaign(campaignRequest({ network: "tiktok", adAccountId: ADV, creatives: [spark] }));
    expect(campaignExternalId).toMatch(new RegExp(`^${ADV}:dry_ttcampaign_`));
    expect(recorder.list().map((r) => new URL(r.url).pathname.replace("/open_api/v1.3", ""))).toEqual(["/tt_video/authorize/", "/campaign/create/", "/adgroup/create/", "/ad/create/", "/campaign/status/update/"]);
    await tt.setDailyBudget(campaignExternalId, 4_050);
    await tt.pause(campaignExternalId);
    expect(recorder.list().slice(-2).map((r) => r.json)).toEqual([
      { advertiser_id: ADV, campaign_id: campaignExternalId.split(":")[1], budget: 40.5 },
      { advertiser_id: ADV, campaign_ids: [campaignExternalId.split(":")[1]], operation_status: "DISABLE" },
    ]);
    expect(await tt.stats(campaignExternalId, "2026-10-01", "2026-10-05")).toEqual([]);
  });
});

describe("TikTokAdsClient.stats", () => {
  it("reads the integrated daily report", async () => {
    const { tt, fake } = setup([
      {
        method: "GET",
        match: "report/integrated/get/",
        json: ok({
          list: [
            { dimensions: { campaign_id: "1800000000000000001", stat_time_day: "2026-10-18 00:00:00" }, metrics: { spend: "4.20", impressions: "800", clicks: "12", app_install: "3" } },
            { dimensions: { campaign_id: "1800000000000000001", stat_time_day: "2026-10-15 00:00:00" }, metrics: { spend: "10.00", impressions: "2100", clicks: "40", app_install: "9" } },
          ],
          page_info: { page: 1, total_page: 1 },
        }),
      },
    ]);
    const stats = await tt.stats(`${ADV}:1800000000000000001`, "2026-10-15", "2026-10-18");
    const url = new URL(fake.calls[0]?.url as string);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      advertiser_id: ADV,
      report_type: "BASIC",
      data_level: "AUCTION_CAMPAIGN",
      dimensions: '["campaign_id","stat_time_day"]',
      metrics: '["spend","impressions","clicks","app_install"]',
      start_date: "2026-10-15",
      end_date: "2026-10-18",
      filtering: '[{"field_name":"campaign_ids","filter_type":"IN","filter_value":"[\\"1800000000000000001\\"]"}]',
    });
    expect(stats).toEqual([
      { date: "2026-10-15", spendCents: 1000, impressions: 2100, taps: 40, installs: 9, conversions: null, revenueCents: null, attributionComplete: true },
      { date: "2026-10-18", spendCents: 420, impressions: 800, taps: 12, installs: 3, conversions: null, revenueCents: null, attributionComplete: false },
    ]);
  });

  it("formats schedule times in UTC", () => {
    expect(tiktokTime("2026-10-20T07:30:00.000Z")).toBe("2026-10-20 07:30:00");
  });
});
