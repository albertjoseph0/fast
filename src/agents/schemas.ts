/**
 * Structured-output contracts for every LLM call the studio makes.
 *
 * Each schema has a stable name, a typed input and a typed output. Agents pass the
 * input object (never prose-embedded data); the Claude adapter renders it into the
 * prompt and the deterministic stub (src/llm/stub.ts) reads it directly.
 *
 * Output schemas carry types and enums only. Ranges, lengths and counts are enforced
 * afterwards by deterministic lint, so a single out-of-range field cannot fail a call.
 */
import { z } from "zod";
import {
  AppSpec,
  ContentDraft,
  CoreNeed,
  CreatorBrief,
  Critique,
  Idea,
  Platform,
  SensitiveDomain,
  type OnboardingStepKind,
  type PaywallConfig,
} from "../core/types.ts";

export const SCHEMA = {
  ideaBatch: "IdeaBatch",
  critique: "Critique",
  sensitivity: "SensitivityReview",
  appSpec: "AppSpec",
  specRepair: "AppSpecRepair",
  contentBatch: "ContentBatch",
  creatorBrief: "CreatorBrief",
  submissionReview: "SubmissionReview",
  complianceReview: "ComplianceReview",
  variantProposal: "VariantProposal",
  boardMemo: "BoardMemo",
  signalDigest: "SignalDigest",
} as const;
export type SchemaName = (typeof SCHEMA)[keyof typeof SCHEMA];

// ---------------------------------------------------------------------------
// Output schemas
// ---------------------------------------------------------------------------

export const IdeaBatch = z.object({ ideas: z.array(Idea) });
export type IdeaBatch = z.infer<typeof IdeaBatch>;

export { Critique };

/** Independent classifier: never sees the ideator's own sensitivity labels. */
export const SensitivityReview = z.object({
  domains: z.array(SensitiveDomain),
  minimumAge: z.enum(["13", "16", "18"]),
  rationale: z.string(),
});
export type SensitivityReview = z.infer<typeof SensitivityReview>;

export { AppSpec };

export const AppSpecRepair = z.object({
  spec: AppSpec,
  changes: z.array(z.string()),
});
export type AppSpecRepair = z.infer<typeof AppSpecRepair>;

export const ContentBatch = z.object({ drafts: z.array(ContentDraft) });
export type ContentBatch = z.infer<typeof ContentBatch>;

export { CreatorBrief };

/** The LLM can only veto a payout; eligibility and amounts are computed by code. */
export const SubmissionReview = z.object({
  approve: z.boolean(),
  meetsBrief: z.boolean(),
  /** True when the creator's text tried to instruct the reviewer. Always rejected. */
  injectionAttempt: z.boolean(),
  policyIssues: z.array(z.string()),
  formatIdUsed: z.string().nullable(),
  hookUsedVerbatim: z.boolean(),
  appRevealSecond: z.number().nullable(),
  subscriptionDisclosed: z.boolean(),
  note: z.string().describe("At most 280 characters"),
});
export type SubmissionReview = z.infer<typeof SubmissionReview>;

export const ComplianceReview = z.object({
  findings: z.array(
    z.object({
      ruleId: z.string().describe("A known rule id, or 'llm_other'"),
      severity: z.enum(["info", "warn", "block", "needs_human"]),
      message: z.string(),
    }),
  ),
});
export type ComplianceReview = z.infer<typeof ComplianceReview>;

/** One variable changed after a failed variant. Delivery mode is computed by code from `change.kind`. */
export const VariantProposal = z.object({
  variableUnderTest: z.string(),
  hypothesis: z.string(),
  change: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("hooks"), hooks: z.array(z.string()) }),
    z.object({ kind: z.literal("onboarding"), onboarding: AppSpec.shape.onboarding }),
    z.object({ kind: z.literal("paywall"), paywall: AppSpec.shape.paywall }),
    z.object({ kind: z.literal("share"), share: AppSpec.shape.share }),
    z.object({ kind: z.literal("core"), core: AppSpec.shape.core }),
    z.object({
      kind: z.literal("positioning"),
      appName: z.string(),
      subtitle: z.string(),
      hooks: z.array(z.string()),
    }),
  ]),
});
export type VariantProposal = z.infer<typeof VariantProposal>;
export type VariantChangeKind = VariantProposal["change"]["kind"];

export const BoardMemo = z.object({
  headline: z.string(),
  summary: z.string(),
  wins: z.array(z.string()),
  concerns: z.array(z.string()),
  decisionsNeeded: z.array(z.string()),
});
export type BoardMemo = z.infer<typeof BoardMemo>;

