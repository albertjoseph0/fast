import { describe, expect, it } from "vitest";
import { EXTRA_THREAD_RULES, principle, PRINCIPLES } from "../../src/principles/bier.ts";
import { ladderFor, ladderSteps } from "../../src/principles/ladder.ts";
import { effectiveDomains, keywordDomains, minimumAgeFor } from "../../src/principles/sensitivity.ts";
import { astra, config } from "./fixtures.ts";

describe("PRINCIPLES", () => {
  it("lists the 11 quoted principles in order with unique ids", () => {
    expect(PRINCIPLES.map((p) => p.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(new Set(PRINCIPLES.map((p) => p.id)).size).toBe(11);
    for (const p of PRINCIPLES) {
      expect(p.appliesAt.length).toBeGreaterThan(0);
      expect(p.quote.length).toBeGreaterThan(20);
    }
  });

  it("quotes the thread verbatim", () => {
    expect(principle("P2_orchestrable_value").quote).toBe(
      "Most product ideas are Dead On Arrival because the conditions to derive value are impossible to orchestrate.",
    );
    expect(principle("P11_core_needs").quote).toContain("(1) finding love, (2) making or saving money, and (3) play");
    expect(principle("P9_external_exposure").review2026.verdict).toBe("partly");
  });

  it("covers the extra thread rules", () => {
    expect(EXTRA_THREAD_RULES.map((r) => r.id)).toEqual([
      "name_after_first_community",
      "life_inflection_points",
      "obsessive_beachheads",
      "seven_opens_per_session",
      "never_meetup_app",
      "partnership_run",
    ]);
  });
});

describe("ladderFor", () => {
  it("assigns single-player to a lone-user utility", () => {
    expect(ladderFor(astra())).toBe("single_player");
  });

  it.each([
    ["no single-player value", { singlePlayerValue: false }],
    ["friends needed", { minFriendsForValue: 1 }],
    ["invite loop primary", { primaryChannel: "invite_loop" as const }],
  ])("assigns social when %s", (_label, overrides) => {
    expect(ladderFor(astra(overrides))).toBe("social");
  });

  it("an invite loop as a secondary channel stays single-player", () => {
    expect(ladderFor(astra({ secondaryChannels: ["invite_loop"] }))).toBe("single_player");
  });

  it("returns copies of the configured steps", () => {
    const steps = ladderSteps("single_player", config);
    expect(steps).toEqual([["S1_distribution", "S1_activation", "S4_monetization"]]);
    steps[0]?.push("S2_sharing");
    expect(config.lab.ladders.single_player[0]).toHaveLength(3);
    expect(ladderSteps("social", config)).toHaveLength(4);
  });
});

describe("sensitivity", () => {
  it.each([
    ["Get your tarot and birth chart reading", "astrology_fortune"],
    ["Rewrite your Hinge openers", "dating_safety"],
    ["Count calories from a photo", "health"],
    ["Track your anxiety", "mental_health"],
    ["Rate my face out of ten", "appearance_rating"],
    ["Your AI girlfriend who remembers", "ai_companion"],
    ["Pick stocks with AI", "finance"],
    ["Homework help for teens", "minors"],
    ["A daily Bible verse", "religion"],
    ["AI parlay builder for the sportsbook", "gambling"],
    ["Face scan to find your style", "biometric"],
    ["Ask a lawyer about your lease", "legal"],
  ] as const)("%s -> %s", (text, domain) => {
    expect(keywordDomains(text)).toContain(domain);
  });

  it("avoids common false positives", () => {
    expect(keywordDomains("A golf swing companion app for the basketball court and trading card collectors")).toEqual([]);
    expect(keywordDomains("Unlock God Mode hints")).toEqual([]);
    expect(keywordDomains("mental health check-ins")).toEqual(["mental_health"]);
  });

  it("unions and sorts the declared, classifier and keyword domains", () => {
    const idea = astra({ sensitiveDomains: ["religion"], oneLiner: "Your chart and your calories" });
    expect(effectiveDomains(idea, ["minors", "religion"])).toEqual(["astrology_fortune", "health", "minors", "religion"]);
  });

  it("derives the minimum age from domains and the wedge", () => {
    const at = (minAge: number) => astra({ wedge: { ...astra().wedge, minAge } });
    expect(minimumAgeFor(at(13), [])).toBe(13);
    expect(minimumAgeFor(at(12), [])).toBe(13);
    expect(minimumAgeFor(at(14), [])).toBe(16);
    expect(minimumAgeFor(at(17), [])).toBe(18);
    expect(minimumAgeFor(at(13), ["dating_safety"])).toBe(18);
    expect(minimumAgeFor(at(13), ["finance"])).toBe(18);
    expect(minimumAgeFor(at(13), ["religion"])).toBe(13);
  });
});
