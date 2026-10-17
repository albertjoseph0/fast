/**
 * The stub LLM's product designer: a complete AppSpec from an idea and the playbook
 * defaults, and mechanical repairs for the spec lint's common findings.
 */
import type { SchemaInputs } from "../agents/schemas.ts";
import type { Rng } from "../core/rng.ts";
import type { AppSpec, CoreNeed, DataUse, Idea, OnboardingStep, OnboardingStepKind } from "../core/types.ts";
import { classifyDomains, ideaText, inferInputKind, nicheTopic, slugify, specMinimumAge, stripDigits, truncateWords } from "./stub-classify.ts";

export const LIMITS = {
  subtitle: 30,
  promotionalText: 170,
  keywords: 100,
  inviteMessage: 160,
  onboardingMin: 8,
  onboardingMax: 16,
  captionsMin: 3,
  captionsMax: 10,
  bulletsMin: 2,
  bulletsMax: 6,
  pagesMax: 4,
  productIdsMax: 4,
  closeAfterMax: 3,
} as const;

/** Steps that store an answer; AI-data consent has to come before all of them (Apple 5.1.2(i)). */
const DATA_STEPS: ReadonlySet<OnboardingStepKind> = new Set([
  "goal_picker",
  "single_choice",
  "multi_choice",
  "text_input",
  "date_input",
  "time_input",
  "place_input",
  "slider",
  "attribution_survey",
]);

const GOALS: Record<CoreNeed, string[]> = {
  love: ["Understand my relationships", "Know what to say", "Have fun with friends"],
  money: ["Save more", "Earn more", "Know what things are worth"],
  play: ["Have fun", "Get better at my hobby", "Settle a debate"],
  self_improvement: ["Build a better habit", "Feel more confident", "See my progress"],
};

const CATEGORY: Record<CoreNeed, string> = {
  love: "Lifestyle",
  money: "Finance",
  play: "Entertainment",
  self_improvement: "Health & Fitness",
};

const VOICE: Record<CoreNeed, string> = {
  love: "Warm, playful and a little blunt, like a best friend who tells the truth",
  money: "Direct, practical and encouraging, never preachy",
  play: "Upbeat, witty and quick",
  self_improvement: "Calm, supportive and specific",
};

const DAILY_HOOK: Record<CoreNeed, string> = {
  love: "A fresh daily read on the people in your life",
  money: "A daily check on where your money is going",
  play: "A new challenge or discovery every day",
  self_improvement: "A daily check-in that keeps the streak alive",
};

const PALETTES: readonly AppSpec["brand"][] = [
  { primaryColor: "#6C4CF5", accentColor: "#F5B84C", backgroundColor: "#0E0B1F", textColor: "#F4F1FF", voice: "", iconPrompt: "" },
  { primaryColor: "#FF4F7B", accentColor: "#FFD166", backgroundColor: "#1A0E14", textColor: "#FFF4F7", voice: "", iconPrompt: "" },
  { primaryColor: "#1FB57A", accentColor: "#C7F464", backgroundColor: "#0B1A14", textColor: "#EFFFF7", voice: "", iconPrompt: "" },
  { primaryColor: "#2F80ED", accentColor: "#56CCF2", backgroundColor: "#0B1220", textColor: "#EEF4FF", voice: "", iconPrompt: "" },
  { primaryColor: "#F2994A", accentColor: "#EB5757", backgroundColor: "#1C120A", textColor: "#FFF6EE", voice: "", iconPrompt: "" },
  { primaryColor: "#111111", accentColor: "#E5FF3D", backgroundColor: "#FAFAF7", textColor: "#111111", voice: "", iconPrompt: "" },
];

const INPUT_LABEL: Record<AppSpec["core"]["inputKind"], string> = {
  photo: "Take or upload a photo",
  screenshot: "Upload a screenshot",
  text: "Describe it in a few words",
  date_time_place: "Enter the birth date, time and place",
  audio_file: "Upload or record a short audio clip",
  choices: "Pick your answers",
  none: "Tap to start",
};

