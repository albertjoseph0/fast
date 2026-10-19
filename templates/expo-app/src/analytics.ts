/**
 * PostHog analytics. Events use the studio's canonical names (events.ts) and carry
 * app_slug and, inside an experiment, cell_id. Install-time person properties are set
 * once so cohorts stay keyed to the storefront and cell the user arrived in. Team, dev
 * and TestFlight devices emit internal_session so the lab can exclude them.
 * No advertising identifier is read and nothing is used for tracking.
 */
import * as Application from "expo-application";
import Constants from "expo-constants";
import * as Updates from "expo-updates";
import { Platform } from "react-native";
import PostHog from "posthog-react-native";
import { APP_EVENTS, type AppEventName } from "./events";
import { studio } from "./spec";
import { KEYS, once, setJson } from "./storage";

type Props = Record<string, string | number | boolean | null | Record<string, string | number | boolean | null>>;

let client: PostHog | null = null;
let internal = false;

function extra(): { posthogApiKey?: string; posthogHost?: string } {
  return (Constants.expoConfig?.extra ?? {}) as { posthogApiKey?: string; posthogHost?: string };
}

/** Dev builds, internal EAS channels, and non-App-Store installs (simulator, ad hoc, development). */
async function detectInternal(): Promise<boolean> {
  if (__DEV__) return true;
  if (Updates.channel === "development" || Updates.channel === "preview") return true;
  if (Platform.OS === "ios") {
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

export async function initAnalytics(): Promise<string> {
  const { posthogApiKey, posthogHost } = extra();
  internal = await detectInternal();
  if (posthogApiKey) {
    client = new PostHog(posthogApiKey, { host: posthogHost, captureAppLifecycleEvents: false, preloadFeatureFlags: true });
    await client.ready();
    await client.register({ app_slug: studio.slug, is_internal: internal });
  }
  return client?.getDistinctId() ?? "anonymous";
}

export function distinctId(): string {
  return client?.getDistinctId() ?? "anonymous";
}

export function track(event: AppEventName, props: Props = {}): void {
  client?.capture(event, props);
}

/** First open emits install with the set-once person properties; every launch emits a session. */
export async function trackLaunch(personProps: { storefront: string | null; experimentId?: string; cellId?: string }): Promise<void> {
  const setOnce: Record<string, string> = { app_slug: studio.slug };
  if (personProps.storefront) setOnce.storefront = personProps.storefront;
  if (personProps.experimentId) setOnce.experiment_id = personProps.experimentId;
  if (personProps.cellId) setOnce.cell_id = personProps.cellId;
  if (personProps.cellId) await client?.register({ cell_id: personProps.cellId });
  if (await once(KEYS.installTracked)) {
    await setJson(KEYS.installedAt, new Date().toISOString());
    track(APP_EVENTS.install, { $set_once: setOnce });
  }
  track(internal ? APP_EVENTS.internalSession : APP_EVENTS.session, { $set_once: setOnce });
}

/** Sticky experiment variants: flag key → variant id (doubles as the cell id) and payload. */
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
