/**
 * Deterministic stub LLM for simulations and tests.
 *
 * Every call derives its randomness from the seed, the schema name and the canonical
 * input alone, so an output never depends on call order or on which other calls ran.
 * Generators read the typed input directly (never prompts) and return outputs that
 * parse with the schema and stay consistent with the input.
 */
import {
  SCHEMAS,
  type BoardMemo,
  type ComplianceReview,
  type ContentBatch,
  type IdeaBatch,
  type SchemaInputs,
  type SchemaName,
  type SchemaOutputs,
  type SensitivityReview,
  type SignalDigest,
  type SubmissionReview,
  type VariantChangeKind,
  type VariantProposal,
} from "../agents/schemas.ts";
import type { LlmObjectRequest, LlmPort, LlmTextRequest, LlmUsage } from "../core/ports.ts";
import { Rng, hashString } from "../core/rng.ts";
import type { AppSpec, ContentDraft, CoreNeed, Critique, CreatorBrief, Idea, SensitiveDomain } from "../core/types.ts";
import { lintCopy, type CopySurface } from "../principles/copy.ts";
import { classifyDomains, canonicalJson, ideaText, nicheTopic, reviewMinimumAge, truncateWords } from "./stub-classify.ts";
import { FLAWED_ARCHETYPES, GOOD_ARCHETYPES, ideaFromArchetype, type IdeaArchetype } from "./stub-ideas.ts";
import { buildAppSpec, normalizeOnboarding, repairAppSpec } from "./stub-spec.ts";

type Generator<N extends SchemaName> = (input: SchemaInputs[N], rng: Rng, untrusted: { label: string; text: string }[]) => SchemaOutputs[N];

const FLAWED_SHARE = 0.25;

// ---------------------------------------------------------------------------
// IdeaBatch
// ---------------------------------------------------------------------------

/** Weighted sampling without replacement (Efraimidis-Spirakis keys). */
function sampleWeighted<T>(items: readonly T[], n: number, weight: (t: T) => number, rng: Rng): T[] {
  return items
    .map((item) => ({ item, key: Math.pow(rng.next(), 1 / Math.max(1e-6, weight(item))) }))
    .sort((a, b) => b.key - a.key)
    .slice(0, n)
    .map((x) => x.item);
}

const REMIX_SUFFIXES = ["Go", "AI", "Pro", "Daily", "Plus", "Now"];

function ideaBatch(input: SchemaInputs["IdeaBatch"], rng: Rng): IdeaBatch {
  const count = Math.max(0, Math.floor(input.count));
  const avoid = new Set(input.avoidTitles.map((t) => t.trim().toLowerCase()));
  const signalText = input.signals.map((s) => `${s.title} ${s.detail} ${s.tags.join(" ")}`).join(" ").toLowerCase();
  const weight = (a: IdeaArchetype): number => {
    const overlap = a.tags.filter((t) => signalText.includes(t)).length;
    const needOk = input.coreNeeds.length === 0 || input.coreNeeds.includes(a.coreNeed);
    return (1 + 2 * overlap) * (needOk ? 1 : 0.25);
  };
  const fresh = (a: IdeaArchetype): boolean => !avoid.has(a.title.toLowerCase());

  const nFlawed = Math.round(count * FLAWED_SHARE);
  const flawed = sampleWeighted(FLAWED_ARCHETYPES.filter(fresh), nFlawed, weight, rng);
  const good = sampleWeighted(GOOD_ARCHETYPES.filter(fresh), count - flawed.length, weight, rng);
  const picked: { archetype: IdeaArchetype; title: string }[] = [...flawed, ...good].map((a) => ({ archetype: a, title: a.title }));

  // Library exhausted: remix archetypes under new working titles.
  const used = new Set([...avoid, ...picked.map((p) => p.title.toLowerCase())]);
  const library = [...GOOD_ARCHETYPES, ...FLAWED_ARCHETYPES];
  for (const suffix of REMIX_SUFFIXES) {
    for (const a of rng.shuffle(library)) {
      if (picked.length >= count) break;
      const title = `${a.title} ${suffix}`;
      if (used.has(title.toLowerCase())) continue;
      used.add(title.toLowerCase());
      picked.push({ archetype: a, title });
    }
  }
  let n = 2;
  while (picked.length < count) {
    const a = rng.pick(library);
    const title = `${a.title} ${n++}`;
    if (used.has(title.toLowerCase())) continue;
    used.add(title.toLowerCase());
    picked.push({ archetype: a, title });
  }

  return { ideas: rng.shuffle(picked.slice(0, count)).map((p) => ideaFromArchetype(p.archetype, rng, p.title)) };
}

