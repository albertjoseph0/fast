/** Device-local state. Nothing here leaves the device except through api.ts after consent. */
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { VerdictSection } from "./types";

export const KEYS = {
  installedAt: "installed_at",
  installTracked: "install_tracked",
  onboardingDone: "onboarding_done",
  profile: "profile",
  aiConsent: "ai_consent",
  usesConsumed: "uses_consumed",
  activated: "activated",
  trialStarted: "trial_started",
  shareFirst: "share_first",
  notificationsEnabled: "notifications_enabled",
  promoOptIn: "promo_opt_in",
  lastResult: "last_result",
  appUserId: "app_user_id",
  installToken: "install_token",
  ageGate: "age_gate",
} as const;

/**
 * Kept by Delete my data: the purchase identity and install token (the subscription is not
 * cancelled, and the server keys abuse limits on the install), and the once-per-user markers
 * so the lab does not count a second install, activation, share or trial for the same person.
 */
const KEPT_ON_DELETE: readonly string[] = [KEYS.appUserId, KEYS.installToken, KEYS.installTracked, KEYS.activated, KEYS.trialStarted, KEYS.shareFirst, KEYS.usesConsumed];

export type StoredResult = { id: string; sections: VerdictSection[]; createdAt: string };
export type Profile = Record<string, string | string[]>;

export async function getJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export async function setJson(key: string, value: unknown): Promise<void> {
  await AsyncStorage.setItem(key, JSON.stringify(value));
}

/** Returns true the first time it is called for a key (unique-per-user events). */
export async function once(key: string): Promise<boolean> {
  if (await getJson<boolean>(key, false)) return false;
  await setJson(key, true);
  return true;
}

/** Delete my data: removes answers, results, consent and preferences. */
export async function clearPersonalData(): Promise<void> {
  const keys = await AsyncStorage.getAllKeys();
  await AsyncStorage.multiRemove(keys.filter((k) => !KEPT_ON_DELETE.includes(k)));
}