const DATA_TYPE: Record<AppSpec["core"]["inputKind"], DataUse["dataType"] | null> = {
  photo: "photo",
  screenshot: "screenshot",
  text: "text",
  date_time_place: "birth_data",
  audio_file: "audio",
  choices: "text",
  none: null,
};

const STOPWORDS = new Set(
  "the and for with your you from that this what into them then than them their every gets get one two three four five six seven eight nine ten your about before after while right just only over most less more like each comes goes".split(
    " ",
  ),
);

function stepId(index: number, kind: OnboardingStepKind): string {
  return `s${index + 1}_${kind}`;
}

function step(kind: OnboardingStepKind, title: string, subtitle: string | null, options: string[], storeAs: string | null): OnboardingStep {
  return { id: kind, kind, title, subtitle, options, storeAs };
}

function onboardingStep(kind: OnboardingStepKind, idea: Idea, inputKind: AppSpec["core"]["inputKind"]): OnboardingStep {
  const name = idea.title;
  const topic = nicheTopic(idea.wedge.creatorNiche);
  switch (kind) {
    case "welcome":
      return step(kind, `Welcome to ${name}`, stripDigits(idea.oneLiner), [], null);
    case "ai_data_consent":
      return step(
        kind,
        "How your answers are used",
        `${name} sends what you share to Anthropic's Claude AI to create your result. Nothing is sold, and you can delete your data anytime.`,
        ["I agree", "Not now"],
        "aiConsent",
      );
    case "goal_picker":
      return step(kind, `What do you want from ${name}?`, null, GOALS[idea.coreNeed], "goal");
    case "single_choice":
      return step(kind, `How into ${topic} are you?`, null, ["Just curious", "Pretty into it", "Obsessed"], "experience");
    case "multi_choice":
      return step(kind, "What should your result focus on?", "Pick all that apply", ["The verdict", "The reasons", "What to do next", "Something to share"], "focus");
    case "text_input":
      return step(kind, "What should we call you?", "Used to personalize your result", [], "name");
    case "date_input":
      return step(kind, inputKind === "date_time_place" ? "When were you born?" : "When did it start?", null, [], "date");
    case "time_input":
      return step(kind, "What time were you born?", "An estimate is fine", [], "time");
    case "place_input":
      return step(kind, "Where were you born?", null, [], "place");
    case "slider":
      return step(kind, "How honest should the verdict be?", null, ["Gentle", "Brutal"], "honesty");
    case "benefit":
      return step(kind, `${name} gives you a clear answer, fast`, stripDigits(idea.verdictMoment), [], null);
    case "value_preview":
      return step(kind, "Here is a first look at your result", `A preview of your ${idea.shareArtifact.toLowerCase() || "result"}`, [], null);
    case "attribution_survey":
      return step(kind, "Where did you hear about us?", null, ["TikTok", "Instagram", "YouTube", "A friend", "App Store search", "Other"], "heardFrom");
    case "notification_preprompt":
      return step(kind, "Want to know when your result updates?", "We only notify you about your own results.", ["Turn on notifications", "Maybe later"], null);
    case "loading_personalization":
      return step(kind, `Personalizing ${name} for you`, null, [], null);
    case "result_teaser":
      return step(kind, "Your verdict is ready", "Unlock it to see the full breakdown", [], null);
  }
}

/**
 * Enforce the onboarding invariants: consent before the first data step, a value preview,
 * and 8..16 steps. Returns the fixed steps and what was changed.
 */
