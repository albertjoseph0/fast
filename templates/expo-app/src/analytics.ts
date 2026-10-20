/**
 * PostHog analytics. Events use the studio's canonical names (events.ts) and carry
 * app_slug and, inside a user-random lab cell, cell_id. Every user gets a person profile
 * (the SDK default keeps anonymous users personless, which drops person properties), and
 * the install-time person properties the lab attributes by (storefront, source_id,
 * channel, experiment_id, cell_id) are set once. Team, dev and TestFlight devices emit
 * internal_session so the lab can exclude them.
 * No advertising identifier is read and nothing is used for tracking.
 */
import * as Application from "expo-application";
import Constants from "expo-constants";
import * as Updates from "expo-updates";
import { Platform } from "react-native";
import PostHog from "posthog-react-native";
import { APP_EVENTS, type AppEventName } from "./events";
import { surveyAttribution, type Attribution } from "./growth";
import { studio } from "./spec";
import { KEYS, once, setJson } from "./storage";

type Props = Record<string, string | number | boolean | null | Record<string, string | number | boolean | null>>;

let client: PostHog | null = null;
let internal = false;

function extra(): { posthogApiKey?: string; posthogHost?: string } {
  return (Constants.expoConfig?.extra ?? {}) as { posthogApiKey?: string; posthogHost?: string };
}

/** Dev builds, internal EAS channels, TestFlight (sandbox receipt), and non-App-Store installs (simulator, ad hoc, development). */
async function detectInternal(): Promise<boolean> {
  if (__DEV__) return true;
  if (Updates.channel === "development" || Updates.channel === "preview") return true;
  if (Platform.OS === "ios") {
    // The release type reads APP_STORE for TestFlight builds too; the store environment tells them apart.
    const env = await Application.getAppleStoreEnvironmentAsync().catch(() => null);
    if (env === "sandbox" || env === "xcode") return true;
    const type = await Application.getIosApplicationReleaseTypeAsync().catch(() => Application.ApplicationReleaseType.UNKNOWN);
    return type !== Application.ApplicationReleaseType.APP_STORE && type !== Application.ApplicationReleaseType.UNKNOWN;
  }
  return false;
}

/** Sandbox purchases mean a TestFlight or reviewer device (purchases.ts reports them). */
export function markInternal(): void {
  internal = true;
  void client?.register({ is_internal: true });
}

export function isInternal(): boolean {
  return internal;
}

export async function initAnalytics(): Promise<void> {
  const { posthogApiKey, posthogHost } = extra();
  internal = await detectInternal();
  if (posthogApiKey) {
    client = new PostHog(posthogApiKey, { host: posthogHost, captureAppLifecycleEvents: false, preloadFeatureFlags: true, personProfiles: "always" });
    await client.ready();
    await client.register({ app_slug: studio.slug, is_internal: internal });
  }
}

/** The PostHog distinct id, or null when the build has no PostHog key. */
export function distinctId(): string | null {
  return client?.getDistinctId() ?? null;
}

export function track(event: AppEventName, props: Props = {}): void {
  client?.capture(event, props);
}

function attributionProps(a: Attribution): Record<string, string> {
  return { ...(a.sourceId ? { source_id: a.sourceId } : {}), ...(a.channel ? { channel: a.channel } : {}) };
}

/**
 * First open emits install with the set-once person properties (and the inviter when a
 * friend's link opened the app); every launch emits a session. cellId is a lab cell id only,
 * never a remote-config variant id.
 */
export async function trackLaunch(personProps: { storefront: string | null; experimentId?: string; cellId?: string; attribution: Attribution }): Promise<void> {
  const setOnce: Record<string, string> = { app_slug: studio.slug, ...attributionProps(personProps.attribution) };
  if (personProps.storefront) setOnce.storefront = personProps.storefront;
  if (personProps.experimentId) setOnce.experiment_id = personProps.experimentId;
  if (personProps.cellId) setOnce.cell_id = personProps.cellId;
  if (personProps.cellId) await client?.register({ cell_id: personProps.cellId });
  if (await once(KEYS.installTracked)) {
    await setJson(KEYS.installedAt, new Date().toISOString());
    const inviter = personProps.attribution.inviter;
    track(APP_EVENTS.install, { $set_once: setOnce, ...(inviter ? { inviter_distinct_id: inviter } : {}) });
  }
  track(internal ? APP_EVENTS.internalSession : APP_EVENTS.session, { $set_once: setOnce });
}

/** The survey answer is the source only when no link named one (set once, so the install's wins). */
export function trackAttributionAnswer(answer: string): void {
  track(APP_EVENTS.attributionAnswer, { answer, $set_once: attributionProps(surveyAttribution(answer)) });
}

/** Sticky experiment variants: flag key → variant id (a lab cell id for user-random cells) and payload. */
export async function flagVariants(keys: readonly string[]): Promise<{ key: string; variant: string; payload: unknown }[]> {
  if (!client) return [];
  await client.reloadFeatureFlagsAsync().catch(() => undefined);
  return keys.flatMap((key) => {
    const variant = client?.getFeatureFlag(key);
    return typeof variant === "string" ? [{ key, variant, payload: client?.getFeatureFlagPayload(key) }] : [];
  });
}

export function resetAnalytics(): void {
  client?.reset();
}
