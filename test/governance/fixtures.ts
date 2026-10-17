import { vi } from "vitest";
import { defaultConfig, type StudioConfig } from "../../src/config/schema.ts";
import { SimClock } from "../../src/core/clock.ts";
import type { ProposeInput } from "../../src/core/context.ts";
import type { WritePorts } from "../../src/core/ports.ts";
import { StudioStore } from "../../src/core/store.ts";
import type {
  ActionKind,
  AdCampaign,
  ContentPiece,
  Creator,
  CreatorCampaign,
  CreatorSubmission,
  DailyMetrics,
  Idea,
  OwnedAccount,
  PublisherAccount,
  Screening,
  Venture,
} from "../../src/core/types.ts";
import { deriveDisclosure, labelsFor } from "../../src/governance/disclosure.ts";
import { LedgerSync } from "../../src/governance/ledger.ts";
import { Governance } from "../../src/governance/outbox.ts";

export const START = "2026-03-02T09:00:00.000Z";

export const IDEA: Idea = {
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
  secondaryChannels: ["owned_social"],
  shareArtifact: "Compatibility card",
  hookExamples: ["a", "b", "c"],
  interaction: {
    tapsToCoreAction: 3,
    secondsToFirstValue: 5,
    typicalSessionSeconds: 60,
    requiresAudio: false,
    requiresVoiceInput: false,
    requiresSustainedAttention: false,
    oneHanded: true,
    interruptible: true,
  },
  monetization: { model: "hard_paywall", payFor: "unlimited verdicts" },
  sensitiveDomains: [],
  differentiation: "Verdict-first",
};

export interface World {
  clock: SimClock;
  store: StudioStore;
  config: StudioConfig;
  ledger: LedgerSync;
  gov: Governance;
  venture: Venture;
}

export function makeWorld(opts: { config?: Parameters<typeof defaultConfig>[0]; store?: StudioStore; clock?: SimClock; killSwitchPath?: string | null } = {}): World {
  const clock = opts.clock ?? new SimClock(START);
  const store = opts.store ?? new StudioStore(null, clock);
  const config = defaultConfig(opts.config ?? {});
  const ledger = new LedgerSync({ store, config, clock });
  const gov = new Governance({ store, config, clock, ledger, killSwitchPath: opts.killSwitchPath ?? null });
  store.publishers.put(publisher("pub_ios", "ios"));
  store.publishers.put(publisher("pub_android", "android"));
  store.ideas.put({ id: "idea_000001", idea: IDEA, sourceSignalIds: [], createdAt: START });
  store.screenings.put(screening([]));
  const venture = store.ventures.put(makeVenture());
  return { clock, store, config, ledger, gov, venture };
}

export function publisher(id: string, platform: "ios" | "android", status: PublisherAccount["status"] = "active"): PublisherAccount {
  return { id, entityId: "ent_000001", platform, externalTeamId: "TEAM", kind: "organization", status, secretRefs: {} };
}

export function screening(domains: Screening["sensitiveDomains"], at = START): Screening {
  return {
    id: `scr_${at}`,
    ideaId: "idea_000001",
    gates: [],
    critiques: [],
    sensitiveDomains: domains,
    score: 80,
    verdict: "advance",
    reasons: [],
    screenedAt: at,
  };
}

export function makeVenture(patch: Partial<Venture> = {}): Venture {
  return {
    id: "ven_000001",
    ideaId: "idea_000001",
    screeningId: "scr_000001",
    name: "Astra",
    slug: "astra",
    wedge: "Gen Z astrology fans",
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
    stores: [
      { platform: "ios", publisherAccountId: "pub_ios", bundleId: "com.faststudio.astra", status: "live", territories: ["CA"], rejectionReasons: [], updatedAt: START },
    ],
    bindings: {
      platforms: ["ios"],
      publisherAccountIds: { ios: "pub_ios", android: "pub_android" },
      bundleId: "com.faststudio.astra",
      androidPackage: "com.faststudio.astra",
      privacyUrl: "https://astra.example.com/privacy",
      supportUrl: "https://astra.example.com/support",
      ownedAccountIds: {},
      adAccountIds: { meta: "act_meta", apple: "apple_org" },
      products: [
        { productId: "com.faststudio.astra.week_699_t3", ladderId: "week_699_t3", platform: "ios", status: "approved" },
        { productId: "com.faststudio.astra.year_3999_t0", ladderId: "year_3999_t0", platform: "ios", status: "approved" },
      ],
    },
    blockedOn: [],
    blockedMs: 0,
    timeboxStartedAt: START,
    history: [],
    createdAt: START,
    updatedAt: START,
    ...patch,
  };
}