export function normalizeOnboarding(steps: OnboardingStep[], idea: Pick<Idea, "verdictMoment"> | null): { steps: OnboardingStep[]; changes: string[] } {
  const changes: string[] = [];
  let out = [...steps];

  const consentAt = out.findIndex((s) => s.kind === "ai_data_consent");
  const firstData = out.findIndex((s) => DATA_STEPS.has(s.kind));
  const leadingWelcome = out.findIndex((s) => s.kind !== "welcome");
  const consentSlot = leadingWelcome === -1 ? out.length : leadingWelcome;
  if (consentAt === -1) {
    out.splice(consentSlot, 0, {
      id: "ai_data_consent",
      kind: "ai_data_consent",
      title: "How your answers are used",
      subtitle: "We send what you share to Anthropic's Claude AI to create your result. You can delete your data anytime.",
      options: ["I agree", "Not now"],
      storeAs: "aiConsent",
    });
    changes.push("inserted ai_data_consent before the first data-collecting step");
  } else if (firstData !== -1 && consentAt > firstData) {
    const [consent] = out.splice(consentAt, 1);
    if (consent) out.splice(Math.min(consentSlot, firstData), 0, consent);
    changes.push("moved ai_data_consent before the first data-collecting step");
  }

  if (!out.some((s) => s.kind === "value_preview")) {
    const before = out.findIndex((s) => s.kind === "notification_preprompt" || s.kind === "result_teaser");
    const preview: OnboardingStep = {
      id: "value_preview",
      kind: "value_preview",
      title: "Here is a first look at your result",
      subtitle: idea ? stripDigits(idea.verdictMoment) : null,
      options: [],
      storeAs: null,
    };
    out.splice(before === -1 ? out.length : before, 0, preview);
    changes.push("inserted value_preview before the paywall");
  }

  while (out.length > LIMITS.onboardingMax) {
    const drop = out.findLastIndex((s) => s.kind === "benefit" || s.kind === "loading_personalization" || s.kind === "multi_choice");
    out.splice(drop === -1 ? out.length - 1 : drop, 1);
    changes.push(`removed a step to stay within ${LIMITS.onboardingMax} onboarding steps`);
  }
  while (out.length < LIMITS.onboardingMin) {
    const at = out.findIndex((s) => s.kind === "value_preview");
    out.splice(at === -1 ? out.length : at, 0, {
      id: "benefit",
      kind: "benefit",
      title: "A clear answer, made for you",
      subtitle: null,
      options: [],
      storeAs: null,
    });
    changes.push(`added a benefit step to reach ${LIMITS.onboardingMin} onboarding steps`);
  }

  out = out.map((s, i) => ({ ...s, id: stepId(i, s.kind) }));
  return { steps: out, changes };
}

function keywordsFor(idea: Idea): string[] {
  const titleWords = new Set(idea.title.toLowerCase().split(/\s+/));
  const source = [nicheTopic(idea.wedge.creatorNiche), idea.oneLiner, idea.shareArtifact, idea.aiCapability, idea.verdictMoment].join(" ");
  const words = stripDigits(source)
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w) && !titleWords.has(w));
  return fitKeywords([...new Set([nicheTopic(idea.wedge.creatorNiche).toLowerCase(), ...words])]);
}

/** Keep keywords in order while the comma-joined list fits the App Store's limit. */
export function fitKeywords(keywords: string[]): string[] {
  const out: string[] = [];
  for (const k of keywords) {
    const kw = k.trim();
    if (!kw || out.includes(kw)) continue;
    if ([...out, kw].join(",").length > LIMITS.keywords) continue;
    out.push(kw);
  }
  return out;
}

function dataInventory(inputKind: AppSpec["core"]["inputKind"]): DataUse[] {
  const out: DataUse[] = [];
  const core = DATA_TYPE[inputKind];
  if (core) {
    out.push({ dataType: core, purpose: "core_feature", sentTo: ["anthropic", "studio_backend"], retentionDays: 30, linkedToUser: false, usedForTracking: false });
  }
  out.push(
    { dataType: "usage", purpose: "analytics", sentTo: ["posthog"], retentionDays: 365, linkedToUser: false, usedForTracking: false },
    { dataType: "purchase", purpose: "core_feature", sentTo: ["revenuecat"], retentionDays: 730, linkedToUser: true, usedForTracking: false },
  );
  return out;
}

