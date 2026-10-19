import { describe, expect, it } from "vitest";
import { DryRunRecorder } from "../../../src/integrations/http.ts";
import { META_API, MetaAdsClient, metaDailyStats } from "../../../src/integrations/ads/meta.ts";
import { account, env0, fakeFetch, forbiddenFetch, image, piece } from "../social/helpers.ts";
import type { FakeRoute } from "../social/helpers.ts";
import { campaignRequest } from "./fixtures.ts";

const ENV = { META_ADS_TOKEN: "metatok", META_ADS_PAGE_ID: "page_1", META_ADS_INSTAGRAM_USER_ID: "ig_brand" };

function setup(routes: FakeRoute[], opts: { dryRun?: boolean; env?: Record<string, string> } = {}) {
  const { config, store, clock } = env0();
  const fake = fakeFetch(routes);
  const meta = new MetaAdsClient({ config, store, clock, env: opts.env ?? ENV, dryRun: opts.dryRun ?? false, fetch: fake.fetch });
  return { meta, fake, store };
}

const createRoutes = (): FakeRoute[] => [
  { method: "GET", match: "act_111?fields=currency", json: { currency: "USD", id: "act_111" } },
  { method: "POST", match: "act_111/campaigns", json: { id: "c100" } },
  { method: "POST", match: "act_111/adsets", json: { id: "s200" } },
  { method: "POST", match: "act_111/adcreatives", json: { id: "cr300" } },
  { method: "POST", match: "act_111/ads", json: { id: "ad400" } },
  { method: "POST", match: `${META_API}/c100`, json: { success: true } },
];

