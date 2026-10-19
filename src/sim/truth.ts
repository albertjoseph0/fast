/**
 * Ground truth for a simulated venture: the funnel rates the market will actually
 * deliver, drawn once from the idea's features plus a large lognormal "luck" factor.
 *
 * Features move the odds the way the principles say they should (fast verdicts, core
 * needs, single-player value, the toilet test), but luck dominates, so most ideas miss
 * the floors and a few clear them by a wide margin, like a real portfolio.
 */
import { hashString, Rng } from "../core/rng.ts";
import type { CoreNeed, Idea, SensitiveDomain } from "../core/types.ts";

export interface VentureTruth {
  /** Overall attractiveness multiplier (median about 1); drives attention and intent. */
  appeal: number;
  /** In-storefront installs per in-geo creator view, in raw units (0.0015 = 1.5 per 1K views). */
  installsPer1kViews: number;
  activationRate: number;
  trialStartRate: number;
  trialKeep24h: number;
  /** P(first charge succeeds | trial still auto-renewing at 24h). */
  trialToPaidGivenKeep: number;
  weeklyFirstRenewal: number;
  weeklyRenewal: number;
  refundRate: number;
  oneStarShare: number;
  shareRate: number;
  /** Invite-driven installs per activated user within 7 days. */
  kFactor: number;
  /** Word-of-mouth installs per day per 1K cumulative installs in a storefront. */
  organicDailyPer1kInstalls: number;
  decayHalfLifeDays: number;
}

const NEED: Record<CoreNeed, number> = { love: 1.15, money: 1.1, play: 1.05, self_improvement: 0.72 };

const MODEL_TRIAL: Record<Idea["monetization"]["model"], number> = { hard_paywall: 1.3, soft_paywall: 0.85, freemium: 0.35, consumable: 0.6 };

/** Domains whose users ask for refunds and complain more (wellness promises, fortune, money). */
const REFUND_PRONE: ReadonlySet<SensitiveDomain> = new Set([
  "health",
  "mental_health",
  "finance",
  "appearance_rating",
  "astrology_fortune",
  "dating_safety",
  "ai_companion",
  "gambling",
]);

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Same rule as principles/ladder.ts: social iff no single-player value, friends needed, or invite-led. */
export function isSocialIdea(idea: Idea): boolean {
  return !idea.singlePlayerValue || idea.minFriendsForValue > 0 || idea.primaryChannel === "invite_loop";
}

/** Bier's single-school seeding: a physically co-present community makes "friends needed" survivable. */
function seeded(idea: Idea): boolean {
  return idea.wedge.kind === "physical_community" && idea.wedge.coPresence >= 0.5;
}

function speedFactor(seconds: number): number {
  if (seconds <= 3) return 1.3;
  if (seconds <= 8) return 1;
  if (seconds <= 15) return 0.8;
  return 0.55;
}

/** Attention the concept earns before luck: what a hook can promise in the first seconds. */
function attention(idea: Idea): number {
  const w = idea.wedge;
  const verdict = idea.verdictMoment.trim().length > 0 ? 1 : 0.7;
  const hooks = idea.hookExamples.length >= 3 ? 1 : 0.8;
  const taps = idea.interaction.tapsToCoreAction > 5 ? 0.85 : 1;
  const wedge = (0.75 + 0.5 * clamp(w.obsessive, 0, 1)) * (0.85 + 0.3 * clamp(w.urgency, 0, 1));
  return NEED[idea.coreNeed] * speedFactor(idea.interaction.secondsToFirstValue) * verdict * hooks * taps * wedge;
}

function activationBase(idea: Idea): number {
  const n = idea.valueConditions.length;
  const conditions = n > 4 ? 0.5 : 1 - 0.04 * Math.max(0, n - 1);
  const friends = idea.minFriendsForValue > 0 && !idea.singlePlayerValue && !seeded(idea) ? 0.3 : 1;
  const sustained = idea.interaction.requiresSustainedAttention ? 0.4 : 1;
  const audio = idea.interaction.requiresAudio || idea.interaction.requiresVoiceInput ? 0.75 : 1;
  const taps = idea.interaction.tapsToCoreAction > 5 ? 0.85 : 1;
  return 0.56 * (idea.singlePlayerValue ? 1 : 0.7) * conditions * friends * sustained * audio * taps;
}

/** Draw a venture's ground truth. Pass a forked Rng (e.g. rng.fork(`truth:${ventureId}`)). */
export function truthFor(idea: Idea, rng: Rng): VentureTruth {
  const luck = rng.lognormal(1, 0.85);
  const appeal = attention(idea) * luck;
  const hard = idea.monetization.model === "hard_paywall";
  const sensitive = idea.sensitiveDomains.some((d) => REFUND_PRONE.has(d));
  const channels = [idea.primaryChannel, ...idea.secondaryChannels];
  const social = isSocialIdea(idea);

  return {
    appeal,
    installsPer1kViews: clamp(0.0013 * appeal ** 1.1 * rng.lognormal(1, 0.15), 0.00005, 0.03),
    activationRate: clamp(activationBase(idea) * appeal ** 0.25 * rng.lognormal(1, 0.1), 0.02, 0.92),
    trialStartRate: clamp(0.11 * MODEL_TRIAL[idea.monetization.model] * appeal ** 0.4 * rng.lognormal(1, 0.2), 0.003, 0.55),
    trialKeep24h: clamp(0.46 * appeal ** 0.12 * rng.lognormal(1, 0.1), 0.12, 0.88),
    trialToPaidGivenKeep: clamp(0.84 * rng.lognormal(1, 0.05), 0.5, 0.97),
    weeklyFirstRenewal: clamp(0.65 * appeal ** 0.08 * rng.lognormal(1, 0.07), 0.3, 0.9),
    weeklyRenewal: clamp(0.88 * rng.lognormal(1, 0.025), 0.6, 0.97),
    refundRate: clamp(0.035 * (sensitive ? 1.8 : 1) * (hard ? 1.2 : 1) * rng.lognormal(1, 0.25), 0.005, 0.3),
    oneStarShare: clamp((0.12 * (hard ? 1.6 : 1) * (sensitive ? 1.2 : 1) * rng.lognormal(1, 0.2)) / appeal ** 0.35, 0.02, 0.85),
    shareRate: clamp((0.05 + (channels.includes("share_loop") ? 0.09 : 0)) * appeal ** 0.3 * rng.lognormal(1, 0.3), 0.003, 0.6),
    kFactor: social
      ? clamp(rng.lognormal(0.5, 0.55) * (idea.primaryChannel === "invite_loop" ? 1.25 : 1) * appeal ** 0.2, 0, 3)
      : clamp(rng.lognormal(0.03, 0.5), 0, 0.3),
    organicDailyPer1kInstalls: 3 * appeal ** 0.5 * rng.lognormal(1, 0.3),
    decayHalfLifeDays: clamp(rng.lognormal(24, 0.45), 5, 180),
  };
}

/**
 * Effect of one variant value on the metric its key controls: a deterministic
 * lognormal(0, 0.15) multiplier, so the same variant always has the same true effect.
 */
export function variantMultiplier(ventureId: string, key: string, value: string | number | boolean, seed: number): number {
  const z = new Rng(hashString(`${seed}:variant:${ventureId}:${key}:${String(value)}`)).normal();
  return Math.exp(0.15 * z);
}