function aiDisclosure(idea: Idea, domains: readonly string[]): string {
  const base = `Results in ${idea.title} are generated by AI (Anthropic's Claude) and can be wrong.`;
  if (domains.includes("health")) return `${base} They are not medical advice.`;
  if (domains.includes("finance")) return `${base} They are not financial advice.`;
  if (domains.includes("astrology_fortune")) return `${base} Readings are for entertainment.`;
  return `${base} Use them for fun and reflection, not as professional advice.`;
}

/** The one-liner's first clause when it fits, else a topic tagline. */
function subtitleFor(idea: Idea): string {
  const clause = stripDigits(idea.oneLiner).split(/,| and | with | from | that | before | so /)[0]?.trim() ?? "";
  if (clause && clause.length <= LIMITS.subtitle) return clause;
  const tagline = `Your ${nicheTopic(idea.wedge.creatorNiche).toLowerCase()} verdict`;
  return tagline.length <= LIMITS.subtitle ? tagline : truncateWords(clause || tagline, LIMITS.subtitle);
}

export function buildAppSpec(input: SchemaInputs["AppSpec"], rng: Rng): AppSpec {
  const { idea, defaults, company } = input;
  const inputKind = inferInputKind(idea);
  const domains = [...new Set([...idea.sensitiveDomains, ...classifyDomains(ideaText(idea)).map((m) => m.domain)])];
  const slug = slugify(idea.title);
  const palette = rng.pick(PALETTES);
  const topic = nicheTopic(idea.wedge.creatorNiche);
  const artifact = idea.shareArtifact || `${idea.title} result card`;
  const onboarding = normalizeOnboarding(
    defaults.onboardingSkeleton.map((k) => onboardingStep(k, idea, inputKind)),
    idea,
  ).steps;
  const usesInvites = idea.primaryChannel === "invite_loop" || idea.secondaryChannels.includes("invite_loop");
  const disclosure = aiDisclosure(idea, domains);

  return {
    appName: idea.title,
    nameCandidates: [`${idea.title} AI`, `My ${idea.title}`, `${idea.title} App`, `Hey ${idea.title}`],
    subtitle: subtitleFor(idea),
    slug,
    category: domains.includes("health") || idea.coreNeed !== "self_improvement" ? CATEGORY[idea.coreNeed] : "Lifestyle",
    locale: input.locale,
    brand: {
      ...palette,
      voice: VOICE[idea.coreNeed],
      iconPrompt: `A bold, simple app icon for ${idea.title}: a single symbol for ${topic} on a ${palette.backgroundColor} background, no text`,
    },
    onboarding,
    core: {
      inputKind,
      inputLabel: INPUT_LABEL[inputKind],
      aiSystemPrompt:
        `You are ${idea.title}. ${idea.aiCapability}. Give a clear verdict first, then the reasons, then one thing to try next. ` +
        "Be specific to what the user shared, keep a playful tone, never claim certainty, and refuse anything unsafe.",
      outputSections: ["Verdict", "Why", "What to try next"],
      loadingMessages: ["Reading what you shared", "Looking for patterns", "Writing your verdict"],
      freeUsesBeforePaywall: defaults.paywall.style === "hard" ? 0 : 1,
    },
    paywall: defaults.paywall,
    share: {
      artifact,
      cardHeadline: `My ${idea.title} verdict`,
      caption: `Got my ${idea.title} result. What would yours say?`,
      deepLinkPath: `/r/${slug}`,
      watermark: `Made with ${idea.title}`,
    },
    invite: usesInvites
      ? { method: "system_share_sheet", prefilledMessage: truncateWords(`Try ${idea.title} with me and compare our results`, LIMITS.inviteMessage) }
      : null,
    retention: {
      pushSchedule: defaults.pushSchedule,
      dailyHook: DAILY_HOOK[idea.coreNeed],
      widget: idea.coreNeed === "play" ? null : "Today's verdict",
    },
    aso: {
      keywords: keywordsFor(idea),
      description: [
        `${stripDigits(idea.oneLiner)}.`,
        `${stripDigits(idea.verdictMoment)}.`,
        `How it works:\n• ${INPUT_LABEL[inputKind]}\n• Get your verdict with the reasons behind it\n• Save and share your ${artifact.toLowerCase()}`,
        disclosure,
        "A subscription is required for full results. Manage or cancel anytime in Settings.",
        `Support: ${company.supportEmail}`,
      ].join("\n\n"),
      promotionalText: truncateWords(`${stripDigits(idea.verdictMoment)}. Made for ${idea.wedge.name.toLowerCase()}.`, LIMITS.promotionalText),
      screenshotCaptions: [
        truncateWords(stripDigits(idea.oneLiner), 60),
        INPUT_LABEL[inputKind],
        "Your verdict, with the reasons",
        `Share your ${artifact.toLowerCase()}`,
        "Personalized to you",
      ],
    },
    compliance: {
      aiDisclosure: disclosure,
      dataInventory: dataInventory(inputKind),
      minimumAge: specMinimumAge(domains, idea.wedge.minAge),
    },
  };
}