describe("MetaAdsClient.createCampaign", () => {
  it("builds an Advantage+ app campaign that starts paused and is enabled last", async () => {
    const { meta, fake, store } = setup(createRoutes());
    const ig = account("instagram", { externalId: "ig_owned" });
    store.accounts.put(ig);
    store.content.put({ ...piece("instagram", [image(1)]), accountId: ig.id });
    const { campaignExternalId } = await meta.createCampaign(campaignRequest());
    expect(campaignExternalId).toBe("c100");
    const writes = fake.calls.filter((c) => c.method === "POST");
    expect(writes.map((c) => c.url.replace(META_API, ""))).toEqual(["/act_111/campaigns", "/act_111/adsets", "/act_111/adcreatives", "/act_111/ads", "/c100"]);
    for (const w of writes) expect(w.headers.authorization).toBe("Bearer metatok");
    expect(writes[0]?.json).toEqual({
      name: "astra-creative-adc_000001",
      objective: "OUTCOME_APP_PROMOTION",
      status: "PAUSED",
      special_ad_categories: [],
      buying_type: "AUCTION",
      daily_budget: 2500,
      bid_strategy: "LOWEST_COST_WITHOUT_CAP",
    });
    expect(writes[0]?.json).not.toHaveProperty("smart_promotion_type");
    expect(writes[1]?.json).toEqual({
      name: "astra-creative-adc_000001-adset",
      campaign_id: "c100",
      status: "ACTIVE",
      optimization_goal: "APP_INSTALLS",
      billing_event: "IMPRESSIONS",
      promoted_object: { application_id: "998877", object_store_url: "https://apps.apple.com/app/id6700000001" },
      targeting: { geo_locations: { countries: ["US", "CA"] }, targeting_automation: { advantage_audience: 1 } },
      start_time: "2026-10-20T00:00:00.000Z",
      end_time: "2026-10-23T00:00:00.000Z",
    });
    expect(writes[2]?.json).toEqual({
      name: "astra-creative-adc_000001-content_000001",
      object_id: "page_1",
      instagram_user_id: "ig_owned",
      source_instagram_media_id: "17900000000000001",
      call_to_action: { type: "INSTALL_MOBILE_APP", value: { link: "https://apps.apple.com/app/id6700000001" } },
    });
    expect(writes[3]?.json).toEqual({ name: "astra-creative-adc_000001-ad-1", adset_id: "s200", creative: { creative_id: "cr300" }, status: "ACTIVE" });
    expect(writes[4]?.json).toEqual({ status: "ACTIVE" });
  });

  it("creates partnership ads from a creator's Instagram media", async () => {
    const { meta, fake } = setup(createRoutes());
    await meta.createCampaign(campaignRequest({ creatives: [{ kind: "ig_partnership", contentId: "content_000009", mediaId: "18000000000000009", creatorIgUserId: "ig_creator" }] }));
    expect(fake.calls.find((c) => c.url.endsWith("/adcreatives"))?.json).toEqual({
      name: "astra-creative-adc_000001-content_000009",
      object_id: "page_1",
      source_instagram_media_id: "18000000000000009",
      instagram_branded_content: { sponsor_id: "ig_brand" },
      facebook_branded_content: { sponsor_page_id: "page_1" },
      call_to_action: { type: "INSTALL_MOBILE_APP", value: { link: "https://apps.apple.com/app/id6700000001" } },
    });
  });

  it("rejects open-ended, search, non-USD and unsupported-creative campaigns before writing", async () => {
    const { meta, fake } = setup([{ method: "GET", match: "fields=currency", json: { currency: "EUR" } }]);
    await expect(meta.createCampaign(campaignRequest({ endAt: "" }))).rejects.toThrow(/endAt/);
    await expect(meta.createCampaign(campaignRequest({ type: "search" }))).rejects.toThrow(/no search campaigns/);
    await expect(meta.createCampaign(campaignRequest({ creatives: [{ kind: "spark_code", contentId: "c", code: "x", expiresAt: "2026-11-01T00:00:00.000Z" }] }))).rejects.toThrow(/TikTok-only/);
    await expect(meta.createCampaign(campaignRequest())).rejects.toThrow(/bills in EUR/);
    expect(fake.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  });

  it("dry-run without a token makes no fetch calls and returns a dry id", async () => {
    const { config, store, clock } = env0();
    const recorder = new DryRunRecorder(null);
    const meta = new MetaAdsClient({ config, store, clock, env: { META_ADS_PAGE_ID: "page_1", META_ADS_INSTAGRAM_USER_ID: "ig_brand" }, dryRun: true, recorder, fetch: forbiddenFetch });
    const { campaignExternalId } = await meta.createCampaign(campaignRequest());
    expect(campaignExternalId).toMatch(/^dry_metacampaign_/);
    expect(recorder.list()).toHaveLength(5);
    expect(recorder.list()[4]?.url).toBe(`${META_API}/${campaignExternalId}`);
    await meta.setDailyBudget(campaignExternalId, 5_000);
    await meta.pause(campaignExternalId);
    expect(recorder.list().slice(5).map((r) => r.json)).toEqual([{ daily_budget: 5000 }, { status: "PAUSED" }]);
    expect(await meta.stats(campaignExternalId, "2026-10-01", "2026-10-02")).toEqual([]);
  });
});

describe("MetaAdsClient budget, pause and stats", () => {
  it("updates budget and pauses on the campaign node", async () => {
    const { meta, fake } = setup([{ method: "POST", match: "c100", json: { success: true } }]);
    await meta.setDailyBudget("c100", 4_000);
    await meta.pause("c100");
    expect(fake.calls.map((c) => [c.url, c.json])).toEqual([
      [`${META_API}/c100`, { daily_budget: 4000 }],
      [`${META_API}/c100`, { status: "PAUSED" }],
    ]);
    await expect(meta.setDailyBudget("c100", 12.5)).rejects.toThrow(/integer cents/);
  });

  it("maps daily insights and follows paging", async () => {
    const { meta, fake } = setup([
      {
        method: "GET",
        match: "after=p2",
        json: { data: [{ date_start: "2026-10-18", spend: "3.10", impressions: "900", clicks: "20" }] },
      },
      {
        method: "GET",
        match: "c100/insights",
        json: {
          data: [
            {
              date_start: "2026-10-16",
              spend: "25.43",
              impressions: "12000",
              clicks: "310",
              actions: [
                { action_type: "mobile_app_install", value: "41" },
                { action_type: "app_custom_event.fb_mobile_purchase", value: "3" },
              ],
              action_values: [{ action_type: "app_custom_event.fb_mobile_purchase", value: "29.97" }],
            },
          ],
          paging: { next: `${META_API}/c100/insights?after=p2` },
        },
      },
    ]);
    const stats = await meta.stats("c100", "2026-10-16", "2026-10-18");
    expect(fake.calls[0]?.url).toContain('time_increment=1&time_range={"since":"2026-10-16","until":"2026-10-18"}');
    expect(stats).toEqual([
      { date: "2026-10-16", spendCents: 2543, impressions: 12000, taps: 310, installs: 41, conversions: 3, revenueCents: 2997, attributionComplete: true },
      { date: "2026-10-18", spendCents: 310, impressions: 900, taps: 20, installs: 0, conversions: null, revenueCents: null, attributionComplete: false },
    ]);
  });

  it("marks the last two days as attribution-incomplete", () => {
    const row = { date_start: "2026-10-17", spend: "1", impressions: "1", clicks: "0", actions: [] };
    expect(metaDailyStats(row, "2026-10-19").attributionComplete).toBe(true);
    expect(metaDailyStats({ ...row, date_start: "2026-10-18" }, "2026-10-19").attributionComplete).toBe(false);
    expect(metaDailyStats({ ...row, date_start: "2026-10-19" }, "2026-10-19")).toMatchObject({ attributionComplete: false, conversions: 0, installs: 0 });
  });
});
