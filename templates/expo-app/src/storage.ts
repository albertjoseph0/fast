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
} as const;

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

export async function clearAll(): Promise<void> {
  await AsyncStorage.clear();
}
