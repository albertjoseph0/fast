/**
 * The studio's constitution (contracts v2): budgets, autonomy limits, decision
 * thresholds, economics and operating modes. Everything an operator might tune lives
 * here, never in code. Numbers carry their source in playbook/benchmarks.ts.
 */
import { z } from "zod";
import { ActionKind, AgentRole, Platform, SensitiveDomain, ValidationStage } from "../core/types.ts";

const Cents = z.number().int().min(0);
const Rate = z.number().min(0).max(1);

export const Threshold = z.object({
  floor: z.number().min(0),
  target: z.number().min(0),
  futility: z.number().min(0),
});

const PostCap = z.object({ perAccountPerDay: z.number().int().min(0), minMinutesBetween: z.number().int().min(0) });

export const PriceLadderEntry = z.object({
  id: z.string(),
  period: z.enum(["week", "month", "year"]),
  usdCents: z.number().int().positive(),
  trialDays: z.number().int().min(0),
});
export type PriceLadderEntry = z.infer<typeof PriceLadderEntry>;

const DEFAULT_LADDER: PriceLadderEntry[] = [
  { id: "week_499_t3", period: "week", usdCents: 499, trialDays: 3 },
  { id: "week_599_t3", period: "week", usdCents: 599, trialDays: 3 },
  { id: "week_699_t3", period: "week", usdCents: 699, trialDays: 3 },
  { id: "week_699_t0", period: "week", usdCents: 699, trialDays: 0 },
  { id: "week_799_t3", period: "week", usdCents: 799, trialDays: 3 },
  { id: "week_999_t7", period: "week", usdCents: 999, trialDays: 7 },
  { id: "month_1499_t0", period: "month", usdCents: 1499, trialDays: 0 },
  { id: "month_1999_t3", period: "month", usdCents: 1999, trialDays: 3 },
  { id: "year_2999_t3", period: "year", usdCents: 2999, trialDays: 3 },
  { id: "year_3999_t0", period: "year", usdCents: 3999, trialDays: 0 },
  { id: "year_4999_t7", period: "year", usdCents: 4999, trialDays: 7 },
];

