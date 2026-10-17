/**
 * Ports: the only way the studio touches the outside world (contracts v2).
 *
 * Every port has a simulator implementation (src/sim) and a live one (src/integrations).
 * Ports are split by side effect:
 *   - ReadPorts go to the orchestrator, agents and lab.
 *   - WritePorts go ONLY to governance/executor.ts, which runs approved Actions.
 * LLM and media calls cost money but are not Actions; they are metered through a
 * CostMeter that enforces daily budgets and books the ledger.
 */
import type {
  AdCreativeRef,
  AdDailyStats,
  AdNetwork,
  AgentRole,
  Cents,
  CohortMetrics,
  ContentPiece,
  CreatorCampaign,
  CreatorDeal,
  DailyMetrics,
  ExternalJob,
  ExternalSubmission,
  HumanTaskDraft,
  Iso,
  JobPoll,
  JobRef,
  OwnedAccount,
  Payout,
  Platform,
  PlatformLabels,
  PostStats,
  StoreListing,
  StorePlatform,
  StoreProductDef,
  StoreRecord,
  SubmissionVerification,
  VentureBindings,
} from "./types.ts";
import type { EventName } from "./events.ts";
import type { SchemaInputs, SchemaName, SchemaOutputs } from "../agents/schemas.ts";

export interface Clock {
  now(): Date;
  iso(): string;
  /** YYYY-MM-DD of now (UTC). */
  today(): string;
}

// ---------------------------------------------------------------------------
// Cost metering (LLM + media)
// ---------------------------------------------------------------------------

export interface CostEvent {
  kind: "llm" | "media";
  ventureId?: string;
  cents: Cents;
  model: string;
  purpose: string;
  /** Unique per call; becomes the ledger sourceKey. */
  ref: string;
}

export interface CostMeter {
  /** Throws BudgetExceededError when today's budget for the kind is spent. */
  assertBudget(kind: CostEvent["kind"], estimateCents: Cents): void;
  charge(event: CostEvent): void;
  remainingTodayCents(kind: CostEvent["kind"]): Cents;
}

// ---------------------------------------------------------------------------
// Intelligence
// ---------------------------------------------------------------------------

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface LlmObjectRequest<N extends SchemaName> {
  role: AgentRole;
  schemaName: N;
  /** Stable role prompt (cache-friendly). Must include UNTRUSTED_RULE when `untrusted` is used. */
  system: string;
  /** Task instructions; the adapter appends the input and untrusted blocks. */
  instructions: string;
  input: SchemaInputs[N];
  /** External text (creator captions, reviews, emails), rendered only via untrusted(). */
  untrusted?: { label: string; text: string }[];
  ventureId?: string;
  purpose: string;
  effort?: Effort;
  maxTokens?: number;
}

export interface LlmTextRequest {
  role: AgentRole;
  system: string;
  instructions: string;
  input?: unknown;
  ventureId?: string;
  purpose: string;
  effort?: Effort;
  maxTokens?: number;
}

export interface LlmUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costCents: Cents;
}

export interface LlmPort {
  readonly kind: "claude" | "stub";
  object<N extends SchemaName>(req: LlmObjectRequest<N>): Promise<SchemaOutputs[N]>;
  text(req: LlmTextRequest): Promise<string>;
  usage(): LlmUsage;
}

export interface MediaAsset {
  path: string;
  mediaType: string;
  bytes: number;
  sha256: string;
  model: string;
  costCents: Cents;
  /** Always true: generated assets are disclosed as AI-generated wherever they are posted. */
  aiGenerated: true;
  /** Whether provenance metadata (C2PA / IPTC digitalSourceType) is embedded. */
  c2pa: boolean;
}

export interface MediaPort {
  readonly kind: "gateway" | "stub";
  image(req: { prompt: string; aspect: "1:1" | "9:16" | "4:5"; outPath: string; ventureId?: string; purpose: string }): Promise<MediaAsset>;
  video(req: { prompt: string; seconds: number; aspect: "9:16" | "16:9"; outPath: string; ventureId?: string; purpose: string }): Promise<MediaAsset>;
}

// ---------------------------------------------------------------------------
// Market intelligence (read-only, public data)
// ---------------------------------------------------------------------------

export interface ChartApp {
  id: string;
  name: string;
  artist: string;
  genre: string;
  rank: number;
  url: string;
}

export interface AppLookup {
  id: string;
  name: string;
  seller: string;
  genre: string;
  ratingCount: number;
  rating: number;
  priceCents: Cents;
  releaseDate: string;
  description: string;
  url: string;
}