// ---------------------------------------------------------------------------
// Critique and sensitivity
// ---------------------------------------------------------------------------

function effectiveDomains(idea: Idea): SensitiveDomain[] {
  return [...new Set([...idea.sensitiveDomains, ...classifyDomains(ideaText(idea)).map((m) => m.domain)])];
}

function critique(input: SchemaInputs["Critique"], rng: Rng): Critique {
  const { idea, lens } = input;
  const ia = idea.interaction;
  const fatalFlaws: string[] = [];
  const risks: string[] = [];
  const fixes: string[] = [];
  let score: number;

  if (lens === "bier_skeptic") {
    score = 8;
    if (!idea.singlePlayerValue || idea.minFriendsForValue >= 7) {
      score -= 4;
      fatalFlaws.push(`Needs ${idea.minFriendsForValue} friends on the app before a user gets value`);
      fixes.push("Give a lone user the full verdict with zero friends on the app");
    } else if (idea.minFriendsForValue > 0) {
      score -= 1.5;
      risks.push(`Value depends on ${idea.minFriendsForValue} other people joining`);
    }
    if (ia.requiresSustainedAttention) {
      score -= 3;
      fatalFlaws.push("Requires sustained attention, so it fails the toilet test");
      fixes.push("Deliver the verdict in a few seconds without live video or long sessions");
    }
    const vc = idea.valueConditions.length;
    if (vc > 4) {
      score -= 3;
      fatalFlaws.push(`${vc} value conditions must all hold before anyone gets value`);
      fixes.push("Cut the value conditions to the two that matter");
    } else if (vc > 2) {
      score -= 0.7 * (vc - 2);
      risks.push(`${vc} value conditions narrow the reachable audience`);
    }
    if (idea.requiresPartnership) {
      score -= 3;
      fatalFlaws.push("Depends on a partnership the studio cannot orchestrate");
    }
    if (ia.tapsToCoreAction > 5 || ia.secondsToFirstValue > 15) {
      score -= 1.5;
      risks.push(`First value takes ${ia.tapsToCoreAction} taps and ${ia.secondsToFirstValue}s`);
      fixes.push("Get to the first verdict in under five taps and fifteen seconds");
    }
    if (idea.coreNeed === "self_improvement" && !idea.secondaryNeeds.some((n) => n !== "self_improvement")) {
      score -= 1;
      risks.push("Self-improvement without a love, money or play angle rarely holds attention");
    }
  } else if (lens === "growth_realist") {
    const creators = idea.wedge.estimatedReachableCreators;
    score = 3.5 + Math.min(3, Math.log10(Math.max(1, creators)));
    score += Math.min(1.5, 0.5 * Math.max(0, idea.hookExamples.length - 2));
    score += idea.wedge.obsessive + 0.5 * idea.wedge.discoverable;
    if (idea.hookExamples.length < 3) risks.push("Fewer than three hooks to test");
    if (idea.shareArtifact.trim()) {
      score += 1;
    } else {
      score -= 1.5;
      fatalFlaws.push("No share artifact, so every install has to be bought");
      fixes.push("Design a result card users want to post");
    }
    if (idea.primaryChannel === "paid_ads") {
      score -= 3;
      fatalFlaws.push("Paid ads as the primary channel with no organic engine");
      fixes.push("Lead with creator UGC in a niche whose audience is the wedge");
    }
    if (creators < 20) {
      score -= 1;
      risks.push(`Only about ${creators} in-wedge creators; three matched cells need more`);
    }
  } else {
    score = 8.5;
    const domains = effectiveDomains(idea);
    for (const d of domains) {
      score -= d === "religion" ? 0.5 : 1.2;
      risks.push(`${d.replace(/_/g, " ")} content needs extra store and policy review`);
    }
    if (/\b(diagnos\w*|symptoms?)\b/i.test(ideaText(idea))) {
      score -= 3;
      fatalFlaws.push("Diagnosing conditions is a regulated medical claim");
      fixes.push("Reframe as general wellness information with no diagnosis");
    }
    if (domains.includes("minors") || idea.wedge.minAge < 16) {
      score -= 3;
      fatalFlaws.push(`Wedge starts at age ${idea.wedge.minAge}; teen apps need parental and store safeguards`);
    } else if (idea.wedge.minAge < 18) {
      score -= 1;
      risks.push("Under-18 users need human review");
    }
    if (idea.differentiation.trim().length < 60) {
      score -= 1.5;
      risks.push("Thin differentiation invites an Apple 4.3 spam rejection");
      fixes.push("State concretely how the output differs from the top three competitors");
    }
  }

  score = Math.round(Math.min(10, Math.max(0, score + rng.uniform(-0.3, 0.3))) * 10) / 10;
  return { lens, score, fatalFlaws, risks, fixes, wouldFund: fatalFlaws.length === 0 && score >= 6 };
}

