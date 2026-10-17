/**
 * Registry of Nikita Bier's January 2022 thread principles (threadreaderapp 1481118406749220868)
 * with the studio's 2026 review and where each one is enforced. Quotes are verbatim as
 * quoted in docs/PRINCIPLES.md; the reviews summarise that document.
 */
import type { PrincipleId } from "../core/types.ts";

export type PrincipleScope = "idea" | "spec" | "experiment" | "portfolio";

export interface PrincipleDoc {
  id: PrincipleId;
  number: number;
  title: string;
  quote: string;
  appliesAt: PrincipleScope[];
  /** The rule the studio enforces in code, and where. */
  operationalization: string;
  review2026: { verdict: "holds" | "partly" | "adapted"; note: string };
}

export const PRINCIPLES: readonly PrincipleDoc[] = [
  {
    id: "P1_reproducible_testing",
    number: 1,
    title: "A reproducible testing process beats any idea",
    quote: "A reproducible testing process is more valuable than any one idea.",
    appliesAt: ["experiment", "portfolio"],
    operationalization:
      "lab/: no spend without a registered plan (hypothesis, one variable, floor/target/futility thresholds, power-based sample, validity checks, budget) frozen by registrationHash; validated tests per month is a company KPI.",
    review2026: {
      verdict: "holds",
      note: "Holds more strongly: AI makes ideas and builds cheap, so the testing harness is the only part competitors can't copy in a weekend.",
    },
  },
  {
    id: "P2_orchestrable_value",
    number: 2,
    title: "Most ideas are dead on arrival",
    quote: "Most product ideas are Dead On Arrival because the conditions to derive value are impossible to orchestrate.",
    appliesAt: ["idea"],
    operationalization:
      "principles/gates.ts gateP2: fail on more than 4 value conditions, any partnership dependency, or 7+ friends without single-player value; warn on 1-6 friends (needs a density-seeding plan).",
    review2026: {
      verdict: "holds",
      note: "Single-player AI verdict utilities (Vert, Cal AI, Umax, Quittr) need only one person plus one input, which can always be orchestrated; social apps are the gated path.",
    },
  },
  {
    id: "P3_narrow_wedge",
    number: 3,
    title: "Start with a narrow wedge",
    quote: "Don't be embarrassed to have a narrow target audience.",
    appliesAt: ["idea", "experiment"],
    operationalization:
      "principles/gates.ts gateP3: six-factor wedge score; social ideas need 4 of 6, single-player ideas a discoverable, owned-reach creator niche with at least 20 in-wedge creators; broad age ranges warn.",
    review2026: {
      verdict: "holds",
      note: "For AI utilities the wedge is usually an interest community reachable through a creator niche ('zodiac TikTok') rather than a school.",
    },
  },
  {
    id: "P4_no_nationwide_tests",
    number: 4,
    title: "Don't test nationwide",
    quote: "If you need to launch nationwide to test your product, it's not a good test.",
    appliesAt: ["experiment", "portfolio"],
    operationalization:
      "gateP4 plus lab/audiences: tests run only in small test storefronts (CA, AU, NZ); the scale market opens after venture.scale; a burned-audience registry allows one test per wedge|channel|platform|unit per cooldown.",
    review2026: {
      verdict: "holds",
      note: "Per-territory App Store availability and creator geo-targeting make small-market tests cheap (Bier's 2014 Malta test reached #1 in 48 hours on $500 of ads).",
    },
  },
  {
    id: "P5_replication",
    number: 5,
    title: "Works in one, works in all; fails in three, fails in all",
    quote:
      "If your product works in one community it should work in all of them. If it fails in three, it should fail in all of them.",
    appliesAt: ["experiment"],
    operationalization:
      "lab/decide: three matched cells per stage; all valid cells pass -> pass; a pass beside a fail with a flagged confound -> fix_harness; never scale on a mixed result.",
    review2026: {
      verdict: "adapted",
      note: "Read as a replication rule: one pass beside a matched failure signals a confound (outlier creator, broken attribution, warm traffic), not a working product.",
    },
  },
  {
    id: "P6_conclusive_tests",
    number: 6,
    title: "Inconclusive tests are the biggest slowdown",
    quote: "Nothing slows down teams more than inconclusive tests.",
    appliesAt: ["experiment"],
    operationalization:
      "lab/stats + decide: sample sizes from an exact power search; binary read at the deadline (pass iff P(p >= floor) >= confidence); invalid cells are harness bugs; unclear valid results are failures.",
    review2026: {
      verdict: "holds",
      note: "'Maybe we needed more downloads' is a statistics problem that pre-registration and power analysis prevent before launch.",
    },
  },
  {
    id: "P7_distribution_first",
    number: 7,
    title: "People and content beat design; filter ideas by distribution",
    quote:
      "The people and content on an app always trump slick design & novel interactions… filter your product ideas by whether you have a distribution channel.",
    appliesAt: ["idea", "spec", "experiment"],
    operationalization:
      "principles/gates.ts gateP7: an organic channel, a share artifact, at least 3 hooks and a creator niche are required; paid-only ideas are rejected.",
    review2026: {
      verdict: "holds",
      note: "For utilities, 'content' is the creator video about the output (Vert: 250+ creator partnerships, 400+ Astra TikToks in six weeks).",
    },
  },
  {
    id: "P8_activation_over_friction",
    number: 8,
    title: "Long signup flows are fine if activation rises",
    quote: "Excessively long sign up flows are fine if it leads to higher activation rates.",
    appliesAt: ["spec", "experiment"],
    operationalization:
      "principles/onboarding.ts: 8-16 steps, one AI-data consent before any data is collected, and a value preview or result teaser before an after-onboarding paywall (never paywall before the aha).",
    review2026: {
      verdict: "holds",
      note: "Now the dominant monetization pattern: multi-page onboarding paywalls convert 12.41% vs 9.07% single-page (Superwall 2026); onboarding must show value before asking for money.",
    },
  },
  {
    id: "P9_external_exposure",
    number: 9,
    title: "Habit needs recurring exposure on other networks",
    quote: "Habit formation requires recurring organic exposure on other networks.",
    appliesAt: ["idea", "spec", "experiment"],
    operationalization:
      "gateP9 and principles/product.ts: every spec has a 1-2 tap share artifact with a watermark and deep link; share rate is the S2 metric; creator cadence is the scaling lever.",
    review2026: {
      verdict: "partly",
      note: "For single-player utilities most outside exposure comes from creators, not users; share cards are a second loop and widgets supply the in-pocket reminder.",
    },
  },
  {
    id: "P10_toilet_test",
    number: 10,
    title: "The toilet test",
    quote:
      "If you can't use your app from the toilet or while distracted… your users will have few opportunities to form a habit.",
    appliesAt: ["idea", "spec"],
    operationalization:
      "principles/gates.ts gateP10: at most 5 taps and 15 seconds to first value (3 seconds target); sustained attention fails; required audio or voice, two-handed use and uninterruptible flows warn.",
    review2026: {
      verdict: "holds",
      note: "Bier quantified it in 2025: most installs happen in bed or on the toilet, and requiring sound or voice at signup is a '60% tax' on growth.",
    },
  },
  {
    id: "P11_core_needs",
    number: 11,
    title: "Love, money or play",
    quote: "People download apps to solve core human needs: (1) finding love, (2) making or saving money, and (3) play.",
    appliesAt: ["idea", "portfolio"],
    operationalization:
      "principles/gates.ts gateP11: love, money and play score fully; self_improvement is penalized unless it also maps to one of them; meetup and hang-out apps are a hard reject.",
    review2026: {
      verdict: "adapted",
      note: "Self-improvement (Cal AI, Umax, Quittr, Haven) behaves like a proven fourth need, often doubling as love or money.",
    },
  },
];

