import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SimClock } from "../../../src/core/clock.ts";
import { AppleTrendPort, RateLimiter, parseChart, parseLookup } from "../../../src/integrations/apple/charts.ts";
import { fakeFetch } from "./fakeFetch.ts";

const FIXTURES = join(import.meta.dirname, "fixtures");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

describe("Apple chart parsing (real fixtures)", () => {
  it("parses an RSS v2 top-free feed in rank order", () => {
    const apps = parseChart(JSON.parse(fixture("rss-top-free-us-10.json")));
    expect(apps).toHaveLength(10);
    expect(apps[0]).toMatchObject({ rank: 1, id: expect.stringMatching(/^\d+$/), name: expect.any(String), artist: expect.any(String) });
    expect(apps.map((a) => a.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(apps.every((a) => a.url.startsWith("https://apps.apple.com/us/app/"))).toBe(true);
    // The live feed currently ships empty genre arrays.
    expect(apps.every((a) => typeof a.genre === "string")).toBe(true);
  });

  it("parses a top-paid feed for another storefront", () => {
    const apps = parseChart(JSON.parse(fixture("rss-top-paid-ca-5.json")));
    expect(apps).toHaveLength(5);
    expect(apps[0]?.url).toContain("apps.apple.com/ca/");
  });

  it("parses iTunes search results into AppLookup", () => {
    const apps = parseLookup(fixture("itunes-search-astrology-us-3.json"));
    expect(apps).toHaveLength(3);
    const first = apps[0];
    expect(first).toBeDefined();
    expect(first!.id).toMatch(/^\d+$/);
    expect(first!.ratingCount).toBeGreaterThan(0);
    expect(first!.rating).toBeGreaterThan(0);
    expect(first!.rating).toBeLessThanOrEqual(5);
    expect(Number.isInteger(first!.priceCents)).toBe(true);
    expect(first!.genre).not.toBe("");
    expect(first!.url).toContain("apps.apple.com");
  });

  it("parses lookup results", () => {
    const apps = parseLookup(fixture("itunes-lookup-us.json"));
    expect(apps.map((a) => a.name)).toEqual(expect.arrayContaining(["ChatGPT"]));
  });

  it("tolerates malformed bodies and entries", () => {
    expect(parseChart(null)).toEqual([]);
    expect(parseChart({ feed: { results: "nope" } })).toEqual([]);
    expect(parseChart({ feed: { results: [{ id: "1" }, { id: "2", name: "Two", genres: [{ name: "Lifestyle" }] }] } })).toEqual([
      { id: "2", name: "Two", artist: "", genre: "Lifestyle", rank: 2, url: "" },
    ]);
    expect(parseLookup("not json")).toEqual([]);
    expect(parseLookup({ results: [{ trackId: 5, trackName: "Song", kind: "song" }, { trackId: 6, trackName: "App", price: 2.99 }] })).toMatchObject([{ id: "6", priceCents: 299, rating: 0 }]);
  });
});

describe("AppleTrendPort", () => {
  it("builds chart, search and lookup URLs and parses text/javascript bodies", async () => {
    const f = fakeFetch([
      { match: "rss.marketingtools.apple.com", text: fixture("rss-top-free-us-10.json") },
      { match: "itunes.apple.com/search", text: fixture("itunes-search-astrology-us-3.json"), contentType: "text/javascript; charset=utf-8" },
      { match: "itunes.apple.com/lookup", text: fixture("itunes-lookup-us.json"), contentType: "text/javascript; charset=utf-8" },
    ]);
    const port = new AppleTrendPort({ fetch: f.fetch });
    expect(port.kind).toBe("apple_public");
    expect(await port.topApps({ country: "US", chart: "top-free", limit: 500 })).toHaveLength(10);
    expect(await port.searchApps({ term: "astrology app", country: "US", limit: 3 })).toHaveLength(3);
    expect(await port.lookupApps({ ids: ["6448311069", "632064380"], country: "us" })).toHaveLength(2);
    expect(f.calls.map((c) => c.url)).toEqual([
      "https://rss.marketingtools.apple.com/api/v2/us/apps/top-free/200/apps.json",
      "https://itunes.apple.com/search?term=astrology+app&entity=software&country=us&limit=3",
      "https://itunes.apple.com/lookup?id=6448311069,632064380&entity=software&country=us",
    ]);
  });

  it("waits once 20 requests ran within a minute", async () => {
    const clock = new SimClock("2026-10-18T00:00:00Z");
    const waits: number[] = [];
    const sleep = async (ms: number) => {
      waits.push(ms);
      clock.advanceHours(ms / 3_600_000);
    };
    const f = fakeFetch([{ match: "itunes.apple.com", json: { resultCount: 0, results: [] } }]);
    const port = new AppleTrendPort({ fetch: f.fetch, clock, sleep });
    for (let i = 0; i < 21; i++) await port.searchApps({ term: `t${i}`, country: "us", limit: 1 });
    expect(f.calls).toHaveLength(21);
    expect(waits).toEqual([60_000]);
  });
});

describe("RateLimiter", () => {
  it("frees slots as the window slides", async () => {
    const clock = new SimClock("2026-10-18T00:00:00Z");
    const waits: number[] = [];
    const limiter = new RateLimiter(2, 1_000, clock, async (ms) => {
      waits.push(ms);
      clock.advanceHours(ms / 3_600_000);
    });
    await limiter.acquire();
    clock.advanceHours(0.4 / 3_600);
    await limiter.acquire();
    await limiter.acquire();
    expect(waits).toEqual([600]);
  });
});

describe.skipIf(process.env.LIVE_APPLE !== "1")("AppleTrendPort live (LIVE_APPLE=1, NODE_USE_ENV_PROXY=1)", () => {
  it("reads a real chart and search", async () => {
    const port = new AppleTrendPort();
    const chart = await port.topApps({ country: "us", chart: "top-free", limit: 5 });
    expect(chart).toHaveLength(5);
    expect(chart[0]!.rank).toBe(1);
    const found = await port.searchApps({ term: "astrology", country: "us", limit: 2 });
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]!.url).toMatch(/^https:\/\/apps\.apple\.com\//);
  }, 30_000);
});
