import { describe, expect, it } from "vitest";
import { ideaDemand, simTrendObservations, SIM_TOPICS, topicsIn, topicTruth } from "../../src/sim/trends.ts";
import { BASE_IDEA } from "./fixtures.ts";

describe("simulated topic demand", () => {
  it("matches topics by word or stem", () => {
    expect(topicsIn("Dreams and dogs, a tarot reading")).toEqual(["tarot", "dream", "dog"]);
    expect(topicsIn("nothing here")).toEqual([]);
  });

  it("averages about 1 across topics and marks a minority as hype", () => {
    const truths = SIM_TOPICS.flatMap((t) => [1, 2, 3, 4, 5].map((seed) => topicTruth(t, seed)));
    const mean = truths.reduce((s, t) => s + t.demand, 0) / truths.length;
    const hyped = truths.filter((t) => t.hype > 1).length / truths.length;
    expect(mean).toBeGreaterThan(0.75);
    expect(mean).toBeLessThan(1.3);
    expect(hyped).toBeGreaterThan(0.05);
    expect(hyped).toBeLessThan(0.3);
  });

  it("is deterministic per seed and neutral for ideas on no topic", () => {
    expect(ideaDemand(BASE_IDEA, 3)).toBe(ideaDemand(BASE_IDEA, 3));
    const plain = { ...BASE_IDEA, title: "Qwz", oneLiner: "qqq", aiCapability: "zzz", verdictMoment: "xxx", wedge: { ...BASE_IDEA.wedge, name: "yyy", description: "www" } };
    expect(ideaDemand(plain, 3)).toBe(1);
  });

  it("lets ad-library money track demand while hype inflates only views", () => {
    const seed = 11;
    const hyped = SIM_TOPICS.find((t) => topicTruth(t, seed).hype > 2);
    expect(hyped).toBeDefined();
    const obs = simTrendObservations(hyped as string, ["youtube", "meta_ads"], seed, "2026-W10", 14);
    expect(obs.map((o) => o.source)).toEqual(["youtube", "meta_ads"]);
    expect(simTrendObservations("nothing", ["youtube"], seed, "2026-W10", 14)).toEqual([]);
  });
});
