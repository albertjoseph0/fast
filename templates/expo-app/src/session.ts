/** App start-up and the small amount of cross-screen state. */
import { APP_EVENTS } from "./events";
import { distinctId, flagVariants, initAnalytics, track, trackLaunch } from "./analytics";
import { scheduleReminders } from "./notifications";
import { configurePurchases, isEntitled, storefront } from "./purchases";
import { getSpec, loadRemoteSpec, REMOTE_KEYS, type SpecOverrides } from "./spec";
import { getJson, KEYS, once } from "./storage";

/** PostHog first (its distinct id is the RevenueCat app user id), then purchases, flags, config. */
export async function boot(): Promise<void> {
  const id = await initAnalytics();
  await configurePurchases(id);
  const flags = await flagVariants(REMOTE_KEYS);
  const overrides: SpecOverrides[] = flags.map((f) => ({ [f.key]: f.payload }) as SpecOverrides);
  const cellId = flags[0]?.variant;
  await loadRemoteSpec(cellId ?? null, overrides);
  const paywallFlag = flags.find((f) => f.key === "paywall");
  if (paywallFlag && (await once(`variant_${paywallFlag.variant}`))) track(APP_EVENTS.paywallVariantAssigned, { variant: paywallFlag.variant });
  await trackLaunch({ storefront: await storefront(), ...(cellId ? { cellId } : {}) });
  await scheduleReminders().catch(() => 0);
}

export function appUserId(): string {
  return distinctId();
}

export async function hasAiConsent(): Promise<boolean> {
  return (await getJson<boolean | null>(KEYS.aiConsent, null)) === true;
}

/** Free uses left before the paywall, or Infinity when subscribed. */
export async function usesLeft(): Promise<number> {
  if (await isEntitled()) return Number.POSITIVE_INFINITY;
  const used = await getJson<number>(KEYS.usesConsumed, 0);
  return Math.max(0, getSpec().core.freeUsesBeforePaywall - used);
}

/** activated is unique per user: the value preview or the first verdict, whichever comes first. */
export async function markActivated(source: "value_preview" | "first_verdict"): Promise<void> {
  if (await once(KEYS.activated)) track(APP_EVENTS.activated, { source });
}
