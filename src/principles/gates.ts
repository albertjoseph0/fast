/**
 * Idea gates: Bier's principles as deterministic checks over an ideator's Idea, plus the
 * compliance and differentiation gates. LLM critiques may lower a score or veto an idea,
 * but only these gates can advance one.
 */
import type { StudioConfig } from "../config/schema.ts";
import type { AudienceExposure } from "../core/store.ts";
import type { ChannelKind, Critique, GateResult, Idea, Iso, Screening, SensitiveDomain, Wedge } from "../core/types.ts";
import { ladderFor } from "./ladder.ts";
import { effectiveDomains, minimumAgeFor } from "./sensitivity.ts";

export interface ScreenInput {
  screeningId: string;
  ideaId: string;
  idea: Idea;
  config: StudioConfig;
  now: Iso;
  exposures: AudienceExposure[];
  critiques: Critique[];
  classifierDomains: SensitiveDomain[];
  /** The classifier's minimum user age; the younger of it and the wedge's minAge decides the minors gate. */
  classifierMinimumAge?: number;
  existingTitles: string[];
}

const WEDGE_FACTORS = ["coPresence", "discoverable", "inflectionPoint", "obsessive", "urgency", "ownedReach"] as const;

/** Channels the studio can reach without buying every user (Bier P7). */
export const ORGANIC_CHANNELS: readonly ChannelKind[] = ["creator_ugc", "owned_social", "share_loop", "invite_loop", "seo"];

const MAX_VALUE_CONDITIONS = 4;
const MAX_FRIENDS_WITHOUT_SINGLE_PLAYER = 7;
const SOCIAL_MIN_FACTOR_SUM = 4;
const MIN_FACTOR = 0.5;
const MIN_REACHABLE_CREATORS = 20;
const MAX_AGE_SPAN = 25;
const MIN_HOOKS = 3;
const MAX_TAPS = 5;
const MAX_SECONDS_TO_VALUE = 15;
const TARGET_SECONDS_TO_VALUE = 3;
const MIN_DIFFERENTIATION_CHARS = 40;
const DAY_MS = 86_400_000;

/** Score weights per gate; they sum to 1. P4 and compliance gates decide verdicts only. */
export const GATE_WEIGHTS: Readonly<Partial<Record<GateResult["gate"], number>>> = {
  P2_orchestrable_value: 0.2,
  P3_narrow_wedge: 0.15,
  P7_distribution_first: 0.2,
  P9_external_exposure: 0.1,
  P10_toilet_test: 0.15,
  P11_core_needs: 0.15,
  "compliance.differentiation": 0.05,
};

const GATE_SHARE = 0.7;
const CRITIQUE_SHARE = 0.3;
const CRITIQUE_VETOES = 2;

/** Rescale wedge factors the LLM wrote on a 0..10 or 0..100 scale to 0..1 and trim strings. */
export function normalizeIdea(idea: Idea): Idea {
  const raw = WEDGE_FACTORS.map((f) => idea.wedge[f]);
  const max = Math.max(...raw.map((v) => (Number.isFinite(v) ? v : 0)));
  const divisor = max > 10 ? 100 : max > 1 ? 10 : 1;
  const factors = Object.fromEntries(
    WEDGE_FACTORS.map((f) => [f, clamp01(Number.isFinite(idea.wedge[f]) ? idea.wedge[f] / divisor : 0)]),
  ) as Pick<Wedge, (typeof WEDGE_FACTORS)[number]>;
  return {
    ...idea,
    title: idea.title.trim(),
    oneLiner: idea.oneLiner.trim(),
    wedge: {
      ...idea.wedge,
      ...factors,
      name: idea.wedge.name.trim(),
      description: idea.wedge.description.trim(),
      locale: idea.wedge.locale.trim(),
      creatorNiche: idea.wedge.creatorNiche.trim(),
      estimatedReachableCreators: Math.max(0, Math.round(idea.wedge.estimatedReachableCreators)),
    },
    verdictMoment: idea.verdictMoment.trim(),
    aiCapability: idea.aiCapability.trim(),
    valueConditions: trimAll(idea.valueConditions),
    minFriendsForValue: Math.max(0, Math.round(idea.minFriendsForValue)),
    shareArtifact: idea.shareArtifact.trim(),
    hookExamples: trimAll(idea.hookExamples),
    monetization: { ...idea.monetization, payFor: idea.monetization.payFor.trim() },
    sensitiveDomains: [...new Set(idea.sensitiveDomains)],
    differentiation: idea.differentiation.trim(),
  };
}

