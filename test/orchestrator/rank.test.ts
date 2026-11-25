import { describe, expect, it } from "vitest";
import type { IdeaRecord, Screening } from "../../src/core/types.ts";
import { rankScreened } from "../../src/orchestrator/discovery.ts";
import { astra } from "../principles/fixtures.ts";
import { makeWorld, tickContext } from "./fixtures.ts";

function item(id: string, score: number, evidence: number): { record: IdeaRecord; screening: Screening } {
  return {
    record: { id, idea: astra({ title: id }), sourceSignalIds: [], createdAt: "2026-11-25T00:00:00.000Z" } as unknown as IdeaRecord,
    screening: {
      id: `scr_${id}`,
      ideaId: id,
      gates: [{ gate: "evidence.demand", verdict: "pass", score: evidence, reason: "" }],
      critiques: [],
      sensitiveDomains: [],
      score,
      verdict: "advance",
      reasons: [],
      screenedAt: "2026-11-25T00:00:00.000Z",
    },
  };
}

describe("ranking screened ideas", () => {
  it("puts measured demand ahead of a slightly higher screening score", () => {
    const w = makeWorld();
    const ctx = tickContext(w);
    const ranked = rankScreened(ctx, [item("hype", 90, 0.2), item("proven", 86, 0.8)]);
    expect(ranked.map((x) => x.record.id)).toEqual(["proven", "hype"]);
  });

  it("falls back to screening score when evidence is off", () => {
    const w = makeWorld();
    const ctx = tickContext(w);
    const off = { ...ctx, config: { ...ctx.config, portfolio: { ...ctx.config.portfolio, requireEvidence: false } } };
    expect(rankScreened(off, [item("hype", 90, 0.2), item("proven", 86, 0.8)]).map((x) => x.record.id)).toEqual(["hype", "proven"]);
  });
});
