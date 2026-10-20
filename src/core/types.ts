/**
 * Domain model for the autonomous app studio (contracts v2).
 *
 * LLM-generated entities are zod schemas so one definition doubles as the
 * structured-output contract. LLM-facing schemas carry types and enums only; numeric
 * ranges, lengths and counts are business rules enforced by deterministic lint
 * (src/principles), never by the decoder, so one out-of-range field cannot sink a call.
 */
import { z } from "zod";
import type { EventName } from "./events.ts";

// ---------------------------------------------------------------------------
// Primitives and shared enums
// ---------------------------------------------------------------------------

/** ISO-8601 timestamp string. */
export type Iso = string;
/** Integer US cents. All money in the system is integer USD cents. */
export type Cents = number;

export const CoreNeed = z.enum([
  // Bier's three core needs.
  "love", // finding love, relationships, compatibility, social standing
  "money", // making or saving money
  "play", // play, hobbies, unplugging from reality
  // Observed 2023-2026 winners (Cal AI, Umax, Quittr): allowed with a scoring penalty.
  "self_improvement",
]);
export type CoreNeed = z.infer<typeof CoreNeed>;

export const Platform = z.enum(["tiktok", "instagram", "youtube", "x", "pinterest", "snapchat", "threads"]);
export type Platform = z.infer<typeof Platform>;

export const StorePlatform = z.enum(["ios", "android"]);
export type StorePlatform = z.infer<typeof StorePlatform>;

export const AdNetwork = z.enum(["meta", "tiktok", "apple", "google"]);
export type AdNetwork = z.infer<typeof AdNetwork>;

/**
 * How a product reaches new people. Bier: product channels are one-to-one invites and
 * one-to-many sharing. Vert / Cal AI: paid human creators posting on their own accounts.
 */
export const ChannelKind = z.enum([
  "creator_ugc", // paid human creators on their own accounts (primary)
  "owned_social", // disclosed brand accounts, low volume
  "share_loop", // users export the app's output to other networks
  "invite_loop", // user-initiated, device-sent one-to-one invites
  "paid_ads", // amplification of proven winners only
  "app_store_search", // ASO + Apple Ads
  "seo", // programmatic web pages
]);
export type ChannelKind = z.infer<typeof ChannelKind>;

export const SensitiveDomain = z.enum([
  "health",
  "mental_health",
  "finance",
  "legal",
  "dating_safety",
  "religion",
  "minors",
  "biometric",
  "ai_companion",
  "appearance_rating",
  "astrology_fortune",
  "gambling",
]);
export type SensitiveDomain = z.infer<typeof SensitiveDomain>;

export const AgentRole = z.enum([
  "scout",
  "ideator",
  "critic",
  "designer",
  "brand",
  "content",
  "creator_ops",
  "analyst",
  "ceo",
  "compliance",
]);
export type AgentRole = z.infer<typeof AgentRole>;

/** Id prefixes. Every id is `${prefix}_${6 digits}` from StudioStore.nextId. */
export const ID = {
  signal: "sig",
  idea: "idea",
  screening: "scr",
  venture: "ven",
  experiment: "exp",
  cell: "cell",
  content: "cnt",
  hook: "hook",
  batch: "bat",
  creator: "cre",
  deal: "deal",
  campaign: "ccmp",
  submission: "sub",
  payout: "pay",
  adCampaign: "adc",
  action: "act",
  task: "task",
  job: "job",
  ledger: "led",
  claim: "clm",
  entity: "ent",
  publisher: "pub",
  account: "acct",
} as const;
export type IdKind = keyof typeof ID;

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export type SignalSource = "app_store_chart" | "app_store_search" | "social_trend" | "search_trend" | "manual" | "portfolio";

export interface Signal {
  id: string;
  source: SignalSource;
  title: string;
  detail: string;
  url?: string;
  /** Numeric facts, e.g. { rank: 12, ratings: 39000, priceCents: 699 }. */
  metrics: Record<string, number>;
  tags: string[];
  observedAt: Iso;
}

export const WedgeKind = z.enum(["interest_community", "life_event", "physical_community", "identity"]);

export const Wedge = z.object({
  name: z.string().describe("Narrow target audience, e.g. 'Gen Z astrology fans on TikTok'"),
  kind: WedgeKind,
  description: z.string(),
  minAge: z.number().int().describe("Youngest intended user (13 or more). Under 18 requires human approval."),
  maxAge: z.number().int(),
  locale: z.string().describe("BCP-47 locale of hooks and app copy, e.g. en-US"),
  creatorNiche: z.string().describe("Creator niche whose audience is this wedge, e.g. 'zodiac TikTok'"),
  estimatedReachableCreators: z.number().int().describe("Creators in the niche with mostly in-wedge audiences"),
  coPresence: z.number().describe("0..1 daily physical co-presence of members (school, gym, team)"),
  discoverable: z.number().describe("0..1 membership is discoverable/bounded (bio tags, rosters, hashtags)"),
  inflectionPoint: z.number().describe("0..1 members are at a life inflection point"),
  obsessive: z.number().describe("0..1 obsessive engagement (fandoms, hobbyists)"),
  urgency: z.number().describe("0..1 emotional stakes / communication urgency"),
  ownedReach: z.number().describe("0..1 reachable through a channel the studio controls or can buy"),
});
export type Wedge = z.infer<typeof Wedge>;

export const InteractionBudget = z.object({
  tapsToCoreAction: z.number().int(),
  secondsToFirstValue: z.number().describe("Seconds from first core-screen view to the aha moment"),
  typicalSessionSeconds: z.number(),
  requiresAudio: z.boolean(),
  requiresVoiceInput: z.boolean(),
  requiresSustainedAttention: z.boolean().describe("Live video, long-form creation, real-time co-presence"),
  oneHanded: z.boolean(),
  interruptible: z.boolean(),
});
export type InteractionBudget = z.infer<typeof InteractionBudget>;

export const Idea = z.object({
  title: z.string().describe("Working brand name, one or two words"),
  oneLiner: z.string(),
  coreNeed: CoreNeed,
  secondaryNeeds: z.array(CoreNeed),
  wedge: Wedge,
  verdictMoment: z.string().describe("The input-to-answer 'aha' that films well in under 3 seconds"),
  aiCapability: z.string().describe("What the AI actually does for the user"),
  valueConditions: z.array(z.string()).describe("Every condition that must be true for a user to get value"),
  singlePlayerValue: z.boolean().describe("A lone user gets full value with zero friends on the app"),
  minFriendsForValue: z.number().int(),
  requiresPartnership: z.boolean(),
  primaryChannel: ChannelKind,
  secondaryChannels: z.array(ChannelKind),
  shareArtifact: z.string().describe("The output users post elsewhere (card, score, video) that advertises the app"),
  hookExamples: z.array(z.string()).describe("At least 3 short-form video/slideshow hooks"),
  interaction: InteractionBudget,
  monetization: z.object({
    model: z.enum(["hard_paywall", "soft_paywall", "freemium", "consumable"]),
    payFor: z.string().describe("The exact thing users pay for"),
  }),
  sensitiveDomains: z.array(SensitiveDomain).describe("Domains needing extra compliance review"),
  differentiation: z.string().describe("Why this is meaningfully different from existing apps (Apple 4.3)"),
});
export type Idea = z.infer<typeof Idea>;

