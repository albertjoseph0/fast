/** App start-up and the small amount of cross-screen state. */
import { Linking } from "react-native";
import { APP_EVENTS } from "./events";
import { distinctId, flagVariants, initAnalytics, track, trackLaunch } from "./analytics";
import { cellIdFrom, parseAttribution } from "./growth";
import { chooseUserId } from "./identity";
import { scheduleReminders } from "./notifications";
import { configurePurchases, isEntitled, storefront } from "./purchases";
import { getSpec, loadRemoteSpec, REMOTE_KEYS, studio, type SpecOverrides } from "./spec";
import { getJson, KEYS, once, setJson } from "./storage";

let userId = "";

/** PostHog first (a first launch adopts its distinct id as the app user id), then purchases, flags, config. */
export async function boot(): Promise<void> {
  await initAnalytics().catch(() => undefined);
  userId = chooseUserId(await getJson<string | null>(KEYS.appUserId, null), distinctId());
  await setJson(KEYS.appUserId, userId);
  await configurePurchases(userId, distinctId());
  const flags = await flagVariants(REMOTE_KEYS);
  const overrides: SpecOverrides[] = flags.map((f) => ({ [f.key]: f.payload }) as SpecOverrides);
  await loadRemoteSpec(flags[0]?.variant ?? null, overrides);
  const paywallFlag = flags.find((f) => f.key === "paywall");
  if (paywallFlag && (await once(`variant_${paywallFlag.variant}`))) track(APP_EVENTS.paywallVariantAssigned, { variant: paywallFlag.variant });
  const cellId = cellIdFrom(flags.map((f) => f.variant));
  const attribution = parseAttribution(await Linking.getInitialURL().catch(() => null));
  await trackLaunch({ storefront: await storefront(), attribution, ...(studio.experimentId ? { experimentId: studio.experimentId } : {}), ...(cellId ? { cellId } : {}) });
  await scheduleReminders().catch(() => 0);
}

/** RevenueCat's app user id, which the verdict backend checks entitlements for. */
export function appUserId(): string {
  return userId;
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
