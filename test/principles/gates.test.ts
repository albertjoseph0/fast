import { describe, expect, it } from "vitest";
import type { AudienceExposure } from "../../src/core/store.ts";
import type { GateResult } from "../../src/core/types.ts";
import {
  gateCompliance,
  gateDifferentiation,
  gateP10,
  gateP11,
  gateP2,
  gateP3,
  gateP4,
  gateP7,
  gateP9,
  GATE_WEIGHTS,
  normalizeIdea,
  screenIdea,
} from "../../src/principles/gates.ts";
import { specDomains } from "../../src/principles/sensitivity.ts";
import { astra, astraSpec, config, critique, NOW, screenInput } from "./fixtures.ts";

const gate = (gates: GateResult[], id: GateResult["gate"]) => gates.find((g) => g.gate === id);

describe("screenIdea", () => {
  it("advances an Astra-like single-player idea", () => {
    const s = screenIdea(screenInput(astra()));
    expect(s.verdict).toBe("advance");
    expect(s.score).toBeGreaterThanOrEqual(config.portfolio.minScreenScore);
    expect(s.score).toBeGreaterThan(85);
    expect(s.sensitiveDomains).toEqual(["astrology_fortune"]);
    expect(s.reasons).toEqual([]);
    expect(s.id).toBe("scr_000001");
    expect(s.screenedAt).toBe(NOW);
  });

  it("rejects a meetup app on P2 and P11", () => {
    const idea = astra({
      title: "Linkup",
      oneLiner: "Make plans with friends and hang out tonight",
      singlePlayerValue: false,
      minFriendsForValue: 8,
      primaryChannel: "invite_loop",
      valueConditions: ["friends install", "friends are free tonight", "friends are nearby", "someone proposes a plan", "venues have space"],
      sensitiveDomains: [],
    });
    const s = screenIdea(screenInput(idea, { classifierDomains: [] }));
    expect(s.verdict).toBe("reject");
    expect(gate(s.gates, "P2_orchestrable_value")?.verdict).toBe("fail");
    expect(gate(s.gates, "P11_core_needs")?.verdict).toBe("fail");
    expect(s.reasons.some((r) => r.startsWith("P2_orchestrable_value fail"))).toBe(true);
    expect(s.reasons.some((r) => r.startsWith("P11_core_needs fail"))).toBe(true);
  });

  it("rejects a live-video app on P10", () => {
    const idea = astra({
      title: "LiveRead",
      interaction: { ...astra().interaction, requiresSustainedAttention: true, requiresAudio: true, secondsToFirstValue: 40 },
    });
    const s = screenIdea(screenInput(idea));
    expect(s.verdict).toBe("reject");
    expect(gate(s.gates, "P10_toilet_test")?.verdict).toBe("fail");
  });

  it("rejects a paid-only idea on P7", () => {
    const s = screenIdea(screenInput(astra({ primaryChannel: "paid_ads", secondaryChannels: ["app_store_search"] })));
    expect(s.verdict).toBe("reject");
    expect(gate(s.gates, "P7_distribution_first")?.reason).toMatch(/no organic channel/);
  });

  it("sends a teen wedge to a human", () => {
    const s = screenIdea(screenInput(astra({ wedge: { ...astra().wedge, minAge: 13, maxAge: 19 } })));
    expect(s.verdict).toBe("needs_human");
    expect(gate(s.gates, "compliance.minors")?.verdict).toBe("needs_human");
  });

  it("sends a calorie app to a human via the health keyword backstop", () => {
    const idea = astra({
      title: "Plate",
      oneLiner: "Snap your plate and get calories in seconds",
      coreNeed: "self_improvement",
      secondaryNeeds: ["love"],
      aiCapability: "Estimates calories and macros from a photo",
      verdictMoment: "Photo to calorie count",
      sensitiveDomains: [],
      wedge: { ...astra().wedge, name: "Gym-going college students", creatorNiche: "gym TikTok" },
    });
    const s = screenIdea(screenInput(idea, { classifierDomains: [] }));
    expect(s.verdict).toBe("needs_human");
    expect(s.sensitiveDomains).toContain("health");
    expect(gate(s.gates, "compliance.sensitive_domain")?.verdict).toBe("needs_human");
    expect(gate(s.gates, "compliance.classifier_disagreement")?.verdict).toBe("pass");
  });

  it("sends a classifier disagreement to a human", () => {
    const s = screenIdea(screenInput(astra(), { classifierDomains: ["astrology_fortune", "religion"] }));
    expect(s.verdict).toBe("needs_human");
    expect(gate(s.gates, "compliance.classifier_disagreement")?.reason).toMatch(/religion/);
    expect(gate(s.gates, "compliance.sensitive_domain")?.verdict).toBe("pass");
    expect(s.sensitiveDomains).toEqual(["astrology_fortune", "religion"]);
  });

  it("blends critiques 70/30 into the score", () => {
    const base = screenIdea(screenInput(astra())).score;
    const s = screenIdea(screenInput(astra(), { critiques: [critique({ score: 4 }), critique({ score: 6, lens: "growth_realist" })] }));
    expect(s.score).toBeCloseTo(0.7 * base + 0.3 * 50, 0);
    expect(s.critiques).toHaveLength(2);
  });

  it("rejects when two critics refuse to fund with fatal flaws", () => {
    const s = screenIdea(
      screenInput(astra(), {
        critiques: [
          critique({ wouldFund: false, fatalFlaws: ["saturated category"], score: 9 }),
          critique({ lens: "growth_realist", wouldFund: false, fatalFlaws: ["no creator supply"], score: 9 }),
          critique({ lens: "store_and_policy" }),
        ],
      }),
    );
    expect(s.verdict).toBe("reject");
    expect(s.reasons.some((r) => r.includes("critics veto"))).toBe(true);
  });

  it("does not veto on refusals without fatal flaws", () => {
    const s = screenIdea(screenInput(astra(), { critiques: [critique({ wouldFund: false }), critique({ wouldFund: false, lens: "growth_realist" })] }));
    expect(s.verdict).toBe("advance");
  });

  it("rejects a low score with no failed gate", () => {
    const weak = astra({
      coreNeed: "self_improvement",
      secondaryNeeds: [],
      secondaryChannels: ["owned_social"],
      differentiation: "Friendlier",
      interaction: { ...astra().interaction, secondsToFirstValue: 5, oneHanded: false },
    });
    const s = screenIdea(screenInput(weak, { critiques: [critique({ score: 0 }), critique({ score: 0 })] }));
    expect(s.gates.every((g) => g.verdict === "pass" || g.verdict === "warn")).toBe(true);
    expect(s.score).toBeLessThan(config.portfolio.minScreenScore);
    expect(s.verdict).toBe("reject");
    expect(s.reasons.at(-1)).toMatch(/^score/);
  });

  it("prefers reject over needs_human", () => {
    const idea = astra({ requiresPartnership: true, wedge: { ...astra().wedge, minAge: 13 } });
    expect(screenIdea(screenInput(idea)).verdict).toBe("reject");
  });

  it("uses weights that sum to 1", () => {
    expect(Object.values(GATE_WEIGHTS).reduce<number>((s, w) => s + (w ?? 0), 0)).toBeCloseTo(1, 10);
  });

  it("normalizes before gating", () => {
    const w = astra().wedge;
    const s = screenIdea(screenInput(astra({ wedge: { ...w, discoverable: 9, ownedReach: 8, obsessive: 9, coPresence: 1, urgency: 5, inflectionPoint: 3 } })));
    expect(s.verdict).toBe("advance");
  });
});

