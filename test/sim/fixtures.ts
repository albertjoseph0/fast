import { defaultConfig, type StudioConfig } from "../../src/config/schema.ts";
import { SimClock } from "../../src/core/clock.ts";
import type { LlmPort, MediaPort, PortSet } from "../../src/core/ports.ts";
import { StudioStore } from "../../src/core/store.ts";
import type { CreatorCampaign, Idea, Venture } from "../../src/core/types.ts";
import { createSimPorts } from "../../src/sim/ports.ts";
import { SimWorld } from "../../src/sim/world.ts";

export const START = "2026-03-02T09:00:00.000Z";

/** A strong single-player verdict app (Astra archetype). */
export const BASE_IDEA: Idea = {
  title: "Astra",
  oneLiner: "Daily compatibility verdicts from your birth chart",
  coreNeed: "love",
  secondaryNeeds: [],
  wedge: {
    name: "Gen Z astrology fans",
    kind: "interest_community",
    description: "Zodiac TikTok",
    minAge: 18,
    maxAge: 30,
    locale: "en-US",
    creatorNiche: "zodiac TikTok",
    estimatedReachableCreators: 120,
    coPresence: 0.2,
    discoverable: 0.8,
    inflectionPoint: 0.3,
    obsessive: 0.8,
    urgency: 0.5,
    ownedReach: 0.6,
  },
  verdictMoment: "Two signs in, one verdict out",
  aiCapability: "Reads two charts",
  valueConditions: ["knows birth date"],
  singlePlayerValue: true,
  minFriendsForValue: 0,
  requiresPartnership: false,
  primaryChannel: "creator_ugc",
  secondaryChannels: ["owned_social", "share_loop"],
  shareArtifact: "Compatibility card",
  hookExamples: ["He texts first? Check your signs", "Your rising sign explains your ex", "Rate your compatibility in 3 seconds"],
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
  monetization: { model: "hard_paywall", payFor: "unlimited verdicts" },
  sensitiveDomains: [],
  differentiation: "Verdict-first compatibility from both charts in one tap, with a shareable card no other app makes",
};

/** Idea archetypes, from the Vert sweet spot to ideas the principles say are doomed. */
export const ARCHETYPES: Record<string, (i: Idea) => Idea> = {
  verdict_love: (i) => i,
  money_utility: (i) => ({ ...i, coreNeed: "money", interaction: { ...i.interaction, secondsToFirstValue: 5 } }),
  play_soft: (i) => ({ ...i, coreNeed: "play", interaction: { ...i.interaction, secondsToFirstValue: 8 }, monetization: { ...i.monetization, model: "soft_paywall" } }),
  self_improvement: (i) => ({ ...i, coreNeed: "self_improvement", interaction: { ...i.interaction, secondsToFirstValue: 5 } }),
  slow_heavy: (i) => ({ ...i, interaction: { ...i.interaction, secondsToFirstValue: 25, tapsToCoreAction: 7 }, valueConditions: ["a", "b", "c", "d", "e"] }),
  social_unseeded: (i) => ({ ...i, singlePlayerValue: false, minFriendsForValue: 3, primaryChannel: "invite_loop" }),
  sustained: (i) => ({ ...i, interaction: { ...i.interaction, requiresSustainedAttention: true } }),
  audio: (i) => ({ ...i, interaction: { ...i.interaction, requiresAudio: true } }),
  freemium: (i) => ({ ...i, monetization: { ...i.monetization, model: "freemium" } }),
  social_seeded: (i) => ({ ...i, singlePlayerValue: false, minFriendsForValue: 3, wedge: { ...i.wedge, kind: "physical_community", coPresence: 0.8 } }),
};

export const GOOD = ["verdict_love", "money_utility"];
export const BAD = ["slow_heavy", "sustained", "social_unseeded", "freemium"];

const stubLlm: LlmPort = {
  kind: "stub",
  object: async () => {
    throw new Error("no llm in sim tests");
  },
  text: async () => "",
  usage: () => ({ calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costCents: 0 }),
};

const stubMedia: MediaPort = {
  kind: "stub",
  image: async () => {
    throw new Error("no media in sim tests");
  },
  video: async () => {
    throw new Error("no media in sim tests");
  },
};

