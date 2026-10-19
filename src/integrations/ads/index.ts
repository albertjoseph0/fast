/**
 * Live AdsRead/AdsWrite: dispatch by network to the Meta, TikTok and Apple Ads adapters.
 * Google Ads is deferred (ARCHITECTURE s.8).
 */
import type { AdsRead, AdsWrite } from "../../core/ports.ts";
import type { AdDailyStats, AdNetwork } from "../../core/types.ts";
import { AppleAdsClient } from "./appleAds.ts";
import { MetaAdsClient } from "./meta.ts";
import { TikTokAdsClient } from "./tiktok.ts";
import type { AdsClientOptions, CreateCampaignRequest, NetworkAdapter } from "./common.ts";

export { ENV_VARS as META_ADS_ENV_VARS } from "./meta.ts";
export { ENV_VARS as TIKTOK_ADS_ENV_VARS } from "./tiktok.ts";
export { ENV_VARS as APPLE_ADS_ENV_VARS } from "./appleAds.ts";
export type { AdsClientOptions, NetworkAdapter } from "./common.ts";

export type AdsAdapters = Partial<Record<AdNetwork, NetworkAdapter>>;

export interface LiveAdsOptions extends AdsClientOptions {
  /** Replace individual network adapters (tests, alternative clients). */
  adapters?: AdsAdapters;
}

export function adsAdapters(opts: LiveAdsOptions): AdsAdapters {
  return { meta: new MetaAdsClient(opts), tiktok: new TikTokAdsClient(opts), apple: new AppleAdsClient(opts), ...opts.adapters };
}

function adapterFor(adapters: AdsAdapters, network: AdNetwork): NetworkAdapter {
  const adapter = adapters[network];
  if (!adapter) throw new Error(`${network} ads are not supported yet`);
  return adapter;
}

export class LiveAdsWrite implements AdsWrite {
  readonly kind = "live" as const;
  private readonly adapters: AdsAdapters;

  constructor(opts: LiveAdsOptions, adapters?: AdsAdapters) {
    this.adapters = adapters ?? adsAdapters(opts);
  }

  async createCampaign(req: CreateCampaignRequest): Promise<{ campaignExternalId: string }> {
    return adapterFor(this.adapters, req.network).createCampaign(req);
  }

  async setDailyBudget(req: Parameters<AdsWrite["setDailyBudget"]>[0]): Promise<void> {
    return adapterFor(this.adapters, req.network).setDailyBudget(req.campaignExternalId, req.dailyBudgetCents);
  }

  async pause(req: Parameters<AdsWrite["pause"]>[0]): Promise<void> {
    return adapterFor(this.adapters, req.network).pause(req.campaignExternalId);
  }
}

export class LiveAdsRead implements AdsRead {
  readonly kind = "live" as const;
  private readonly adapters: AdsAdapters;

  constructor(opts: LiveAdsOptions, adapters?: AdsAdapters) {
    this.adapters = adapters ?? adsAdapters(opts);
  }

  async stats(req: Parameters<AdsRead["stats"]>[0]): Promise<AdDailyStats[]> {
    if (req.since > req.until) return [];
    return adapterFor(this.adapters, req.network).stats(req.campaignExternalId, req.since, req.until);
  }
}

/** Read and write ports over one set of adapters (shared token caches). */
export function createLiveAds(opts: LiveAdsOptions): { read: LiveAdsRead; write: LiveAdsWrite } {
  const adapters = adsAdapters(opts);
  return { read: new LiveAdsRead(opts, adapters), write: new LiveAdsWrite(opts, adapters) };
}
