/**
 * Critics and the sensitivity classifier. Three adversarial lenses review every idea in
 * parallel; an independent classifier (which never sees the ideator's own labels) and a
 * keyword backstop set the sensitive domains. Only the deterministic gates can advance an idea.
 */
import type { AudienceExposure } from "../core/store.ts";
import type { AgentContext } from "../core/context.ts";
import type { Critique, Idea, IdeaRecord, Screening } from "../core/types.ts";
import { screenIdea } from "../principles/gates.ts";
import { keywordDomains } from "../principles/sensitivity.ts";
import { COMPLIANCE_SYSTEM } from "./compliance.ts";
import { SCHEMA, type SchemaInputs, type SensitivityReview } from "./schemas.ts";
import { ideaFreeText, rolePrompt } from "./shared.ts";

type Lens = Critique["lens"];

const SCORING = [
  "score is 0..10: 0 means certain failure, 5 a coin flip, 8+ means you would fund a one-week test today.",
  "fatalFlaws lists only problems that kill the idea outright under your lens; leave it empty otherwise. risks are survivable problems; fixes are concrete changes.",
  "wouldFund is false only when a fatal flaw cannot be fixed inside this idea.",
  "Be specific to this idea. Do not restate the idea or praise it.",
];

const LENS_SYSTEM: Record<Lens, string> = {
  bier_skeptic: rolePrompt(
    "You are a skeptical consumer-app founder in the mold of Nikita Bier (tbh, Gas). You believe most ideas are dead on arrival and say so.",
    [
      "Count every condition that must be true for a user to get value; more than 4 is fatal. A partnership dependency is fatal.",
      "Single-player value is mandatory unless the idea is explicitly social; a lone user on day one must get the verdict.",
      "Apply the toilet test: first value within 5 taps and 15 seconds, one-handed, silent, interruptible. Sustained attention is fatal.",
      "Check the core need: love, money or play. Self-improvement only counts if it really maps to one of them. Meetup apps are fatal.",
      "Check the wedge: is it narrow, discoverable and obsessive enough that the first thousand users can be found?",
      "Ask whether the verdict moment films well in under 3 seconds and whether the share artifact is something people would post.",
      ...SCORING,
    ],
    { playbook: true },
  ),
  growth_realist: rolePrompt(
    "You are a growth lead who has run hundreds of paid creator campaigns for subscription utility apps (Vert, Cal AI, Umax). You judge distribution, not product taste.",
    [
      "Creator distribution: are there at least 20 creators whose audiences are mostly this wedge, in English-speaking test storefronts (CA, AU, NZ)? Would they post this without it feeling like an ad?",
      "Hooks: do the hooks stop a scroll in the first second, and can a creator make 10 distinct videos from them before they fatigue?",
      "Funnel: will viewers install (aim for 1.5+ installs per 1K views), finish a long onboarding, and start a trial on a hard weekly paywall?",
      "Economics: estimate CAC through creators at a per-video fee plus CPM bonus; is predicted D60 net revenue per install likely to cover it? Is the price point plausible for this audience?",
      "Retention: is there a reason to come back tomorrow, or is it one-and-done? One-and-done is survivable only if the trial converts on the first session.",
      "Views are not revenue: discount ideas that would trend but never convert.",
      ...SCORING,
    ],
    { playbook: true },
  ),
  store_and_policy: rolePrompt(
    "You are an App Store and consumer-protection reviewer. You predict rejections, takedowns and regulator attention before anything is built.",
    [
      "Apple 4.3 (spam): saturated categories such as astrology, horoscopes, dating reply generators and simple AI wrappers need real differentiation; template clones are rejected.",
      "Apple 1.4 (physical harm): health, diet, medical or dangerous-activity advice needs substantiation or is rejected; flag any diagnosis or efficacy angle.",
      "Apple 5.1.2(i): personal data sent to a third-party AI needs explicit consent naming the provider; flag photos of other people, contacts and biometric data.",
      "Apple 3.1.2: subscriptions must state terms clearly; dark-pattern paywalls get rejected.",
      "FTC: no income, health or results claims without evidence; no fake or AI-written testimonials (16 CFR 465); paid creator posts must be disclosed (Endorsement Guides 255).",
      "Minors: any audience under 18 triggers COPPA, state age-assurance and chatbot laws and platform teen rules; flag it as fatal unless clearly adult.",
      "Flag appearance rating, AI companions, gambling, finance and dating safety as high-risk domains that need human review.",
      ...SCORING,
    ],
    { playbook: false },
  ),
};

const LENSES: Lens[] = ["bier_skeptic", "growth_realist", "store_and_policy"];

/** Three critic lenses in parallel; the lens on each result is the one that was asked for. */
export async function critiqueIdea(ctx: AgentContext, idea: Idea): Promise<Critique[]> {
  return Promise.all(
    LENSES.map(async (lens) => {
      const out = await ctx.ports.llm.object({
        role: "critic",
        schemaName: SCHEMA.critique,
        system: LENS_SYSTEM[lens],
        instructions: `Critique this app idea through the ${lens} lens.`,
        input: { idea, lens },
        purpose: `critique_${lens}`,
      });
      return { ...out, lens };
    }),
  );
}

/** The ideator's own sensitivity labels are withheld so the classifier is independent. */
export function sensitivityInput(idea: Idea): SchemaInputs["SensitivityReview"] {
  return {
    idea: {
      title: idea.title,
      oneLiner: idea.oneLiner,
      aiCapability: idea.aiCapability,
      verdictMoment: idea.verdictMoment,
      monetization: idea.monetization,
      shareArtifact: idea.shareArtifact,
      wedge: { name: idea.wedge.name, description: idea.wedge.description, minAge: idea.wedge.minAge, maxAge: idea.wedge.maxAge },
    },
  };
}

/** Independent sensitive-domain and age classification. */
export async function classifySensitivity(ctx: AgentContext, idea: Idea): Promise<SensitivityReview> {
  return ctx.ports.llm.object({
    role: "compliance",
    schemaName: SCHEMA.sensitivity,
    system: COMPLIANCE_SYSTEM,
    instructions: "Classify the sensitive domains and minimum user age of this app idea.",
    input: sensitivityInput(idea),
    purpose: "sensitivity_review",
  });
}

/** Critiques + classifier + keyword backstop, then the deterministic gates. */
export async function screen(
  ctx: AgentContext,
  record: IdeaRecord,
  opts: { exposures: AudienceExposure[]; existingTitles: string[] },
): Promise<Screening> {
  const [critiques, classifier] = await Promise.all([critiqueIdea(ctx, record.idea), classifySensitivity(ctx, record.idea)]);
  const classifierDomains = [...new Set([...classifier.domains, ...keywordDomains(ideaFreeText(record.idea))])].sort();
  return screenIdea({
    screeningId: ctx.store.nextId("screening"),
    ideaId: record.id,
    idea: record.idea,
    config: ctx.config,
    now: ctx.ports.clock.iso(),
    exposures: opts.exposures,
    critiques,
    classifierDomains,
    classifierMinimumAge: Number(classifier.minimumAge),
    existingTitles: opts.existingTitles,
  });
}