// ---------------------------------------------------------------------------
// Repair
// ---------------------------------------------------------------------------

type PathKey = string | number;

function parsePath(path: string): PathKey[] {
  const keys: PathKey[] = [];
  for (const part of path.split(".")) {
    const m = /^([^[\]]*)((?:\[\d+\])*)$/.exec(part);
    if (!m) return [];
    if (m[1]) keys.push(m[1]);
    for (const idx of (m[2] ?? "").matchAll(/\[(\d+)\]/g)) keys.push(Number(idx[1]));
  }
  return keys;
}

/** Remove `match` from the string at `path`, or from every string field when the path is unknown. */
function removeText(root: unknown, path: string | null, match: string): number {
  if (!match) return 0;
  const clean = (s: string): string => s.split(match).join("").replace(/\s{2,}/g, " ").replace(/\s+([,.!?])/g, "$1").trim();
  if (path) {
    const keys = parsePath(path);
    let parent: unknown = root;
    for (const k of keys.slice(0, -1)) parent = (parent as Record<PathKey, unknown> | null)?.[k];
    const last = keys.at(-1);
    if (last === undefined || !parent || typeof parent !== "object") return 0;
    const holder = parent as Record<PathKey, unknown>;
    const value = holder[last];
    if (typeof value !== "string" || !value.includes(match)) return 0;
    holder[last] = clean(value);
    return 1;
  }
  let count = 0;
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const obj = node as Record<PathKey, unknown>;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (typeof v === "string" && v.includes(match)) {
        obj[k] = clean(v);
        count++;
      } else walk(v);
    }
  };
  walk(root);
  return count;
}

const COPY_FINDING = /(?: at ([\w.[\]]+))?: "(.+)"$/;

