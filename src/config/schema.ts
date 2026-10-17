/**
 * The studio's constitution: budgets, autonomy limits, decision thresholds and
 * operating modes. Everything an operator might want to tune lives here, never in code.
 */
import { z } from "zod";

const Cents = z.number().int().min(0);

export const MetricThreshold = z.object({
  pass: z.number().min(0),
  kill: z.number().min(0),
});

export const StudioConfig = z.object({
  name: z.string().default("Fast Studio"),
  /** sim: every external port is simulated. live: ports talk to real APIs (dry-run until approved). */
  mode: z.enum(["sim", "live"]).default("sim"),
  /** live mode: when true, external writes are recorded to the outbox but never sent. */
  dryRun: z.boolean().default(true),
  seed: z.number().int().default(42),
  dataDir: z.string().default(".factory"),

  llm: z
    .object({
      /** auto: Anthropic API if ANTHROPIC_API_KEY is set, else Vercel AI Gateway if reachable, else stub. */
      provider: z.enum(["auto", "anthropic", "gateway", "stub"]).default("auto"),
      model: z.string().default("claude-opus-5-5"),
      /** High-volume roles (content variants, submission review) can use a cheaper tier. */
      fastModel: z.string().default("claude-sonnet-5-5"),
      fastRoles: z.array(z.string()).default(["content", "creator_ops"]),
      maxDailyCents: Cents.default(5_000),
    })
    .prefault({}),

  media: z
    .object({
      provider: z.enum(["gateway", "stub"]).default("stub"),
      imageModel: z.string().default("openai/gpt-image-2"),
      videoModel: z.string().default("google/veo-3.1-fast-generate-001"),
      maxDailyCents: Cents.default(2_000),
    })
    .prefault({}),

  portfolio: z
    .object({
      ideasPerCycle: z.number().int().min(1).default(6),
      /** Run discovery every N ticks (a tick is one simulated or real day). */
      discoveryEveryTicks: z.number().int().min(1).default(3),
      maxActiveVentures: z.number().int().min(1).default(10),
      maxConceptTestsInFlight: z.number().int().min(1).default(4),
      maxBuildsInFlight: z.number().int().min(1).default(3),
      minScreenScore: z.number().min(0).max(100).default(62),
      /** Bier's disband rule compressed for AI speed: a venture must validate S1-S4 within this. */
      maxDaysToValidate: z.number().int().min(7).default(42),
    })
    .prefault({}),

  budgets: z
    .object({
      startingCashCents: Cents.default(2_500_000),
      /** Never spend below this; the company stops buying distribution. */
      reserveCents: Cents.default(500_000),
      dailySpendCapCents: Cents.default(150_000),
      conceptTestCents: Cents.default(30_000),
      liveTestCellCents: Cents.default(40_000),
      /** Max daily spend per scaling venture; ramps with payback. */
      scaleDailyCapCents: Cents.default(100_000),
      /** Scale only while paid/creator spend pays back within this many days. */
      maxPaybackDays: z.number().int().min(1).default(60),
    })
    .prefault({}),

  autonomy: z
    .object({
      /** Action kinds that always wait for a human. */
      alwaysApprove: z
        .array(z.string())
        .default(["account.create", "store.create_app", "venture.scale"]),
      /** First store submission per venture needs a human; later updates are autonomous. */
      approveFirstSubmission: z.boolean().default(true),
      /** Spend actions above this need a human. */
      autoApproveBelowCents: Cents.default(25_000),
      /** No single action may commit more than this, approved or not. */
      hardActionCapCents: Cents.default(250_000),
      /** Wedges with minAge below this need a human (Bier's teen playbook is gated). */
      humanReviewBelowAge: z.number().int().default(18),
      /** Ideas touching these domains need a human before building. */
      humanReviewDomains: z
        .array(z.string())
        .default(["health", "mental_health", "finance", "legal", "minors", "biometric", "dating_safety"]),
      /** File whose existence halts every external action. */
      killSwitchFile: z.string().default("STOP"),
    })
    .prefault({}),

  lab: z
    .object({
      /** Posterior probability required to call pass or kill. */
      confidence: z.number().min(0.5).max(0.999).default(0.9),
      /** Bier: read a test within ~48h. Past this without a call, the harness is at fault. */
      maxHoursToRead: z.number().int().min(12).default(72),
      minSamplePerCell: z.number().int().min(20).default(300),
      replicationCells: z.number().int().min(1).default(2),
      /** Bier: fails in three communities => fails everywhere. */
      killAfterValidFailures: z.number().int().min(1).default(3),
      maxIterationsPerStage: z.number().int().min(1).default(5),
      /** No audience (wedge|geo|channel) gets more than one concept test per window. */
      audienceCooldownDays: z.number().int().min(0).default(56),
      /** Small, cheap markets for tests; never the scale market (Bier P4). */
      testGeos: z.array(z.string()).default(["CA", "AU", "NZ", "IE", "GB", "SE", "NL"]),
      scaleGeos: z.array(z.string()).default(["US"]),
    })
    .prefault({}),

  /** Pass/kill thresholds by metric. Defaults come from playbook/benchmarks.ts. */
  thresholds: z
    .object({
      /** S0: link clicks (or waitlist joins) per 1,000 views of concept hooks. */
      demandIntentPer1k: MetricThreshold.prefault({ pass: 6, kill: 2 }),
      /** S0: views per post median for concept hooks (attention). */
      hookViewsMedian: MetricThreshold.prefault({ pass: 3_000, kill: 600 }),
      /** S1: installs that reach first value. */
      activationRate: MetricThreshold.prefault({ pass: 0.45, kill: 0.25 }),
      /** S1: day-1 retention. */
      d1Retention: MetricThreshold.prefault({ pass: 0.3, kill: 0.15 }),
      /** S2: activated users who export the share artifact. */
      shareRate: MetricThreshold.prefault({ pass: 0.12, kill: 0.04 }),
      /** S3 (social ideas only): invite-driven installs per activated user, a K-factor proxy. Bier: K >= 1 is viral. */
      kFactor: MetricThreshold.prefault({ pass: 0.6, kill: 0.2 }),
      /** S4: installs that start a trial or buy. */
      trialStartRate: MetricThreshold.prefault({ pass: 0.1, kill: 0.04 }),
      /** S4: trials that convert to paid. */
      trialToPaid: MetricThreshold.prefault({ pass: 0.3, kill: 0.15 }),
      /** Guardrail: refunds as a share of gross revenue. */
      refundShareMax: z.number().min(0).max(1).default(0.12),
      /** Guardrail: one-star share of written reviews before the venture is paused for fixes. */
      oneStarShareMax: z.number().min(0).max(1).default(0.5),
    })
    .prefault({}),
});

export type StudioConfig = z.infer<typeof StudioConfig>;
export type MetricThreshold = z.infer<typeof MetricThreshold>;

export function defaultConfig(overrides: Partial<z.input<typeof StudioConfig>> = {}): StudioConfig {
  return StudioConfig.parse(overrides);
}
