/**
 * Product defaults for the single-player AI verdict template (Vert / Cal AI / Quittr):
 * a long personalization onboarding with a value preview, a hard multi-page paywall over
 * price-ladder products, and push that is transactional before it is promotional.
 *
 * Prices, periods and trials are never written by an LLM: paywall copy carries no
 * numbers, and terms text keeps `{price}` for the store price rendered at runtime.
 */
import type { StudioConfig, PriceLadderEntry } from "../config/schema.ts";
import type { AppSpec, OnboardingStepKind, PaywallConfig, StoreProductDef } from "../core/types.ts";

/**
 * 12 steps (P8 allows 8-16). AI-data consent (Apple 5.1.2(i)) precedes every step that
 * collects an answer. The value preview and result teaser come before the paywall, and
 * the notification pre-prompt follows them so the permission ask lands after the aha.
 */
export const DEFAULT_ONBOARDING_SKELETON: readonly OnboardingStepKind[] = [
  "welcome",
  "ai_data_consent",
  "goal_picker",
  "single_choice",
  "multi_choice",
  "text_input",
  "benefit",
  "attribution_survey",
  "loading_personalization",
  "value_preview",
  "result_teaser",
  "notification_preprompt",
];

/** Steps that store a user answer; ai_data_consent must precede all of them. */
export const DATA_COLLECTING_STEPS: readonly OnboardingStepKind[] = [
  "goal_picker",
  "single_choice",
  "multi_choice",
  "text_input",
  "date_input",
  "time_input",
  "place_input",
  "slider",
  "attribution_survey",
];

/**
 * Hard, two-page paywall after onboarding (multi-page converts 12.41% vs 9.07%,
 * superwall.multi_page_paywall_conversion). Throws if a configured product id is not in
 * the price ladder.
 */
export function defaultPaywall(config: StudioConfig): PaywallConfig {
  const { defaultProductIds, defaultHighlightedProductId } = config.monetization;
  for (const id of defaultProductIds) ladderEntry(config, id);
  if (!defaultProductIds.includes(defaultHighlightedProductId)) {
    throw new Error(`highlighted product ${defaultHighlightedProductId} is not among the default product ids`);
  }
  return {
    placement: "after_onboarding",
    style: "hard",
    pages: 2,
    headline: "Unlock your full result",
    bullets: [
      "Your complete, personalized breakdown",
      "Ask again whenever something changes",
      "Save and share your result cards",
      "Cancel anytime in Settings",
    ],
    productIds: [...defaultProductIds],
    highlightedProductId: defaultHighlightedProductId,
    showCloseAfterSeconds: 3,
  };
}

/** Transactional pushes first; promotional ones only later and only after the in-app opt-in (Apple 4.5.4). */
export const DEFAULT_PUSH_SCHEDULE: AppSpec["retention"]["pushSchedule"] = [
  { dayOffset: 0, hourLocal: 20, kind: "transactional", copy: "Your full result is ready. Tap to open it." },
  { dayOffset: 1, hourLocal: 9, kind: "transactional", copy: "Today's update is ready for you." },
  { dayOffset: 2, hourLocal: 9, kind: "transactional", copy: "A new insight is waiting in the app." },
  { dayOffset: 4, hourLocal: 18, kind: "promotional", copy: "Curious what changed this week? Take a look." },
  { dayOffset: 7, hourLocal: 18, kind: "promotional", copy: "Your weekly check-in is here." },
];

/** A price-ladder entry by id. Throws if unknown. */
export function ladderEntry(config: StudioConfig, id: string): PriceLadderEntry {
  const entry = config.monetization.ladder.find((e) => e.id === id);
  if (!entry) throw new Error(`unknown price ladder id: ${id}`);
  return entry;
}

/**
 * Store product id `${bundleId}.${ladderId}`. Google Play requires lowercase letters,
 * digits, '_' and '.', which App Store Connect also accepts, so anything else becomes '_'.
 */
export function productIdFor(bundleId: string, ladderId: string): string {
  return `${bundleId}.${ladderId}`.toLowerCase().replace(/[^a-z0-9._]/g, "_");
}

const PERIOD_UNIT: Record<PriceLadderEntry["period"], string> = { week: "week", month: "month", year: "year" };
const PERIOD_ADJECTIVE: Record<PriceLadderEntry["period"], string> = { week: "Weekly", month: "Monthly", year: "Annual" };

/**
 * Subscription terms shown next to the CTA (Apple 3.1.2, ROSCA). `{price}` stays literal
 * and is replaced with the localized store price at runtime.
 */
export function termsTemplate(entry: PriceLadderEntry): string {
  const unit = PERIOD_UNIT[entry.period];
  const renewal = "Renews automatically until cancelled. Cancel anytime in Settings at least 24 hours before renewal.";
  if (entry.trialDays > 0) return `${entry.trialDays}-day free trial, then {price}/${unit}. ${renewal}`;
  return `{price}/${unit}. ${renewal}`;
}

function displayName(config: StudioConfig, entry: PriceLadderEntry): string {
  const ent = config.monetization.entitlementId;
  const brand = ent.charAt(0).toUpperCase() + ent.slice(1);
  const base = `${brand} ${PERIOD_ADJECTIVE[entry.period]}`;
  return entry.trialDays > 0 ? `${base} (${entry.trialDays}-day trial)` : base;
}

/** One store subscription definition per ladder entry, for `store.upsert_subscriptions`. */
export function storeProductDefs(config: StudioConfig, bundleId: string, territories: string[]): StoreProductDef[] {
  return config.monetization.ladder.map((entry) => ({
    productId: productIdFor(bundleId, entry.id),
    ladderId: entry.id,
    period: entry.period,
    usdCents: entry.usdCents,
    trialDays: entry.trialDays,
    displayName: displayName(config, entry),
    territories: [...territories],
  }));
}
