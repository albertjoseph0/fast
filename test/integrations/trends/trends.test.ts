import { describe, expect, it } from "vitest";
import type { TrendObservation } from "../../../src/core/ports.ts";
import { LiveSocialTrendPort, liveTrendSources } from "../../../src/integrations/trends/index.ts";
import { instagramObservation } from "../../../src/integrations/trends/instagram.ts";
import { adCountries, metaAdsObservation } from "../../../src/integrations/trends/metaAdLibrary.ts";
import { youtubeObservation } from "../../../src/integrations/trends/youtube.ts";
import type { TrendSourceClient } from "../../../src/integrations/trends/common.ts";

const NOW = new Date("2026-11-25T00:00:00Z");
const ago = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const clock = { now: () => NOW, iso: () => NOW.toISOString() } as never;

describe("trend observations", () => {
  it("summarises YouTube videos as views per day and engagement", () => {
    const obs = youtubeObservation(
      "tarot",
      [
        { statistics: { viewCount: "100000", likeCount: "5000", commentCount: "100" }, snippet: { publishedAt: ago(10), channelId: "c1", title: "A" } },
        { statistics: { viewCount: "20000", likeCount: "100" }, snippet: { publishedAt: ago(2), channelId: "c2", title: "B" } },
        { statistics: { viewCount: "5" }, snippet: { publishedAt: "not a date", channelId: "c3" } },
      ],
      NOW,
    );
    expect(obs?.metrics).toMatchObject({ videos: 2, channels: 2, views: 120_000, viewsPerDay: 20_000 });
    expect(obs?.samples[0]).toBe("A");
    expect(youtubeObservation("x", [], NOW)).toBeNull();
  });

  it("summarises an Instagram hashtag's top posts, recent ones apart", () => {
    const obs = instagramObservation(
      "tarot",
      "tarot",
      [
        { like_count: 900, comments_count: 100, timestamp: ago(3), caption: "new" },
        { like_count: 50, comments_count: 0, timestamp: ago(40), caption: "old" },
      ],
      NOW,
      14,
    );
    expect(obs?.metrics).toMatchObject({ posts: 2, recentPosts: 1, engagement: 1050, recentMedianEngagement: 1000 });
  });

  it("counts long-running advertisers and app ads in the Meta Ad Library", () => {
    const ad = (page: string, days: number, caption = "example.com") => ({ page_id: page, ad_delivery_start_time: ago(days), eu_total_reach: 1000, ad_creative_link_captions: [caption], ad_creative_bodies: [`ad ${page}`] });
    const obs = metaAdsObservation("tarot", [ad("p1", 60, "apps.apple.com"), ad("p1", 45), ad("p2", 5), ad("p3", 31, "play.google.com")], NOW, ["DE"]);
    expect(obs?.metrics).toMatchObject({ activeAds: 4, advertisers: 3, longRunningAds: 3, longRunningAdvertisers: 2, appAds: 2, longRunningAppAds: 2, euReach: 4000 });
    expect(obs?.url).toContain("country=DE");
  });

  it("searches EU storefronts only and accepts an override", () => {
    expect(adCountries({})).toEqual(["DE", "FR", "NL", "SE", "IE"]);
    expect(adCountries({ META_AD_LIBRARY_COUNTRIES: "fr, nl,usa" })).toEqual(["FR", "NL"]);
  });
});

describe("live social trend port", () => {
  it("uses only configured sources", () => {
    expect(liveTrendSources({ env: {}, clock })).toHaveLength(0);
    expect(liveTrendSources({ env: { YOUTUBE_API_KEY: "k", META_AD_LIBRARY_TOKEN: "t" }, clock }).map((c) => c.source)).toEqual(["youtube", "meta_ads"]);
  });

  it("dedupes and caps terms per source and skips a failing term", async () => {
    const seen: string[] = [];
    const client: TrendSourceClient = {
      source: "youtube",
      maxTermsPerScan: 2,
      async scanTerm({ term }) {
        seen.push(term);
        if (term === "a") throw new Error("quota");
        return { source: "youtube", term, metrics: {}, samples: [] } satisfies TrendObservation;
      },
    };
    const port = new LiveSocialTrendPort([client]);
    const out = await port.scan({ terms: ["C", "b", "a", "b "], country: "US", sinceDays: 14 });
    expect(seen).toEqual(["a", "b"]);
    expect(out.map((o) => o.term)).toEqual(["b"]);
  });
});
