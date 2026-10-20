import { defaultConfig } from "../../src/config/schema.ts";
import type { AppSpec, Critique, Idea } from "../../src/core/types.ts";
import type { ScreenInput } from "../../src/principles/gates.ts";
import { AI_DISCLOSURE } from "../../src/principles/product.ts";

export const NOW = "2026-10-17T12:00:00.000Z";
export const config = defaultConfig();

/** Vert's Astra: a single-player AI astrology verdict app for an interest community. */
export function astra(overrides: Partial<Idea> = {}): Idea {
  return {
    title: "Astra",
    oneLiner: "Your birth chart read like a group chat",
    coreNeed: "love",
    secondaryNeeds: ["play"],
    wedge: {
      name: "Gen Z astrology fans on TikTok",
      kind: "interest_community",
      description: "Young adults who post their big three and argue about compatibility",
      minAge: 18,
      maxAge: 30,
      locale: "en-US",
      creatorNiche: "zodiac TikTok",
      estimatedReachableCreators: 180,
      coPresence: 0.1,
      discoverable: 0.9,
      inflectionPoint: 0.3,
      obsessive: 0.9,
      urgency: 0.5,
      ownedReach: 0.8,
    },
    verdictMoment: "Enter your birth date and see your sun, moon and rising reading",
    aiCapability: "Writes a personal natal chart reading and compatibility verdicts",
    valueConditions: ["user knows their birth date", "reading feels personal"],
    singlePlayerValue: true,
    minFriendsForValue: 0,
    requiresPartnership: false,
    primaryChannel: "creator_ugc",
    secondaryChannels: ["share_loop", "owned_social"],
    shareArtifact: "Big-three card with a compatibility score",
    hookExamples: ["POV: the app read me to filth", "Rating my exes by their rising sign", "Your moon sign explains your texting"],
    interaction: {
      tapsToCoreAction: 3,
      secondsToFirstValue: 2,
      typicalSessionSeconds: 90,
      requiresAudio: false,
      requiresVoiceInput: false,
      requiresSustainedAttention: false,
      oneHanded: true,
      interruptible: true,
    },
    monetization: { model: "hard_paywall", payFor: "Unlimited readings and compatibility checks" },
    sensitiveDomains: ["astrology_fortune"],
    differentiation: "Readings written in the voice of a best friend's group chat, not a horoscope column",
    ...overrides,
  };
}

export function screenInput(idea: Idea, overrides: Partial<ScreenInput> = {}): ScreenInput {
  return {
    screeningId: "scr_000001",
    ideaId: "idea_000001",
    idea,
    config,
    now: NOW,
    exposures: [],
    critiques: [],
    classifierDomains: [...idea.sensitiveDomains],
    existingTitles: [],
    ...overrides,
  };
}

export function critique(overrides: Partial<Critique> = {}): Critique {
  return { lens: "bier_skeptic", score: 8, fatalFlaws: [], risks: [], fixes: [], wouldFund: true, ...overrides };
}

const step = (id: string, kind: AppSpec["onboarding"][number]["kind"], options: string[] = []): AppSpec["onboarding"][number] => ({
  id,
  kind,
  title: `Step ${id}`,
  subtitle: null,
  options,
  storeAs: options.length > 0 || kind.endsWith("_input") ? id : null,
});

/** A spec that passes every lint rule for the Astra idea. */
export function astraSpec(): AppSpec {
  return {
    appName: "Astra",
    nameCandidates: ["Astra", "Astra Chart", "Astra Reads"],
    subtitle: "Your chart, read honestly",
    slug: "astra",
    category: "Lifestyle",
    locale: "en-US",
    brand: {
      primaryColor: "#2B1B5A",
      accentColor: "#F5C542",
      backgroundColor: "#0E0A1F",
      textColor: "#FFFFFF",
      voice: "Your funniest friend who knows astrology",
      iconPrompt: "A gold crescent on deep purple",
    },
    onboarding: [
      step("welcome", "welcome"),
      step("consent", "ai_data_consent"),
      step("goal", "goal_picker", ["Love", "Career", "Friends"]),
      step("vibe", "single_choice", ["Chaotic", "Calm"]),
      step("birth_date", "date_input"),
      step("birth_time", "time_input"),
      step("birth_place", "place_input"),
      step("benefit", "benefit"),
      step("heard", "attribution_survey", ["TikTok", "Instagram", "A friend"]),
      step("loading", "loading_personalization"),
      step("preview", "value_preview"),
      step("notify", "notification_preprompt"),
    ],
    core: {
      inputKind: "date_time_place",
      inputLabel: "Your birth details",
      aiSystemPrompt: "You write playful, specific natal chart readings. Never predict health, money or death.",
      outputSections: ["Sun", "Moon", "Rising"],
      loadingMessages: ["Finding your planets"],
      freeUsesBeforePaywall: 0,
    },
    paywall: {
      placement: "after_onboarding",
      style: "hard",
      pages: 2,
      headline: "Unlock your full chart",
      bullets: ["Your complete reading", "Compatibility with anyone", "Daily transits"],
      productIds: ["week_699_t3", "year_3999_t0"],
      highlightedProductId: "week_699_t3",
      showCloseAfterSeconds: 3,
    },
    share: {
      artifact: "Big-three card",
      cardHeadline: "My big three, explained",
      caption: "This app gets me",
      deepLinkPath: "/chart",
      watermark: "astra",
    },
    invite: { method: "system_share_sheet", prefilledMessage: "Check our compatibility on Astra" },
    retention: {
      pushSchedule: [
        { dayOffset: 0, hourLocal: 20, kind: "transactional", copy: "Your full reading is ready." },
        { dayOffset: 4, hourLocal: 18, kind: "promotional", copy: "Mercury is up to something. Take a look." },
      ],
      dailyHook: "A daily transit note for your sign",
      widget: "Today's moon",
    },
    aso: {
      keywords: ["astrology", "birth chart", "zodiac", "horoscope", "compatibility"],
      description: "Astra reads your birth chart like a friend would.",
      promotionalText: "New: compatibility readings for any two charts.",
      screenshotCaptions: ["Your big three", "Compatibility, explained", "Daily transits"],
    },
    compliance: {
      aiDisclosure: AI_DISCLOSURE,
      dataInventory: [
        { dataType: "birth_data", purpose: "core_feature", sentTo: ["anthropic", "studio_backend"], retentionDays: 30, linkedToUser: false, usedForTracking: false },
      ],
      minimumAge: "18",
    },
  };
}