function sensitivity(input: SchemaInputs["SensitivityReview"]): SensitivityReview {
  const matches = classifyDomains(ideaText(input.idea));
  const domains = matches.map((m) => m.domain);
  const minimumAge = reviewMinimumAge(domains, input.idea.wedge.minAge);
  const rationale = matches.length
    ? `Matched ${matches.map((m) => `${m.domain} ("${m.keyword}")`).join(", ")}; minimum age ${minimumAge}.`
    : `No sensitive-domain keywords matched; minimum age ${minimumAge} from the wedge.`;
  return { domains, minimumAge, rationale };
}

// ---------------------------------------------------------------------------
// Content and creators
// ---------------------------------------------------------------------------

const ANGLES = ["curiosity", "callout", "comparison", "transformation", "challenge", "storytime"];

function isSlideshow(f: { id: string; name: string }): boolean {
  return /slide|carousel/i.test(`${f.id} ${f.name}`);
}

function hashtag(text: string): string {
  return `#${text.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
}

/** The low end of a "N-M slides" range in a format's structure, else five. */
function slideCount(structure: string): number {
  const m = /(\d+)\s*[-–]\s*(\d+)[\s-]*slides?\b/i.exec(structure);
  return Math.min(35, Math.max(3, m ? Number(m[1]) : 5));
}

const STORY_BEATS = [
  "Nobody warned me about this part",
  "I kept going back and forth about it",
  "My friends all had opinions",
  "Honestly I was overthinking everything",
  "I needed a straight answer",
];

/** A story arc with exactly one app reveal a little before the middle (where slideshow formats place it). */
function storySlides(n: number, hook: string, topic: string, product: SchemaInputs["ContentBatch"]["product"]): ContentDraft["slides"] {
  const reveal = Math.max(1, Math.round(n * 0.45));
  return Array.from({ length: n }, (_, i) => {
    if (i === 0) return { text: truncateWords(hook, 140), imagePrompt: `Moody vertical photo setting the scene for: ${hook}`, isAppReveal: false };
    if (i === reveal) return { text: truncateWords(`So I asked ${product.name}`, 140), imagePrompt: `Phone screen showing the ${product.name} result screen`, isAppReveal: true };
    if (i === reveal + 1) return { text: truncateWords(product.verdictMoment, 140), imagePrompt: `Close-up of a result card: ${product.shareArtifact}`, isAppReveal: false };
    if (i === n - 1) return { text: "Now I need to know what yours says", imagePrompt: `Friends laughing at a phone screen about ${topic}`, isAppReveal: false };
    const beat = STORY_BEATS[(i - 1) % STORY_BEATS.length] ?? STORY_BEATS[0] ?? "";
    return { text: i < reveal ? beat : `It made so much sense about my ${topic}`, imagePrompt: `Candid phone photo, ${topic} mood, scene ${i + 1}`, isAppReveal: false };
  });
}

function contentBatch(input: SchemaInputs["ContentBatch"], rng: Rng): ContentBatch {
  const { product, platform } = input;
  const onPlatform = input.formats.filter((f) => f.platforms.includes(platform));
  const formats = onPlatform.length ? onPlatform : input.formats;
  const voices = input.allowedVoices.length ? input.allowedVoices : (["brand_third_person"] as ContentDraft["voice"][]);
  const hooks = input.topHooks.length ? input.topHooks : [`I asked AI about my ${product.wedge.toLowerCase()} life`, `POV: ${product.verdictMoment}`];
  const topic = nicheTopic(product.wedge);
  const cta = input.purpose === "attention_probe" ? `${product.name} is coming soon` : `Search ${product.name} on the App Store`;

  const drafts: ContentDraft[] = [];
  for (let i = 0; i < Math.max(0, input.count); i++) {
    const format = formats.length ? formats[i % formats.length] : undefined;
    const hook = hooks[i % hooks.length] ?? hooks[0] ?? product.oneLiner;
    const voice = voices[(i + rng.int(0, voices.length - 1)) % voices.length] ?? "brand_third_person";
    const slideshow = format ? isSlideshow(format) : false;
    const slides = slideshow && format ? storySlides(slideCount(format.structure), hook, topic, product) : [];
    const script = slideshow
      ? ""
      : voice === "creator_first_person"
        ? `${hook}. So I tried ${product.name}. ${product.verdictMoment}. Okay, that was a little too accurate for me.`
        : voice === "product_demo"
          ? `${hook}. Open ${product.name}. ${product.verdictMoment}. That is the whole thing.`
          : `${hook}. ${product.name}: ${product.oneLiner}.`;
    drafts.push({
      formatId: format?.id ?? "freeform",
      platform,
      voice,
      hook,
      angle: ANGLES[(i + rng.int(0, ANGLES.length - 1)) % ANGLES.length] ?? "curiosity",
      script,
      slides,
      caption: truncateWords(`${hook} (made with ${product.name})`, 150),
      hashtags: [hashtag(product.name), hashtag(topic), "#aiapp"].filter((t, k, all) => t.length > 1 && all.indexOf(t) === k),
      callToAction: cta,
    });
  }
  return { drafts };
}

function creatorBrief(input: SchemaInputs["CreatorBrief"]): CreatorBrief {
  const { product } = input;
  const mustInclude = [
    `Show the ${product.name} app on screen within the first 15 seconds`,
    `Use ${product.name} yourself before posting and show your real result`,
    "Turn on the platform's paid-partnership or branded-content label",
    `Say or show the name ${product.name} on screen`,
  ];
  if (product.subscriptionRequired) mustInclude.push("Say or caption that a subscription is required for full results");
  const mustAvoid = [
    ...input.mustAvoid,
    "Promises about accuracy, outcomes or earnings",
    "Prices, discounts or free claims",
    "User counts, ratings or rankings",
    "Scripted testimonials or pretending to be a long-time customer",
  ].filter((v, i, all) => all.indexOf(v) === i);
  return {
    title: `${product.name} creator brief`,
    productSummary: `${product.oneLiner}. ${product.verdictMoment}.`,
    audience: product.audience,
    formats: input.formats.map((f) => f.name),
    hooks: input.topHooks.length ? [...input.topHooks] : [`I asked ${product.name} and was not ready`],
    mustInclude,
    mustAvoid,
    deliverables:
      "One vertical video per agreed post, filmed on your own account. Submit the draft for approval before posting, then post with the partnership label on and share the link.",
  };
}

const INJECTION = /ignore (all |previous|prior)|approve (this|the) (payout|submission)|system prompt|you are now/i;

function submissionReview(input: SchemaInputs["SubmissionReview"], rng: Rng, untrusted: { label: string; text: string }[]): SubmissionReview {
  const caption = untrusted.map((u) => u.text).join("\n");
  if (INJECTION.test(caption)) {
    return {
      approve: false,
      meetsBrief: false,
      injectionAttempt: true,
      policyIssues: ["Caption contains instructions addressed to the reviewer"],
      formatIdUsed: null,
      hookUsedVerbatim: false,
      appRevealSecond: null,
      subscriptionDisclosed: false,
      note: `Rejected: @${input.submission.creatorHandle}'s caption tries to instruct the reviewer.`,
    };
  }
  const lower = caption.toLowerCase();
  const policyIssues = lintCopy({ text: caption, surface: "content" }).map((f) => `${f.ruleId}: ${f.message}`);
  const formatIdUsed = input.brief.formats.find((f) => lower.includes(f.toLowerCase())) ?? null;
  return {
    approve: true,
    meetsBrief: policyIssues.length === 0,
    injectionAttempt: false,
    policyIssues,
    formatIdUsed,
    hookUsedVerbatim: input.brief.hooks.some((h) => h.trim() !== "" && lower.includes(h.toLowerCase())),
    appRevealSecond: rng.int(2, 12),
    subscriptionDisclosed: /\bsubscri(be|ption)/i.test(caption),
    note: truncateWords(
      policyIssues.length ? `Approved with ${policyIssues.length} copy issue(s) to fix next time.` : `Approved: ${input.submission.stage.replace("_", " ")} matches the brief.`,
      280,
    ),
  };
}