export function account(patch: Partial<OwnedAccount> = {}): OwnedAccount {
  return {
    id: "acct_000001",
    ventureId: "ven_000001",
    platform: "instagram",
    handle: "@astra.app",
    publishMode: "business_api",
    bioDisclosesBrand: true,
    standingConsent: { scopes: ["publish"], grantedAt: START, expiresAt: "2026-12-31T00:00:00.000Z", grantedBy: "owner" },
    status: "active",
    ...patch,
  };
}

export function piece(patch: Partial<ContentPiece> = {}): ContentPiece {
  return {
    id: "cnt_000001",
    ventureId: "ven_000001",
    formatId: "slideshow_verdict",
    draft: {
      formatId: "slideshow_verdict",
      platform: "instagram",
      voice: "brand_third_person",
      hook: "Your sign says you text first",
      angle: "compatibility",
      script: "",
      slides: [{ text: "Leo + Scorpio?", imagePrompt: "flat pastel illustration of two zodiac glyphs", isAppReveal: false }],
      caption: "Find out in Astra",
      hashtags: ["#astrology"],
      callToAction: "Try it",
    },
    media: [{ localPath: "/tmp/a.png", sha256: "sha_a", mediaType: "image/png", aiGenerated: true, c2pa: true }],
    channel: "owned_social",
    platform: "instagram",
    similarityKey: "slideshow_verdict:abc",
    status: "approved",
    ...patch,
  };
}

/** A content.publish input with correct derived labels. */
export function publishInput(p: ContentPiece, acct: OwnedAccount, now: string, naturalKey = p.id): ProposeInput<"content.publish"> {
  return {
    kind: "content.publish",
    ventureId: p.ventureId,
    payload: {
      contentId: p.id,
      accountId: acct.id,
      platform: p.platform,
      mode: "direct",
      labels: labelsFor(p.platform, deriveDisclosure(p, now)),
      mediaSha256: p.media.map((m) => m.sha256),
    },
    summary: "post",
    rationale: "test",
    proposedBy: "content",
    naturalKey,
  };
}

export function creator(patch: Partial<Creator> = {}): Creator {
  return {
    id: "cre_000001",
    platform: "tiktok",
    handle: "@stargazer",
    externalIds: { sideshift: "ss_1" },
    niche: "zodiac",
    followers: 50_000,
    medianViews30d: 20_000,
    audienceGeo: { CA: 0.7 },
    audienceUnder18Share: 0.1,
    source: "sideshift",
    status: "active",
    stats: { posts: 0, views: 0, attributedInstalls: 0, attributedTrials: 0, paidCents: 0 },
    ...patch,
  };
}

export function campaign(patch: Partial<CreatorCampaign> = {}): CreatorCampaign {
  return {
    id: "ccmp_000001",
    ventureId: "ven_000001",
    brief: {
      title: "Astra compatibility reveal",
      productSummary: "An app that gives a compatibility verdict from two birth dates",
      audience: "Astrology fans 18-30",
      formats: ["green screen reaction"],
      hooks: ["I checked my ex's sign"],
      mustInclude: ["Show the app within 15s", "Turn on the paid partnership label"],
      mustAvoid: ["Never say it is guaranteed"],
      deliverables: "One video",
    },
    platforms: ["tiktok"],
    targetCountries: ["CA"],
    creatorAudienceCountryMinPct: 0.5,
    flatFeeCents: 1_500,
    cpmCents: 150,
    maxPayoutPerVideoCents: 15_000,
    payoutMaturityDays: 7,
    budgetCents: 100_000,
    status: "open",
    createdAt: START,
    ...patch,
  };
}

export function submission(patch: Partial<CreatorSubmission> = {}): CreatorSubmission {
  return {
    id: "sub_000001",
    externalId: "ss_sub_1",
    campaignId: "ccmp_000001",
    creatorId: "cre_000001",
    creatorHandle: "@stargazer",
    platform: "tiktok",
    postUrl: "https://tiktok.com/@stargazer/video/1",
    untrustedCaption: "so accurate",
    stage: "post_approved",
    verification: { fetchedAt: START, postIsPublic: true, authorHandleMatches: true, platformDisclosureLabel: true, viewsFromPlatform: 40_000 },
    review: { approve: true, injectionAttempt: false, policyIssues: [], note: "" },
    viewsAtLock: 40_000,
    lockedAt: START,
    payoutCents: 0,
    postedAt: "2026-02-20T09:00:00.000Z",
    submittedAt: "2026-02-19T09:00:00.000Z",
    ...patch,
  };
}