export interface IdeaRecord {
  id: string;
  idea: Idea;
  sourceSignalIds: string[];
  createdAt: Iso;
}

// ---------------------------------------------------------------------------
// Principles engine
// ---------------------------------------------------------------------------

export type PrincipleId =
  | "P1_reproducible_testing"
  | "P2_orchestrable_value"
  | "P3_narrow_wedge"
  | "P4_no_nationwide_tests"
  | "P5_replication"
  | "P6_conclusive_tests"
  | "P7_distribution_first"
  | "P8_activation_over_friction"
  | "P9_external_exposure"
  | "P10_toilet_test"
  | "P11_core_needs";

export type GateVerdict = "pass" | "warn" | "fail" | "needs_human";

export interface GateResult {
  /** A principle id, or a compliance gate id such as "compliance.minors". */
  gate: PrincipleId | `compliance.${string}`;
  verdict: GateVerdict;
  /** 0..1 contribution to the idea score. */
  score: number;
  reason: string;
}

/** One adversarial reviewer's verdict on an idea (LLM output). */
export const Critique = z.object({
  lens: z.enum(["bier_skeptic", "growth_realist", "store_and_policy"]),
  score: z.number().describe("0..10"),
  fatalFlaws: z.array(z.string()),
  risks: z.array(z.string()),
  fixes: z.array(z.string()),
  wouldFund: z.boolean(),
});
export type Critique = z.infer<typeof Critique>;

export interface Screening {
  id: string;
  ideaId: string;
  gates: GateResult[];
  critiques: Critique[];
  /** Effective sensitive domains: union of the ideator's labels and the independent classifier. */
  sensitiveDomains: SensitiveDomain[];
  /** Weighted 0..100 composite. */
  score: number;
  verdict: "advance" | "reject" | "needs_human";
  reasons: string[];
  screenedAt: Iso;
}

// ---------------------------------------------------------------------------
// Product spec (consumed by the app template)
// ---------------------------------------------------------------------------

export const OnboardingStepKind = z.enum([
  "welcome",
  "goal_picker",
  "single_choice",
  "multi_choice",
  "text_input",
  "date_input",
  "time_input",
  "place_input",
  "slider",
  "benefit", // product benefit statement; no numbers, ratings or testimonials
  "value_preview", // a taste of the verdict before any paywall (P8: never paywall before the aha)
  "ai_data_consent", // Apple 5.1.2(i): names the AI providers before any user data is sent
  "attribution_survey", // "where did you hear about us" (no-SDK attribution)
  "notification_preprompt",
  "loading_personalization",
  "result_teaser",
]);
export type OnboardingStepKind = z.infer<typeof OnboardingStepKind>;

export const OnboardingStep = z.object({
  id: z.string(),
  kind: OnboardingStepKind,
  title: z.string(),
  subtitle: z.string().nullable(),
  options: z.array(z.string()).describe("Choices for picker/choice/survey steps; empty otherwise"),
  storeAs: z.string().nullable().describe("Profile key the answer is saved under"),
});
export type OnboardingStep = z.infer<typeof OnboardingStep>;

export const PaywallConfig = z.object({
  placement: z.enum(["after_onboarding", "after_first_value", "on_limit"]),
  style: z.enum(["hard", "soft"]),
  pages: z.number().int().describe("1..4 paywall pages"),
  headline: z.string(),
  bullets: z.array(z.string()).describe("2..6 benefit bullets; no prices, numbers or claims"),
  /** Ids from config.monetization.ladder; price/period/trial are looked up, never written by an LLM. */
  productIds: z.array(z.string()).describe("1..4 price-ladder ids, e.g. 'week_699_t3'"),
  highlightedProductId: z.string(),
  showCloseAfterSeconds: z.number().int().nullable().describe("0..3, or null (hard paywall only)"),
});
export type PaywallConfig = z.infer<typeof PaywallConfig>;

export const DataUse = z.object({
  dataType: z.enum(["photo", "screenshot", "text", "birth_data", "audio", "contacts", "device_id", "usage", "purchase"]),
  purpose: z.enum(["core_feature", "analytics", "attribution"]),
  sentTo: z.array(z.enum(["anthropic", "posthog", "revenuecat", "studio_backend"])),
  retentionDays: z.number().int(),
  linkedToUser: z.boolean(),
  usedForTracking: z.boolean(),
});
export type DataUse = z.infer<typeof DataUse>;

export const AppSpec = z.object({
  appName: z.string(),
  nameCandidates: z.array(z.string()).describe("At least 3 fallback names in case the store name is taken"),
  subtitle: z.string().describe("At most 30 characters"),
  slug: z.string().describe("lowercase a-z0-9 and dashes"),
  category: z.string().describe("App Store primary category"),
  locale: z.string(),
  brand: z.object({
    primaryColor: z.string(),
    accentColor: z.string(),
    backgroundColor: z.string(),
    textColor: z.string(),
    voice: z.string().describe("Tone of voice for all copy"),
    iconPrompt: z.string(),
  }),
  onboarding: z.array(OnboardingStep).describe("8..16 steps"),
  core: z.object({
    inputKind: z.enum(["photo", "screenshot", "text", "date_time_place", "audio_file", "choices", "none"]),
    inputLabel: z.string(),
    /** Product prompt only; the build prepends a fixed safety preamble from the playbook. */
    aiSystemPrompt: z.string(),
    outputSections: z.array(z.string()),
    loadingMessages: z.array(z.string()),
    freeUsesBeforePaywall: z.number().int(),
  }),
  paywall: PaywallConfig,
  share: z.object({
    artifact: z.string(),
    cardHeadline: z.string(),
    caption: z.string(),
    deepLinkPath: z.string(),
    watermark: z.string(),
  }),
  invite: z
    .object({
      method: z.enum(["system_share_sheet", "contact_access_picker"]),
      prefilledMessage: z.string().describe("At most 160 characters; always sent by the user's own device"),
    })
    .nullable(),
  retention: z.object({
    pushSchedule: z.array(
      z.object({
        dayOffset: z.number().int(),
        hourLocal: z.number().int(),
        kind: z.enum(["transactional", "promotional"]),
        copy: z.string(),
      }),
    ),
    dailyHook: z.string().describe("Why a user opens the app again tomorrow"),
    widget: z.string().nullable(),
  }),
  aso: z.object({
    keywords: z.array(z.string()).describe("Comma-joined at most 100 characters"),
    description: z.string(),
    promotionalText: z.string().describe("At most 170 characters"),
    screenshotCaptions: z.array(z.string()).describe("3..10 captions"),
  }),
  compliance: z.object({
    aiDisclosure: z.string(),
    dataInventory: z.array(DataUse),
    minimumAge: z.enum(["13", "16", "18"]),
  }),
});
export type AppSpec = z.infer<typeof AppSpec>;