describe("normalizeIdea", () => {
  it("rescales 0..10 factors and trims strings", () => {
    const w = astra().wedge;
    const n = normalizeIdea(
      astra({
        title: "  Astra ",
        hookExamples: [" a ", "", "b"],
        wedge: { ...w, coPresence: 1, discoverable: 9, inflectionPoint: 3, obsessive: 10, urgency: 5, ownedReach: 8, name: " Fans " },
      }),
    );
    expect(n.title).toBe("Astra");
    expect(n.hookExamples).toEqual(["a", "b"]);
    expect(n.wedge.name).toBe("Fans");
    expect(n.wedge).toMatchObject({ coPresence: 0.1, discoverable: 0.9, inflectionPoint: 0.3, obsessive: 1, urgency: 0.5, ownedReach: 0.8 });
  });

  it("rescales 0..100 factors and clamps out-of-range values", () => {
    const w = astra().wedge;
    const n = normalizeIdea(astra({ wedge: { ...w, coPresence: 40, discoverable: 90, inflectionPoint: -5, obsessive: 100, urgency: 250, ownedReach: 0 } }));
    expect(n.wedge).toMatchObject({ coPresence: 0.4, discoverable: 0.9, inflectionPoint: 0, obsessive: 1, urgency: 1, ownedReach: 0 });
  });

  it("leaves 0..1 factors unchanged", () => {
    expect(normalizeIdea(astra()).wedge).toEqual(astra().wedge);
  });
});

