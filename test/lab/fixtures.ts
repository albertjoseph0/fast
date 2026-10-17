import { defaultConfig } from "../../src/config/schema.ts";
import type { CellObservation, Idea, MetricCounts, MetricKey, Venture } from "../../src/core/types.ts";

export const config = defaultConfig();

export function astraIdea(overrides: Partial<Idea> = {}): Idea {
  return {
    title: "Stellar",
    oneLiner: "Astrology readings and compatibility from your birth chart",
    coreNeed: "love",
    secondaryNeeds: ["self_improvement"],
    wedge: {
      name: "Gen Z astrology fans on TikTok",
      kind: "interest_community",
      description: "18-30 year olds who follow zodiac creators",
      minAge: 18,
      maxAge: 30,
      locale: "en-US",
      creatorNiche: "zodiac TikTok",
      estimatedReachableCreators: 400,
      coPresence: 0.1,
      discoverable: 0.9,
      inflectionPoint: 0.3,
      obsessive: 0.8,
      urgency: 0.5,
      ownedReach: 0.8,
    },
    verdictMoment: "Enter birth date, see your compatibility score",
    aiCapability: "Generates personalized readings",
    valueConditions: ["user knows birth date"],
    singlePlayerValue: true,
    minFriendsForValue: 0,
    requiresPartnership: false,
    primaryChannel: "creator_ugc",
    secondaryChannels: ["share_loop", "owned_social"],
    shareArtifact: "Compatibility card",
    hookExamples: ["POV: your chart explains everything", "Rating my ex's sign", "What your Venus says"],
    interaction: {
      tapsToCoreAction: 3,
      secondsToFirstValue: 3,
      typicalSessionSeconds: 60,
      requiresAudio: false,
      requiresVoiceInput: false,
      requiresSustainedAttention: false,
      oneHanded: true,
      interruptible: true,
    },
    monetization: { model: "hard_paywall", payFor: "Unlimited readings" },
    sensitiveDomains: ["astrology_fortune"],
    differentiation: "Compatibility-first readings with shareable cards instead of daily horoscopes",
    ...overrides,
  };
}

export function venture(overrides: Partial<Venture> = {}): Venture {
  return {
    id: "ven_000001",
    ideaId: "idea_000001",
    screeningId: "scr_000001",
    name: "Stellar",
    slug: "stellar",
    wedge: "Gen Z astrology fans on TikTok",
    stage: "live_test",
    ladder: {
      kind: "single_player",
      steps: [["S1_distribution", "S1_activation", "S4_monetization"]],
      stepIndex: 0,
      validated: [],
      currentExperimentId: null,
      experimentIds: [],
      iteration: 0,
      harnessFixes: 0,
      stepStartedAt: null,
    },
    specVersion: 1,
    specHistory: [],
    baseline: { specVersion: 1, hookIds: [], paywallVariantId: null, onboardingVariantId: null },
    stores: [],
    bindings: { platforms: ["ios"], publisherAccountIds: {}, bundleId: "com.faststudio.stellar", androidPackage: "com.faststudio.stellar", ownedAccountIds: {}, adAccountIds: {}, products: [] },
    blockedOn: [],
    blockedMs: 0,
    timeboxStartedAt: null,
    history: [],
    createdAt: "2026-01-05T09:00:00.000Z",
    updatedAt: "2026-01-05T09:00:00.000Z",
    ...overrides,
  };
}

/** Counts spread evenly over `sources` sources. */
export function counts(successes: number, trials: number, sources = 10): MetricCounts {
  const bySource: MetricCounts["bySource"] = {};
  for (let i = 0; i < sources; i++) {
    const t = Math.floor(trials / sources) + (i < trials % sources ? 1 : 0);
    const s = Math.floor(successes / sources) + (i < successes % sources ? 1 : 0);
    bySource[`src_${i}`] = { successes: Math.min(s, t), trials: t };
  }
  return { successes, trials, bySource };
}

export function observation(cellId: string, metrics: Partial<Record<MetricKey, MetricCounts>>, extra: Partial<CellObservation> = {}): CellObservation {
  return { cellId, metrics, exposureViews: 0, spendCents: 0, internalShare: 0, observedAt: "2026-01-10T09:00:00.000Z", ...extra };
}
