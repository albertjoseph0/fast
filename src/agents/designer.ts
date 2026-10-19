/**
 * Designer: idea → AppSpec, and one-variable variants after a failed test. Mechanical
 * problems are fixed by autoFix; judgment problems get one repair call. Delivery mode and
 * the allowed variant kinds are computed here from the change kind and failed stages,
 * never chosen by the model.
 */
import type { AgentContext } from "../core/context.ts";
import type { AppSpec, DeliveryMode, Idea, OnboardingStep, PolicyFinding, ValidationStage, Venture } from "../core/types.ts";
import { DEFAULT_ONBOARDING_SKELETON, DEFAULT_PUSH_SCHEDULE, defaultPaywall } from "../playbook/product.ts";
import { lintCopy } from "../principles/copy.ts";
import { autoFix, lintSpec } from "../principles/product.ts";
import { effectiveDomains } from "../principles/sensitivity.ts";
import { SCHEMA, type VariantChangeKind, type VariantProposal } from "./schemas.ts";
import { hasBlock, normKey, rolePrompt, screenedDomains, truncate } from "./shared.ts";

const SUBTITLE_MAX = 30;
const MIN_ONBOARDING_STEPS = 8;
const DROPPABLE_STEPS: readonly OnboardingStep["kind"][] = ["attribution_survey", "benefit", "multi_choice"];

const SYSTEM = rolePrompt(
  "You are the product designer of an app studio. You turn an approved idea into the complete spec the app template renders: onboarding, one AI capability, paywall, share card, push, store listing and privacy inventory.",
  [
    "Start from the defaults in the input: follow the onboarding skeleton (8-16 steps), keep ai_data_consent before any step that collects an answer, and put a value_preview or result_teaser before the paywall.",
    "Paywall: start from the default paywall. productIds and highlightedProductId come only from priceLadderIds. Headline and bullets carry no prices, currency, trial lengths, numbers, ratings or claims; terms are rendered from store data.",
    "Store limits: subtitle at most 30 characters, promotional text at most 170, keywords at most 100 characters comma-joined, 3-10 screenshot captions, at least 3 distinct name candidates, slug of lowercase a-z, 0-9 and dashes.",
    "Copy everywhere has no user counts, rankings, ratings, testimonials, efficacy, health or income promises, and no fake urgency.",
    "core.aiSystemPrompt is the product prompt only; a fixed safety preamble is prepended at build time. Never ask the model to ignore rules.",
    "share needs an artifact, a watermark with the app name and a deepLinkPath starting with '/'. An invite, if any, is sent by the user's own device and is at most 160 characters.",
    "dataInventory lists every data type honestly; the core input sent to the AI is a core_feature entry with sentTo including anthropic. minimumAge respects the idea's sensitive domains.",
    "For a variant, change exactly one thing of an allowed kind, keep everything else identical, and state a falsifiable hypothesis.",
  ],
  { playbook: true },
);

/** How a variant of each kind reaches users. */
export function deliveryModeFor(kind: VariantChangeKind): DeliveryMode {
  switch (kind) {
    case "hooks":
      return "content_only";
    case "positioning":
      return "store_metadata";
    case "onboarding":
    case "paywall":
    case "share":
    case "core":
      return "remote_config";
  }
}

const KINDS_BY_STAGE: Record<ValidationStage, VariantChangeKind[]> = {
  S0_attention: ["hooks"],
  S1_distribution: ["hooks", "positioning"],
  S1_activation: ["onboarding", "core"],
  S2_sharing: ["share"],
  S3_cross_cell: ["share", "core"],
  S4_monetization: ["paywall", "onboarding"],
};

/** Variant kinds that can plausibly move the failed stages, in stage order without duplicates. */
export function allowedKindsFor(stages: ValidationStage[]): VariantChangeKind[] {
  return [...new Set(stages.flatMap((s) => KINDS_BY_STAGE[s]))];
}

function triedKind(tried: string[], kind: VariantChangeKind): boolean {
  return tried.some((t) => t === kind || t.startsWith(`${kind}.`) || t.startsWith(`${kind}:`));
}