/** Rules from the other 14 tweets of the thread, and what enforces them. */
export const EXTRA_THREAD_RULES: readonly { id: string; rule: string; enforcedBy: string }[] = [
  {
    id: "name_after_first_community",
    rule: "If your first users are Berkeley students, go ahead & call the app Berkeley Memes (thread tweet 14): name the app after the first community.",
    enforcedBy: "designer brief (community identity in name, first screen and invite); principles/product.ts spec.name_candidates",
  },
  {
    id: "life_inflection_points",
    rule: "Great products take off by targeting a specific life inflection point (thread tweet 15).",
    enforcedBy: "principles/gates.ts gateP3 (wedge.inflectionPoint factor)",
  },
  {
    id: "obsessive_beachheads",
    rule: "Audiences that exhibit obsessive behavior (gamers, teens, and hobbyists) make the best beachheads (thread tweet 16).",
    enforcedBy: "principles/gates.ts gateP3 (wedge.obsessive factor)",
  },
  {
    id: "seven_opens_per_session",
    rule: "Aim for each app session to trigger 7 new people to open your app (thread tweet 19).",
    enforcedBy: "lab social ladder: S2_sharing shareRate and S3_cross_cell kFactor >= 1.0",
  },
  {
    id: "never_meetup_app",
    rule: 'Never build an app to "meetup with friends." (thread tweet 13).',
    enforcedBy: "principles/gates.ts gateP11 (meetup and hang-out pattern is a hard fail)",
  },
  {
    id: "partnership_run",
    rule: 'If your product requires a "partnership", run (thread tweet 22).',
    enforcedBy: "principles/gates.ts gateP2 (requiresPartnership is a hard fail)",
  },
];

/** A principle by id. Throws if unknown. */
export function principle(id: PrincipleId): PrincipleDoc {
  const doc = PRINCIPLES.find((p) => p.id === id);
  if (!doc) throw new Error(`unknown principle: ${id}`);
  return doc;
}
