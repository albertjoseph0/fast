/**
 * Onboarding lint (Bier P8): long personalization flows are fine when they raise
 * activation, but data is collected only after AI-data consent (Apple 5.1.2(i)) and the
 * user sees value before an after-onboarding paywall (never paywall before the aha).
 */
import type { AppSpec, OnboardingStep, OnboardingStepKind, PolicyFinding } from "../core/types.ts";
import { lintCopyAll } from "./copy.ts";

/** Steps that collect personal data the AI receives; consent must come first. */
export const DATA_INPUT_STEPS: readonly OnboardingStepKind[] = ["text_input", "date_input", "time_input", "place_input"];
/**
 * A step collects data the AI receives when it is a data-input step or saves its answer to
 * the profile (storeAs): the app sends the whole profile with every verdict request.
 */
export function collectsData(step: OnboardingStep): boolean {
  return DATA_INPUT_STEPS.includes(step.kind) || Boolean(step.storeAs?.trim());
}

/** True when any onboarding answer or the core input reaches the AI. */
export function sendsDataToAi(spec: AppSpec): boolean {
  return spec.core.inputKind !== "none" || spec.onboarding.some(collectsData);
}

/** Steps that show the user a taste of the verdict. */
export const VALUE_STEPS: readonly OnboardingStepKind[] = ["value_preview", "result_teaser"];
const CHOICE_STEPS: readonly OnboardingStepKind[] = ["goal_picker", "single_choice", "multi_choice", "attribution_survey"];

export const ONBOARDING_STEPS = { min: 8, max: 16, hardMin: 6, hardMax: 18 } as const;

const APPLE_CONSENT = "Apple 5.1.2(i) (disclose and get consent before sharing data with third-party AI)";

/** Lint the onboarding flow of a spec. Empty means clean. */
export function lintOnboarding(spec: AppSpec): PolicyFinding[] {
  const steps = spec.onboarding;
  const findings: PolicyFinding[] = [];
  const add = (ruleId: string, severity: PolicyFinding["severity"], message: string, citation?: string) =>
    findings.push({ ruleId: `onboarding.${ruleId}`, severity, message, ...(citation ? { citation } : {}) });

  const n = steps.length;
  const { min, max, hardMin, hardMax } = ONBOARDING_STEPS;
  if (n < hardMin || n > hardMax) add("length", "block", `${n} onboarding steps (allowed ${hardMin}..${hardMax}, target ${min}..${max})`, "Bier P8");
  else if (n < min || n > max) add("length", "warn", `${n} onboarding steps (target ${min}..${max})`, "Bier P8");

  const consentIdx = steps.flatMap((s, i) => (s.kind === "ai_data_consent" ? [i] : []));
  const firstData = steps.findIndex(collectsData);
  const needsConsent = sendsDataToAi(spec);
  if (consentIdx.length > 1) add("ai_data_consent", "block", `${consentIdx.length} ai_data_consent steps (exactly one allowed)`, APPLE_CONSENT);
  const firstConsent = consentIdx[0];
  if (firstConsent === undefined) {
    if (needsConsent) add("ai_data_consent", "block", "no ai_data_consent step before data is collected or the core screen", APPLE_CONSENT);
  } else if (firstData >= 0 && firstConsent > firstData) {
    add(
      "consent_order",
      "block",
      `ai_data_consent (step ${firstConsent + 1}) comes after data collection at step ${firstData + 1} (${steps[firstData]?.kind})`,
      APPLE_CONSENT,
    );
  }

  if (spec.paywall.placement === "after_onboarding" && !steps.some((s) => VALUE_STEPS.includes(s.kind))) {
    add("value_before_paywall", "block", "no value_preview or result_teaser before the after-onboarding paywall", "Bier P8: never paywall before the aha");
  }

  steps.forEach((s, i) => {
    if (CHOICE_STEPS.includes(s.kind) && s.options.filter((o) => o.trim()).length === 0) {
      add("options", "block", `onboarding[${i}] ${s.kind} "${s.id}" has no options`);
    }
  });

  if (!steps.some((s) => s.kind === "notification_preprompt")) {
    add("notification_preprompt", "warn", "no notification_preprompt step: push opt-in will be the cold system prompt", "Apple 4.5.4");
  }
  if (!steps.some((s) => s.kind === "attribution_survey")) {
    add("attribution_survey", "warn", "no attribution_survey step: creator attribution falls back to storefront geo only");
  }

  const copy = steps.flatMap((s, i) => [
    { text: s.title, path: `onboarding[${i}].title` },
    ...(s.subtitle ? [{ text: s.subtitle, path: `onboarding[${i}].subtitle` }] : []),
    ...s.options.map((o, j) => ({ text: o, path: `onboarding[${i}].options[${j}]` })),
  ]);
  findings.push(...lintCopyAll(copy, "onboarding"));
  return findings;
}