const SURFACE: Record<SchemaInputs["ComplianceReview"]["kind"], CopySurface> = {
  listing: "aso",
  paywall: "paywall",
  onboarding: "onboarding",
  content: "content",
  brief: "brief",
  push: "push",
  support: "support",
};

function complianceReview(input: SchemaInputs["ComplianceReview"]): ComplianceReview {
  const findings: ComplianceReview["findings"] = lintCopy({ text: input.text, surface: SURFACE[input.kind] }).map((f) => ({
    ruleId: f.ruleId,
    severity: f.severity,
    message: f.message,
  }));
  const domains = input.context.sensitiveDomains;
  if (input.kind === "listing" && domains.includes("health") && !/not medical advice/i.test(input.text)) {
    findings.push({ ruleId: "llm_other", severity: "warn", message: `${input.context.appName}: a health listing should say results are not medical advice` });
  }
  if (input.kind === "listing" && domains.includes("finance") && !/not financial advice/i.test(input.text)) {
    findings.push({ ruleId: "llm_other", severity: "warn", message: `${input.context.appName}: a finance listing should say results are not financial advice` });
  }
  return { findings };
}

// ---------------------------------------------------------------------------
// Iteration, memo and discovery
// ---------------------------------------------------------------------------

function triedKind(tried: string[], kind: VariantChangeKind): boolean {
  return tried.some((t) => t === kind || t.startsWith(`${kind}.`) || t.startsWith(`${kind}:`));
}

