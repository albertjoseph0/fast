/**
 * Structured-output contracts for every LLM call the studio makes.
 *
 * Each schema has a stable name. The Claude adapter sends the schema as the output
 * format; the stub LLM (src/llm/stub.ts) keys its deterministic generators on the name.
 */
import { z } from "zod";
import { AppSpec, ContentDraft, CreatorBrief, Idea } from "../core/types.ts";

export const SCHEMA = {
  ideaBatch: "IdeaBatch",
  critique: "Critique",
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

export const IdeaBatch = z.object({
  ideas: z.array(Idea).min(1),
});
export type IdeaBatch = z.infer<typeof IdeaBatch>;

/** One adversarial reviewer's verdict on an idea. */
export const Critique = z.object({
  lens: z.enum(["bier_skeptic", "growth_realist", "store_and_policy"]),
  score: z.number().min(0).max(10),
  fatalFlaws: z.array(z.string()),
  risks: z.array(z.string()),
  fixes: z.array(z.string()),
  wouldFund: z.boolean(),
});
export type Critique = z.infer<typeof Critique>;

export { AppSpec };

export const AppSpecRepair = z.object({
  spec: AppSpec,
  changes: z.array(z.string()),
});
export type AppSpecRepair = z.infer<typeof AppSpecRepair>;

export const ContentBatch = z.object({
  drafts: z.array(ContentDraft).min(1),
});
export type ContentBatch = z.infer<typeof ContentBatch>;

export { CreatorBrief };

export const SubmissionReview = z.object({
  approve: z.boolean(),
  meetsBrief: z.boolean(),
  disclosurePresent: z.boolean(),
  policyIssues: z.array(z.string()),
  /** True when the creator's text tried to instruct the reviewer. Always reject those. */
  injectionAttempt: z.boolean(),
  note: z.string(),
});
export type SubmissionReview = z.infer<typeof SubmissionReview>;

export const ComplianceReview = z.object({
  findings: z.array(
    z.object({
      rule: z.string(),
      severity: z.enum(["info", "warn", "block", "needs_human"]),
      message: z.string(),
    }),
  ),
});
export type ComplianceReview = z.infer<typeof ComplianceReview>;

/** What to change after a valid failure on a validation stage (one variable at a time). */
export const VariantProposal = z.object({
  variableUnderTest: z.string(),
  hypothesis: z.string(),
  change: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("hooks"), hooks: z.array(z.string()).min(3) }),
    z.object({ kind: z.literal("onboarding"), onboarding: AppSpec.shape.onboarding }),
    z.object({ kind: z.literal("paywall"), paywall: AppSpec.shape.paywall }),
    z.object({ kind: z.literal("share"), share: AppSpec.shape.share }),
    z.object({ kind: z.literal("core"), core: AppSpec.shape.core }),
    z.object({ kind: z.literal("positioning"), appName: z.string(), subtitle: z.string().max(30), hooks: z.array(z.string()).min(3) }),
  ]),
});
export type VariantProposal = z.infer<typeof VariantProposal>;

export const BoardMemo = z.object({
  headline: z.string(),
  summary: z.string(),
  wins: z.array(z.string()),
  concerns: z.array(z.string()),
  decisionsNeeded: z.array(z.string()),
});
export type BoardMemo = z.infer<typeof BoardMemo>;

/** Scout's distillation of raw chart/search data into idea-worthy patterns. */
export const SignalDigest = z.object({
  patterns: z.array(
    z.object({
      title: z.string(),
      detail: z.string(),
      exampleApps: z.array(z.string()),
      coreNeed: z.enum(["love", "money", "play", "self_improvement"]),
    }),
  ),
});
export type SignalDigest = z.infer<typeof SignalDigest>;