/** Spec for an idea: one design call, autoFix, lint, and one repair call if anything still blocks. */
export async function designSpec(
  ctx: AgentContext,
  opts: { idea: Idea; ventureId?: string },
): Promise<{ spec: AppSpec; findings: PolicyFinding[]; repaired: boolean }> {
  const { idea, ventureId } = opts;
  const config = ctx.config;
  const domains = effectiveDomains(idea, screenedDomains(ctx, ventureId));
  const venture = ventureId ? { ventureId } : {};

  const draft = await ctx.ports.llm.object({
    role: "designer",
    schemaName: SCHEMA.appSpec,
    system: SYSTEM,
    instructions: "Design the complete app spec for this idea.",
    input: {
      idea,
      locale: idea.wedge.locale || config.company.defaultLocale,
      defaults: {
        onboardingSkeleton: [...DEFAULT_ONBOARDING_SKELETON],
        paywall: defaultPaywall(config),
        priceLadderIds: config.monetization.ladder.map((e) => e.id),
        pushSchedule: DEFAULT_PUSH_SCHEDULE,
      },
      company: { legalName: config.company.legalName, supportEmail: config.company.supportEmail },
    },
    ...venture,
    purpose: "app_spec",
  });
  let spec = autoFix(draft, config).spec;
  let findings = lintSpec(spec, idea, config, domains);
  if (!hasBlock(findings)) return { spec, findings, repaired: false };

  const repair = await ctx.ports.llm.object({
    role: "designer",
    schemaName: SCHEMA.specRepair,
    system: SYSTEM,
    instructions: "Fix every finding in this spec. Change only what the findings require and list each change.",
    input: { spec, findings: findings.filter((f) => f.severity === "block").map((f) => ({ ruleId: f.ruleId, message: f.message })) },
    ...venture,
    purpose: "app_spec_repair",
  });
  spec = autoFix(repair.spec, config).spec;
  findings = lintSpec(spec, idea, config, domains);
  return { spec, findings, repaired: true };
}

/**
 * One-variable change after a failed variant. A proposal of a kind that is not allowed for
 * the failed stages, already tried, empty, or that introduces a new blocking lint finding
 * is replaced by a deterministic minimal change of the first allowed untried kind.
 */
export async function proposeVariant(
  ctx: AgentContext,
  opts: { venture: Pick<Venture, "id" | "name">; idea: Idea; spec: AppSpec; outcomeSummary: string; failedStages: ValidationStage[]; triedVariables: string[] },
): Promise<{ proposal: VariantProposal; deliveryMode: DeliveryMode }> {
  const { idea, spec } = opts;
  const allowed = allowedKindsFor(opts.failedStages);
  const pool = allowed.length > 0 ? allowed : (["hooks"] as VariantChangeKind[]);
  const untried = pool.filter((k) => !triedKind(opts.triedVariables, k));
  const candidates = untried.length > 0 ? untried : pool;

  const llm = await ctx.ports.llm.object({
    role: "designer",
    schemaName: SCHEMA.variantProposal,
    system: SYSTEM,
    instructions: "The last variant failed. Propose the single change most likely to fix the failed stages. Use one of allowedKinds.",
    input: {
      venture: { id: opts.venture.id, name: opts.venture.name },
      idea,
      spec,
      failedStages: opts.failedStages,
      outcomeSummary: opts.outcomeSummary,
      triedVariables: opts.triedVariables,
      allowedKinds: candidates,
    },
    ventureId: opts.venture.id,
    purpose: "variant_proposal",
  });

  const domains = effectiveDomains(idea, screenedDomains(ctx, opts.venture.id));
  const baseBlocks = blockIds(lintSpec(spec, idea, ctx.config, domains));
  const proposal = sanitize(llm);
  const acceptable =
    proposal !== null &&
    candidates.includes(proposal.change.kind) &&
    [...blockIds(lintSpec(applyVariant(spec, proposal), idea, ctx.config, domains))].every((id) => baseBlocks.has(id));
  const chosen = acceptable ? proposal : fallbackProposal(candidates[0] ?? "hooks", idea, spec, opts.failedStages);
  return { proposal: chosen, deliveryMode: deliveryModeFor(chosen.change.kind) };
}

/** Apply a proposal to a spec without mutating either. Hooks live outside the spec. */
export function applyVariant(spec: AppSpec, proposal: VariantProposal): AppSpec {
  const next = structuredClone(spec);
  const change = structuredClone(proposal.change);
  switch (change.kind) {
    case "hooks":
      return next;
    case "positioning": {
      const nameCandidates = dedupeNames([change.appName, ...next.nameCandidates]);
      return { ...next, appName: change.appName, subtitle: change.subtitle, nameCandidates };
    }
    case "onboarding":
      return { ...next, onboarding: change.onboarding };
    case "paywall":
      return { ...next, paywall: change.paywall };
    case "share":
      return { ...next, share: change.share };
    case "core":
      return { ...next, core: change.core };
  }
}

