import { describe, expect, it } from "vitest";
import { DryRunRecorder } from "../../../src/integrations/http.ts";
import { LiveAdsRead, LiveAdsWrite, createLiveAds } from "../../../src/integrations/ads/index.ts";
import type { NetworkAdapter } from "../../../src/integrations/ads/index.ts";
import { env0, forbiddenFetch } from "../social/helpers.ts";
import { campaignRequest } from "./fixtures.ts";

describe("LiveAdsWrite / LiveAdsRead", () => {
  it("dispatches by network in dry-run without any fetch", async () => {
    const { config, store, clock } = env0();
    const recorder = new DryRunRecorder(null);
    const { read, write } = createLiveAds({ config, store, clock, env: { META_ADS_PAGE_ID: "page_1", META_ADS_INSTAGRAM_USER_ID: "ig" }, dryRun: true, recorder, fetch: forbiddenFetch });
    const meta = await write.createCampaign(campaignRequest());
    const apple = await write.createCampaign(
      campaignRequest({ network: "apple", adAccountId: "42", type: "search", creatives: [], keywords: [{ text: "astra", match: "exact", bidCents: 100 }] }),
    );
    await write.setDailyBudget({ network: "apple", campaignExternalId: apple.campaignExternalId, dailyBudgetCents: 1_000 });
    await write.pause({ network: "meta", campaignExternalId: meta.campaignExternalId });
    expect(new Set(recorder.list().map((r) => r.service))).toEqual(new Set(["meta_ads", "apple_ads"]));
    expect(await read.stats({ network: "meta", campaignExternalId: meta.campaignExternalId, since: "2026-10-01", until: "2026-10-02" })).toEqual([]);
  });

  it("rejects Google Ads", async () => {
    const { config, store, clock } = env0();
    const opts = { config, store, clock, env: {}, dryRun: true, fetch: forbiddenFetch };
    await expect(new LiveAdsWrite(opts).createCampaign(campaignRequest({ network: "google" }))).rejects.toThrow(/google ads are not supported yet/);
    await expect(new LiveAdsRead(opts).stats({ network: "google", campaignExternalId: "x", since: "2026-10-01", until: "2026-10-02" })).rejects.toThrow(/not supported yet/);
  });

  it("routes to injected adapters and skips empty ranges", async () => {
    const { config, store, clock } = env0();
    const seen: string[] = [];
    const fake: NetworkAdapter = {
      createCampaign: async () => ({ campaignExternalId: "x" }),
      setDailyBudget: async (id, cents) => void seen.push(`budget ${id} ${cents}`),
      pause: async (id) => void seen.push(`pause ${id}`),
      stats: async (id, since, until) => (seen.push(`stats ${id} ${since} ${until}`), []),
    };
    const opts = { config, store, clock, env: {}, dryRun: false, fetch: forbiddenFetch, adapters: { tiktok: fake } };
    const { read, write } = createLiveAds(opts);
    await write.setDailyBudget({ network: "tiktok", campaignExternalId: "a:1", dailyBudgetCents: 700 });
    await write.pause({ network: "tiktok", campaignExternalId: "a:1" });
    await read.stats({ network: "tiktok", campaignExternalId: "a:1", since: "2026-10-03", until: "2026-10-02" });
    await read.stats({ network: "tiktok", campaignExternalId: "a:1", since: "2026-10-01", until: "2026-10-02" });
    expect(seen).toEqual(["budget a:1 700", "pause a:1", "stats a:1 2026-10-01 2026-10-02"]);
  });
});
