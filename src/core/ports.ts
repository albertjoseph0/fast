/**
 * Ports: the only way the studio touches the outside world.
 *
 * Every port has a simulator implementation (src/sim) so the whole company can run
 * end-to-end without credentials, and a live implementation (src/integrations) that
 * talks to the real API. The orchestrator never imports an adapter directly.
 */
import type { z } from "zod";
import type {
  AppSpec,
  Cents,
  ContentPiece,
  CreatorCampaign,
  CreatorSubmission,
  DailyMetrics,
  PaywallConfig,
  Platform,
  StoreRecord,
} from "./types.ts";

export interface Clock {
  now(): Date;
  iso(): string;
  /** YYYY-MM-DD of now (UTC). */
  today(): string;
}

// ---------------------------------------------------------------------------
// Intelligence
// ---------------------------------------------------------------------------

export type AgentRole =
  | "scout"
  | "ideator"
  | "critic"
  | "designer"
  | "engineer"
  | "brand"
  | "content"
  | "creator_ops"
  | "analyst"
  | "ceo"
  | "compliance";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface LlmObjectRequest<T> {
  role: AgentRole;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  /** Name used for the JSON schema / logs. */
  schemaName: string;
  effort?: Effort;
  maxTokens?: number;
}

export interface LlmTextRequest {
  role: AgentRole;
  system: string;
  prompt: string;
  effort?: Effort;
  maxTokens?: number;
}

export interface LlmUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costCents: Cents;
}

export interface LlmPort {
  readonly kind: "claude" | "stub";
  object<T>(req: LlmObjectRequest<T>): Promise<T>;
  text(req: LlmTextRequest): Promise<string>;
  usage(): LlmUsage;
}

export interface MediaAsset {
  path: string;
  mediaType: string;
  bytes: number;
  model: string;
  costCents: Cents;
  /** Always true: every generated asset must be disclosed as AI-generated when posted. */
  aiGenerated: true;
}

export interface MediaPort {
  readonly kind: "gateway" | "stub";
  image(req: { prompt: string; aspect: "1:1" | "9:16" | "4:5"; outPath: string }): Promise<MediaAsset>;
  video(req: { prompt: string; seconds: number; aspect: "9:16" | "16:9"; outPath: string }): Promise<MediaAsset>;
}

// ---------------------------------------------------------------------------
// Market intelligence
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
// Build and ship
// ---------------------------------------------------------------------------

export type StorePlatform = "ios" | "android";

export interface StorePort {
  readonly kind: "live" | "sim";
  /**
   * Create the store record. On iOS this cannot be done through the App Store Connect
   * API; live adapters return { needsHuman: true } with instructions instead.
   */
  createApp(req: {
    ventureId: string;
    platform: StorePlatform;
    bundleId: string;
    name: string;
    sku: string;
    primaryLocale: string;
  }): Promise<{ appId?: string; needsHuman?: { instructions: string } }>;
  uploadBuild(req: { ventureId: string; platform: StorePlatform; projectDir: string; appId: string }): Promise<{ buildId: string }>;
  updateListing(req: { ventureId: string; platform: StorePlatform; appId: string; spec: AppSpec; screenshotPaths: string[] }): Promise<void>;
  setTerritories(req: { ventureId: string; platform: StorePlatform; appId: string; territories: string[] }): Promise<void>;
  submitForReview(req: { ventureId: string; platform: StorePlatform; appId: string; buildId: string }): Promise<{ submissionId: string }>;
  status(req: { ventureId: string; platform: StorePlatform; appId: string }): Promise<StoreRecord>;
}

export interface MonetizationPort {
  readonly kind: "live" | "sim";
  /** Create products/entitlements/offering for the paywall. */
  configure(req: { ventureId: string; appId: string; bundleId: string; paywall: PaywallConfig }): Promise<{ offeringId: string }>;
  /** Route a share of new users to a paywall variant (remote config, no rebuild). */
  setPaywallVariant(req: { ventureId: string; variantId: string; paywall: PaywallConfig; trafficPct: number }): Promise<void>;
}

export interface MetricsPort {
  readonly kind: "live" | "sim";
  daily(req: { ventureId: string; since: string; until: string }): Promise<DailyMetrics[]>;
  /** Event counts attributed to an experiment cell since a date. */
  cellCounts(req: { ventureId: string; experimentId: string; cellId: string; events: string[]; since: string }): Promise<Record<string, number>>;
}

// ---------------------------------------------------------------------------
// Distribution
// ---------------------------------------------------------------------------

export interface CreatorMarketplacePort {
  readonly kind: "live" | "sim";
  createCampaign(campaign: CreatorCampaign): Promise<{ externalId: string }>;
  listSubmissions(req: { campaignExternalId: string }): Promise<CreatorSubmission[]>;
  reviewSubmission(req: { submissionId: string; approve: boolean; note: string }): Promise<void>;
  payout(req: { submissionId: string; amountCents: Cents; idempotencyKey: string }): Promise<{ payoutId: string }>;
  closeCampaign(req: { campaignExternalId: string }): Promise<void>;
}

export interface SocialPublisherPort {
  readonly kind: "live" | "sim";
  publish(req: { piece: ContentPiece; accountId: string; platform: Platform; trialAudience: boolean }): Promise<{ externalId: string; url?: string }>;
  postStats(req: { externalId: string; platform: Platform }): Promise<{ views: number; likes: number; shares: number; comments: number }>;
}

export type AdNetwork = "meta" | "tiktok" | "apple" | "google";

export interface AdsPort {
  readonly kind: "live" | "sim";
  createCampaign(req: {
    ventureId: string;
    network: AdNetwork;
    dailyBudgetCents: Cents;
    geos: string[];
    creativeRefs: string[];
    experimentId?: string;
    cellId?: string;
  }): Promise<{ campaignId: string }>;
  setDailyBudget(req: { network: AdNetwork; campaignId: string; dailyBudgetCents: Cents }): Promise<void>;
  pause(req: { network: AdNetwork; campaignId: string }): Promise<void>;
  stats(req: { network: AdNetwork; campaignId: string; since: string }): Promise<{ spendCents: Cents; impressions: number; installs: number }>;
}

export interface Ports {
  clock: Clock;
  llm: LlmPort;
  media: MediaPort;
  trends: TrendPort;
  store: StorePort;
  monetization: MonetizationPort;
  metrics: MetricsPort;
  creators: CreatorMarketplacePort;
  social: SocialPublisherPort;
  ads: AdsPort;
}