export interface TrendPort {
  readonly kind: "apple_public" | "sim";
  topApps(req: { country: string; chart: "top-free" | "top-paid"; limit: number }): Promise<ChartApp[]>;
  searchApps(req: { term: string; country: string; limit: number }): Promise<AppLookup[]>;
}

// ---------------------------------------------------------------------------
// Stores (App Store Connect, Google Play, EAS)
// ---------------------------------------------------------------------------

export interface StoreRead {
  readonly kind: "live" | "sim";
  status(req: { bindings: VentureBindings; platform: StorePlatform }): Promise<Partial<StoreRecord>>;
  reviews(req: { bindings: VentureBindings; platform: StorePlatform; since: string }): Promise<{ date: string; territory: string; rating: 1 | 2 | 3 | 4 | 5 }[]>;
  poll(job: ExternalJob): Promise<JobPoll>;
}

export interface StoreWrite {
  readonly kind: "live" | "sim";
  registerBundleId(req: { bindings: VentureBindings; platform: StorePlatform; capabilities: string[] }): Promise<{ bundleIdResourceId: string }>;
  /** iOS: App Store Connect cannot create apps; live adapters return a human task instead. */
  createApp(req: {
    bindings: VentureBindings;
    platform: StorePlatform;
    name: string;
    sku: string;
    primaryLocale: string;
  }): Promise<{ appId: string } | { humanTask: HumanTaskDraft }>;
  upsertSubscriptions(req: { bindings: VentureBindings; platform: StorePlatform; groupName: string; products: StoreProductDef[] }): Promise<JobRef>;
  startBuild(req: { bindings: VentureBindings; platform: StorePlatform; projectDir: string }): Promise<JobRef>;
  submitBuild(req: { bindings: VentureBindings; platform: StorePlatform; easBuildId: string }): Promise<JobRef>;
  updateListing(req: { bindings: VentureBindings; platform: StorePlatform; listing: StoreListing; screenshotPaths: string[] }): Promise<JobRef>;
  setTerritories(req: { bindings: VentureBindings; platform: StorePlatform; territories: string[] }): Promise<void>;
  submitForReview(req: { bindings: VentureBindings; platform: StorePlatform; storeBuildId: string; notesForReviewer: string }): Promise<JobRef>;
  release(req: { bindings: VentureBindings; platform: StorePlatform; phased: boolean }): Promise<void>;
  removeFromSale(req: { bindings: VentureBindings; platform: StorePlatform }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Monetization, remote config, analytics
// ---------------------------------------------------------------------------

export interface MonetizationWrite {
  readonly kind: "live" | "sim";
  /** RevenueCat: app, products, entitlement, offerings. Store products must already exist. */
  configure(req: { bindings: VentureBindings; productIds: string[]; entitlementId: string }): Promise<{ offeringIds: Record<string, string> }>;
}

export interface RemoteConfigWrite {
  readonly kind: "live" | "sim";
  /** Sticky multivariate flag with JSON payloads (PostHog). Variant ids double as cell ids. */
  setFlag(req: { bindings: VentureBindings; key: string; variants: { id: string; rolloutPct: number; payload: unknown }[] }): Promise<{ flagKey: string }>;
}

export interface CellMetricRequest {
  bindings: VentureBindings;
  ventureId: string;
  experimentId: string;
  cellId: string;
  /** Storefront territory for geo cells; ignored for user_random cells. */
  geo: string;
  assignment: "geo" | "user_random";
  numerator: EventName;
  denominator: EventName;
  maturityHours: number;
  windowHours?: number;
  since: Iso;
  asOf: Iso;
}

export interface MetricsPort {
  readonly kind: "live" | "sim";
  /** Maturity-filtered counts for one cell, broken down by traffic source. */
  cellMetric(req: CellMetricRequest): Promise<{ successes: number; trials: number; bySource: Record<string, { successes: number; trials: number }> }>;
  /** Share of sessions in a cell from internal/test devices. */
  internalShare(req: { bindings: VentureBindings; ventureId: string; cellId: string; geo: string; since: Iso; asOf: Iso }): Promise<number>;
  /** App-analytics daily rows (venture total and per geo). */
  daily(req: { bindings: VentureBindings; ventureId: string; since: string; until: string }): Promise<DailyMetrics[]>;
  /** Cumulative cohort rows; the only input to economic decisions. */
  cohorts(req: { bindings: VentureBindings; ventureId: string; cohortSince: string; cohortUntil: string; maxAgeDays: number }): Promise<CohortMetrics[]>;
}

// ---------------------------------------------------------------------------
// Distribution
// ---------------------------------------------------------------------------

export interface CreatorProfile {
  externalId: string;
  platform: Platform;
  handle: string;
  niche: string;
  followers: number;
  medianViews30d: number;
  audienceGeo: Record<string, number>;
  audienceUnder18Share: number | null;
}

export interface CreatorRead {
  readonly kind: "live" | "sim";
  searchCreators(req: { niche: string; platform: Platform; minMedianViews: number; geo: string; limit: number }): Promise<CreatorProfile[]>;
  listSubmissions(req: { campaignExternalId: string }): Promise<ExternalSubmission[]>;
  /** Fetched from the platform of record: public status, author, disclosure label, views. */
  verifyPost(req: { submissionExternalId: string; postUrl: string; platform: Platform }): Promise<SubmissionVerification>;
  balance(): Promise<{ availableCents: Cents }>;
}

export interface CreatorWrite {
  readonly kind: "live" | "sim";
  createCampaign(campaign: CreatorCampaign): Promise<{ externalId: string }>;
  closeCampaign(req: { campaignExternalId: string }): Promise<void>;
  sendMessage(req: { creatorExternalId: string; text: string }): Promise<void>;
  offerDeal(req: { creatorExternalId: string; deal: CreatorDeal; campaignExternalId?: string }): Promise<{ externalId: string }>;
  reviewDraft(req: { submissionExternalId: string; approve: boolean; note: string }): Promise<void>;
  reviewPost(req: { submissionExternalId: string; approve: boolean; note: string }): Promise<void>;
  payout(req: { submissionExternalId: string; amountCents: Cents; idempotencyKey: string; basis: Payout["basis"] }): Promise<{ payoutId: string }>;
}

export interface SocialRead {
  readonly kind: "live" | "sim";
  postStats(req: { platform: Platform; externalId: string; account?: OwnedAccount }): Promise<PostStats>;
  poll(job: ExternalJob): Promise<JobPoll>;
}

export interface SocialWrite {
  readonly kind: "live" | "sim";
  /** Long-running: returns a job; poll yields { externalId, url?, moderation }. */
  publish(req: {
    account: OwnedAccount;
    platform: Platform;
    piece: ContentPiece;
    mode: "direct" | "inbox_draft" | "trial_reel";
    labels: PlatformLabels;
  }): Promise<JobRef>;
}

export interface AdsRead {
  readonly kind: "live" | "sim";
  stats(req: { network: AdNetwork; campaignExternalId: string; since: string; until: string }): Promise<AdDailyStats[]>;
}

export interface AdsWrite {
  readonly kind: "live" | "sim";
  createCampaign(req: {
    bindings: VentureBindings;
    network: AdNetwork;
    adAccountId: string;
    os: StorePlatform;
    type: "creative" | "search";
    dailyBudgetCents: Cents;
    startAt: Iso;
    endAt: Iso;
    geos: string[];
    creatives: AdCreativeRef[];
    keywords: { text: string; match: "exact" | "broad"; bidCents: Cents }[];
    name: string;
  }): Promise<{ campaignExternalId: string }>;
  setDailyBudget(req: { network: AdNetwork; campaignExternalId: string; dailyBudgetCents: Cents }): Promise<void>;
  pause(req: { network: AdNetwork; campaignExternalId: string }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Web hosting (public URLs for assets, legal pages, deep-link files)
// ---------------------------------------------------------------------------

export interface WebWrite {
  readonly kind: "live" | "sim";
  putAsset(req: { ventureId: string; localPath: string; contentType: string }): Promise<{ publicUrl: string; sha256: string }>;
  publishSite(req: { ventureId: string; files: { path: string; localPath: string }[] }): Promise<{ baseUrl: string }>;
}

// ---------------------------------------------------------------------------
// Bundles
// ---------------------------------------------------------------------------

export interface ReadPorts {
  clock: Clock;
  llm: LlmPort;
  media: MediaPort;
  trends: TrendPort;
  store: StoreRead;
  metrics: MetricsPort;
  creators: CreatorRead;
  social: SocialRead;
  ads: AdsRead;
}

/** Only governance/executor.ts may hold these. */
export interface WritePorts {
  store: StoreWrite;
  monetization: MonetizationWrite;
  remoteConfig: RemoteConfigWrite;
  creators: CreatorWrite;
  social: SocialWrite;
  ads: AdsWrite;
  web: WebWrite;
}

export interface PortSet {
  read: ReadPorts;
  write: WritePorts;
}