// ---------------------------------------------------------------------------
// Accounts, entities and human tasks
// ---------------------------------------------------------------------------

/** One studio entity by default. Extra entities only for spin-outs, created by humans. */
export interface LegalEntity {
  id: string;
  legalName: string;
  jurisdiction: string;
  purpose: "studio" | "spinout";
  dsaTrader?: { verified: boolean; publicEmail: string; publicPhone: string; address: string };
}

/** A store developer account (organization). Registered by a human, never created by the system. */
export interface PublisherAccount {
  id: string;
  entityId: string;
  platform: StorePlatform;
  externalTeamId: string;
  kind: "organization";
  status: "active" | "warning" | "suspended" | "terminated";
  /** Environment variable names holding credentials (never the secrets themselves). */
  secretRefs: Record<string, string>;
}

/** A disclosed brand social account, connected by a human with standing consent. */
export interface OwnedAccount {
  id: string;
  ventureId: string;
  platform: Platform;
  handle: string;
  externalId?: string;
  publishMode: "business_api" | "draft_for_human" | "api_direct";
  bioDisclosesBrand: boolean;
  standingConsent: { scopes: string[]; grantedAt: Iso; expiresAt: Iso; grantedBy: string };
  tokenSecretRef?: string;
  status: "active" | "restricted" | "disabled";
}

export type HumanTaskKind =
  | "apple.create_app"
  | "apple.privacy_labels"
  | "apple.paid_apps_agreement"
  | "play.create_app"
  | "play.content_rating"
  | "play.data_safety_review"
  | "play.production_access"
  | "social.connect_account"
  | "tiktok.audit"
  | "tiktok.verify_domain"
  | "meta.business_verification"
  | "ads.billing_setup"
  | "creators.fund_wallet"
  | "web.deploy_site"
  | "backend.deploy"
  | "legal.review"
  /** A store console step an adapter reported it cannot do by API (e.g. a subscription's review screenshot). */
  | "store.manual_step"
  /** Per-venture analytics, subscription and build projects (PostHog, RevenueCat, EAS) the adapters write into. */
  | "integrations.bind_projects"
  /** Deploy the venture's tenant file (composed system prompt) and RevenueCat secret to the verdict backend. */
  | "backend.add_tenant"
  /** App Store metadata no API covers well: age rating questionnaire, category, copyright, content rights, price. */
  | "apple.app_info"
  /** Post an owned-account draft (TikTok inbox) by hand, applying the exact disclosure labels listed. */
  | "social.finish_draft"
  /** A creator payout the marketplace refused after retries (usually the creator's payout setup). */
  | "creators.payout_failed"
  /** A creator payout whose call failed after it may have reached the marketplace: was it sent? */
  | "creators.verify_payout"
  /** A creator post the marketplace reported without a URL: a human finds it so it can be verified. */
  | "creators.verify_post";

export interface HumanTask {
  id: string;
  kind: HumanTaskKind;
  ventureId?: string;
  title: string;
  /** Markdown with links to the exact console page. */
  instructions: string;
  inputs: { key: string; label: string; pattern?: string }[];
  outputs?: Record<string, string>;
  blocksActionIds: string[];
  status: "open" | "done" | "cancelled";
  createdAt: Iso;
  completedAt?: Iso;
  completedBy?: string;
}

export type HumanTaskDraft = Omit<HumanTask, "id" | "status" | "createdAt" | "blocksActionIds">;

// ---------------------------------------------------------------------------
// Ventures
// ---------------------------------------------------------------------------

export type VentureStage =
  | "screened" // passed idea gates; waiting for a build slot
  | "building" // spec, render, brand, store setup (an optional S0 attention probe runs alongside)
  | "in_review" // store review
  | "live_test" // validation ladder in test storefronts
  | "iterating" // a variant failed; preparing the next one
  | "scaling" // passed + replicated; allocator funds lanes
  | "harvest" // mature: price optimization, decay management
  | "sunsetting" // winding down; serving paid users until their periods lapse
  | "killed"
  | "exited";

export const ValidationStage = z.enum([
  "S0_attention", // optional pre-launch probe on owned trial reels; can only kill
  "S1_distribution", // creator batch: in-geo installs per 1K views
  "S1_activation", // installs that reach the pre-paywall value preview / first verdict
  "S2_sharing", // social apps: users who export the artifact
  "S3_cross_cell", // social apps: invite-driven installs per activated user (K)
  "S4_monetization", // trial start, trial keep, predicted unit economics
]);
export type ValidationStage = z.infer<typeof ValidationStage>;

export type LadderKind = "single_player" | "social";

export interface StageTransition {
  from: VentureStage | null;
  to: VentureStage;
  at: Iso;
  reason: string;
}

export type BakedBinding = "webBaseUrl" | "deepLinkDomain" | "easProjectId" | "ascAppId" | "backendUrl";

export interface BuildRecord {
  projectDir: string;
  version: string;
  buildNumber: number;
  specVersion: number;
  /** Bindings the render baked into the app (site, deep links, build project, app record); a change re-renders. */
  baked?: Partial<Record<BakedBinding, string>>;
  checks: { name: string; passed: boolean; detail: string }[];
  builtAt: Iso;
  easBuildId?: string;
  artifactUrl?: string;
}

export type StoreStatus =
  | "not_created"
  | "draft"
  | "build_processing"
  | "ready_to_submit"
  | "waiting_for_review"
  | "in_review"
  | "rejected"
  | "metadata_rejected"
  | "pending_release"
  | "live"
  | "removed";

export interface StoreRecord {
  platform: StorePlatform;
  publisherAccountId: string;
  bundleId: string;
  appId?: string;
  status: StoreStatus;
  versionString?: string;
  storeBuildId?: string;
  reviewSubmissionId?: string;
  territories: string[];
  rejectionReasons: string[];
  updatedAt: Iso;
}