/** P2: value must be orchestrable by the studio alone. */
export function gateP2(idea: Idea): GateResult {
  const fails: string[] = [];
  const n = idea.valueConditions.length;
  if (n > MAX_VALUE_CONDITIONS) fails.push(`${n} value conditions (max ${MAX_VALUE_CONDITIONS})`);
  if (idea.requiresPartnership) fails.push("value depends on a partnership");
  if (!idea.singlePlayerValue && idea.minFriendsForValue >= MAX_FRIENDS_WITHOUT_SINGLE_PLAYER) {
    fails.push(`needs ${idea.minFriendsForValue} friends with no single-player value`);
  }
  if (fails.length > 0) return result("P2_orchestrable_value", "fail", 0, fails.join("; "));
  const conditionScore = 1 - 0.1 * Math.max(0, n - 2);
  if (idea.minFriendsForValue > 0) {
    return result("P2_orchestrable_value", "warn", conditionScore * 0.6, `needs ${idea.minFriendsForValue} friends: requires a density-seeding plan`);
  }
  return result("P2_orchestrable_value", "pass", conditionScore, `${n} value conditions, single-player value`);
}

/** P3: a narrow wedge. Social ideas need 4 of 6 factors; single-player ideas a reachable creator niche. */
export function gateP3(idea: Idea): GateResult {
  const w = idea.wedge;
  const ageSpanWarn = w.maxAge - w.minAge > MAX_AGE_SPAN ? `age range ${w.minAge}-${w.maxAge} is broad` : null;
  if (ladderFor(idea) === "social") {
    const sum = WEDGE_FACTORS.reduce((s, f) => s + w[f], 0);
    if (sum < SOCIAL_MIN_FACTOR_SUM) {
      return result("P3_narrow_wedge", "fail", 0, `social wedge factor sum ${sum.toFixed(2)} < ${SOCIAL_MIN_FACTOR_SUM} of 6`);
    }
    const score = sum / WEDGE_FACTORS.length;
    return ageSpanWarn
      ? result("P3_narrow_wedge", "warn", score * 0.85, ageSpanWarn)
      : result("P3_narrow_wedge", "pass", score, `social wedge factor sum ${sum.toFixed(2)} of 6`);
  }
  const fails: string[] = [];
  if (w.discoverable < MIN_FACTOR) fails.push(`discoverable ${w.discoverable.toFixed(2)} < ${MIN_FACTOR}`);
  if (w.ownedReach < MIN_FACTOR) fails.push(`ownedReach ${w.ownedReach.toFixed(2)} < ${MIN_FACTOR}`);
  if (w.estimatedReachableCreators < MIN_REACHABLE_CREATORS) {
    fails.push(`${w.estimatedReachableCreators} reachable creators < ${MIN_REACHABLE_CREATORS}`);
  }
  if (fails.length > 0) return result("P3_narrow_wedge", "fail", 0, fails.join("; "));
  const score = (w.discoverable + w.ownedReach + w.obsessive + Math.min(1, w.estimatedReachableCreators / 50)) / 4;
  return ageSpanWarn
    ? result("P3_narrow_wedge", "warn", score * 0.85, ageSpanWarn)
    : result("P3_narrow_wedge", "pass", score, `creator niche "${w.creatorNiche}" with ${w.estimatedReachableCreators} creators`);
}