export function repairAppSpec(input: SchemaInputs["AppSpecRepair"]): { spec: AppSpec; changes: string[] } {
  const spec = structuredClone(input.spec);
  const changes: string[] = [];

  for (const f of input.findings) {
    if (!f.ruleId.startsWith("copy.")) continue;
    const m = COPY_FINDING.exec(f.message);
    if (!m?.[2]) continue;
    const n = removeText(spec, m[1] ?? null, m[2]);
    if (n > 0) changes.push(`removed "${m[2]}" (${f.ruleId})${m[1] ? ` at ${m[1]}` : ""}`);
  }

  const subtitle = truncateWords(spec.subtitle, LIMITS.subtitle);
  if (subtitle !== spec.subtitle) {
    spec.subtitle = subtitle;
    changes.push(`truncated subtitle to ${LIMITS.subtitle} characters`);
  }
  const promo = truncateWords(spec.aso.promotionalText, LIMITS.promotionalText);
  if (promo !== spec.aso.promotionalText) {
    spec.aso.promotionalText = promo;
    changes.push(`truncated promotional text to ${LIMITS.promotionalText} characters`);
  }
  const keywords = fitKeywords(spec.aso.keywords);
  if (keywords.join(",") !== spec.aso.keywords.join(",")) {
    spec.aso.keywords = keywords;
    changes.push(`trimmed keywords to ${LIMITS.keywords} comma-joined characters`);
  }
  if (spec.aso.screenshotCaptions.length > LIMITS.captionsMax) {
    spec.aso.screenshotCaptions = spec.aso.screenshotCaptions.slice(0, LIMITS.captionsMax);
    changes.push(`kept the first ${LIMITS.captionsMax} screenshot captions`);
  }
  while (spec.aso.screenshotCaptions.length < LIMITS.captionsMin) {
    spec.aso.screenshotCaptions.push(["Your verdict, with the reasons", "Personalized to you", `Share your ${spec.share.artifact.toLowerCase()}`][spec.aso.screenshotCaptions.length % 3] ?? "Personalized to you");
    changes.push("added a screenshot caption");
  }

  const slug = slugify(spec.slug);
  if (slug !== spec.slug) {
    spec.slug = slug;
    changes.push("normalized slug");
  }
  const names = [...new Set(spec.nameCandidates.filter((n) => n.trim() && n !== spec.appName))];
  for (const extra of [`${spec.appName} AI`, `My ${spec.appName}`, `${spec.appName} App`]) {
    if (names.length >= 3) break;
    if (!names.includes(extra)) names.push(extra);
  }
  if (names.join("|") !== spec.nameCandidates.join("|")) {
    spec.nameCandidates = names;
    changes.push("completed name candidates");
  }

  const onboarding = normalizeOnboarding(spec.onboarding, null);
  if (onboarding.changes.length) {
    spec.onboarding = onboarding.steps;
    changes.push(...onboarding.changes);
  }

  const pw = spec.paywall;
  if (pw.showCloseAfterSeconds !== null) {
    const clamped = Math.min(LIMITS.closeAfterMax, Math.max(0, Math.round(pw.showCloseAfterSeconds)));
    if (clamped !== pw.showCloseAfterSeconds) {
      pw.showCloseAfterSeconds = clamped;
      changes.push(`clamped showCloseAfterSeconds to ${clamped}`);
    }
  } else if (pw.style === "soft") {
    pw.showCloseAfterSeconds = 0;
    changes.push("set showCloseAfterSeconds to 0 on a soft paywall");
  }
  const pages = Math.min(LIMITS.pagesMax, Math.max(1, pw.pages));
  if (pages !== pw.pages) {
    pw.pages = pages;
    changes.push(`clamped paywall pages to ${pages}`);
  }
  if (pw.bullets.length > LIMITS.bulletsMax) {
    pw.bullets = pw.bullets.slice(0, LIMITS.bulletsMax);
    changes.push(`kept the first ${LIMITS.bulletsMax} paywall bullets`);
  }
  while (pw.bullets.length < LIMITS.bulletsMin) {
    pw.bullets.push(pw.bullets.length === 0 ? "Your complete, personalized result" : "Cancel anytime in Settings");
    changes.push("added a paywall bullet");
  }
  if (pw.productIds.length > LIMITS.productIdsMax) {
    pw.productIds = pw.productIds.slice(0, LIMITS.productIdsMax);
    changes.push(`kept the first ${LIMITS.productIdsMax} paywall products`);
  }
  const first = pw.productIds[0];
  if (first !== undefined && !pw.productIds.includes(pw.highlightedProductId)) {
    pw.highlightedProductId = first;
    changes.push("highlighted a product that is on the paywall");
  }

  if (spec.invite && spec.invite.prefilledMessage.length > LIMITS.inviteMessage) {
    spec.invite.prefilledMessage = truncateWords(spec.invite.prefilledMessage, LIMITS.inviteMessage);
    changes.push(`truncated the invite message to ${LIMITS.inviteMessage} characters`);
  }

  return { spec, changes };
}