export interface StoreProduct {
  /** `${bundleId}.${ladderId}`; never reused even after deletion (App Store rule). */
  productId: string;
  ladderId: string;
  platform: StorePlatform;
  status: "planned" | "created" | "in_review" | "approved" | "rejected";
}

/** Everything that maps a venture to its external identities. */
export interface VentureBindings {
  platforms: StorePlatform[];
  publisherAccountIds: Partial<Record<StorePlatform, string>>;
  bundleId: string;
  androidPackage: string;
  ascAppId?: string;
  appStoreUrl?: string;
  playUrl?: string;
  easProjectId?: string;
  revenueCatProjectId?: string;
  revenueCatAppIds?: Partial<Record<StorePlatform, string>>;
  posthogProjectId?: string;
  webBaseUrl?: string;
  privacyUrl?: string;
  termsUrl?: string;
  supportUrl?: string;
  deepLinkDomain?: string;
  backendUrl?: string;
  ownedAccountIds: Partial<Record<Platform, string>>;
  adAccountIds: Partial<Record<AdNetwork, string>>;
  metaAppId?: string;
  products: StoreProduct[];
}

export interface VentureLadder {
  kind: LadderKind;
  /** Steps in order; each step is validated by one experiment covering its stages. */
  steps: ValidationStage[][];
  stepIndex: number;
  validated: ValidationStage[];
  currentExperimentId: string | null;
  experimentIds: string[];
  /** Failed variants on the current step. */
  iteration: number;
  /** Harness repairs on the current step; past the cap the venture escalates to a human. */
  harnessFixes: number;
  stepStartedAt: Iso | null;
}

export interface VentureBaseline {
  specVersion: number;
  hookIds: string[];
  paywallVariantId: string | null;
  onboardingVariantId: string | null;
}

export interface Venture {
  id: string;
  ideaId: string;
  screeningId: string;
  name: string;
  slug: string;
  wedge: string;
  stage: VentureStage;
  ladder: VentureLadder;
  spec?: AppSpec;
  specVersion: number;
  specHistory: { version: number; spec: AppSpec; changedBy: string; reason: string; at: Iso }[];
  baseline: VentureBaseline;
  build?: BuildRecord;
  stores: StoreRecord[];
  bindings: VentureBindings;
  /** The next variable to test after a failed variant, held until its delivery completes. */
  pendingVariant?: {
    variableUnderTest: string;
    variant: Record<string, string | number | boolean>;
    hypothesis: string;
    deliveryMode: DeliveryMode;
    parentExperimentId: string;
    /** Storefronts to reuse (harness re-runs); otherwise fresh ones are picked. */
    geos?: string[];
    /** Set once the variant is live (remote config executed, build live, hooks created). */
    readyAt?: Iso;
  };
  /** The allocator's current daily growth budget while scaling (persisted so plans survive restarts). */
  budget?: { dailyCents: Cents; changedAt: Iso };
  /** Human task ids this venture is waiting on; blocked time does not count against the time box. */
  blockedOn: string[];
  blockedMs: number;
  timeboxStartedAt: Iso | null;
  endedReason?: string;
  history: StageTransition[];
  createdAt: Iso;
  updatedAt: Iso;
}

// ---------------------------------------------------------------------------
// Lab: pre-registered experiments
// ---------------------------------------------------------------------------

export type MetricKey =
  | "attentionHitRate" // S0: owned posts reaching config.lab.attentionHitViews
  | "installsPer1kViews" // S1_distribution: in-geo installs per view (unit: post)
  | "activationRate" // S1_activation: installs reaching the value preview
  | "trialStartRate" // S4: installs starting a trial or buying
  | "trialKeep24h" // S4: trials still auto-renewing 24h after start (leading proxy)
  | "trialToPaid" // scaling tripwire: matured trials converting
  | "shareRate" // S2: activated users who exported the artifact (unique)
  | "kFactor" // S3: invite installs per activated user (rate, can exceed 1)
  | "d1Retention"; // informational

export type MetricKind = "proportion" | "rate";

export interface Threshold {
  /** Minimum acceptable true value: pass iff P(p >= floor) >= confidence. */
  floor: number;
  /** Design alternative used for the power calculation. */
  target: number;
  /** Early-stop level: stop as futile once P(p < futility) >= confidence. */
  futility: number;
}

export interface MetricSpec extends Threshold {
  key: MetricKey;
  label: string;
  kind: MetricKind;
  /** proportion: unique-user numerator that is a subset of the denominator. */
  numerator: EventName;
  /** proportion: trials. rate: exposure units (e.g. activated users). */
  denominator: EventName;
  /** Sampling unit; "post" metrics are clustered by content source. */
  unit: "user" | "post";
  /** Only denominator units at least this old count (cohort maturity). */
  maturityHours: number;
  /** Numerator must occur within this many hours of the denominator event. */
  windowHours?: number;
  role: "required" | "futility_only" | "informational";
  /** Report-only multiplier, e.g. 1000 for per-1K display. Thresholds stay in raw units. */
  displayScale?: number;
}

export type ValidityCheckId =
  | "min_sample"
  | "exposure_delivered"
  | "instrumentation"
  | "cold_traffic"
  | "source_concentration"
  | "budget_not_exceeded"
  | "audience_disjoint"
  | "support_coverage";

export interface ValidityRequirement {
  id: ValidityCheckId;
  description: string;
  threshold?: number;
}

export type CellAssignment = "geo" | "user_random";
export type CellAttribution = "storefront_geo" | "in_app_flag" | "promo_code" | "campaign_link";

export interface TestCell {
  /** Globally unique cell_ id; also the in-app flag variant id for user_random cells. */
  id: string;
  /** Sequential mode: phase 2 cells are pre-registered and activated after a phase 1 pass. */
  phase: 1 | 2;
  role: "primary" | "replication";
  platform: Platform | "app";
  channel: ChannelKind;
  geo: string;
  locale: string;
  assignment: CellAssignment;
  attribution: CellAttribution;
  /** creatorIds, accountIds or adSetIds; disjoint across cells and live experiments. */
  audienceUnits: string[];
  /** Must contain exactly the plan's variableUnderTest key; identical across cells. */
  variant: Record<string, string | number | boolean>;
  trafficPct?: number;
  budgetCents: Cents;
  firstExposureAt?: Iso;
}

export type ExperimentStatus = "registered" | "running" | "decided" | "aborted";

export type DeliveryMode = "content_only" | "remote_config" | "ota_update" | "store_metadata" | "native_build";

