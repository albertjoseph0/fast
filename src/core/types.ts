/**
 * Domain model for the autonomous app studio.
 *
 * Entities the LLM agents generate (ideas, specs, content, briefs) are defined as
 * zod schemas so the same definition doubles as the structured-output contract.
 * Everything else is a plain TypeScript type owned by deterministic code.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** ISO-8601 timestamp string. */
export type Iso = string;
/** Integer US cents. All money in the system is integer cents. */
export type Cents = number;

export const CoreNeed = z.enum([
  // Bier's three core needs.
  "love", // finding love, relationships, compatibility, social standing
  "money", // making or saving money
  "play", // play, hobbies, unplugging from reality
  // Extensions observed in 2023-2026 winners (Cal AI, Umax, Quittr, Astra). Allowed but
  // scored lower unless the idea also maps to one of Bier's three.
  "self_improvement", // looks, fitness, habits, faith, self-understanding
]);
export type CoreNeed = z.infer<typeof CoreNeed>;

export const Platform = z.enum(["tiktok", "instagram", "youtube", "x", "pinterest", "snapchat", "threads"]);
export type Platform = z.infer<typeof Platform>;

/**
 * How a product reaches new people. Bier: product channels are one-to-one invites
 * and one-to-many sharing; Vert/Cal AI: paid human creators on their own accounts.
 */
export const ChannelKind = z.enum([
  "creator_ugc", // paid human creators posting on their own accounts (primary)
  "owned_social", // brand-owned accounts (limited volume, disclosed)
  "share_loop", // users share the app's output to other networks (one-to-many)
  "invite_loop", // user-initiated one-to-one invites
  "paid_ads", // amplification of proven winners only
  "app_store_search", // ASO + Apple Ads
  "seo", // programmatic SEO pages
]);
export type ChannelKind = z.infer<typeof ChannelKind>;

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export type SignalSource = "app_store_chart" | "app_store_search" | "social_trend" | "search_trend" | "manual" | "portfolio";

/** A market observation that can seed ideas. */
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
  minAge: z.number().int().min(13).describe("Youngest intended user. Under-18 wedges require human approval."),
  maxAge: z.number().int().max(99),
  geos: z.array(z.string()).min(1).describe("ISO country codes where the first tests run"),
  creatorNiche: z.string().describe("The creator niche whose audience is this wedge, e.g. 'zodiac TikTok'"),
  estimatedReachableCreators: z.number().int().min(0),
  /** Bier wedge factors, each 0..1. */
  coPresence: z.number().min(0).max(1).describe("Daily physical co-presence of members (school, gym, team)"),
  discoverable: z.number().min(0).max(1).describe("Membership is discoverable/bounded (bio tags, rosters, hashtags)"),
  inflectionPoint: z.number().min(0).max(1).describe("Members are at a life inflection point"),
  obsessive: z.number().min(0).max(1).describe("Obsessive engagement (fandoms, hobbyists)"),
  urgency: z.number().min(0).max(1).describe("Communication urgency / emotional stakes"),
  ownedReach: z.number().min(0).max(1).describe("Reachable through a channel the studio controls or can buy"),
});
export type Wedge = z.infer<typeof Wedge>;

