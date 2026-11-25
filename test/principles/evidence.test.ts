import { describe, expect, it } from "vitest";
import type { Signal } from "../../src/core/types.ts";
import { evidenceFor, gateEvidence, isMeasured } from "../../src/principles/evidence.ts";
import { screenIdea } from "../../src/principles/gates.ts";
import { astra, screenInput } from "./fixtures.ts";

const NOW = "2026-10-17T12:00:00.000Z";
function sig(source: Signal["source"], metrics: Record<string, number>, extra: Partial<Signal> = {}): Signal {
  return { id: `sig_${source}`, source, title: "t", detail: "d", metrics, tags: [], observedAt: NOW, ...extra };
}

describe("evidence", () => {
  it("does not count LLM pattern summaries as measurements", () => {
    const e = evidenceFor([sig("search_trend", { ratings: 1e6 })]);
    expect(isMeasured(sig("search_trend", {}))).toBe(false);
    expect(e.measured).toBe(0);
    expect(e.score).toBe(0);
    expect(gateEvidence(e).verdict).toBe("fail");
  });

  it("scores store demand, attention and money, and rewards breadth", () => {
    const store = sig("app_store_search", { ratings: 100_000, ratingsPerDay: 200 });
    const views = sig("social_trend", { viewsPerDay: 200_000 }, { trend: "youtube" });
    const ads = sig("social_trend", { longRunningAdvertisers: 5, longRunningAds: 15, longRunningAppAds: 5 }, { trend: "meta_ads" });
    const one = evidenceFor([store]);
    const all = evidenceFor([store, views, ads]);
    expect(one.storeDemand).toBeGreaterThan(0.9);
    expect(all.money).toBe(1);
    expect(all.kinds).toEqual(["store", "attention", "money"]);
    expect(all.score).toBeGreaterThan(one.score);
    expect(gateEvidence(all).verdict).toBe("pass");
  });

  it("caps attention without money or store demand as possible hype", () => {
    const e = evidenceFor([sig("social_trend", { viewsPerDay: 3_000_000 }, { trend: "youtube" }), sig("social_trend", { recentMedianEngagement: 30_000 }, { trend: "instagram" })]);
    expect(e.attention).toBeGreaterThan(0.6);
    expect(e.score).toBeLessThanOrEqual(0.45);
    expect(e.notes.join(" ")).toMatch(/fad/);
  });

  it("fails below the configured minimum and warns when thin", () => {
    const thin = evidenceFor([sig("app_store_chart", { rank: 150 })]);
    expect(gateEvidence(thin).verdict).toBe("warn");
    expect(gateEvidence(thin, 0.5).verdict).toBe("fail");
  });

  it("enters the screening score and can reject an idea", () => {
    const strong = evidenceFor([sig("app_store_search", { ratings: 100_000 }), sig("social_trend", { longRunningAdvertisers: 5, longRunningAds: 15 }, { trend: "meta_ads" })]);
    const none = evidenceFor([]);
    const a = screenIdea(screenInput(astra(), { evidence: strong }));
    const b = screenIdea(screenInput(astra(), { evidence: none }));
    expect(a.gates.find((g) => g.gate === "evidence.demand")?.verdict).toBe("pass");
    expect(b.verdict).toBe("reject");
    expect(screenIdea(screenInput(astra())).gates.some((g) => g.gate === "evidence.demand")).toBe(false);
  });
});