/** P4: a small test market must exist for the wedge locale, and the wedge must not be burned. */
export function gateP4(idea: Idea, config: StudioConfig, exposures: AudienceExposure[], now: Iso): GateResult {
  const warns: string[] = [];
  const locale = idea.wedge.locale;
  const lang = locale.split("-")[0]?.toLowerCase() ?? "";
  const geos = lang === "en" ? config.lab.testGeos : (config.lab.localizedTestGeos[locale] ?? config.lab.localizedTestGeos[lang] ?? []);
  if (geos.length === 0) warns.push(`no test geos configured for locale ${locale}`);
  const nowMs = Date.parse(now);
  const wedgeKey = idea.wedge.name.toLowerCase();
  const recent = exposures.filter(
    (e) => e.wedge.trim().toLowerCase() === wedgeKey && (nowMs - Date.parse(e.at)) / DAY_MS < config.lab.audienceCooldownDays,
  );
  if (recent.length > 0) {
    warns.push(`wedge "${idea.wedge.name}" was exposed ${recent.length}x within the ${config.lab.audienceCooldownDays}-day cooldown`);
  }
  return warns.length > 0
    ? result("P4_no_nationwide_tests", "warn", 0.5, warns.join("; "))
    : result("P4_no_nationwide_tests", "pass", 1, `test geos ${geos.join(", ")}`);
}

/** P7: distribution first. Paid-only ideas are rejected. */
export function gateP7(idea: Idea): GateResult {
  const channels = [idea.primaryChannel, ...idea.secondaryChannels];
  const fails: string[] = [];
  if (!channels.some((c) => ORGANIC_CHANNELS.includes(c))) fails.push(`no organic channel among ${channels.join(", ")}`);
  if (idea.hookExamples.length < MIN_HOOKS) fails.push(`${idea.hookExamples.length} hooks (min ${MIN_HOOKS})`);
  if (!idea.shareArtifact.trim()) fails.push("no share artifact");
  if (!idea.wedge.creatorNiche.trim()) fails.push("no creator niche");
  if (idea.primaryChannel === "creator_ugc" && idea.wedge.estimatedReachableCreators < MIN_REACHABLE_CREATORS) {
    fails.push(`creator_ugc primary with ${idea.wedge.estimatedReachableCreators} reachable creators (min ${MIN_REACHABLE_CREATORS})`);
  }
  if (fails.length > 0) return result("P7_distribution_first", "fail", 0, fails.join("; "));
  if (!ORGANIC_CHANNELS.includes(idea.primaryChannel)) {
    return result("P7_distribution_first", "warn", 0.6, `primary channel ${idea.primaryChannel} is not organic`);
  }
  return result("P7_distribution_first", "pass", 1, `organic primary ${idea.primaryChannel}, ${idea.hookExamples.length} hooks`);
}

/** P9: the output must be postable on other networks; a share loop earns the full score. */
export function gateP9(idea: Idea): GateResult {
  if (!idea.shareArtifact.trim()) return result("P9_external_exposure", "warn", 0, "no share artifact for exposure on other networks");
  const loop = idea.primaryChannel === "share_loop" || idea.secondaryChannels.includes("share_loop");
  return result("P9_external_exposure", "pass", loop ? 1 : 0.7, `share artifact "${idea.shareArtifact}"${loop ? " with a share loop" : ""}`);
}