function freshHooks(idea: Idea, existing: string[], rng: Rng): string[] {
  const topic = nicheTopic(idea.wedge.creatorNiche);
  const templates = [
    `I asked ${idea.title} about my ${topic} and I was not ready`,
    `Nobody told me this about ${topic}`,
    `POV: you finally get a straight answer about ${topic}`,
    `Testing ${idea.title} on my friends so you do not have to`,
    `The ${topic} verdict that started an argument`,
    `Rating my ${topic} with AI, part one`,
  ];
  const seen = new Set(existing.map((h) => h.toLowerCase()));
  return rng
    .shuffle(templates)
    .filter((h) => !seen.has(h.toLowerCase()))
    .slice(0, 3);
}

/** Move the value preview to just after the first answered question, keeping consent ahead of it. */
function earlierPreview(steps: AppSpec["onboarding"]): AppSpec["onboarding"] {
  const at = steps.findIndex((s) => s.kind === "value_preview");
  const consent = steps.findIndex((s) => s.kind === "ai_data_consent");
  if (at === -1) return steps;
  const rest = steps.filter((_, i) => i !== at);
  const firstAnswer = rest.findIndex((s, i) => i > consent && s.storeAs !== null && s.kind !== "ai_data_consent");
  const preview = steps[at];
  if (firstAnswer === -1 || !preview) return steps;
  return [...rest.slice(0, firstAnswer + 1), preview, ...rest.slice(firstAnswer + 1)];
}