describe("individual gates", () => {
  it("P2 warns on 1-6 friends and fails on partnerships and too many conditions", () => {
    expect(gateP2(astra()).verdict).toBe("pass");
    expect(gateP2(astra({ minFriendsForValue: 3 })).verdict).toBe("warn");
    expect(gateP2(astra({ requiresPartnership: true })).verdict).toBe("fail");
    expect(gateP2(astra({ valueConditions: ["a", "b", "c", "d", "e"] })).verdict).toBe("fail");
    expect(gateP2(astra({ valueConditions: ["a", "b", "c", "d"] })).verdict).toBe("pass");
    expect(gateP2(astra({ singlePlayerValue: false, minFriendsForValue: 7 })).verdict).toBe("fail");
  });

  it("P3 checks social factor sums and single-player creator niches", () => {
    expect(gateP3(astra()).verdict).toBe("pass");
    expect(gateP3(astra({ wedge: { ...astra().wedge, estimatedReachableCreators: 12 } })).verdict).toBe("fail");
    expect(gateP3(astra({ wedge: { ...astra().wedge, discoverable: 0.4 } })).verdict).toBe("fail");
    expect(gateP3(astra({ wedge: { ...astra().wedge, minAge: 18, maxAge: 60 } })).verdict).toBe("warn");
    const social = astra({ minFriendsForValue: 2 });
    expect(gateP3(social).verdict).toBe("fail");
    const dense = { ...astra().wedge, coPresence: 1, inflectionPoint: 0.8, urgency: 0.8 };
    expect(gateP3({ ...social, wedge: dense }).verdict).toBe("pass");
  });

  it("P4 warns without test geos for the locale and on a burned wedge", () => {
    expect(gateP4(astra(), config, [], NOW).verdict).toBe("pass");
    const fr = astra({ wedge: { ...astra().wedge, locale: "fr-FR" } });
    expect(gateP4(fr, config, [], NOW).reason).toMatch(/no test geos/);
    const exposure = (at: string): AudienceExposure => ({ key: "k", wedge: "gen z astrology fans on tiktok", ventureId: "ven_1", experimentId: "exp_1", at });
    expect(gateP4(astra(), config, [exposure("2026-10-01T00:00:00.000Z")], NOW).verdict).toBe("warn");
    expect(gateP4(astra(), config, [exposure("2026-01-01T00:00:00.000Z")], NOW).verdict).toBe("pass");
  });

  it("P7 requires hooks, a share artifact and enough creators for creator UGC", () => {
    expect(gateP7(astra()).verdict).toBe("pass");
    expect(gateP7(astra({ hookExamples: ["a", "b"] })).verdict).toBe("fail");
    expect(gateP7(astra({ shareArtifact: " " })).verdict).toBe("fail");
    expect(gateP7(astra({ wedge: { ...astra().wedge, estimatedReachableCreators: 10 } })).verdict).toBe("fail");
    expect(gateP7(astra({ primaryChannel: "paid_ads" })).verdict).toBe("warn");
  });

  it("P9 rewards a share loop", () => {
    expect(gateP9(astra()).score).toBe(1);
    expect(gateP9(astra({ secondaryChannels: ["owned_social"] })).score).toBe(0.7);
    expect(gateP9(astra({ shareArtifact: "" })).verdict).toBe("warn");
  });

  it("P10 fails on taps or time and warns on soft issues", () => {
    const i = astra().interaction;
    expect(gateP10(astra()).verdict).toBe("pass");
    expect(gateP10(astra({ interaction: { ...i, tapsToCoreAction: 6 } })).verdict).toBe("fail");
    expect(gateP10(astra({ interaction: { ...i, secondsToFirstValue: 16 } })).verdict).toBe("fail");
    for (const soft of [{ secondsToFirstValue: 5 }, { requiresVoiceInput: true }, { oneHanded: false }, { interruptible: false }]) {
      expect(gateP10(astra({ interaction: { ...i, ...soft } })).verdict).toBe("warn");
    }
  });

  it("P11 penalizes unmapped self-improvement", () => {
    expect(gateP11(astra()).score).toBe(1);
    expect(gateP11(astra({ coreNeed: "self_improvement", secondaryNeeds: ["money"] })).score).toBe(0.85);
    const unmapped = gateP11(astra({ coreNeed: "self_improvement", secondaryNeeds: [] }));
    expect(unmapped).toMatchObject({ verdict: "warn", score: 0.7 });
    expect(gateP11(astra({ oneLiner: "Find friends nearby for a meetup" })).verdict).toBe("fail");
  });

  it("compliance always reports all three gates", () => {
    expect(gateCompliance(astra(), config, ["astrology_fortune"]).map((g) => [g.gate, g.verdict])).toEqual([
      ["compliance.minors", "pass"],
      ["compliance.sensitive_domain", "pass"],
      ["compliance.classifier_disagreement", "pass"],
    ]);
    const lowered = { ...config, autonomy: { ...config.autonomy, autonomousMinAge: 13 } };
    expect(gateCompliance(astra({ wedge: { ...astra().wedge, minAge: 13 } }), lowered, [])[0]?.verdict).toBe("pass");
  });

  it("compliance takes the younger of the wedge and the classifier's minimum age", () => {
    const minors = (age?: number) => gateCompliance(astra(), config, ["astrology_fortune"], age)[0];
    expect(minors(18)?.verdict).toBe("pass");
    expect(minors(16)).toMatchObject({ verdict: "needs_human" });
    expect(minors(16)?.reason).toContain("classifier puts the youngest users at 16");
    expect(screenIdea(screenInput(astra(), { classifierMinimumAge: 13 })).verdict).toBe("needs_human");
  });

  it("differentiation rejects duplicate titles and warns on thin differentiation", () => {
    expect(gateDifferentiation(astra(), ["Plug AI", " astra "]).verdict).toBe("fail");
    expect(gateDifferentiation(astra({ differentiation: "It is better" }), []).verdict).toBe("warn");
    expect(gateDifferentiation(astra(), ["Strum"]).verdict).toBe("pass");
  });
});

