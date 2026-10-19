/**
 * Helpers shared by the role agents: stable system prompts, severity ordering and small
 * text utilities. System prompts are pure functions of constants so every call of a role
 * sends identical bytes (prompt caching, reproducible stub runs).
 */
import type { Idea, PolicyFinding, SensitiveDomain } from "../core/types.ts";
import type { AgentContext } from "../core/context.ts";
import { UNTRUSTED_RULE } from "../llm/prompt.ts";
import { playbookContext } from "../playbook/context.ts";

/** A role system prompt: identity, numbered rules, then the untrusted-data rule and the playbook when asked for. */
export function rolePrompt(identity: string, rules: readonly string[], opts: { playbook?: boolean; untrusted?: boolean } = {}): string {
  const parts = [identity.trim(), `Rules:\n${rules.map((r, i) => `${i + 1}. ${r}`).join("\n")}`];
  if (opts.untrusted) parts.push(UNTRUSTED_RULE);
  if (opts.playbook) parts.push(`# Studio playbook\n\n${playbookContext()}`);
  return parts.join("\n\n");
}

const SEVERITY_RANK: Record<PolicyFinding["severity"], number> = { info: 0, warn: 1, needs_human: 2, block: 3 };

/** info < warn < needs_human < block. */
export function severityRank(s: PolicyFinding["severity"]): number {
  return SEVERITY_RANK[s];
}

export function hasBlock(findings: PolicyFinding[]): boolean {
  return findings.some((f) => f.severity === "block");
}

/** Cut to at most `max` characters, at a word boundary when one exists. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max + 1);
  const space = cut.lastIndexOf(" ");
  return (space > 0 ? cut.slice(0, space) : text.slice(0, max)).replace(/[\s,;:.\-–—]+$/u, "");
}

/** Case- and whitespace-insensitive key for deduping titles and phrases. */
export function normKey(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Every free-text field of an idea except its own sensitivity labels. */
export function ideaFreeText(idea: Idea): string {
  return [
    idea.title,
    idea.oneLiner,
    idea.wedge.name,
    idea.wedge.description,
    idea.wedge.creatorNiche,
    idea.verdictMoment,
    idea.aiCapability,
    ...idea.valueConditions,
    idea.shareArtifact,
    ...idea.hookExamples,
    idea.monetization.payFor,
    idea.differentiation,
  ].join("\n");
}

/** Effective sensitive domains recorded at screening for a venture, if any. */
export function screenedDomains(ctx: AgentContext, ventureId: string | undefined): SensitiveDomain[] {
  if (!ventureId) return [];
  const venture = ctx.store.ventures.get(ventureId);
  if (!venture) return [];
  return ctx.store.screenings.get(venture.screeningId)?.sensitiveDomains ?? [];
}