function variantProposal(input: SchemaInputs["VariantProposal"], rng: Rng): VariantProposal {
  const { idea, spec } = input;
  const kinds: VariantChangeKind[] = input.allowedKinds.length ? input.allowedKinds : ["hooks"];
  const kind = kinds.find((k) => !triedKind(input.triedVariables, k)) ?? kinds[0] ?? "hooks";
  const failed = input.failedStages.length ? input.failedStages.join(" and ") : "the last test";
  const because = input.outcomeSummary ? ` (${truncateWords(input.outcomeSummary, 120)})` : "";

  switch (kind) {
    case "hooks":
      return {
        variableUnderTest: "hooks",
        hypothesis: `Hooks that lead with the verdict moment will lift ${failed}${because}`,
        change: { kind, hooks: freshHooks(idea, idea.hookExamples, rng) },
      };
    case "onboarding": {
      const drop = spec.onboarding.findIndex((s) => s.kind === "attribution_survey" || s.kind === "multi_choice" || s.kind === "benefit");
      const steps = spec.onboarding.length > 8 && drop !== -1 ? spec.onboarding.filter((_, i) => i !== drop) : earlierPreview(spec.onboarding);
      return {
        variableUnderTest: "onboarding",
        hypothesis: `A shorter path to the value preview will lift ${failed}${because}`,
        change: { kind, onboarding: normalizeOnboarding(steps, idea).steps },
      };
    }
    case "paywall":
      return {
        variableUnderTest: "paywall",
        hypothesis: `Leading the paywall with the user's own result will lift ${failed}${because}`,
        change: {
          kind,
          paywall: {
            ...spec.paywall,
            headline: "See your full verdict",
            bullets: [...spec.paywall.bullets.slice(1), ...spec.paywall.bullets.slice(0, 1)],
          },
        },
      };
    case "share":
      return {
        variableUnderTest: "share",
        hypothesis: `A share card that invites comparison will lift ${failed}${because}`,
        change: { kind, share: { ...spec.share, cardHeadline: `What does ${spec.appName} say about you?`, caption: `Mine was a surprise. Try ${spec.appName} and compare.` } },
      };
    case "core":
      return {
        variableUnderTest: "core",
        hypothesis: `A punchier verdict with one reason will lift ${failed}${because}`,
        change: {
          kind,
          core: {
            ...spec.core,
            outputSections: ["Verdict", "The one reason that matters", "Try this next"],
            loadingMessages: ["Looking closely", "Comparing patterns", "Almost there"],
          },
        },
      };
    case "positioning": {
      const appName = spec.nameCandidates.find((n) => n !== spec.appName) ?? spec.appName;
      return {
        variableUnderTest: "positioning",
        hypothesis: `Positioning around ${nicheTopic(idea.wedge.creatorNiche)} will lift ${failed}${because}`,
        change: {
          kind,
          appName,
          subtitle: truncateWords(`Your ${nicheTopic(idea.wedge.creatorNiche)} verdict`, 30),
          hooks: freshHooks(idea, idea.hookExamples, rng),
        },
      };
    }
  }
}