describe("keyword backstop precision", () => {
  it("flags dating apps and budgeting tools but not other senses of the words", async () => {
    const { keywordDomains } = await import("../../src/principles/sensitivity.ts");
    expect(keywordDomains("Paste the text you're about to send your match on a dating app")).toContain("dating_safety");
    expect(keywordDomains("Back to dating after a divorce")).toContain("dating_safety");
    expect(keywordDomains("Snap a vintage tee's tag for dating the print era")).not.toContain("dating_safety");
    expect(keywordDomains("A budgeting coach for your first paycheck")).toContain("finance");
    expect(keywordDomains("Budget-friendly thrift flips for resellers")).not.toContain("finance");
  });
});

describe("specDomains", () => {
  const fitCheck = () =>
    astra({
      title: "Fit Check",
      oneLiner: "Honest verdicts on your look",
      sensitiveDomains: [],
      wedge: { ...astra().wedge, minAge: 16, name: "Gen Z fashion TikTok", description: "Teens who post outfit videos", creatorNiche: "fashion" },
    });

  it("classifies the spec's own prompt, adds biometric for judged photos and minors for an under-18 wedge", () => {
    const spec = astraSpec();
    spec.core.inputKind = "photo";
    spec.core.aiSystemPrompt = "Give an attractiveness score from 1-10 for their face and body.";
    expect(specDomains(spec, fitCheck(), [])).toEqual(expect.arrayContaining(["appearance_rating", "biometric", "minors"]));
  });

  it("keeps the idea's domains and adds nothing for an adult text app", () => {
    const spec = astraSpec();
    spec.core.aiSystemPrompt = "You write playful, specific natal chart readings.";
    expect(specDomains(spec, astra(), ["astrology_fortune"])).toEqual(["astrology_fortune"]);
  });
});
