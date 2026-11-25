import { describe, expect, it } from "vitest";
import { cleanTerms } from "../../src/agents/ideator.ts";
import { MAX_VERIFY_TERMS, verifyDemand } from "../../src/agents/scout.ts";
import type { AppLookup, SocialTrendPort, TrendObservation, TrendPort } from "../../src/core/ports.ts";
import type { IdeaRecord } from "../../src/core/types.ts";
import { evidenceFor } from "../../src/principles/evidence.ts";
import { textDemand, topicTruth } from "../../src/sim/trends.ts";
import { agentContext, astra } from "./fixtures.ts";

function lookup(name: string, ratingCount: number): AppLookup {
  return { id: name, name, seller: "S", genre: "Lifestyle", ratingCount, rating: 4.5, priceCents: 0, releaseDate: "2024-01-01T00:00:00Z", description: "", url: `https://apps.apple.com/${name}` };
}

function record(id: string, terms: string[]): IdeaRecord {
  return { id, idea: astra(), sourceSignalIds: [], demandTerms: terms, createdAt: "2026-10-17T12:00:00.000Z" };
}

function ports(searched: string[], scanned: string[][]) {
  const trends: TrendPort = {
    kind: "sim",
    topApps: async () => [],
    searchApps: async (req) => {
      searched.push(req.term);
      if (req.term === "broken") throw new Error("search down");
      return req.term === "golf swing" ? [lookup("Swingpro", 120_000)] : [];
    },
  };
  const socialTrends: SocialTrendPort = {
    kind: "sim",
    sources: () => ["youtube"],
    scan: async (req) => {
      scanned.push(req.terms);
      return req.terms.map((term): TrendObservation => ({ source: "youtube", term, metrics: { viewsPerDay: term === "golf swing" ? 50_000 : 10 }, samples: [] }));
    },
  };
  return { trends, socialTrends };
}

describe("verifyDemand", () => {
  it("measures each idea's own terms once, and maps the signals back to every idea that named them", async () => {
    const searched: string[] = [];
    const scanned: string[][] = [];
    const ctx = agentContext(ports(searched, scanned));
    const a = record("idea_1", ["golf swing", "broken"]);
    const b = record("idea_2", ["golf swing"]);
    const c = record("idea_3", []);
    const { signals, byIdea } = await verifyDemand(ctx, [a, b, c]);

    expect(searched.sort()).toEqual(["broken", "golf swing"]);
    expect(scanned).toEqual([["golf swing", "broken"]]);
    expect(signals.map((s) => s.title).sort()).toEqual(["Swingpro", "broken on YouTube", "golf swing on YouTube"]);
    expect(byIdea.get("idea_1")).toHaveLength(3);
    expect(byIdea.get("idea_2")).toHaveLength(2);
    expect(byIdea.has("idea_3")).toBe(false);
    const golf = (byIdea.get("idea_2") ?? []).map((id) => signals.find((s) => s.id === id)!);
    expect(evidenceFor(golf).score).toBeGreaterThan(evidenceFor(signals.filter((s) => s.title === "broken on YouTube")).score);
  });

  it("caps the terms measured in one cycle", async () => {
    const searched: string[] = [];
    const ctx = agentContext(ports(searched, []));
    const many = Array.from({ length: 30 }, (_, i) => record(`idea_${i}`, [`term ${i}`]));
    await verifyDemand(ctx, many);
    expect(searched).toHaveLength(MAX_VERIFY_TERMS);
  });

  it("does nothing without terms", async () => {
    const ctx = agentContext();
    expect((await verifyDemand(ctx, [record("idea_1", [])])).signals).toEqual([]);
  });
});

describe("cleanTerms", () => {
  it("keeps up to three short lowercase phrases", () => {
    expect(cleanTerms(["Golf Swing!", "golf swing", "x", "a very long phrase that is far too many words", "Dream  meaning", "tarot", "extra"])).toEqual([
      "golf swing",
      "dream meaning",
      "tarot",
    ]);
  });
});

describe("simulated store demand", () => {
  it("follows the hidden topic demand", () => {
    expect(textDemand("Swingpro: golf swing analysis", 7)).toBeCloseTo(topicTruth("golf", 7).demand);
    expect(textDemand("nothing here", 7)).toBe(1);
  });
});