function dollars(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const whole = Math.floor(Math.abs(cents) / 100);
  return `${sign}$${String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

function boardMemo(input: SchemaInputs["BoardMemo"]): BoardMemo {
  const byStage = new Map<string, number>();
  for (const v of input.ventures) byStage.set(v.stage, (byStage.get(v.stage) ?? 0) + 1);
  const stages = [...byStage.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([s, n]) => `${n} ${s.replace(/_/g, " ")}`)
    .join(", ");
  const wins = input.ventures.filter((v) => v.stage === "scaling" || v.stage === "harvest" || /\bpass(ed)?\b/i.test(v.detail)).map((v) => `${v.name}: ${v.detail}`);
  const concerns = input.ventures.filter((v) => v.stage === "killed" || /\b(fail\w*|blocked|rejected)\b/i.test(v.detail)).map((v) => `${v.name}: ${v.detail}`);
  if (input.cashCents > 0 && input.freeCashCents < input.cashCents * 0.25) concerns.push(`Free cash ${dollars(input.freeCashCents)} is under a quarter of cash`);
  if (input.freeCashCents < 0) concerns.push("Commitments exceed cash");
  const decisionsNeeded: string[] = [];
  if (input.pendingApprovals > 0) decisionsNeeded.push(`Review ${input.pendingApprovals} pending approval(s)`);
  if (input.openHumanTasks > 0) decisionsNeeded.push(`Complete ${input.openHumanTasks} open human task(s)`);
  return {
    headline: `${input.date}: ${input.ventures.length} venture(s), ${dollars(input.freeCashCents)} free cash`,
    summary:
      `Cash ${dollars(input.cashCents)}, free cash ${dollars(input.freeCashCents)}. ` +
      `Portfolio: ${stages || "no ventures yet"}. ${input.decisions.length} decision(s) today` +
      (input.decisions.length ? `: ${input.decisions.slice(0, 3).join("; ")}.` : "."),
    wins,
    concerns,
    decisionsNeeded,
  };
}

const GENRE_NEED: readonly (readonly [RegExp, CoreNeed])[] = [
  [/lifestyle|social|dating/i, "love"],
  [/financ|business|shopping/i, "money"],
  [/health|fitness|medical|education|productivity/i, "self_improvement"],
  [/game|entertainment|music|sports|photo|video|reference|travel|food/i, "play"],
];

function needFor(text: string): CoreNeed {
  for (const [pattern, need] of GENRE_NEED) if (pattern.test(text)) return need;
  const domains = classifyDomains(text).map((m) => m.domain);
  if (domains.includes("astrology_fortune") || domains.includes("dating_safety")) return "love";
  if (domains.includes("finance")) return "money";
  if (domains.includes("health")) return "self_improvement";
  return "play";
}

function signalDigest(input: SchemaInputs["SignalDigest"]): SignalDigest {
  const byGenre = new Map<string, SchemaInputs["SignalDigest"]["charts"]>();
  for (const c of input.charts) byGenre.set(c.genre, [...(byGenre.get(c.genre) ?? []), c]);
  const genrePatterns = [...byGenre.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .slice(0, 6)
    .map(([genre, apps]) => {
      const sorted = [...apps].sort((a, b) => a.rank - b.rank);
      const countries = [...new Set(apps.map((a) => a.country))].sort();
      return {
        title: `${genre} apps are charting`,
        detail: `${apps.length} chart entries in ${countries.join(", ")}; best rank ${sorted[0]?.rank ?? "n/a"}.`,
        exampleApps: [...new Set(sorted.map((a) => a.name))].slice(0, 3),
        coreNeed: needFor(genre),
      };
    });
  const searchPatterns = input.searches
    .filter((s) => s.top.length > 0)
    .slice(0, 4)
    .map((s) => {
      const ratings = s.top.reduce((sum, t) => sum + t.ratingCount, 0);
      const paid = s.top.filter((t) => t.priceCents > 0).length;
      return {
        title: `Demand for "${s.term}"`,
        detail: `Top results hold ${ratings} ratings combined; ${paid} of ${s.top.length} are paid upfront.`,
        exampleApps: s.top.slice(0, 3).map((t) => t.name),
        coreNeed: needFor(s.term),
      };
    });
  return { patterns: [...genrePatterns, ...searchPatterns] };
}

// ---------------------------------------------------------------------------
// Port
// ---------------------------------------------------------------------------

const GENERATORS: { [N in SchemaName]: Generator<N> } = {
  IdeaBatch: (input, rng) => ideaBatch(input, rng),
  Critique: (input, rng) => critique(input, rng),
  SensitivityReview: (input) => sensitivity(input),
  AppSpec: (input, rng) => buildAppSpec(input, rng),
  AppSpecRepair: (input) => repairAppSpec(input),
  ContentBatch: (input, rng) => contentBatch(input, rng),
  CreatorBrief: (input) => creatorBrief(input),
  SubmissionReview: (input, rng, untrusted) => submissionReview(input, rng, untrusted),
  ComplianceReview: (input) => complianceReview(input),
  VariantProposal: (input, rng) => variantProposal(input, rng),
  BoardMemo: (input) => boardMemo(input),
  SignalDigest: (input) => signalDigest(input),
};

export class StubLlm implements LlmPort {
  readonly kind = "stub";
  private readonly seed: number;

  constructor(opts: { seed: number }) {
    this.seed = opts.seed;
  }

  async object<N extends SchemaName>(req: LlmObjectRequest<N>): Promise<SchemaOutputs[N]> {
    const rng = new Rng(hashString(`${this.seed}:${req.schemaName}:${canonicalJson(req.input)}`));
    const generate = GENERATORS[req.schemaName] as Generator<N>;
    return SCHEMAS[req.schemaName].parse(generate(structuredClone(req.input), rng, req.untrusted ?? []));
  }

  async text(req: LlmTextRequest): Promise<string> {
    const keys = req.input && typeof req.input === "object" ? Object.keys(req.input).sort() : [];
    const tag = (hashString(`${this.seed}:text:${req.role}:${req.instructions}:${canonicalJson(req.input)}`) >>> 0).toString(16).padStart(8, "0");
    const about = truncateWords(req.instructions.replace(/\s+/g, " "), 160);
    return `[stub ${req.role} ${tag}] ${req.purpose}: ${about}${keys.length ? ` (input: ${keys.join(", ")})` : ""}`;
  }

  usage(): LlmUsage {
    return { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costCents: 0 };
  }
}
