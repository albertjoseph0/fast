import type { SchemaInputs, SchemaName } from "../../src/agents/schemas.ts";
import { defaultConfig } from "../../src/config/schema.ts";
import type { CostEvent, CostMeter, LlmObjectRequest } from "../../src/core/ports.ts";
import { Rng } from "../../src/core/rng.ts";
import type { AppSpec, Idea } from "../../src/core/types.ts";
import { GOOD_ARCHETYPES, FLAWED_ARCHETYPES, ideaFromArchetype } from "../../src/llm/stub-ideas.ts";
import { formatSummaries } from "../../src/playbook/formats.ts";
import { DEFAULT_ONBOARDING_SKELETON, DEFAULT_PUSH_SCHEDULE, defaultPaywall } from "../../src/playbook/product.ts";

export const CONFIG = defaultConfig();

export function archetypeIdea(title: string): Idea {
  const a = [...GOOD_ARCHETYPES, ...FLAWED_ARCHETYPES].find((x) => x.title === title);
  if (!a) throw new Error(`no archetype ${title}`);
  return ideaFromArchetype(a, new Rng(7));
}

export function appSpecInput(idea: Idea): SchemaInputs["AppSpec"] {
  return {
    idea,
    locale: "en-US",
    defaults: {
      onboardingSkeleton: [...DEFAULT_ONBOARDING_SKELETON],
      paywall: defaultPaywall(CONFIG),
      priceLadderIds: CONFIG.monetization.ladder.map((e) => e.id),
      pushSchedule: DEFAULT_PUSH_SCHEDULE,
    },
    company: { legalName: CONFIG.company.legalName, supportEmail: CONFIG.company.supportEmail },
  };
}

/** Realistic inputs for every schema, built around one idea and its spec. */
export function inputsFor(idea: Idea, spec: AppSpec): { [N in SchemaName]: SchemaInputs[N] } {
  const product = { name: spec.appName, oneLiner: idea.oneLiner, verdictMoment: idea.verdictMoment, shareArtifact: idea.shareArtifact, wedge: idea.wedge.name };
  const brief = {
    title: `${spec.appName} creator brief`,
    productSummary: idea.oneLiner,
    audience: idea.wedge.name,
    formats: ["TikTok photo slideshow story", "POV hook"],
    hooks: idea.hookExamples,
    mustInclude: ["Show the app within the first 15 seconds"],
    mustAvoid: ["Accuracy claims"],
    deliverables: "One vertical video",
  };
  return {
    IdeaBatch: {
      count: 8,
      signals: [
        { title: "Astrology apps charting in CA", detail: "Co-Star and Nebula in the top 50 lifestyle", metrics: { rank: 12 }, tags: ["astrology", "lifestyle"] },
        { title: "Dating reply generators trending", detail: "rizz app hooks on TikTok", metrics: { views: 1_200_000 }, tags: ["dating", "rizz"] },
      ],
      coreNeeds: ["love", "money", "play"],
      avoidTitles: ["Starmatch"],
      playbookNotes: ["Single-player verdict apps with a hard paywall"],
    },
    Critique: { idea, lens: "bier_skeptic" },
    SensitivityReview: {
      idea: {
        title: idea.title,
        oneLiner: idea.oneLiner,
        aiCapability: idea.aiCapability,
        verdictMoment: idea.verdictMoment,
        monetization: idea.monetization,
        shareArtifact: idea.shareArtifact,
        wedge: { name: idea.wedge.name, description: idea.wedge.description, minAge: idea.wedge.minAge, maxAge: idea.wedge.maxAge },
      },
    },
    AppSpec: appSpecInput(idea),
    AppSpecRepair: { spec, findings: [{ ruleId: "spec.subtitle_length", message: "subtitle is too long" }] },
    ContentBatch: {
      purpose: "owned_post",
      platform: "tiktok",
      count: 4,
      product,
      formats: formatSummaries({ platform: "tiktok" }).slice(0, 4),
      topHooks: idea.hookExamples,
      allowedVoices: ["brand_third_person", "product_demo"],
    },
    CreatorBrief: {
      product: { name: spec.appName, oneLiner: idea.oneLiner, verdictMoment: idea.verdictMoment, audience: idea.wedge.name, subscriptionRequired: true },
      formats: formatSummaries({ channel: "creator" }).slice(0, 3),
      topHooks: idea.hookExamples,
      mustAvoid: ["Medical claims"],
    },
    SubmissionReview: { brief, submission: { platform: "tiktok", creatorHandle: "zodiacqueen", stage: "draft_submitted" } },
    ComplianceReview: { kind: "listing", text: spec.aso?.description ?? idea.oneLiner, context: { appName: spec.appName, sensitiveDomains: idea.sensitiveDomains } },
    VariantProposal: {
      venture: { id: "ven_000001", name: spec.appName },
      idea,
      spec,
      failedStages: ["S1_distribution"],
      outcomeSummary: "Installs per 1K views below floor in all three cells",
      triedVariables: ["hooks"],
      allowedKinds: ["hooks", "positioning", "paywall"],
    },
    BoardMemo: {
      date: "2026-03-02",
      cashCents: 4_812_345,
      freeCashCents: 3_100_000,
      ventures: [
        { id: "ven_000001", name: spec.appName, stage: "live_test", detail: "S1 running in CA, AU, NZ" },
        { id: "ven_000002", name: "Penny", stage: "scaling", detail: "passed S4 with ROAS 1.2" },
        { id: "ven_000003", name: "Squadup", stage: "killed", detail: "failed P2 gate" },
      ],
      decisions: ["kill ven_000003", "scale ven_000002"],
      pendingApprovals: 2,
      openHumanTasks: 1,
    },
    SignalDigest: {
      charts: [
        { name: "Co-Star", genre: "Lifestyle", rank: 14, chart: "top-free", country: "CA" },
        { name: "Nebula", genre: "Lifestyle", rank: 31, chart: "top-free", country: "AU" },
        { name: "Cal AI", genre: "Health & Fitness", rank: 8, chart: "top-free", country: "CA" },
        { name: "Chess.com", genre: "Games", rank: 22, chart: "top-free", country: "NZ" },
      ],
      searches: [{ term: "tarot reading", top: [{ name: "Labyrinthos", ratingCount: 12000, priceCents: 0 }] }],
    },
  };
}

export function objectRequest<N extends SchemaName>(schemaName: N, input: SchemaInputs[N], extra: Partial<LlmObjectRequest<N>> = {}): LlmObjectRequest<N> {
  return {
    role: "ideator",
    schemaName,
    system: "You are a studio agent.",
    instructions: `Produce a ${schemaName}.`,
    input,
    purpose: `test:${schemaName}`,
    ...extra,
  };
}

export class FakeMeter implements CostMeter {
  readonly charges: CostEvent[] = [];
  readonly asserts: { kind: CostEvent["kind"]; estimateCents: number }[] = [];
  failWith: Error | null = null;

  assertBudget(kind: CostEvent["kind"], estimateCents: number): void {
    this.asserts.push({ kind, estimateCents });
    if (this.failWith) throw this.failWith;
  }
  charge(event: CostEvent): void {
    this.charges.push(event);
  }
  remainingTodayCents(): number {
    return 1_000_000;
  }
}