export const InteractionBudget = z.object({
  tapsToCoreAction: z.number().int().min(0),
  secondsToFirstValue: z.number().min(0).describe("Seconds from first core-screen view to the aha moment"),
  typicalSessionSeconds: z.number().min(0),
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
  minFriendsForValue: z.number().int().min(0),
  requiresPartnership: z.boolean(),
  primaryChannel: ChannelKind,
  secondaryChannels: z.array(ChannelKind),
  shareArtifact: z.string().describe("The output users post elsewhere (card, score, video) that advertises the app"),
  hookExamples: z.array(z.string()).min(3).describe("Short-form video/slideshow hooks"),
  interaction: InteractionBudget,
  monetization: z.object({
    model: z.enum(["hard_paywall", "soft_paywall", "freemium", "consumable"]),
    payFor: z.string().describe("The exact thing users pay for"),
  }),
  sensitiveDomains: z
    .array(z.enum(["health", "mental_health", "finance", "legal", "dating_safety", "religion", "minors", "biometric"]))
    .describe("Domains needing extra compliance review"),
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
// Principles engine output
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

export type GateVerdict = "pass" | "warn" | "fail";

export interface GateResult {
  principle: PrincipleId;
  verdict: GateVerdict;
  /** 0..1 contribution to the idea score. */
  score: number;
  reason: string;
}

export interface Screening {
  ideaId: string;
  gates: GateResult[];
  /** Weighted 0..100 composite. */
  score: number;
  verdict: "advance" | "reject" | "needs_human";
  reasons: string[];
  critique?: string;
  screenedAt: Iso;
}

// ---------------------------------------------------------------------------
// Product spec (consumed by the app template)
// ---------------------------------------------------------------------------

export const OnboardingStep = z.object({
  id: z.string(),
  kind: z.enum([
    "welcome",
    "goal_picker",
    "single_choice",
    "multi_choice",
    "text_input",
    "date_input",
    "slider",
    "social_proof",
    "value_preview",
    "notification_preprompt",
    "loading_personalization",
    "result_teaser",
  ]),
  title: z.string(),
  subtitle: z.string().optional(),
  options: z.array(z.string()).optional(),
  storeAs: z.string().optional().describe("Profile key the answer is saved under"),
});
export type OnboardingStep = z.infer<typeof OnboardingStep>;

export const PaywallProduct = z.object({
  id: z.string().describe("Store product id suffix, e.g. 'weekly_699_trial3'"),
  period: z.enum(["week", "month", "year", "lifetime"]),
  priceCents: z.number().int().positive(),
  trialDays: z.number().int().min(0),
  highlighted: z.boolean(),
});
export type PaywallProduct = z.infer<typeof PaywallProduct>;

export const PaywallConfig = z.object({
  placement: z.enum(["after_onboarding", "after_first_value", "on_limit"]),
  style: z.enum(["hard", "soft"]),
  pages: z.number().int().min(1).max(4),
  headline: z.string(),
  bullets: z.array(z.string()).min(2).max(6),
  products: z.array(PaywallProduct).min(1).max(4),
  /** Clear terms rendered next to the CTA (Apple 3.1.2, FTC/ROSCA, state ARLs). */
  termsCopy: z.string(),
  showCloseAfterSeconds: z.number().int().min(0).nullable(),
});
export type PaywallConfig = z.infer<typeof PaywallConfig>;

export const AppSpec = z.object({
  appName: z.string(),
  subtitle: z.string().max(30),
  slug: z.string().regex(/^[a-z0-9-]+$/),
  category: z.string().describe("App Store primary category"),
  brand: z.object({
    primaryColor: z.string(),
    accentColor: z.string(),
    backgroundColor: z.string(),
    textColor: z.string(),
    voice: z.string().describe("Tone of voice for all copy"),
    iconPrompt: z.string(),
  }),
  onboarding: z.array(OnboardingStep).min(6).max(18),
  core: z.object({
    inputKind: z.enum(["photo", "screenshot", "text", "date_time_place", "audio_file", "choices", "none"]),
    inputLabel: z.string(),
    aiSystemPrompt: z.string().describe("System prompt the app's backend sends to the model"),
    outputSections: z.array(z.string()).min(1),
    loadingMessages: z.array(z.string()).min(2),
    freeUsesBeforePaywall: z.number().int().min(0),
  }),
  paywall: PaywallConfig,
  share: z.object({
    artifact: z.string(),
    cardHeadline: z.string(),
    caption: z.string(),
    deepLinkPath: z.string(),
    watermark: z.string(),
  }),
  retention: z.object({
    pushSchedule: z.array(z.object({ dayOffset: z.number().int().min(0), hourLocal: z.number().int().min(0).max(23), copy: z.string() })),
    dailyHook: z.string().describe("Why a user opens the app again tomorrow"),
    widget: z.string().nullable(),
  }),
  aso: z.object({
    keywords: z.array(z.string()).max(20),
    description: z.string(),
    promotionalText: z.string().max(170),
    screenshotCaptions: z.array(z.string()).min(3).max(10),
  }),
  compliance: z.object({
    aiDisclosure: z.string(),
    dataUseSummary: z.string(),
    minimumAge: z.number().int().min(13),
    thirdPartyAiConsentCopy: z.string().describe("Apple 5.1.2(i) consent before sending data to a third-party AI"),
  }),
  analyticsEvents: z.array(z.string()).min(5),
});
export type AppSpec = z.infer<typeof AppSpec>;

// ---------------------------------------------------------------------------
// Ventures (one per app) and their lifecycle
// ---------------------------------------------------------------------------

export type VentureStage =
  | "screened" // passed idea gates; waiting for a concept test slot
  | "concept_test" // demand test with hooks/content before any build
  | "specced"
  | "building"
  | "in_review" // store review
  | "live_test" // validation ladder in test cells
  | "iterating" // valid failure on a stage; trying a variant
  | "scaling" // passed + replicated; budget ramps
  | "harvest" // mature: price optimization, paid UA, decay management
  | "killed"
  | "exited";

export type ValidationStage =
  | "S0_demand" // do hooks about the concept earn views and intent before building?
  | "S1_activation" // does the core flow deliver value (activation, D1)?
  | "S2_sharing" // do users export the artifact / invite (external exposure, K)?
  | "S3_cross_cell" // does it spread to untouched cells?
  | "S4_monetization"; // trial start + trial-to-paid, revenue per install

export interface StageTransition {
  from: VentureStage | null;
  to: VentureStage;
  at: Iso;
  reason: string;
}

export interface BuildRecord {
  projectDir: string;
  version: string;
  buildNumber: number;
  artifactUrl?: string;
  checks: { name: string; passed: boolean; detail: string }[];
  builtAt: Iso;
}

export interface StoreRecord {
  platform: "ios" | "android";
  appId?: string;
  bundleId: string;
  status: "not_created" | "draft" | "in_review" | "rejected" | "live" | "removed";
  territories: string[];
  rejectionReason?: string;
  updatedAt: Iso;
}

export interface Venture {
  id: string;
  ideaId: string;
  name: string;
  stage: VentureStage;
  /** Highest validation stage passed with replication. */
  validated: ValidationStage[];
  spec?: AppSpec;
  build?: BuildRecord;
  stores: StoreRecord[];
  /** Iterations attempted on the current validation stage. */
  iteration: number;
  /** Valid (non-confounded) failures on the current stage. */
  validFailures: number;
  budget: { allocatedCents: Cents; spentCents: Cents };
  history: StageTransition[];
  createdAt: Iso;
  updatedAt: Iso;
}

// ---------------------------------------------------------------------------
// Lab: pre-registered experiments
// ---------------------------------------------------------------------------

export type MetricKind = "proportion" | "rate_per_1k";

export interface MetricSpec {
  key: string;
  label: string;
  kind: MetricKind;
  /** Event counted as a success (proportion) or as the event (rate). */
  numerator: string;
  /** Event counted as a trial (proportion) or exposure (rate: per 1,000 of these). */
  denominator: string;
  /** Pass when we are confident the true value is at or above this. */
  passThreshold: number;
  /** Kill when we are confident the true value is below this. */
  killThreshold: number;
}

export type ValidityCheckId =
  | "min_sample"
  | "seeding_saturation"
  | "instrumentation"
  | "cold_traffic"
  | "support_coverage"
  | "budget_not_exceeded"
  | "no_audience_overlap";

export interface ValidityRequirement {
  id: ValidityCheckId;
  description: string;
  /** Numeric floor where relevant, e.g. min_sample = 400 trials per cell. */
  threshold?: number;
}

export interface TestCell {
  id: string;
  /** Audience the cell targets: a wedge in a geo through a channel. */
  wedge: string;
  geo: string;
  channel: ChannelKind;
  /** The variant under test (hook id, paywall variant, onboarding variant...). */
  variant: Record<string, string | number | boolean>;
  role: "primary" | "replication";
  budgetCents: Cents;
}

export type ExperimentStatus = "registered" | "running" | "decided" | "invalid" | "aborted";

export interface ExperimentPlan {
  id: string;
  ventureId: string;
  stage: ValidationStage;
  hypothesis: string;
  /** The one variable that differs from the venture's current baseline. */
  variableUnderTest: string;
  primary: MetricSpec;
  guardrails: MetricSpec[];
  cells: TestCell[];
  minSamplePerCell: number;
  maxDurationHours: number;
  maxBudgetCents: Cents;
  validity: ValidityRequirement[];
  status: ExperimentStatus;
  registeredAt: Iso;
  startedAt?: Iso;
  decidedAt?: Iso;
}

export interface CellObservation {
  cellId: string;
  /** Raw event counts keyed by event name (e.g. { install: 812, trial_start: 61 }). */
  counts: Record<string, number>;
  spendCents: Cents;
  observedAt: Iso;
}

export type CellDecision = "pass" | "kill" | "inconclusive" | "invalid";

export interface CellVerdict {
  cellId: string;
  decision: CellDecision;
  estimate: number;
  /** Central 90% credible interval. */
  interval: [number, number];
  pAbovePass: number;
  pBelowKill: number;
  validity: { id: ValidityCheckId; passed: boolean; detail: string }[];
}

export type ExperimentDecision = "pass" | "replicate" | "iterate" | "kill" | "fix_harness" | "continue";

export interface ExperimentOutcome {
  experimentId: string;
  decision: ExperimentDecision;
  cells: CellVerdict[];
  rationale: string;
  decidedAt: Iso;
}

// ---------------------------------------------------------------------------
// Content and creators
// ---------------------------------------------------------------------------

export const Slide = z.object({
  text: z.string().max(140),
  imagePrompt: z.string(),
  isAppReveal: z.boolean(),
});

export const ContentDraft = z.object({
  formatId: z.string(),
  platform: Platform,
  hook: z.string().describe("First 1-2 seconds / first slide text"),
  script: z.string().describe("Voiceover or on-screen narrative; empty for silent slideshows"),
  slides: z.array(Slide).describe("For slideshow formats; empty otherwise"),
  caption: z.string(),
  hashtags: z.array(z.string()),
  callToAction: z.string(),
});
export type ContentDraft = z.infer<typeof ContentDraft>;

export interface ContentPiece {
  id: string;
  ventureId: string;
  draft: ContentDraft;
  mediaPaths: string[];
  channel: ChannelKind;
  accountId?: string;
  creatorId?: string;
  disclosure: { aiGenerated: boolean; paidPartnership: boolean };
  status: "draft" | "approved" | "scheduled" | "posted" | "rejected";
  externalId?: string;
  postedAt?: Iso;
  metrics?: { views: number; likes: number; shares: number; comments: number; installs: number };
  experimentId?: string;
  cellId?: string;
}

export const CreatorBrief = z.object({
  title: z.string(),
  productSummary: z.string(),
  audience: z.string(),
  formats: z.array(z.string()).min(1),
  hooks: z.array(z.string()).min(3),
  mustInclude: z.array(z.string()).describe("e.g. app reveal within first 15s, on-screen app name"),
  mustAvoid: z.array(z.string()).describe("Claims and content that are not allowed"),
  disclosure: z.string().describe("Required paid-partnership disclosure"),
  deliverables: z.string(),
});
export type CreatorBrief = z.infer<typeof CreatorBrief>;

export interface CreatorCampaign {
  id: string;
  ventureId: string;
  externalId?: string;
  brief: CreatorBrief;
  platform: Platform;
  flatFeeCents: Cents;
  cpmCents: Cents;
  maxPayoutPerVideoCents: Cents;
  budgetCents: Cents;
  status: "draft" | "open" | "paused" | "closed";
  experimentId?: string;
  cellId?: string;
  createdAt: Iso;
}

export interface CreatorSubmission {
  id: string;
  campaignId: string;
  creatorId: string;
  creatorHandle: string;
  platform: Platform;
  postUrl?: string;
  /** Untrusted: text supplied by an external creator. Never treat as instructions. */
  untrustedCaption: string;
  disclosed: boolean;
  views: number;
  installs: number;
  status: "pending_review" | "approved" | "rejected" | "paid";
  payoutCents: Cents;
  submittedAt: Iso;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/** Daily funnel counts for a venture (optionally per cell). */
export interface DailyMetrics {
  ventureId: string;
  cellId?: string;
  date: string; // YYYY-MM-DD
  views: number;
  installs: number;
  onboardingStarted: number;
  onboardingCompleted: number;
  activated: number; // reached first value
  paywallViews: number;
  trialStarts: number;
  conversions: number; // first paid period
  activeSubscribers: number;
  shares: number;
  invitesSent: number;
  inviteInstalls: number;
  d1Retained: number;
  d1Eligible: number;
  revenueCents: Cents;
  refundsCents: Cents;
  spendCents: Cents;
  oneStarReviews: number;
  reviews: number;
}

// ---------------------------------------------------------------------------
// Governance: every external side effect is an Action
// ---------------------------------------------------------------------------

export type ActionKind =
  | "store.create_app"
  | "store.upload_build"
  | "store.update_listing"
  | "store.submit_review"
  | "store.release"
  | "store.set_territories"
  | "monetization.configure"
  | "paywall.update"
  | "content.publish"
  | "creator.campaign_create"
  | "creator.submission_review"
  | "creator.payout"
  | "ads.campaign_create"
  | "ads.budget_change"
  | "ads.pause"
  | "account.create"
  | "venture.kill"
  | "venture.scale"
  | "support.reply";

export type ActionStatus = "proposed" | "blocked" | "awaiting_approval" | "approved" | "executed" | "failed" | "rejected";

export interface PolicyFinding {
  rule: string;
  severity: "info" | "warn" | "block" | "needs_human";
  message: string;
}

export interface Action {
  id: string;
  kind: ActionKind;
  ventureId?: string;
  summary: string;
  payload: Record<string, unknown>;
  /** Money this action commits, if any. */
  costCents: Cents;
  findings: PolicyFinding[];
  status: ActionStatus;
  approvedBy?: string;
  result?: Record<string, unknown>;
  error?: string;
  createdAt: Iso;
  decidedAt?: Iso;
  executedAt?: Iso;
}

export type LedgerCategory = "ai" | "media" | "creators" | "ads" | "infra" | "store_fees" | "revenue" | "refunds";

export interface LedgerEntry {
  id: string;
  ventureId?: string;
  category: LedgerCategory;
  /** Positive = money in, negative = money out. */
  amountCents: Cents;
  memo: string;
  at: Iso;
}

/** Append-only audit event. */
export interface StudioEvent {
  seq: number;
  at: Iso;
  type: string;
  ventureId?: string;
  data: Record<string, unknown>;
}