/** P10: the toilet test. */
export function gateP10(idea: Idea): GateResult {
  const i = idea.interaction;
  const fails: string[] = [];
  if (i.tapsToCoreAction > MAX_TAPS) fails.push(`${i.tapsToCoreAction} taps to core action (max ${MAX_TAPS})`);
  if (i.secondsToFirstValue > MAX_SECONDS_TO_VALUE) fails.push(`${i.secondsToFirstValue}s to first value (max ${MAX_SECONDS_TO_VALUE})`);
  if (i.requiresSustainedAttention) fails.push("requires sustained attention");
  if (fails.length > 0) return result("P10_toilet_test", "fail", 0, fails.join("; "));
  const warns: string[] = [];
  if (i.secondsToFirstValue > TARGET_SECONDS_TO_VALUE) warns.push(`${i.secondsToFirstValue}s to first value (target ${TARGET_SECONDS_TO_VALUE})`);
  if (i.requiresAudio || i.requiresVoiceInput) warns.push("requires sound or voice (Bier: a 60% tax on growth)");
  if (!i.oneHanded) warns.push("not one-handed");
  if (!i.interruptible) warns.push("not interruptible");
  if (warns.length > 0) return result("P10_toilet_test", "warn", Math.max(0.3, 1 - 0.15 * warns.length), warns.join("; "));
  return result("P10_toilet_test", "pass", 1, `${i.tapsToCoreAction} taps, ${i.secondsToFirstValue}s to first value`);
}

const MEETUP_PATTERN =
  /\b(meet[- ]?ups?|meet up|hang(ing)?[- ]?outs?|hang out|make plans with (your )?friends|plans? with friends|find (people|friends) nearby|meet (new )?(people|friends) (nearby|near you|irl)|irl (events?|plans))\b/i;

/** P11: love, money or play; self-improvement is penalized unless it maps to one; never a meetup app. */
export function gateP11(idea: Idea): GateResult {
  const text = [idea.title, idea.oneLiner, idea.aiCapability, idea.verdictMoment, idea.wedge.description, ...idea.valueConditions].join("\n");
  const meetup = MEETUP_PATTERN.exec(text);
  if (meetup) return result("P11_core_needs", "fail", 0, `meetup / hang-out app ("${meetup[0]}"): Bier, never build one`);
  if (idea.coreNeed !== "self_improvement") return result("P11_core_needs", "pass", 1, `core need ${idea.coreNeed}`);
  const mapped = idea.secondaryNeeds.find((n) => n !== "self_improvement");
  return mapped
    ? result("P11_core_needs", "pass", 0.85, `self_improvement that also maps to ${mapped}`)
    : result("P11_core_needs", "warn", 0.7, "self_improvement without love, money or play");
}

/**
 * Minors, human-review domains and classifier disagreement each need a human. The youngest
 * user is the lower of the wedge's minAge and the classifier's minimum age.
 */
export function gateCompliance(idea: Idea, config: StudioConfig, classifierDomains: SensitiveDomain[], classifierMinimumAge?: number): GateResult[] {
  const domains = effectiveDomains(idea, classifierDomains);
  const { autonomousMinAge, humanReviewDomains } = config.autonomy;
  const classifierAge = classifierMinimumAge !== undefined && Number.isFinite(classifierMinimumAge) ? classifierMinimumAge : Infinity;
  const minAge = Math.min(idea.wedge.minAge, classifierAge);
  const rating = minimumAgeFor({ ...idea, wedge: { ...idea.wedge, minAge } }, domains);
  const source = classifierAge < idea.wedge.minAge ? `classifier puts the youngest users at ${minAge} (wedge says ${idea.wedge.minAge})` : `wedge starts at age ${minAge}`;
  const minors =
    minAge < autonomousMinAge
      ? result("compliance.minors", "needs_human", 0, `${source} (< ${autonomousMinAge}); store rating ${rating}+`)
      : result("compliance.minors", "pass", 1, `${source}; store rating ${rating}+`);
  const review = domains.filter((d) => humanReviewDomains.includes(d));
  const sensitive =
    review.length > 0
      ? result("compliance.sensitive_domain", "needs_human", 0, `human-review domains: ${review.join(", ")}`)
      : result("compliance.sensitive_domain", "pass", 1, domains.length > 0 ? `domains ${domains.join(", ")} need no review` : "no sensitive domains");
  const undeclared = [...new Set(classifierDomains)].filter((d) => !idea.sensitiveDomains.includes(d)).sort();
  const disagreement =
    undeclared.length > 0
      ? result("compliance.classifier_disagreement", "needs_human", 0, `classifier found undeclared domains: ${undeclared.join(", ")}`)
      : result("compliance.classifier_disagreement", "pass", 1, "classifier agrees with the declared domains");
  return [minors, sensitive, disagreement];
}