export const StudioConfig = z.object({
  name: z.string().default("Fast Studio"),
  /** sim: every port is simulated. live: ports talk to real APIs. */
  mode: z.enum(["sim", "live"]).default("sim"),
  /** live mode: actions run as dry_run (recorded, never sent) until a human turns this off via the CLI. */
  dryRun: z.boolean().default(true),
  seed: z.number().int().default(42),
  dataDir: z.string().default(".factory"),

  company: z
    .object({
      legalName: z.string().default("Fast Studio LLC"),
      bundleIdPrefix: z.string().default("com.faststudio"),
      supportEmail: z.string().default("support@example.com"),
      legalBaseUrl: z.string().default("https://example.com"),
      defaultLocale: z.string().default("en-US"),
    })
    .prefault({}),

  llm: z
    .object({
      /** auto: stub in sim mode; in live mode the Anthropic API if ANTHROPIC_API_KEY is set, else the Vercel AI Gateway. */
      provider: z.enum(["auto", "anthropic", "gateway", "stub"]).default("auto"),
      model: z.string().default("claude-opus-5-5"),
      /** High-volume roles can use a cheaper tier. */
      fastModel: z.string().default("claude-sonnet-5-5"),
      fastRoles: z.array(AgentRole).default(["content", "creator_ops"]),
      effortByRole: z
        .partialRecord(AgentRole, z.enum(["low", "medium", "high", "xhigh", "max"]))
        .default({ ideator: "high", designer: "high", critic: "medium", compliance: "medium", ceo: "medium" }),
      gatewayModelMap: z.record(z.string(), z.string()).default({
        "claude-opus-5-5": "anthropic/claude-opus-5.5",
        "claude-sonnet-5-5": "anthropic/claude-sonnet-5.5",
        "claude-haiku-5-5": "anthropic/claude-haiku-5.5",
        "claude-fable-5-1": "anthropic/claude-fable-5.1",
      }),
      maxDailyCents: Cents.default(5_000),
    })
    .prefault({}),

  media: z
    .object({
      provider: z.enum(["gateway", "stub"]).default("stub"),
      imageModel: z.string().default("openai/gpt-image-2"),
      videoModel: z.string().default("google/veo-3.1-fast-generate-001"),
      maxDailyCents: Cents.default(2_000),
      maxSlidesRenderedPerDraft: z.number().int().min(1).default(6),
    })
    .prefault({}),

  portfolio: z
    .object({
      ideasPerCycle: z.number().int().min(1).default(6),
      /** Run discovery every N ticks (a tick is one day). */
      discoveryEveryTicks: z.number().int().min(1).default(3),
      maxActiveVentures: z.number().int().min(1).default(5),
      /** Active ventures allowed per this much free cash (scales the portfolio with the bankroll). */
      freeCashPerActiveVentureCents: Cents.default(400_000),
      maxBuildsInFlight: z.number().int().min(1).default(2),
      maxAttentionProbesInFlight: z.number().int().min(0).default(3),
      minScreenScore: z.number().min(0).max(100).default(62),
      /** Bier's disband rule, compressed for AI speed. Time blocked on humans does not count. */
      maxDaysToValidate: z.number().int().min(7).default(42),
    })
    .prefault({}),

  budgets: z
    .object({
      startingCashCents: Cents.default(5_000_000),
      /** Reserve = max(floor, fixedBurnDays x trailing fixed burn per day + commitments). */
      reserveFloorCents: Cents.default(750_000),
      reserveFixedBurnDays: z.number().int().min(0).default(90),
      monthlyFixedCapCents: Cents.default(250_000),
      /** Daily distribution spend cap: min(this, share x free cash). */
      dailySpendCapCents: Cents.default(150_000),
      dailySpendCapShareOfFreeCash: Rate.default(0.07),
      maxCellBudgetCents: Cents.default(75_000),
      /** Disband rule in dollars: test spend before S4 passes. */
      maxTestSpendPerVentureCents: Cents.default(400_000),
      /** Upper bound per scaling venture; the allocator's cash-trough constraint usually binds first. */
      scaleDailyCapCents: Cents.default(100_000),
      maxPaybackDays: z.number().int().min(1).default(30),
      maxPaybackDaysWhenRich: z.number().int().min(1).default(60),
      richFreeCashCents: Cents.default(10_000_000),
      scaleRampMaxStepPct: Rate.default(0.25),
      scaleRampMinDaysBetweenSteps: z.number().int().min(1).default(3),
      /** Share of 7-day spend reserved for the validation pipeline so winners cannot starve discovery. */
      testBudgetShare: Rate.default(0.35),
    })
    .prefault({}),

  economics: z
    .object({
      storeFeeRate: z.object({ ios: Rate, android: Rate, web: Rate }).default({ ios: 0.15, android: 0.15, web: 0.035 }),
      iosFeeAboveSmallBusiness: Rate.default(0.3),
      smallBusinessCapCents: Cents.default(100_000_000),
      /** VAT/GST included in storefront prices (US prices exclude tax). */
      vatInclusiveRateByGeo: z.record(z.string(), Rate).default({ GB: 0.2, IE: 0.23, SE: 0.25, NL: 0.21, AU: 0.1, NZ: 0.15, CA: 0.13, US: 0 }),
      refundHaircutPrior: Rate.default(0.083),
      /** Verdict-backend inference cost per app session (Opus at low effort, ~1.5K in / 600 out tokens). */
      inferenceCentsPerSession: z.number().min(0).default(2),
      refundLagDays: z.number().int().default(90),
      settlementLagDays: z.object({ ios: z.number().int(), android: z.number().int(), web: z.number().int() }).default({ ios: 45, android: 30, web: 3 }),
      /** Subscription survival priors (RevenueCat SOSA 2026). */
      weeklyFirstRenewalPrior: Rate.default(0.65),
      weeklyRenewalPrior: Rate.default(0.88),
      monthlyRenewalPrior: Rate.default(0.8),
      annualRenewalPrior: Rate.default(0.28),
      /** Share of trial cancellations that happen within 24h; maps trialKeep24h to trial-to-paid. */
      trialCancelWithin24hShare: Rate.default(0.84),
      billingFailureRate: Rate.default(0.05),
      monthlyDiscountRate: Rate.default(0.03),
      /** Prior cost per install by channel, used for budgeting cells before data exists. */
      cpiPriorCents: z.record(z.string(), Cents).default({ creator_ugc: 120, paid_ads: 250, owned_social: 0, app_store_search: 250 }),
    })
    .prefault({}),

  monetization: z
    .object({
      entitlementId: z.string().default("pro"),
      ladder: z.array(PriceLadderEntry).default(DEFAULT_LADDER),
      defaultProductIds: z.array(z.string()).default(["week_699_t3", "year_3999_t0"]),
      defaultHighlightedProductId: z.string().default("week_699_t3"),
      /** paywall.update runs autonomously only inside this grid. */
      priceGrid: z
        .object({ week: z.tuple([Cents, Cents]), month: z.tuple([Cents, Cents]), year: z.tuple([Cents, Cents]) })
        .default({ week: [499, 999], month: [999, 1999], year: [2999, 5999] }),
      allowedTrialDays: z.array(z.number().int()).default([0, 3, 7]),
    })
    .prefault({}),

  lab: z
    .object({
      /** pass iff P(p >= floor) >= confidence at the read deadline. */
      confidence: z.number().min(0.5).max(0.999).default(0.9),
      /** Power at the target value, for all cells passing together. */
      power: z.number().min(0.5).max(0.99).default(0.8),
      readHours: z.record(ValidationStage, z.number().int().min(12)).default({
        S0_attention: 72,
        S1_distribution: 96,
        S1_activation: 96,
        S2_sharing: 96,
        S3_cross_cell: 168,
        S4_monetization: 96,
      }),
      /**
       * A cell with no exposure this many hours after its traffic source launched (the creator campaign
       * went live, or the experiment started for owned and product-side cells) is invalid (harness failure).
       * Marketplace creators typically apply, get a draft approved and post within a week.
       */
      maxHoursToFirstExposure: z.number().int().min(1).default(168),
      /** Absolute per-metric sample floors in denominator units (posts for post-unit metrics). */
      minSampleFloor: z
        .record(z.string(), z.number().int().min(1))
        .default({
          attentionHitRate: 12,
          installsPer1kViews: 12,
          activationRate: 120,
          trialStartRate: 150,
          trialKeep24h: 40,
          trialToPaid: 60,
          shareRate: 80,
          kFactor: 80,
          d1Retention: 120,
        }),
      /** source_concentration validity: at least this many sources, none above the share. */
      minSources: z.number().int().min(1).default(5),
      maxSourceShare: Rate.default(0.5),
      ladders: z
        .object({ single_player: z.array(z.array(ValidationStage)), social: z.array(z.array(ValidationStage)) })
        .default({
          single_player: [["S1_distribution", "S1_activation", "S4_monetization"]],
          social: [["S1_distribution", "S1_activation"], ["S2_sharing"], ["S3_cross_cell"], ["S4_monetization"]],
        }),
      attentionProbe: z
        .object({ enabled: z.boolean(), posts: z.number().int().min(1), hitViews: z.number().int().min(1) })
        .default({ enabled: true, posts: 12, hitViews: 5_000 }),
      creatorBatch: z
        .object({ creatorsPerCell: z.number().int().min(1), postsPerCreator: z.number().int().min(1) })
        .default({ creatorsPerCell: 6, postsPerCreator: 3 }),
      maxIterationsPerStep: z.number().int().min(1).default(4),
      maxHarnessFixesPerStep: z.number().int().min(0).default(2),
      /** No wedge|channel|platform|unit is reused across ventures within this window. */
      audienceCooldownDays: z.number().int().min(0).default(56),
      sameVentureCooldownDays: z.number().int().min(0).default(7),
      /** English storefronts outside GDPR/DSA scope by default (see privacy.euUkEnabled). */
      testGeos: z.array(z.string()).default(["CA", "AU", "NZ"]),
      localizedTestGeos: z.record(z.string(), z.array(z.string())).default({}),
      scaleGeos: z.array(z.string()).default(["US"]),
      /** Capped US calibration probe before scaling (approved together with venture.scale). */
      usProbeBudgetCents: Cents.default(45_000),
      /** Creators join a geo cell only if this share of their audience is in the geo. */
      minCreatorGeoShare: Rate.default(0.5),
      /** S4 unit economics: 20th percentile of predicted D60 ROAS must reach this. */
      s4MinRoasD60P20: z.number().min(0).default(0.8),
      /** Revenue rows younger than this are incomplete (trial conversions, store lag). */
      revenueLagDays: z.number().int().min(0).default(3),
    })
    .prefault({}),

  /** Thresholds in raw units (installsPer1kViews 0.0015 means 1.5 per 1K views). */
  thresholds: z
    .object({
      attentionHitRate: Threshold.prefault({ floor: 0.15, target: 0.3, futility: 0.05 }),
      installsPer1kViews: Threshold.prefault({ floor: 0.0015, target: 0.003, futility: 0.0006 }),
      activationRate: Threshold.prefault({ floor: 0.45, target: 0.55, futility: 0.25 }),
      trialStartRate: Threshold.prefault({ floor: 0.12, target: 0.18, futility: 0.06 }),
      trialKeep24h: Threshold.prefault({ floor: 0.41, target: 0.5, futility: 0.29 }),
      trialToPaid: Threshold.prefault({ floor: 0.3, target: 0.38, futility: 0.15 }),
      shareRate: Threshold.prefault({ floor: 0.12, target: 0.2, futility: 0.04 }),
      kFactor: Threshold.prefault({ floor: 1.0, target: 1.2, futility: 0.3 }),
      d1Retention: Threshold.prefault({ floor: 0.3, target: 0.4, futility: 0.15 }),
      /** Scaling tripwires, evaluated on mature cohorts only. */
      refundShareMax: Rate.default(0.12),
      oneStarShareMax: Rate.default(0.5),
      oneStarMinReviews: z.number().int().default(20),
    })
    .prefault({}),

  distribution: z
    .object({
      /** TikTok's audit rejects uploaders for your own accounts: owned TikTok posts are drafts a human finishes. */
      tiktokOwnedMode: z.enum(["inbox_draft", "direct"]).default("inbox_draft"),
      tiktokAudited: z.boolean().default(false),
      postCaps: z.record(Platform, PostCap).default({
        tiktok: { perAccountPerDay: 3, minMinutesBetween: 120 },
        instagram: { perAccountPerDay: 3, minMinutesBetween: 120 },
        youtube: { perAccountPerDay: 2, minMinutesBetween: 240 },
        x: { perAccountPerDay: 10, minMinutesBetween: 30 },
        threads: { perAccountPerDay: 5, minMinutesBetween: 60 },
        pinterest: { perAccountPerDay: 10, minMinutesBetween: 30 },
        snapchat: { perAccountPerDay: 0, minMinutesBetween: 0 },
      }),
      youtubeProjectInsertsPerDay: z.number().int().default(80),
      maxNearDuplicatePerAccountPer7d: z.number().int().default(2),
    })
    .prefault({}),

  growth: z
    .object({
      creative: z
        .object({ batchDays: z.number().int(), cullMinPosts: z.number().int(), cullProbBest: Rate, exploreShare: Rate })
        .default({ batchDays: 7, cullMinPosts: 6, cullProbBest: 0.05, exploreShare: 0.2 }),
      amplify: z
        .object({
          minAttributedInstalls: z.number().int(),
          minRpmOverCpm: z.number(),
          probeLifetimeCapCents: Cents,
          probeDays: z.number().int(),
          minProbeRoasD60P20: z.number(),
          fatigueCpiRisePct: z.number(),
          maxCreativeDays: z.number().int(),
          assumedPaidCpmCents: z.record(z.string(), Cents),
        })
        .default({
          minAttributedInstalls: 50,
          minRpmOverCpm: 1.5,
          probeLifetimeCapCents: 30_000,
          probeDays: 3,
          minProbeRoasD60P20: 1.0,
          fatigueCpiRisePct: 0.4,
          maxCreativeDays: 14,
          assumedPaidCpmCents: { tiktok: 800, meta: 1000 },
        }),
      paywallExperimentsPerMonth: z.number().int().default(4),
      brandDefenseDailyCents: Cents.default(2_000),
    })
    .prefault({}),

  creators: z
    .object({
      firstPayoutToNewCreatorNeedsHuman: z.boolean().default(true),
      maxPayoutPerCreatorPer30dCents: Cents.default(50_000),
      viewLockDays: z.number().int().min(1).default(7),
      maxAudienceUnder18Share: Rate.default(0.3),
      defaultDeal: z
        .object({ flatFeeCents: Cents, cpmCents: Cents, maxPayoutCents: Cents })
        .default({ flatFeeCents: 1_500, cpmCents: 150, maxPayoutCents: 15_000 }),
    })
    .prefault({}),

  exit: z
    .object({
      saleMultipleOfTtmContribution: z.number().default(3),
      minTtmProceedsForExitFlagCents: Cents.default(25_000_000),
      decliningMonthsForFlag: z.number().int().default(2),
      harvestHalfLifeDays: z.number().int().default(21),
      harvestBelowPeak: Rate.default(0.3),
      sunsetNegativeContributionMonths: z.number().int().default(2),
    })
    .prefault({}),

  autonomy: z
    .object({
      /** Action kinds that always wait for a human. */
      alwaysApprove: z
        .array(ActionKind)
        .default(["store.create_app", "venture.scale", "venture.sunset", "store.remove_from_sale", "monetization.configure"]),
      approveFirstSubmission: z.boolean().default(true),
      approveResubmitAfterRejection: z.boolean().default(true),
      firstAdCampaignPerNetworkNeedsHuman: z.boolean().default(true),
      autoApproveBelowCentsByKind: z
        .partialRecord(ActionKind, Cents)
        .default({ "creator.campaign_create": 50_000, "ads.campaign_create": 30_000, "ads.budget_change": 20_000, "creator.payout": 15_000 }),
      defaultAutoApproveBelowCents: Cents.default(25_000),
      /** No single action may commit more than this, approved or not. */
      hardActionCapCents: Cents.default(250_000),
      /** Wedges or apps for anyone younger than this need a human. */
      autonomousMinAge: z.number().int().default(18),
      humanReviewDomains: z
        .array(SensitiveDomain)
        .default(["health", "mental_health", "finance", "legal", "minors", "biometric", "dating_safety", "ai_companion", "appearance_rating", "gambling"]),
      /**
       * Red categories (research 2026-10: Apple 4.3 saturated categories, FTC Genesis Tech, state chatbot
       * laws): every store submission and every ad campaign for these ventures needs a human.
       */
      redCategoryDomains: z
        .array(SensitiveDomain)
        .default(["astrology_fortune", "dating_safety", "ai_companion", "mental_health", "health", "finance", "gambling", "appearance_rating", "minors"]),
      /** A file at this path (relative to dataDir) halts every external action. */
      killSwitchFile: z.string().default("STOP"),
      /** People allowed to approve actions and complete human tasks. */
      board: z.array(z.string()).default(["owner"]),
    })
    .prefault({}),

  privacy: z
    .object({
      /** GB/EU storefronts need GDPR consent flows, an Art. 27 representative and DSA trader verification. */
      euUkEnabled: z.boolean().default(false),
      euRepresentative: z.string().optional(),
    })
    .prefault({}),
});

export type StudioConfig = z.infer<typeof StudioConfig>;
export type ThresholdConfig = z.infer<typeof Threshold>;

export function defaultConfig(overrides: z.input<typeof StudioConfig> = {}): StudioConfig {
  return StudioConfig.parse(overrides);
}
