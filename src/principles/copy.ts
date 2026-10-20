/**
 * Deterministic copy lint for every surface an LLM writes: onboarding, paywall, store
 * listing, screenshots, share cards, push, owned content and creator briefs.
 *
 * It blocks what an AI studio must never publish without evidence: user counts,
 * ratings, rankings, efficacy promises, testimonials and hard-coded prices (prices are
 * rendered from store data at runtime). Approved Claim texts are exempt verbatim.
 * Citations: FTC 16 CFR 465 (fake/AI testimonials), Endorsement Guides 255,
 * Apple 2.3.1 / 3.1.2 / 5.6, ROSCA.
 */
import type { Claim, PolicyFinding } from "../core/types.ts";

export type CopySurface =
  | "onboarding"
  | "paywall"
  | "aso"
  | "screenshot"
  | "share"
  | "push"
  | "content"
  | "brief"
  | "support"
  | "system_prompt";

interface CopyRule {
  ruleId: string;
  pattern: RegExp;
  severity: PolicyFinding["severity"];
  message: string;
  citation: string;
  surfaces?: CopySurface[];
}

const RULES: CopyRule[] = [
  {
    ruleId: "copy.unverified_count",
    pattern:
      /(\b\d[\d,.]*\+?\s*(k|m|million|thousand|users|people|downloads|members|customers)\b|\b\d{1,3}(,\d{3})+\b|\b\d{4,}\s*\+|\b\d+(\.\d+)?\s?[km]\+|\b(thousands|millions|billions)\b)/i,
    severity: "block",
    message: "Quantified social proof needs an approved claim backed by metrics",
    citation: "FTC Act s.5 substantiation; Apple 2.3.1",
  },
  {
    ruleId: "copy.unverified_ranking",
    pattern: /(#\s?1\b|\bno\.?\s?1\b|\bnumber one\b|\btop[- ]rated\b|\bbest[- ]rated\b|\bmost popular\b|\bworld'?s (best|first|leading)\b|\b(the )?best \w+ app\b)/i,
    severity: "block",
    message: "Ranking or superiority claims need an approved claim",
    citation: "FTC Act s.5; Apple 2.3.1",
  },
  {
    ruleId: "copy.unverified_rating",
    pattern: /(★|⭐|\b[1-5](\.\d)?\s*stars?\b|\brated\s+[1-5](\.\d)?\b|\b[1-5](\.\d)?\s*(\/|out of)\s*5\b)/i,
    severity: "block",
    message: "Ratings may only be quoted from the store with an approved claim",
    citation: "Apple 5.6.3; FTC 16 CFR 465",
  },
  {
    ruleId: "copy.testimonial",
    // First-person quotes, or any quote attributed to a name or handle ("..." - Jess, 22).
    pattern: /(["“][^"”]{3,}\b(I|I'm|I've|my|me)\b[^"”]*["”]\s*[-–—]\s*[A-Z]?\w+|["“][^"”]{3,}["”]\s*[-–—]\s*(@\w+|[A-Z][a-z]+(,\s*\d{1,2}\b|\s+[A-Z]\.?(?!\w)|\s*[,.;)]|\s*$)))/,
    severity: "block",
    message: "Quoted testimonials must come from real, verified users (never generated)",
    citation: "FTC 16 CFR 465.2; Endorsement Guides 255.1",
  },
  {
    ruleId: "copy.currency_literal",
    pattern:
      /([$€£¥]\s?\d|\b\d+([.,]\d{2})?\s?(usd|eur|gbp|aud|cad|nzd|dollars?|euros?|pounds?)\b|\b\d+[.,]\d{2}\s*(\/\s*(week|wk|month|mo|year|yr)|(a|per|each)\s+(week|month|year))\b)/i,
    severity: "block",
    message: "Prices are rendered from the store at runtime; copy must not hard-code currency amounts",
    citation: "Apple 3.1.2; ROSCA",
    surfaces: ["onboarding", "paywall", "aso", "screenshot", "share", "push", "content", "brief"],
  },
  {
    ruleId: "copy.trial_length",
    pattern:
      /\b((\d+|one|two|three|five|seven|ten|fourteen|thirty)[- ]?(days?|weeks?|months?)[- ](free|trial)\b|free\s+for\s+(\d+|a|one|two|three|five|seven|ten|fourteen|thirty)\s+(days?|weeks?|months?)\b)/i,
    severity: "block",
    message: "Trial lengths come from the store product at runtime; copy must not hard-code them",
    citation: "Apple 3.1.2; ROSCA",
    surfaces: ["onboarding", "paywall", "aso", "screenshot", "share", "push", "content", "brief"],
  },
  {
    ruleId: "copy.efficacy_claim",
    pattern:
      /\b(guarantee[sd]?|100% accurate|always accurate|cures?|cured|heals?|clinically|scientifically proven|doctor[- ]approved|diagnos(e|is)|lose \d+\s?(lbs?|kg|pounds)|get rich|risk[- ]free returns?)\b/i,
    severity: "needs_human",
    message: "Efficacy, health or money promises need substantiation and human review",
    citation: "FTC Act s.5; Apple 1.4.1",
  },
  {
    ruleId: "copy.fake_urgency",
    pattern: /\b(only \d+ (spots?|seats?|left)|offer ends (today|tonight|soon)|last chance|expires in \d+ (minutes?|hours?))\b/i,
    severity: "warn",
    message: "Artificial scarcity or countdowns are a dark pattern",
    citation: "FTC dark patterns report (2022)",
  },
  {
    ruleId: "copy.prompt_override",
    pattern: /\b(ignore (all |the |any )?(previous|prior|above) (instructions|rules)|no (restrictions|rules|filters)|jailbreak|developer mode)\b/i,
    severity: "block",
    message: "Product prompts may not try to override the fixed safety preamble",
    citation: "Apple 1.1 / 1.2 (objectionable generated content)",
    surfaces: ["system_prompt"],
  },
];

export interface CopyLintInput {
  text: string;
  surface: CopySurface;
  /** Approved claims whose exact text may appear. */
  claims?: Claim[];
  /** Where in a spec the text came from, for messages (e.g. "paywall.bullets[2]"). */
  path?: string;
}

/** Lint one piece of copy. Returns findings; empty means clean. */
export function lintCopy(input: CopyLintInput): PolicyFinding[] {
  let text = input.text;
  for (const claim of input.claims ?? []) {
    if (claim.approvedBy && claim.text) text = text.split(claim.text).join(" ");
  }
  const findings: PolicyFinding[] = [];
  for (const rule of RULES) {
    if (rule.surfaces && !rule.surfaces.includes(input.surface)) continue;
    const match = rule.pattern.exec(text);
    if (!match) continue;
    findings.push({
      ruleId: rule.ruleId,
      severity: rule.severity,
      message: `${rule.message}${input.path ? ` at ${input.path}` : ""}: "${match[0].trim()}"`,
      citation: rule.citation,
    });
  }
  return findings;
}

/** Lint many strings at once; `path` is attached to each finding. */
export function lintCopyAll(items: { text: string; path: string }[], surface: CopySurface, claims?: Claim[]): PolicyFinding[] {
  return items.flatMap((i) => lintCopy({ text: i.text, surface, path: i.path, ...(claims ? { claims } : {}) }));
}

export const COPY_RULE_IDS: readonly string[] = RULES.map((r) => r.ruleId);
