import { describe, expect, it } from "vitest";
import { Rng } from "../../src/core/rng.ts";
import type { Venture } from "../../src/core/types.ts";
import { baseRate, familyPosterior, ideaFamily, MONTHLY_DISCOUNT, sampleFamilyLift, ventureOutcomes, type FamilyOutcome } from "../../src/orchestrator/ideaPrior.ts";

const NOW = new Date("2026-11-25T00:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

function venture(stage: Venture["stage"], extra: Partial<Venture> = {}): Venture {
  return { id: `v_${stage}`, stage, ladder: { steps: ["S1"], stepIndex: 0 }, history: [], updatedAt: daysAgo(1), ...extra } as unknown as Venture;
}

describe("family prior", () => {
  it("names a family by core need and wedge kind", () => {
    expect(ideaFamily({ coreNeed: "love", wedge: { kind: "interest_community" } as never })).toBe("love:interest_community");
  });

  it("reads validated ventures as successes and killed ones as failures, ignoring those still testing", () => {
    const out = ventureOutcomes(
      [venture("killed"), venture("scaling", { history: [{ from: "live_test", to: "scaling", at: daysAgo(3), reason: "" }] } as never), venture("live_test")],
      () => "f",
    );
    expect(out.map((o) => o.success)).toEqual([false, true]);
  });

  it("shrinks a small record toward the studio rate and discounts old outcomes", () => {
    const outcomes: FamilyOutcome[] = [
      { family: "a", success: true, at: daysAgo(1) },
      { family: "a", success: true, at: daysAgo(1) },
      { family: "b", success: false, at: daysAgo(1) },
      { family: "b", success: false, at: daysAgo(1) },
      { family: "b", success: false, at: daysAgo(1) },
    ];
    const rate = baseRate(outcomes, NOW);
    const a = familyPosterior("a", outcomes, NOW, rate);
    const b = familyPosterior("b", outcomes, NOW, rate);
    const mean = (p: { alpha: number; beta: number }) => p.alpha / (p.alpha + p.beta);
    expect(mean(a)).toBeGreaterThan(rate);
    expect(mean(a)).toBeLessThan(0.8); // two wins do not make a sure thing
    expect(mean(b)).toBeLessThan(rate);
    const old = familyPosterior("a", [{ family: "a", success: true, at: daysAgo(300) }], NOW, rate);
    expect(old.successes).toBeCloseTo(MONTHLY_DISCOUNT ** 10, 2);
  });

  it("samples lifts around 1 for an unseen family and higher for a proven one", () => {
    const rng = new Rng(9);
    const outcomes: FamilyOutcome[] = Array.from({ length: 6 }, () => ({ family: "good", success: true, at: daysAgo(5) }));
    const rate = baseRate(outcomes, NOW);
    const draws = (f: string) => Array.from({ length: 400 }, () => sampleFamilyLift(familyPosterior(f, outcomes, NOW, rate), rate, rng));
    const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
    expect(avg(draws("unseen"))).toBeGreaterThan(0.8);
    expect(avg(draws("unseen"))).toBeLessThan(1.2);
    expect(avg(draws("good"))).toBeGreaterThan(avg(draws("unseen")));
  });
});