export interface ExperimentPlan {
  id: string;
  ventureId: string;
  stages: ValidationStage[];
  hypothesis: string;
  variableUnderTest: string;
  baseline: VentureBaseline;
  metrics: MetricSpec[];
  cells: TestCell[];
  mode: "parallel" | "sequential";
  /** Denominator units each cell needs, per metric, from the power calculation. */
  minSamplePerCell: Partial<Record<MetricKey, number>>;
  operatingCharacteristics: { powerAtTarget: number; falsePassAtFloor: number };
  /** Read deadline = firstExposureAt + readHours (+ the metric's maturity). */
  readHours: number;
  maxHoursToFirstExposure: number;
  maxBudgetCents: Cents;
  expectedCostPerUnitCents: number;
  validity: ValidityRequirement[];
  deliveryMode: DeliveryMode;
  startNotBefore: Iso;
  parentExperimentId?: string;
  /** sha256 of the canonical plan; frozen once running (P1). */
  registrationHash: string;
  status: ExperimentStatus;
  registeredAt: Iso;
  startedAt?: Iso;
  decidedAt?: Iso;
}

export interface MetricCounts {
  successes: number;
  trials: number;
  /** Per traffic source (creator post, account, ad set): used for clustering corrections. */
  bySource: Record<string, { successes: number; trials: number }>;
}

/** Cumulative, maturity-filtered snapshot for one cell. */
export interface CellObservation {
  cellId: string;
  metrics: Partial<Record<MetricKey, MetricCounts>>;
  exposureViews: number;
  spendCents: Cents;
  /** Share of sessions from internal/test devices. */
  internalShare: number;
  observedAt: Iso;
}

export type CellDecision = "pending" | "pass" | "fail" | "futile" | "invalid";

export interface MetricVerdict {
  decision: CellDecision;
  estimate: number;
  /** Central credible interval of mass 2*confidence-1. */
  interval: [number, number];
  pAtLeastFloor: number;
  nEffective: number;
}

export interface CellVerdict {
  cellId: string;
  decision: CellDecision;
  perMetric: Partial<Record<MetricKey, MetricVerdict>>;
  validity: { id: ValidityCheckId; passed: boolean; detail: string }[];
}

export type ExperimentDecision = "continue" | "pass" | "replicate" | "iterate" | "kill" | "fix_harness" | "escalate";

export interface ExperimentOutcome {
  experimentId: string;
  decision: ExperimentDecision;
  cells: CellVerdict[];
  rationale: string;
  diagnostics?: { id: ValidityCheckId; detail: string }[];
  /** Cells to re-run on fix_harness. */
  rerunCellIds?: string[];
  unitEconomics?: { predNetRpiD60P20Cents: Cents; cacCents: Cents; roasD60P20: number };
  decidedAt: Iso;
}

// ---------------------------------------------------------------------------
// Creative loop (always-on, separate from the validation ladder)
// ---------------------------------------------------------------------------

export interface Hook {
  id: string;
  ventureId: string;
  formatId: string;
  text: string;
  angle: string;
  parentHookId?: string;
  source: "idea" | "variant" | "generated" | "winner";
  status: "exploring" | "active" | "culled";
  createdAt: Iso;
}

export interface CreativeArmResult {
  posts: number;
  views: number;
  attributedInstalls: number;
  attributedTrials: number;
  spendCents: Cents;
}