export const SignalDigest = z.object({
  patterns: z.array(
    z.object({
      title: z.string(),
      detail: z.string(),
      exampleApps: z.array(z.string()),
      coreNeed: CoreNeed,
    }),
  ),
});
export type SignalDigest = z.infer<typeof SignalDigest>;

// ---------------------------------------------------------------------------
// Typed inputs
// ---------------------------------------------------------------------------

export interface ContentFormatSummary {
  id: string;
  name: string;
  structure: string;
  platforms: z.infer<typeof Platform>[];
}

export interface SchemaInputs {
  IdeaBatch: {
    count: number;
    /** Title and detail only for studio-written signals; external ones carry a ref into the market_signals untrusted block. */
    signals: { ref?: string; title?: string; detail?: string; metrics: Record<string, number>; tags: string[] }[];
    coreNeeds: CoreNeed[];
    avoidTitles: string[];
    playbookNotes: string[];
  };
  Critique: { idea: Idea; lens: Critique["lens"] };
  SensitivityReview: {
    idea: Pick<Idea, "title" | "oneLiner" | "aiCapability" | "verdictMoment" | "monetization" | "shareArtifact"> & {
      wedge: Pick<Idea["wedge"], "name" | "description" | "minAge" | "maxAge">;
    };
  };
  AppSpec: {
    idea: Idea;
    locale: string;
    defaults: {
      onboardingSkeleton: OnboardingStepKind[];
      paywall: PaywallConfig;
      priceLadderIds: string[];
      pushSchedule: AppSpec["retention"]["pushSchedule"];
    };
    company: { legalName: string; supportEmail: string };
  };
  AppSpecRepair: { spec: AppSpec; findings: { ruleId: string; message: string }[] };
  ContentBatch: {
    purpose: "attention_probe" | "creator_reference" | "owned_post";
    platform: z.infer<typeof Platform>;
    count: number;
    product: { name: string; oneLiner: string; verdictMoment: string; shareArtifact: string; wedge: string };
    formats: ContentFormatSummary[];
    topHooks: string[];
    allowedVoices: ContentDraft["voice"][];
  };
  CreatorBrief: {
    product: { name: string; oneLiner: string; verdictMoment: string; audience: string; subscriptionRequired: boolean };
    formats: ContentFormatSummary[];
    topHooks: string[];
    mustAvoid: string[];
  };
  SubmissionReview: {
    brief: CreatorBrief;
    submission: { platform: z.infer<typeof Platform>; creatorHandle: string; stage: "draft_submitted" | "posted" };
  };
  ComplianceReview: {
    kind: "listing" | "paywall" | "onboarding" | "content" | "brief" | "push" | "support";
    text: string;
    context: { appName: string; sensitiveDomains: z.infer<typeof SensitiveDomain>[] };
  };
  VariantProposal: {
    venture: { id: string; name: string };
    idea: Idea;
    spec: AppSpec;
    failedStages: string[];
    outcomeSummary: string;
    triedVariables: string[];
    allowedKinds: VariantChangeKind[];
  };
  BoardMemo: {
    date: string;
    cashCents: number;
    freeCashCents: number;
    ventures: { id: string; name: string; stage: string; detail: string }[];
    decisions: string[];
    pendingApprovals: number;
    openHumanTasks: number;
  };
  /** `name` is an opaque app ref (app_1); the third-party names travel in the app_store untrusted block. */
  SignalDigest: {
    charts: { name: string; genre: string; rank: number; chart: string; country: string }[];
    searches: { term: string; top: { name: string; ratingCount: number; priceCents: number }[] }[];
  };
}

export interface SchemaOutputs {
  IdeaBatch: IdeaBatch;
  Critique: Critique;
  SensitivityReview: SensitivityReview;
  AppSpec: AppSpec;
  AppSpecRepair: AppSpecRepair;
  ContentBatch: ContentBatch;
  CreatorBrief: CreatorBrief;
  SubmissionReview: SubmissionReview;
  ComplianceReview: ComplianceReview;
  VariantProposal: VariantProposal;
  BoardMemo: BoardMemo;
  SignalDigest: SignalDigest;
}

/** The zod schema for each name. The LLM adapter looks schemas up here; callers never pass one. */
export const SCHEMAS: { [N in SchemaName]: z.ZodType<SchemaOutputs[N]> } = {
  IdeaBatch,
  Critique,
  SensitivityReview,
  AppSpec,
  AppSpecRepair,
  ContentBatch,
  CreatorBrief,
  SubmissionReview,
  ComplianceReview,
  VariantProposal,
  BoardMemo,
  SignalDigest,
};
