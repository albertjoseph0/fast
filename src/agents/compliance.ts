/**
 * Compliance copy review: the deterministic copy lint is the floor, and Claude can only
 * add findings or escalate existing ones, never clear or downgrade them.
 */
import type { AgentContext } from "../core/context.ts";
import type { PolicyFinding, SensitiveDomain } from "../core/types.ts";
import { COPY_RULE_IDS, lintCopy, type CopySurface } from "../principles/copy.ts";
import { SCHEMA, type SchemaInputs } from "./schemas.ts";
import { rolePrompt, severityRank } from "./shared.ts";

export type CopyKind = SchemaInputs["ComplianceReview"]["kind"];

export const LLM_OTHER = "llm_other";

/** Shared by every compliance-role call (sensitivity classification and copy review). */
export const COMPLIANCE_SYSTEM = rolePrompt(
  "You are the compliance reviewer of an app studio. You classify ideas and review copy against platform policy and consumer-protection law.",
  [
    "Classify sensitive domains independently and conservatively; when in doubt, include the domain.",
    "Domains: health (diet, calories, symptoms, fertility), mental_health (anxiety, addiction, therapy), finance (investing, budgets, debt), legal, dating_safety (dating, flirting, matches), religion, minors (anyone under 18 as a user or subject), biometric (face, voice or body scans), ai_companion (ongoing AI relationships or role-play), appearance_rating (rating looks or bodies), astrology_fortune (astrology, tarot, fortune telling), gambling.",
    "minimumAge is 18 for dating, appearance rating, AI companions, gambling and finance; otherwise the youngest intended user rounded up to 13, 16 or 18.",
    "In copy reviews flag claims (user counts, ratings, rankings, efficacy, income), testimonials, prices or trial lengths in copy, missing disclosures, dark patterns and anything aimed at minors.",
    `Use one of these rule ids when it fits: ${COPY_RULE_IDS.join(", ")}. Otherwise use '${LLM_OTHER}'.`,
    "Severity: info, warn, needs_human (a person must look), block (must not ship). Return no findings for clean copy.",
    "Write rationales and messages in one or two plain sentences.",
  ],
);

const SURFACE: Record<CopyKind, CopySurface> = {
  listing: "aso",
  paywall: "paywall",
  onboarding: "onboarding",
  content: "content",
  brief: "brief",
  push: "push",
  support: "support",
};

/** Copy lint findings merged with the LLM review; one finding per rule id at its highest severity. */
export async function reviewCopy(
  ctx: AgentContext,
  opts: { kind: CopyKind; text: string; appName: string; domains: SensitiveDomain[] },
): Promise<PolicyFinding[]> {
  const lint = lintCopy({ text: opts.text, surface: SURFACE[opts.kind] });
  const review = await ctx.ports.llm.object({
    role: "compliance",
    schemaName: SCHEMA.complianceReview,
    system: COMPLIANCE_SYSTEM,
    instructions: `Review this ${opts.kind} copy for policy and consumer-protection problems.`,
    input: { kind: opts.kind, text: opts.text, context: { appName: opts.appName, sensitiveDomains: opts.domains } },
    purpose: `compliance_${opts.kind}`,
  });
  const known = new Set(COPY_RULE_IDS);
  const llm: PolicyFinding[] = review.findings.map((f) => ({
    ruleId: known.has(f.ruleId) ? f.ruleId : LLM_OTHER,
    severity: f.severity,
    message: f.message.trim(),
    citation: "compliance review (LLM)",
  }));
  return mergeFindings(lint, llm);
}

/**
 * Deterministic findings first; an LLM finding on the same rule can only raise its
 * severity, and a new rule id is appended.
 */
export function mergeFindings(base: PolicyFinding[], added: PolicyFinding[]): PolicyFinding[] {
  const out: PolicyFinding[] = [];
  const index = new Map<string, number>();
  for (const f of [...base, ...added]) {
    const at = index.get(f.ruleId);
    if (at === undefined) {
      index.set(f.ruleId, out.length);
      out.push({ ...f });
      continue;
    }
    const current = out[at] as PolicyFinding;
    if (severityRank(f.severity) > severityRank(current.severity)) {
      out[at] = { ...current, severity: f.severity, message: `${current.message} (escalated: ${f.message})` };
    }
  }
  return out;
}