export function adCampaign(patch: Partial<AdCampaign> = {}): AdCampaign {
  return {
    id: "adc_000001",
    ventureId: "ven_000001",
    network: "meta",
    actionId: "",
    type: "creative",
    os: "ios",
    dailyBudgetCents: 5_000,
    startAt: "2026-03-02T00:00:00.000Z",
    endAt: "2026-03-05T00:00:00.000Z",
    geos: ["CA"],
    creatives: [{ kind: "owned_post", contentId: "cnt_000001", platform: "instagram", externalId: "ig_1" }],
    keywords: [],
    status: "pending",
    createdAt: START,
    ...patch,
  };
}

export function metricsRow(patch: Partial<DailyMetrics> = {}): DailyMetrics {
  return {
    ventureId: "ven_000001",
    date: "2026-03-01",
    cellId: null,
    geo: null,
    counts: {},
    grossRevenueCents: 0,
    proceedsCents: 0,
    refundsCents: 0,
    activeSubscribers: 0,
    reportedSpendCents: 0,
    complete: true,
    ...patch,
  };
}

/** Minimal propose input for kinds whose payload is supplied by the test. */
export function input<K extends ActionKind>(kind: K, payload: ProposeInput<K>["payload"], extra: Partial<ProposeInput<K>> = {}): ProposeInput<K> {
  return { kind, ventureId: "ven_000001", payload, summary: kind, rationale: "test", proposedBy: "orchestrator", naturalKey: kind, ...extra };
}

/** WritePorts where every method is a vi.fn with a benign default. */
export function fakeWrite(): WritePorts {
  const job = { op: "store.review" as const, externalRef: { id: "ext" }, pollAfterSec: 60 };
  return {
    store: {
      kind: "sim",
      registerBundleId: vi.fn(async () => ({ bundleIdResourceId: "bid_1" })),
      createApp: vi.fn(async () => ({ appId: "app_1" })),
      upsertSubscriptions: vi.fn(async () => ({ ...job, op: "store.upsert_subscriptions" as const })),
      startBuild: vi.fn(async () => ({ ...job, op: "store.build" as const })),
      submitBuild: vi.fn(async () => ({ ...job, op: "store.submit_build" as const })),
      updateListing: vi.fn(async () => ({ ...job, op: "store.update_listing" as const })),
      setTerritories: vi.fn(async () => undefined),
      submitForReview: vi.fn(async () => job),
      release: vi.fn(async () => undefined),
      removeFromSale: vi.fn(async () => undefined),
    },
    monetization: { kind: "sim", configure: vi.fn(async () => ({ offeringIds: { default: "ofrng_1" } })) },
    remoteConfig: { kind: "sim", setFlag: vi.fn(async () => ({ flagKey: "paywall" })) },
    creators: {
      kind: "sim",
      createCampaign: vi.fn(async () => ({ externalId: "ss_cmp_1" })),
      closeCampaign: vi.fn(async () => undefined),
      sendMessage: vi.fn(async () => undefined),
      offerDeal: vi.fn(async () => ({ externalId: "ss_deal_1" })),
      reviewDraft: vi.fn(async () => undefined),
      reviewPost: vi.fn(async () => undefined),
      payout: vi.fn(async () => ({ payoutId: "ss_pay_1" })),
    },
    social: { kind: "sim", publish: vi.fn(async () => ({ op: "social.publish" as const, externalRef: { container: "c1" }, pollAfterSec: 30 })) },
    ads: {
      kind: "sim",
      createCampaign: vi.fn(async () => ({ campaignExternalId: "meta_cmp_1" })),
      setDailyBudget: vi.fn(async () => undefined),
      pause: vi.fn(async () => undefined),
    },
    web: {
      kind: "sim",
      putAsset: vi.fn(async () => ({ publicUrl: "https://cdn.example.com/a.png", sha256: "sha_a" })),
      publishSite: vi.fn(async () => ({ baseUrl: "https://astra.example.com" })),
    },
  };
}