/** Drop blocked or empty hooks; null when nothing usable is left. */
function sanitize(p: VariantProposal): VariantProposal | null {
  const change = p.change;
  if (change.kind !== "hooks" && change.kind !== "positioning") return p;
  const hooks = cleanHooks(change.hooks);
  if (hooks.length === 0) return null;
  if (change.kind === "positioning") {
    if (!change.appName.trim()) return null;
    return { ...p, change: { ...change, appName: change.appName.trim(), subtitle: truncate(change.subtitle.trim(), SUBTITLE_MAX), hooks } };
  }
  return { ...p, change: { ...change, hooks } };
}

function cleanHooks(hooks: string[]): string[] {
  const seen = new Set<string>();
  return hooks
    .map((h) => h.trim())
    .filter((h) => h.length > 0 && !hasBlock(lintCopy({ text: h, surface: "content" })))
    .filter((h) => {
      const key = normKey(h);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** The smallest deterministic change of a kind, built only from the idea and the current spec. */
export function fallbackProposal(kind: VariantChangeKind, idea: Idea, spec: AppSpec, failedStages: ValidationStage[]): VariantProposal {
  const failed = failedStages.length > 0 ? failedStages.join(" and ") : "the last test";
  const verdictHooks = () => {
    const lead = `POV: ${lowerFirst(idea.verdictMoment)}`;
    const rotated = [...idea.hookExamples.slice(1), ...idea.hookExamples.slice(0, 1)];
    const hooks = cleanHooks([lead, ...rotated]);
    return hooks.length > 0 ? hooks : idea.hookExamples;
  };
  switch (kind) {
    case "hooks":
      return {
        variableUnderTest: "hooks",
        hypothesis: `Hooks that open on the verdict moment will lift ${failed}`,
        change: { kind, hooks: verdictHooks() },
      };
    case "positioning": {
      const appName = spec.nameCandidates.find((n) => normKey(n) !== normKey(spec.appName)) ?? spec.appName;
      return {
        variableUnderTest: "positioning",
        hypothesis: `Positioning on the one-line promise will lift ${failed}`,
        change: { kind, appName, subtitle: truncate(idea.oneLiner, SUBTITLE_MAX), hooks: verdictHooks() },
      };
    }
    case "onboarding": {
      const drop = spec.onboarding.findIndex((s) => DROPPABLE_STEPS.includes(s.kind));
      const onboarding = spec.onboarding.length > MIN_ONBOARDING_STEPS && drop >= 0 ? spec.onboarding.filter((_, i) => i !== drop) : spec.onboarding;
      return {
        variableUnderTest: "onboarding",
        hypothesis: `One fewer step before the value preview will lift ${failed}`,
        change: { kind, onboarding: structuredClone(onboarding) },
      };
    }
    case "paywall":
      return {
        variableUnderTest: "paywall",
        hypothesis: `A paywall that leads with the user's own result will lift ${failed}`,
        change: {
          kind,
          paywall: { ...structuredClone(spec.paywall), headline: "See your full result", bullets: [...spec.paywall.bullets.slice(1), ...spec.paywall.bullets.slice(0, 1)] },
        },
      };
    case "share":
      return {
        variableUnderTest: "share",
        hypothesis: `A share card that invites comparison will lift ${failed}`,
        change: { kind, share: { ...structuredClone(spec.share), cardHeadline: `What does ${spec.appName} say about you?` } },
      };
    case "core": {
      const rest = spec.core.outputSections.filter((s) => normKey(s) !== "verdict");
      return {
        variableUnderTest: "core",
        hypothesis: `Leading the result with a one-line verdict will lift ${failed}`,
        change: { kind, core: { ...structuredClone(spec.core), outputSections: ["Verdict", ...rest] } },
      };
    }
  }
}

function blockIds(findings: PolicyFinding[]): Set<string> {
  return new Set(findings.filter((f) => f.severity === "block").map((f) => f.ruleId));
}

function dedupeNames(names: string[]): string[] {
  const seen = new Set<string>();
  return names.filter((n) => {
    const key = normKey(n);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function lowerFirst(text: string): string {
  const t = text.trim();
  return t.charAt(0).toLowerCase() + t.slice(1);
}
