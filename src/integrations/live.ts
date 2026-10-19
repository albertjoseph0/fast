/**
 * Live composition root: every port backed by the real platform client. Writes go through
 * HttpClient's dry-run guard, so with config.dryRun every write is recorded under
 * <dataDir>/dry-run and nothing is sent.
 */
import { join } from "node:path";
import type { StudioConfig } from "../config/schema.ts";
import type { Clock, LlmPort, MediaPort, PortSet, WebWrite } from "../core/ports.ts";
import type { StudioStore } from "../core/store.ts";
import { createLiveAds } from "./ads/index.ts";
import { ENV_VARS as APPLE_ADS_ENV } from "./ads/appleAds.ts";
import { ENV_VARS as META_ADS_ENV } from "./ads/meta.ts";
import { ENV_VARS as TIKTOK_ADS_ENV } from "./ads/tiktok.ts";
import { ENV_VARS as ASC_ENV } from "./apple/appStoreConnect.ts";
import { AppleTrendPort } from "./apple/charts.ts";
import { ENV_VARS as EAS_ENV } from "./expo/eas.ts";
import { ENV_VARS as PLAY_ENV } from "./google/play.ts";
import { DryRunRecorder } from "./http.ts";
import { ENV_VARS as POSTHOG_ENV, LiveMetricsPort, LiveRemoteConfigWrite } from "./posthog/client.ts";
import { ENV_VARS as REVENUECAT_ENV, LiveMonetizationWrite } from "./revenuecat/client.ts";
import { ENV_VARS as SIDESHIFT_ENV, LiveCreatorRead, LiveCreatorWrite } from "./sideshift/client.ts";
import { createLiveSocial } from "./social/index.ts";
import { ENV_VARS as INSTAGRAM_ENV } from "./social/instagram.ts";
import { ENV_VARS as TIKTOK_ENV } from "./social/tiktok.ts";
import { ENV_VARS as YOUTUBE_ENV } from "./social/youtube.ts";
import { createLiveStorePorts, ENV_VARS as STORES_ENV } from "./stores.ts";
import { ENV_VARS as BLOB_ENV, VercelBlobWebWrite } from "./web/blob.ts";
import { ENV_VARS as STATIC_ENV, LocalStaticWebWrite } from "./web/static.ts";

type Env = Record<string, string | undefined>;
export interface EnvVar {
  name: string;
  purpose: string;
  required: boolean;
}

/** Every environment variable a live adapter reads, grouped by service (for `factory env` and the runbook). */
export const LIVE_ENV_VARS: readonly { service: string; vars: readonly EnvVar[] }[] = [
  { service: "App Store Connect", vars: ASC_ENV },
  { service: "Store ports", vars: STORES_ENV },
  { service: "Google Play", vars: PLAY_ENV },
  { service: "Expo EAS", vars: EAS_ENV },
  { service: "RevenueCat", vars: REVENUECAT_ENV },
  { service: "PostHog", vars: POSTHOG_ENV },
  { service: "SideShift", vars: SIDESHIFT_ENV },
  { service: "Instagram", vars: INSTAGRAM_ENV },
  { service: "TikTok", vars: TIKTOK_ENV },
  { service: "YouTube", vars: YOUTUBE_ENV },
  { service: "Meta Ads", vars: META_ADS_ENV },
  { service: "TikTok Ads", vars: TIKTOK_ADS_ENV },
  { service: "Apple Ads", vars: APPLE_ADS_ENV },
  { service: "Web host (static)", vars: STATIC_ENV },
  { service: "Web media (Vercel Blob, optional)", vars: BLOB_ENV },
];

/**
 * Site files always go to the static host: universal-link files must sit at the deep-link domain's
 * root, which Blob cannot serve. Content media goes to Blob when a token is configured.
 */
function webWrite(base: ConstructorParameters<typeof LocalStaticWebWrite>[0], env: Env): WebWrite {
  const site = new LocalStaticWebWrite(base);
  if (!env.BLOB_READ_WRITE_TOKEN) return site;
  const media = new VercelBlobWebWrite(base);
  return {
    kind: "live",
    putAsset: (req) => media.putAsset(req),
    publishSite: (req) => site.publishSite(req),
  };
}

export async function createLivePorts(opts: {
  config: StudioConfig;
  store: StudioStore;
  env: Env;
  clock: Clock;
  llm: LlmPort;
  media: MediaPort;
  dataDir: string;
}): Promise<PortSet> {
  const { config, store, env, clock } = opts;
  const dryRun = config.dryRun;
  const recorder = new DryRunRecorder(dryRun ? join(opts.dataDir, "dry-run") : null);
  const base = { config, store, env, dryRun, recorder, clock };
  const stores = createLiveStorePorts(base);
  const social = createLiveSocial(base);
  const ads = createLiveAds(base);
  return {
    read: {
      clock,
      llm: opts.llm,
      media: opts.media,
      trends: new AppleTrendPort(base),
      store: stores.read,
      metrics: new LiveMetricsPort(base),
      creators: new LiveCreatorRead(base),
      social: social.read,
      ads: ads.read,
    },
    write: {
      store: stores.write,
      monetization: new LiveMonetizationWrite(base),
      remoteConfig: new LiveRemoteConfigWrite(base),
      creators: new LiveCreatorWrite(base),
      social: social.write,
      ads: ads.write,
      web: webWrite({ ...base, dataDir: opts.dataDir }, env),
    },
  };
}
