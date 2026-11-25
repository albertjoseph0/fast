import { describe, expect, it } from "vitest";
import type { Signal } from "../../src/core/types.ts";
import { selectSignals } from "../../src/agents/ideator.ts";
import { addMomentum } from "../../src/agents/scout.ts";

const at = (d: string) => `2026-11-${d}T00:00:00.000Z`;
function sig(source: Signal["source"], i: number, extra: Partial<Signal> = {}): Signal {
  return { id: `${source}_${i}`, source, title: `${source} ${i}`, detail: "", metrics: {}, tags: [], observedAt: at("20"), ...extra };
}

describe("signal selection", () => {
  it("shares the prompt across sources so summaries cannot crowd out measurements", () => {
    const many = [...Array.from({ length: 80 }, (_, i) => sig("search_trend", i)), ...Array.from({ length: 10 }, (_, i) => sig("app_store_search", i)), sig("app_store_chart", 0)];
    const out = selectSignals(many, 25);
    expect(out).toHaveLength(25);
    expect(out.filter((s) => s.source === "app_store_search")).toHaveLength(10);
    expect(out.filter((s) => s.source === "app_store_chart")).toHaveLength(1);
    expect(out[0]?.source).toBe("search_trend");
  });
});

describe("momentum", () => {
  const { id: _id, observedAt: _o, ...base } = sig("app_store_search", 1, { title: "Co-Star", metrics: { ratings: 1000 } });
  it("adds daily change against the last scan at least a day old", () => {
    const prior = [sig("app_store_search", 1, { title: "Co-Star", metrics: { ratings: 800 }, observedAt: at("21") }), sig("app_store_search", 1, { title: "Co-Star", metrics: { ratings: 990 }, observedAt: "2026-11-24T20:00:00.000Z" })];
    const [d] = addMomentum([{ ...base, metrics: { ratings: 1000 } }], prior, new Date(at("25")));
    expect(d?.metrics.ratingsPerDay).toBe(50);
  });

  it("marks rank movement and new chart entries", () => {
    const chart = (title: string, rank: number, observedAt = at("20")) => sig("app_store_chart", rank, { title, metrics: { rank }, tags: ["Lifestyle", "top-free", "US"], observedAt });
    const { id: _i, observedAt: _t, ...climber } = chart("Climber", 10);
    const { id: _j, observedAt: _u, ...newbie } = chart("Newbie", 50);
    const out = addMomentum([climber, newbie], [chart("Climber", 30)], new Date(at("25")));
    expect(out[0]?.metrics.rankDelta).toBe(20);
    expect(out[1]?.metrics.newEntry).toBe(1);
  });
});
