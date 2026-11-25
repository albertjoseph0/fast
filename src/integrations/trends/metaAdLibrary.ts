/**
 * Meta Ad Library API (Graph `ads_archive`) as a demand source: who is paying to advertise
 * against a term on Facebook, Instagram and Messenger, and for how long.
 *
 * An ad that keeps running for weeks is the cheapest public evidence that its advertiser makes
 * money from it. Non-political ads are only returned when they reached an EU country, so the
 * scan asks about EU storefronts (META_AD_LIBRARY_COUNTRIES) and the numbers describe EU delivery.
 * eu_total_reach is only set for EU-delivered ads. Access needs a Meta developer app and an
 * identity-confirmed Facebook account; the API is read-only.
 */
import { META_GRAPH_VERSION } from "../ads/meta.ts";
import { HttpClient, withQuery } from "../http.ts";
import type { TrendObservation } from "../../core/ports.ts";
import { ageDays, arr, median, num, obj, samples, str, type TrendSourceClient, type TrendSourceOptions } from "./common.ts";

export const ENV_VARS: readonly { name: string; purpose: string; required: boolean }[] = [
  {
    name: "META_AD_LIBRARY_TOKEN",
    purpose: "User access token from a Meta developer app whose owner completed Ad Library identity confirmation (read-only ads_archive)",
    required: false,
  },
  { name: "META_AD_LIBRARY_COUNTRIES", purpose: "Comma-separated EU country codes to search (default DE,FR,NL,SE,IE); non-political ads exist in the library only for EU delivery", required: false },
];

const ARCHIVE = `https://graph.facebook.com/${META_GRAPH_VERSION}/ads_archive`;
export const DEFAULT_AD_COUNTRIES = ["DE", "FR", "NL", "SE", "IE"] as const;
/** An ad still running after this many days is treated as paying for itself. */
export const LONG_RUNNING_DAYS = 30;
export const META_ADS_TERMS_PER_SCAN = 30;
const FIELDS = [
  "id",
  "page_id",
  "page_name",
  "ad_delivery_start_time",
  "ad_delivery_stop_time",
  "eu_total_reach",
  "ad_creative_bodies",
  "ad_creative_link_titles",
  "ad_creative_link_captions",
  "publisher_platforms",
].join(",");
const APP_LINK = /(apps\.apple\.com|itunes\.apple\.com|play\.google\.com|onelink\.me|app\.link)/i;

export function metaAdLibraryConfigured(env: Record<string, string | undefined>): boolean {
  return Boolean(env.META_AD_LIBRARY_TOKEN);
}

export function adCountries(env: Record<string, string | undefined>): string[] {
  const raw = (env.META_AD_LIBRARY_COUNTRIES ?? "")
    .split(",")
    .map((c) => c.trim().toUpperCase())
    .filter((c) => /^[A-Z]{2}$/.test(c));
  return raw.length > 0 ? raw : [...DEFAULT_AD_COUNTRIES];
}

export class MetaAdLibrarySource implements TrendSourceClient {
  readonly source = "meta_ads" as const;
  readonly maxTermsPerScan = META_ADS_TERMS_PER_SCAN;
  private readonly http: HttpClient;
  private readonly countries: string[];

  constructor(private readonly opts: TrendSourceOptions) {
    const token = opts.env.META_AD_LIBRARY_TOKEN ?? "";
    this.countries = adCountries(opts.env);
    this.http = new HttpClient({
      service: "meta_ad_library",
      dryRun: false,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
      defaultHeaders: () => ({ authorization: `Bearer ${token}` }),
    });
  }

  /** `country` is ignored: the library only answers non-political queries for EU delivery. */
  async scanTerm(req: { term: string; country: string; sinceDays: number }): Promise<TrendObservation | null> {
    const res = await this.http.get<unknown>(
      withQuery(ARCHIVE, {
        search_terms: req.term.slice(0, 100),
        ad_reached_countries: JSON.stringify(this.countries),
        ad_type: "ALL",
        ad_active_status: "ACTIVE",
        fields: FIELDS,
        limit: 100,
      }),
    );
    return metaAdsObservation(req.term, arr(obj(res.data).data), this.opts.clock.now(), this.countries);
  }
}

/** Who advertises against a term and for how long. Counts cover the first page (up to 100 ads). */
export function metaAdsObservation(term: string, items: unknown[], now: Date, countries: readonly string[]): TrendObservation | null {
  const ads = items.map((raw) => {
    const a = obj(raw);
    const captions = arr(a.ad_creative_link_captions).map(str);
    return {
      page: str(a.page_id),
      days: ageDays(str(a.ad_delivery_start_time), now),
      reach: num(a.eu_total_reach),
      app: captions.some((c) => APP_LINK.test(c)),
      text: [...arr(a.ad_creative_link_titles).map(str), ...arr(a.ad_creative_bodies).map(str)][0] ?? "",
    };
  });
  const valid = ads.filter((a) => Number.isFinite(a.days));
  if (valid.length === 0) return null;
  const long = valid.filter((a) => a.days >= LONG_RUNNING_DAYS);
  const appAds = valid.filter((a) => a.app);
  return {
    source: "meta_ads",
    term,
    url: `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&q=${encodeURIComponent(term)}&search_type=keyword_unordered&country=${countries[0] ?? "ALL"}`,
    metrics: {
      activeAds: valid.length,
      advertisers: new Set(valid.map((a) => a.page).filter(Boolean)).size,
      longRunningAds: long.length,
      longRunningAdvertisers: new Set(long.map((a) => a.page).filter(Boolean)).size,
      medianDaysRunning: Math.round(median(valid.map((a) => a.days))),
      maxDaysRunning: Math.round(Math.max(...valid.map((a) => a.days))),
      appAds: appAds.length,
      longRunningAppAds: appAds.filter((a) => a.days >= LONG_RUNNING_DAYS).length,
      euReach: valid.reduce((s, a) => s + a.reach, 0),
    },
    samples: samples(long.concat(valid.filter((a) => a.days < LONG_RUNNING_DAYS)).map((a) => a.text)),
  };
}