export interface Harness {
  clock: SimClock;
  store: StudioStore;
  config: StudioConfig;
  world: SimWorld;
  ports: PortSet;
}

export function harness(seed = 7, config: StudioConfig = defaultConfig({ seed })): Harness {
  const clock = new SimClock(START);
  const store = new StudioStore(null, clock, seed);
  const world = new SimWorld({ seed, clock, store, config });
  const ports = createSimPorts({ world, clock, store, config, llm: stubLlm, media: stubMedia });
  return { clock, store, config, world, ports };
}

/** Put an idea and a venture whose iOS app is live in `territories` (empty: not live). */
export function addVenture(h: Harness, n: number, idea: Idea, territories: string[]): Venture {
  const id = `ven_${String(n).padStart(6, "0")}`;
  const ideaId = `idea_${String(n).padStart(6, "0")}`;
  const bundleId = `com.faststudio.app${n}`;
  h.store.ideas.put({ id: ideaId, idea, sourceSignalIds: [], createdAt: START });
  return h.store.ventures.put({
    id,
    ideaId,
    screeningId: `scr_${n}`,
    name: idea.title,
    slug: `app${n}`,
    wedge: idea.wedge.name,
    stage: "live_test",
    ladder: { kind: "single_player", steps: [["S1_distribution", "S1_activation", "S4_monetization"]], stepIndex: 0, validated: [], currentExperimentId: null, experimentIds: [], iteration: 0, harnessFixes: 0, stepStartedAt: null },
    specVersion: 1,
    specHistory: [],
    baseline: { specVersion: 1, hookIds: [], paywallVariantId: null, onboardingVariantId: null },
    stores: territories.length
      ? [{ platform: "ios", publisherAccountId: "pub_ios", bundleId, status: "live", territories, rejectionReasons: [], updatedAt: START }]
      : [],
    bindings: {
      platforms: ["ios"],
      publisherAccountIds: { ios: "pub_ios" },
      bundleId,
      androidPackage: bundleId,
      ownedAccountIds: {},
      adAccountIds: { meta: "act_sim" },
      products: [],
    },
    blockedOn: [],
    blockedMs: 0,
    timeboxStartedAt: START,
    history: [],
    createdAt: START,
    updatedAt: START,
  });
}

export function campaign(h: Harness, v: Venture, n: number, geo: string, opts: Partial<CreatorCampaign> = {}): CreatorCampaign {
  const idea = h.store.ideas.require(v.ideaId).idea;
  return h.store.campaigns.put({
    id: `ccmp_${String(n).padStart(6, "0")}`,
    ventureId: v.id,
    brief: { title: idea.title, productSummary: idea.oneLiner, audience: idea.wedge.name, formats: ["slideshow"], hooks: idea.hookExamples, mustInclude: [], mustAvoid: [], deliverables: "1 video" },
    platforms: ["tiktok", "instagram"],
    targetCountries: [geo],
    creatorAudienceCountryMinPct: 0.5,
    flatFeeCents: 1_500,
    cpmCents: 150,
    maxPayoutPerVideoCents: 15_000,
    payoutMaturityDays: 7,
    budgetCents: 75_000,
    status: "draft",
    createdAt: h.clock.iso(),
    ...opts,
  });
}

/** Open a campaign through the marketplace port, as the executor would. */
export async function openCampaign(h: Harness, c: CreatorCampaign): Promise<CreatorCampaign> {
  const { externalId } = await h.ports.write.creators.createCampaign(c);
  return h.store.campaigns.put({ ...c, externalId, status: "open" });
}

/** One operating day: approve every new draft (like creator ops would), then simulate the market. */
export async function day(h: Harness): Promise<void> {
  for (const c of h.store.campaigns.list((x) => Boolean(x.externalId))) {
    for (const s of await h.ports.read.creators.listSubmissions({ campaignExternalId: c.externalId as string })) {
      if (s.stage === "draft_submitted") await h.ports.write.creators.reviewDraft({ submissionExternalId: s.externalId, approve: true, note: "ok" });
    }
  }
  h.world.advanceDay();
  h.clock.advanceDays(1);
}

export async function days(h: Harness, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await day(h);
}