/** Apple 4.3: no duplicate of an existing title, and a stated differentiation. */
export function gateDifferentiation(idea: Idea, existingTitles: string[]): GateResult {
  const title = idea.title.trim().toLowerCase();
  if (existingTitles.some((t) => t.trim().toLowerCase() === title)) {
    return result("compliance.differentiation", "fail", 0, `duplicate title "${idea.title}"`);
  }
  if (idea.differentiation.trim().length < MIN_DIFFERENTIATION_CHARS) {
    return result("compliance.differentiation", "warn", 0.5, `differentiation is under ${MIN_DIFFERENTIATION_CHARS} characters`);
  }
  return result("compliance.differentiation", "pass", 1, "distinct title and stated differentiation");
}

/**
 * Screen an idea. Gate score = 100 x the weighted gate scores (GATE_WEIGHTS). With critiques,
 * the final score is 0.7 x gate score + 0.3 x mean critique score (0..10) x 10. Verdict order:
 * any failed gate or two funding vetoes with fatal flaws reject; any needs_human gate waits for
 * a human; a score below portfolio.minScreenScore rejects; otherwise the idea advances.
 */
export function screenIdea(input: ScreenInput): Screening {
  const idea = normalizeIdea(input.idea);
  const gates: GateResult[] = [
    gateP2(idea),
    gateP3(idea),
    gateP4(idea, input.config, input.exposures, input.now),
    gateP7(idea),
    gateP9(idea),
    gateP10(idea),
    gateP11(idea),
    ...gateCompliance(idea, input.config, input.classifierDomains, input.classifierMinimumAge),
    gateDifferentiation(idea, input.existingTitles),
  ];
  const gateScore = 100 * gates.reduce((s, g) => s + (GATE_WEIGHTS[g.gate] ?? 0) * clamp01(g.score), 0);
  const critiqueMean =
    input.critiques.length > 0 ? input.critiques.reduce((s, c) => s + critiqueScore(c.score), 0) / input.critiques.length : null;
  const score = round1(critiqueMean === null ? gateScore : GATE_SHARE * gateScore + CRITIQUE_SHARE * critiqueMean * 10);

  const reasons = gates.filter((g) => g.verdict !== "pass").map((g) => `${g.gate} ${g.verdict}: ${g.reason}`);
  const vetoes = input.critiques.filter((c) => !c.wouldFund && c.fatalFlaws.length > 0);
  const vetoed = vetoes.length >= CRITIQUE_VETOES;
  if (vetoed) reasons.push(`critics veto (${vetoes.map((c) => c.lens).join(", ")}): ${vetoes.flatMap((c) => c.fatalFlaws).join("; ")}`);
  const minScore = input.config.portfolio.minScreenScore;
  const lowScore = score < minScore;
  if (lowScore) reasons.push(`score ${score} < ${minScore}`);

  const verdict: Screening["verdict"] =
    gates.some((g) => g.verdict === "fail") || vetoed
      ? "reject"
      : gates.some((g) => g.verdict === "needs_human")
        ? "needs_human"
        : lowScore
          ? "reject"
          : "advance";

  return {
    id: input.screeningId,
    ideaId: input.ideaId,
    gates,
    critiques: input.critiques,
    sensitiveDomains: effectiveDomains(idea, input.classifierDomains),
    score,
    verdict,
    reasons,
    screenedAt: input.now,
  };
}

function result(gate: GateResult["gate"], verdict: GateResult["verdict"], score: number, reason: string): GateResult {
  return { gate, verdict, score: clamp01(score), reason };
}

/** Critique scores are 0..10; an LLM that answered on 0..100 is rescaled. */
function critiqueScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.min(10, Math.max(0, score > 10 ? score / 10 : score));
}

function trimAll(items: string[]): string[] {
  return items.map((s) => s.trim()).filter((s) => s.length > 0);
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