export interface CreativeBatch {
  id: string;
  ventureId: string;
  family: "creator" | "owned";
  startedAt: Iso;
  closesAt: Iso;
  /** `${formatId}:${hookId}` */
  arms: string[];
  allocation: Record<string, number>;
  results: Record<string, CreativeArmResult>;
  culled: string[];
  status: "open" | "closed";
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

export const Slide = z.object({
  text: z.string().describe("At most 140 characters"),
  imagePrompt: z.string(),
  isAppReveal: z.boolean(),
});

export const ContentDraft = z.object({
  formatId: z.string(),
  platform: Platform,
  voice: z.enum(["brand_third_person", "product_demo", "creator_first_person"]),
  hook: z.string().describe("First 1-2 seconds / first slide text"),
  angle: z.string(),
  script: z.string().describe("Voiceover or on-screen narrative; empty for silent slideshows"),
  slides: z.array(Slide).describe("For slideshow formats; empty otherwise"),
  caption: z.string(),
  hashtags: z.array(z.string()),
  callToAction: z.string(),
});
export type ContentDraft = z.infer<typeof ContentDraft>;

export interface MediaRef {
  localPath: string;
  publicUrl?: string;
  sha256: string;
  mediaType: string;
  aiGenerated: boolean;
  /** Provenance metadata preserved from the generator (never stripped). */
  c2pa: boolean;
}

/** Computed by governance/disclosure.ts only. Never written by an LLM. */
export interface Disclosure {
  aiGenerated: boolean;
  aiRealism: "none" | "stylized" | "photorealistic_person" | "photorealistic_scene" | "synthetic_voice";
  commercial: "own_brand" | "paid_partnership";
  derivedAt: Iso;
}

export interface PostStats {
  asOf: Iso;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  profileVisits: number | null;
  linkClicks: number | null;
  /** Share of viewers by country, when the platform reports it. */
  audienceGeo?: Record<string, number>;
}

export interface ContentPiece {
  id: string;
  ventureId: string;
  hookId?: string;
  formatId: string;
  draft: ContentDraft;
  media: MediaRef[];
  channel: ChannelKind;
  platform: Platform;
  accountId?: string;
  creatorId?: string;
  disclosure?: Disclosure;
  /** formatId + normalized hook hash; caps near-duplicates per account. */
  similarityKey: string;
  status: "draft" | "approved" | "scheduled" | "pending_human" | "posted" | "rejected";
  externalId?: string;
  url?: string;
  postedAt?: Iso;
  stats?: PostStats;
  experimentId?: string;
  cellId?: string;
  batchId?: string;
  economics?: {
    attributedInstalls: number;
    predNetRpmD60Cents: Cents;
    effectiveCpmCents: Cents;
    provenAt?: Iso;
    fatiguedAt?: Iso;
  };
}

// ---------------------------------------------------------------------------
// Creators
// ---------------------------------------------------------------------------

export const CreatorBrief = z.object({
  title: z.string(),
  productSummary: z.string(),
  audience: z.string(),
  formats: z.array(z.string()),
  hooks: z.array(z.string()),
  mustInclude: z.array(z.string()).describe("e.g. app shown within first 15s, on-screen app name, 'subscription required'"),
  mustAvoid: z.array(z.string()).describe("Claims and content that are not allowed"),
  deliverables: z.string(),
});
export type CreatorBrief = z.infer<typeof CreatorBrief>;

export interface Creator {
  id: string;
  platform: Platform;
  handle: string;
  externalIds: Record<string, string>;
  niche: string;
  followers: number;
  medianViews30d: number;
  audienceGeo: Record<string, number>;
  audienceUnder18Share: number | null;
  source: "sideshift" | "whop" | "outreach" | "inbound" | "sim";
  status: "prospect" | "contacted" | "negotiating" | "active" | "paused" | "dropped";
  promoCode?: string;
  campaignToken?: string;
  stats: { posts: number; views: number; attributedInstalls: number; attributedTrials: number; paidCents: Cents; lastPostedAt?: Iso };
  firstPaidAt?: Iso;
}

export interface CreatorDeal {
  id: string;
  creatorId: string;
  ventureId: string;
  kind: "per_video" | "cpm" | "retainer" | "guarantee";
  flatFeeCents: Cents;
  cpmCents: Cents;
  monthlyRetainerCents: Cents;
  postsPerMonth: number;
  guaranteedViews: number;
  upfrontPct: number;
  prorateShortfall: boolean;
  maxPayoutCents: Cents;
  /** CPM payouts use views at postedAt + viewLockDays, so payouts are deterministic. */
  viewLockDays: number;
  usageRightsDays: number;
  sparkAuthorization: boolean;
  status: "offered" | "active" | "ended" | "declined";
  startsAt: Iso;
  endsAt: Iso;
}

export interface CreatorCampaign {
  id: string;
  ventureId: string;
  externalId?: string;
  brief: CreatorBrief;
  platforms: Platform[];
  /** Must be within the cell geo (P4). */
  targetCountries: string[];
  creatorAudienceCountryMinPct: number;
  /** 18+ apps: the most of a creator's audience that may be under 18 (0..1); unset for all-ages apps. */
  creatorAudienceUnder18MaxPct?: number;
  flatFeeCents: Cents;
  cpmCents: Cents;
  maxPayoutPerVideoCents: Cents;
  payoutMaturityDays: number;
  budgetCents: Cents;
  status: "draft" | "open" | "paused" | "closed";
  experimentId?: string;
  cellId?: string;
  batchId?: string;
  createdAt: Iso;
}

/** Facts fetched by code from the platform of record, never parsed from creator text. */
export interface SubmissionVerification {
  fetchedAt: Iso;
  postIsPublic: boolean;
  authorHandleMatches: boolean;
  platformDisclosureLabel: boolean;
  viewsFromPlatform: number;
  postedAt?: Iso;
  audienceGeo?: Record<string, number>;
}

/** What a marketplace returns. Our own review state lives on CreatorSubmission. */
export interface ExternalSubmission {
  externalId: string;
  campaignExternalId: string;
  creatorExternalId: string;
  creatorHandle: string;
  platform: Platform;
  postUrl?: string;
  /** Untrusted: text supplied by an external creator. */
  untrustedCaption: string;
  /** Untrusted: the caption or title on the live post, when the marketplace reports it. */
  untrustedPostCaption?: string;
  stage: "draft_submitted" | "posted";
  submittedAt: Iso;
  /** When the post went live, when the marketplace reports it. */
  postedAt?: Iso;
  /** The post's current platform view count, when the marketplace reports it. */
  views?: number;
  /** The creator's audience as the marketplace reports it (needed to clear posts for 18+ apps). */
  creatorAudience?: { geo: Record<string, number>; under18Share: number | null; followers: number; medianViews30d: number };
}

export interface CreatorSubmission {
  id: string;
  externalId: string;
  campaignId: string;
  creatorId: string;
  creatorHandle: string;
  platform: Platform;
  postUrl?: string;
  untrustedCaption: string;
  stage: "draft_submitted" | "draft_approved" | "posted" | "post_approved" | "paid" | "rejected";
  hookId?: string;
  formatId?: string;
  verification?: SubmissionVerification;
  review?: { approve: boolean; injectionAttempt: boolean; policyIssues: string[]; note: string };
  viewsAtLock?: number;
  lockedAt?: Iso;
  payoutCents: Cents;
  postedAt?: Iso;
  submittedAt: Iso;
}

export interface Payout {
  id: string;
  submissionId: string;
  amountCents: Cents;
  idempotencyKey: string;
  externalId?: string;
  basis: { views: number; viewsAsOf: Iso; flatFeeCents: Cents; cpmCents: Cents; capCents: Cents };
  at: Iso;
}

// ---------------------------------------------------------------------------
// Paid acquisition
// ---------------------------------------------------------------------------

export type AdCreativeRef =
  | { kind: "spark_code"; contentId: string; code: string; expiresAt: Iso }
  | { kind: "ig_partnership"; contentId: string; mediaId: string; creatorIgUserId: string }
  | { kind: "owned_post"; contentId: string; platform: Platform; externalId: string }
  | { kind: "uploaded_video"; contentId: string; publicUrl: string; aiGenerated: boolean };

export interface AdCampaign {
  id: string;
  ventureId: string;
  network: AdNetwork;
  externalId?: string;
  actionId: string;
  type: "creative" | "search";
  os: StorePlatform;
  dailyBudgetCents: Cents;
  startAt: Iso;
  /** Required: open-ended budgets are not allowed. */
  endAt: Iso;
  geos: string[];
  creatives: AdCreativeRef[];
  keywords: { text: string; match: "exact" | "broad"; bidCents: Cents }[];
  experimentId?: string;
  cellId?: string;
  lane?: string;
  status: "pending" | "active" | "paused" | "ended";
  createdAt: Iso;
}

export interface AdDailyStats {
  date: string;
  spendCents: Cents;
  impressions: number;
  taps: number;
  installs: number;
  conversions: number | null;
  revenueCents: Cents | null;
  /** False while the network's attribution window is still open. */
  attributionComplete: boolean;
}

// ---------------------------------------------------------------------------
// Metrics and economics
// ---------------------------------------------------------------------------

/** One venture-day (cellId null) or one cell-day. Assembled only by orchestrator/metrics.ts. */
export interface DailyMetrics {
  ventureId: string;
  date: string; // YYYY-MM-DD
  cellId: string | null;
  geo: string | null;
  counts: Partial<Record<EventName, number>>;
  grossRevenueCents: Cents;
  /** After store fee and VAT. */
  proceedsCents: Cents;
  refundsCents: Cents;
  activeSubscribers: number;
  /** Informational only: spend is booked from the ledger, never from here. */
  reportedSpendCents: Cents;
  complete: boolean;
}

/** Cumulative outcomes of one install cohort at a given age. Economic decisions read only these. */
export interface CohortMetrics {
  ventureId: string;
  cohortDate: string;
  ageDays: number;
  platform: StorePlatform;
  geo: string;
  channel: ChannelKind;
  /** Lane key: `${ventureId}|${channel}|${geo}|${sourceId}`. */
  lane: string;
  experimentId?: string;
  cellId?: string;
  installs: number;
  spendCents: Cents;
  trialStarts: number;
  trialCancels: number;
  conversions: number;
  renewals: number;
  activeSubscribers: number;
  grossRevenueCents: Cents;
  proceedsCents: Cents;
  refundsCents: Cents;
}

export interface UnitEconomics {
  ventureId: string;
  lane: string;
  asOf: Iso;
  installs: number;
  spendCents: Cents;
  cacCents: Cents;
  predNetRpiCents: { d7: Cents; d30: Cents; d60: Cents; d180: Cents };
  predInterval80D60: [Cents, Cents];
  paybackDaysPred: number | null;
  modelVersion: string;
}

export interface VentureEconomics {
  ventureId: string;
  asOf: Iso;
  ttmProceedsCents: Cents;
  ttmContributionCents: Cents;
  organicInstallsHalfLifeDays: number | null;
  peakWeeklyProceedsCents: Cents;
  weeklyProceedsVsPeak: number;
  holdNpvCents: Cents;
  saleEstimateCents: Cents;
}

export interface AllocationPlan {
  date: string;
  freeCashCents: Cents;
  projectedTroughCents: Cents;
  testBudgetCents: Cents;
  lanes: {
    lane: string;
    ventureId: string;
    currentDailyCents: Cents;
    proposedDailyCents: Cents;
    marginalCacCents: Cents;
    predNetRpiD60P20Cents: Cents;
    marginalRoasD60: number;
    paybackDaysPred: number | null;
    reason: string;
  }[];
}

/** A claim the product may make (user counts, ratings, rankings). Pre-launch: none exist. */
export interface Claim {
  id: string;
  ventureId: string | "studio";
  kind: "user_count" | "rating" | "ranking" | "efficacy" | "press" | "price_comparison";
  text: string;
  evidence: { source: "metrics" | "store" | "study" | "press_url"; value: number | string; asOf: Iso; url?: string };
  expiresAt: Iso;
  approvedBy?: string;
}

// ---------------------------------------------------------------------------
// Governance: every external side effect is an Action
// ---------------------------------------------------------------------------

export const ActionKind = z.enum([
  "store.register_bundle",
  "store.create_app",
  "store.upsert_subscriptions",
  "store.start_build",
  "store.submit_build",
  "store.update_listing",
  "store.set_territories",
  "store.submit_review",
  "store.release",
  "store.remove_from_sale",
  "monetization.configure",
  "remote_config.set",
  "web.publish_site",
  "web.put_asset",
  "content.publish",
  "creator.campaign_create",
  "creator.campaign_close",
  "creator.outreach",
  "creator.deal_offer",
  "creator.review_draft",
  "creator.review_post",
  "creator.payout",
  "ads.campaign_create",
  "ads.budget_change",
  "ads.pause",
  "venture.scale",
  "venture.kill",
  "venture.sunset",
  "venture.exit_flag",
  "support.reply",
]);
export type ActionKind = z.infer<typeof ActionKind>;

export type ActionStatus =
  | "proposed"
  | "blocked"
  | "awaiting_approval"
  | "awaiting_human_task"
  | "approved"
  | "executing"
  | "executed"
  | "dry_run"
  | "failed"
  | "rejected"
  | "cancelled";

export type ProposedBy = AgentRole | "orchestrator" | "allocator" | "lab" | "human";

export interface PolicyFinding {
  ruleId: string;
  severity: "info" | "warn" | "block" | "needs_human";
  message: string;
  citation?: string;
}

/** A human sign-off bound to the exact payload it approved. */
export interface Approval {
  approver: string;
  payloadHash: string;
  at: Iso;
  channel: "cli" | "web";
  note?: string;
  /** needs_human rule ids the approver was shown; absent (older approvals) covers every rule. */
  coveredRuleIds?: string[];
}

export interface Commitment {
  kind: "one_time" | "daily" | "lifetime_cap" | "settles_liability";
  amountCents: Cents;
  maxTotalCents: Cents;
  startsAt: Iso;
  endsAt?: Iso;
  liabilityRef?: string;
}

export interface PlatformLabels {
  tiktok?: { is_aigc: boolean; brand_content_toggle: boolean; brand_organic_toggle: boolean };
  instagram?: { is_ai_generated: boolean; is_paid_partnership: boolean };
  youtube?: { containsSyntheticMedia: boolean; selfDeclaredMadeForKids: false; hasPaidProductPlacement: boolean };
  other?: { aiLabelInCaption: boolean; adLabelInCaption: boolean };
}

export type SubmissionChangeArea = "new_app" | "core" | "monetization" | "age_rating" | "data_flows" | "copy" | "other";

export interface StoreProductDef {
  productId: string;
  ladderId: string;
  period: "week" | "month" | "year";
  usdCents: Cents;
  trialDays: number;
  displayName: string;
  territories: string[];
}

export interface StoreListing {
  locale: string;
  name: string;
  subtitle: string;
  description: string;
  keywords: string;
  promotionalText: string;
  supportUrl: string;
  privacyUrl: string;
  marketingUrl?: string;
}

/** Typed payload per action kind. */
/**
 * Why a kill or sunset was proposed. Time-box and spend-cap stops are withdrawn if the venture
 * validates before the board decides; the others stand.
 */
export type StopCause = "evidence" | "timebox" | "spend_cap" | "scale_declined" | "app_review" | "human";

export interface ActionPayloads {
  "store.register_bundle": { platform: StorePlatform; bundleId: string; capabilities: ("push" | "associated_domains" | "sign_in_with_apple")[] };
  "store.create_app": { platform: StorePlatform; bundleId: string; name: string; sku: string; primaryLocale: string };
  "store.upsert_subscriptions": { platform: StorePlatform; groupName: string; products: StoreProductDef[] };
  "store.start_build": { platform: StorePlatform; projectDir: string; specVersion: number };
  "store.submit_build": { platform: StorePlatform; easBuildId: string };
  "store.update_listing": { platform: StorePlatform; listing: StoreListing; screenshotPaths: string[] };
  "store.set_territories": { platform: StorePlatform; territories: string[] };
  "store.submit_review": {
    platform: StorePlatform;
    storeBuildId: string;
    notesForReviewer: string;
    /** What changed since the last approved submission (Apple 2.5.19: core/monetization/age/data changes need a human). */
    changedAreas?: SubmissionChangeArea[];
    /** Automated differentiation evidence against store competitors and our own portfolio (Apple 4.3). */
    differentiationReport?: string;
  };
  "store.release": { platform: StorePlatform; phased: boolean };
  "store.remove_from_sale": { platform: StorePlatform; reason: string };
  "monetization.configure": { productIds: string[]; entitlementId: string };
  "remote_config.set": { key: "paywall" | "onboarding" | "share" | "core"; variants: { id: string; rolloutPct: number; payload: unknown }[]; experimentId?: string };
  "web.publish_site": { files: { path: string; localPath: string }[] };
  "web.put_asset": { localPath: string; contentType: string };
  "content.publish": { contentId: string; accountId: string; platform: Platform; mode: "direct" | "inbox_draft" | "trial_reel"; labels: PlatformLabels; mediaSha256: string[] };
  "creator.campaign_create": { campaignId: string };
  "creator.campaign_close": { campaignId: string };
  "creator.outreach": { creatorId: string; message: string };
  "creator.deal_offer": { dealId: string };
  "creator.review_draft": { submissionId: string; approve: boolean; note: string };
  "creator.review_post": { submissionId: string; approve: boolean; note: string };
  "creator.payout": { submissionId: string; amountCents: Cents; basis: Payout["basis"] };
  "ads.campaign_create": { adCampaignId: string };
  "ads.budget_change": { adCampaignId: string; fromDailyCents: Cents; toDailyCents: Cents; evidence: string };
  "ads.pause": { adCampaignId: string; reason: string };
  "venture.scale": { evidence: string; experimentIds: string[]; proposedDailyCents: Cents; addTerritories: string[] };
  "venture.kill": { reason: string; cause?: StopCause };
  "venture.sunset": { activeSubscribers: number; plan: "serve_until_lapse" | "stop_renewals_and_notify"; reason: string; cause?: StopCause };
  "venture.exit_flag": { holdNpvCents: Cents; saleEstimateCents: Cents; rationale: string };
  "support.reply": { ticketId: string; reply: string; aiDisclosed: boolean };
}

export interface ActionResults {
  "store.register_bundle": { bundleIdResourceId: string };
  "store.create_app": { appId: string };
  "store.upsert_subscriptions": { jobId: string };
  "store.start_build": { jobId: string };
  "store.submit_build": { jobId: string };
  "store.update_listing": { jobId: string };
  "store.set_territories": { territories: string[] };
  "store.submit_review": { jobId: string };
  "store.release": { released: boolean };
  "store.remove_from_sale": { removed: boolean };
  "monetization.configure": { offeringIds: Record<string, string> };
  "remote_config.set": { flagKey: string };
  "web.publish_site": { baseUrl: string };
  "web.put_asset": { publicUrl: string; sha256: string };
  "content.publish": { jobId: string };
  "creator.campaign_create": { externalId: string };
  "creator.campaign_close": { closed: boolean };
  "creator.outreach": { sent: boolean };
  "creator.deal_offer": { externalId: string };
  "creator.review_draft": { recorded: boolean };
  "creator.review_post": { recorded: boolean };
  "creator.payout": { payoutId: string };
  "ads.campaign_create": { externalId: string };
  "ads.budget_change": { dailyBudgetCents: Cents };
  "ads.pause": { paused: boolean };
  "venture.scale": { approved: boolean };
  "venture.kill": { killed: boolean };
  "venture.sunset": { started: boolean };
  "venture.exit_flag": { flagged: boolean };
  "support.reply": { sent: boolean };
}

export interface Action<K extends ActionKind = ActionKind> {
  id: string;
  kind: K;
  ventureId?: string;
  summary: string;
  rationale: string;
  proposedBy: ProposedBy;
  payload: ActionPayloads[K];
  /** sha256 of canonical JSON of { kind, ventureId, payload }. Approvals bind to it. */
  payloadHash: string;
  /** Stable across restarts: `${kind}:${ventureId}:${natural key}`. Sent to every API that accepts one. */
  idempotencyKey: string;
  /** Open actions with the same key are not proposed twice. */
  dedupeKey: string;
  commitment?: Commitment;
  /** Maximum money this action can commit (commitment.maxTotalCents when present). */
  costCents: Cents;
  findings: PolicyFinding[];
  status: ActionStatus;
  approvals: Approval[];
  blockedByTaskIds: string[];
  experimentId?: string;
  cellId?: string;
  result?: ActionResults[K];
  error?: string;
  externalRefs?: Record<string, string>;
  policyVersion: string;
  createdAt: Iso;
  decidedAt?: Iso;
  executedAt?: Iso;
}

export type JobOp =
  | "store.upsert_subscriptions"
  | "store.build"
  | "store.submit_build"
  | "store.update_listing"
  | "store.review"
  | "social.publish";

export interface JobRef {
  op: JobOp;
  externalRef: Record<string, string>;
  pollAfterSec: number;
}

/** A long-running external operation polled by the orchestrator. */
export interface ExternalJob {
  id: string;
  op: JobOp;
  ventureId?: string;
  actionId: string;
  externalRef: Record<string, string>;
  status: "running" | "succeeded" | "failed" | "needs_human";
  nextPollAt: Iso;
  deadlineAt: Iso;
  attempts: number;
  result?: Record<string, unknown>;
  error?: string;
  createdAt: Iso;
}

export interface JobPoll {
  status: ExternalJob["status"];
  result?: Record<string, unknown>;
  error?: string;
  pollAfterSec?: number;
}

export type LedgerCategory = "ai" | "media" | "inference" | "creators" | "ads" | "infra" | "tools" | "revenue" | "refunds";

export interface LedgerEntry {
  id: string;
  /** Unique natural key; booking the same key twice is a no-op (idempotent sync). */
  sourceKey: string;
  ventureId?: string;
  category: LedgerCategory;
  /** Positive = money in (proceeds after fees and VAT), negative = money out. */
  amountCents: Cents;
  grossCents?: Cents;
  feeCents?: Cents;
  taxCents?: Cents;
  /** When proceeds reach the bank (store settlement lag). Cash counts revenue only after this. */
  settlesAt?: Iso;
  actionId?: string;
  experimentId?: string;
  cellId?: string;
  memo: string;
  at: Iso;
}

export type StudioEventType =
  | "tick.started"
  | "tick.committed"
  | "signal.recorded"
  | "idea.created"
  | "idea.screened"
  | "venture.created"
  | "venture.stage_changed"
  | "venture.blocked"
  | "experiment.registered"
  | "experiment.started"
  | "experiment.observed"
  | "experiment.decided"
  | "creative.batch_closed"
  | "content.requeued"
  | "action.proposed"
  | "action.decided"
  | "action.executed"
  | "action.failed"
  | "task.opened"
  | "task.completed"
  | "job.updated"
  | "ledger.booked"
  | "llm.call"
  | "policy.blocked"
  | "allocation.planned"
  | "memo.written";

/** Append-only audit event. */
export interface StudioEvent {
  seq: number;
  at: Iso;
  type: StudioEventType;
  ventureId?: string;
  data: Record<string, unknown>;
}
