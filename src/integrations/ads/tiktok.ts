/**
 * TikTok API for Business (Marketing API v1.3) app-install campaigns with Spark Ads.
 *
 * The campaign (objective APP_PROMOTION / APP_INSTALL) holds the daily budget and is created
 * disabled; the ad group targets the app and countries with a fixed schedule; ads boost
 * existing posts: creator posts through Spark authorization codes (identity_type AUTH_CODE)
 * and the brand's own posts through its linked TikTok account (TT_USER). The campaign is
 * enabled only after every ad exists. TikTok answers HTTP 200 with a non-zero `code` on
 * errors, so every response is unwrapped. Campaign ids are "<advertiser_id>:<campaign_id>".
 */
import type { Clock } from "../../core/ports.ts";
import type { AdCreativeRef, AdDailyStats, Cents } from "../../core/types.ts";
import { SystemClock } from "../../core/clock.ts";
import { HttpClient, withQuery } from "../http.ts";
import type { HttpRequest } from "../http.ts";
import { amountToCents, attributionComplete, centsToAmount, dateChunks, dryId, int, isDry, joinId, splitId, validateCampaign } from "./common.ts";
import type { AdsClientOptions, CreateCampaignRequest, NetworkAdapter } from "./common.ts";
import { bigIntSafeFetch } from "../social/common.ts";

export const ENV_VARS: readonly { name: string; purpose: string; required: boolean }[] = [
  { name: "TIKTOK_ADS_TOKEN", purpose: "TikTok API for Business advertiser access token (Access-Token header)", required: true },
  { name: "TIKTOK_ADS_APP_ID", purpose: "TikTok app-management id of the promoted app; looked up via app/list when unset", required: false },
  { name: "TIKTOK_ADS_IDENTITY_ID", purpose: "Identity id of the brand's linked TikTok account (TT_USER) for boosting owned posts", required: false },
];

export const TIKTOK_ADS_API = "https://business-api.tiktok.com/open_api/v1.3";
export const TIKTOK_REPORT_METRICS = ["spend", "impressions", "clicks", "app_install"] as const;
/** Daily reports accept at most 30 days per request. */
const REPORT_MAX_DAYS = 30;

/**
 * Country-level location ids (TikTok uses GeoNames ids). Others fail loudly rather than
 * silently broadening targeting.
 */
export const TIKTOK_COUNTRY_LOCATION_IDS: Readonly<Record<string, string>> = {
  US: "6252001", CA: "6251999", GB: "2635167", IE: "2963597", AU: "2077456", NZ: "2186224",
  DE: "2921044", FR: "3017382", IT: "3175395", ES: "2510769", NL: "2750405", BE: "2802361",
  AT: "2782113", CH: "2658434", PT: "2264397", SE: "2661886", NO: "3144096", DK: "2623032",
  FI: "660013", PL: "798544", BR: "3469034", MX: "3996063", AR: "3865483", CO: "3686110",
  CL: "3895114", JP: "1861060", KR: "1835841", IN: "1269750", PH: "1694008", ID: "1643084",
  SG: "1880251", MY: "1733045", TH: "1605651", VN: "1562822", TR: "298795", SA: "102358",
  AE: "290557", ZA: "953987",
};

interface Envelope<T> {
  code?: number;
  message?: string;
  request_id?: string;
  data?: T;
}

interface ReportRow {
  dimensions: { campaign_id?: string; stat_time_day: string };
  metrics: Record<string, string | number | undefined>;
}

function tiktokAdsDryRunResponse(req: HttpRequest): unknown {
  const path = new URL(req.url).pathname;
  const data = path.endsWith("/campaign/create/")
    ? { campaign_id: dryId("ttcampaign", req) }
    : path.endsWith("/adgroup/create/")
      ? { adgroup_id: dryId("ttadgroup", req) }
      : path.endsWith("/ad/create/")
        ? { ad_ids: [dryId("ttad", req)] }
        : {};
  return { code: 0, message: "OK", data };
}

function unwrap<T>(body: Envelope<T>, what: string): T {
  if (body.code !== 0) throw new Error(`TikTok Ads ${what}: code ${body.code ?? "?"} ${body.message ?? ""} (request ${body.request_id ?? "?"})`);
  return (body.data ?? {}) as T;
}

/** "2026-10-20T00:00:00.000Z" → "2026-10-20 00:00:00" (UTC). */
export function tiktokTime(iso: string): string {
  return new Date(iso).toISOString().slice(0, 19).replace("T", " ");
}

export function locationIds(geos: readonly string[]): string[] {
  const unknown = geos.filter((g) => !TIKTOK_COUNTRY_LOCATION_IDS[g.toUpperCase()]);
  if (unknown.length) throw new Error(`no TikTok location id for ${unknown.join(", ")}`);
  return geos.map((g) => TIKTOK_COUNTRY_LOCATION_IDS[g.toUpperCase()] as string);
}

/** One report row → AdDailyStats (the advertiser currency is USD). */
export function tiktokDailyStats(row: ReportRow, today: string): AdDailyStats {
  const date = row.dimensions.stat_time_day.slice(0, 10);
  return {
    date,
    spendCents: amountToCents(row.metrics.spend),
    impressions: int(row.metrics.impressions),
    taps: int(row.metrics.clicks),
    installs: int(row.metrics.app_install),
    conversions: null,
    revenueCents: null,
    attributionComplete: attributionComplete(date, today),
  };
}

export class TikTokAdsClient implements NetworkAdapter {
  private readonly http: HttpClient;
  private readonly clock: Clock;

  constructor(private readonly opts: AdsClientOptions) {
    this.clock = opts.clock ?? new SystemClock();
    this.http = new HttpClient({
      service: "tiktok_ads",
      dryRun: opts.dryRun,
      dryRunResponse: tiktokAdsDryRunResponse,
      ...(opts.recorder ? { recorder: opts.recorder } : {}),
      fetch: bigIntSafeFetch(opts.fetch ?? fetch),
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
    });
  }

  private get token(): string | undefined {
    return this.opts.env.TIKTOK_ADS_TOKEN;
  }

  /** Dry-run without a token: nothing reaches TikTok, reads come back empty. */
  get offline(): boolean {
    return this.opts.dryRun && !this.token;
  }

  async createCampaign(req: CreateCampaignRequest): Promise<{ campaignExternalId: string }> {
    validateCampaign(req);
    if (req.type !== "creative") throw new Error("TikTok has no search campaigns; use Apple Ads for search");
    if (!req.creatives.length) throw new Error(`campaign ${req.name}: TikTok app campaigns need at least one creative`);
    const advertiser_id = req.adAccountId;
    const location_ids = locationIds(req.geos);
    const identities = [];
    for (const c of req.creatives) identities.push(await this.identity(advertiser_id, c));
    const app_id = await this.appId(advertiser_id, req);

    const campaign = await this.write<{ campaign_id: string }>("campaign/create/", {
      advertiser_id,
      campaign_name: req.name,
      objective_type: "APP_PROMOTION",
      app_promotion_type: "APP_INSTALL",
      budget_mode: "BUDGET_MODE_DAY",
      budget: Number(centsToAmount(req.dailyBudgetCents)),
      operation_status: "DISABLE",
    });
    const adgroup = await this.write<{ adgroup_id: string }>("adgroup/create/", {
      advertiser_id,
      campaign_id: campaign.campaign_id,
      adgroup_name: `${req.name}-adgroup`,
      promotion_type: req.os === "ios" ? "APP_IOS" : "APP_ANDROID",
      app_id,
      operating_systems: [req.os === "ios" ? "IOS" : "ANDROID"],
      placement_type: "PLACEMENT_TYPE_NORMAL",
      placements: ["PLACEMENT_TIKTOK"],
      location_ids,
      budget_mode: "BUDGET_MODE_INFINITE",
      schedule_type: "SCHEDULE_START_END",
      schedule_start_time: tiktokTime(req.startAt),
      schedule_end_time: tiktokTime(req.endAt),
      optimization_goal: "INSTALL",
      billing_event: "OCPM",
      bid_type: "BID_TYPE_NO_BID",
      pacing: "PACING_MODE_SMOOTH",
      operation_status: "ENABLE",
    });
    await this.write("ad/create/", {
      advertiser_id,
      adgroup_id: adgroup.adgroup_id,
      creatives: identities.map((id, i) => ({
        ad_name: `${req.name}-ad-${i + 1}`,
        ad_format: "SINGLE_VIDEO",
        identity_type: id.identity_type,
        identity_id: id.identity_id,
        tiktok_item_id: id.tiktok_item_id,
        call_to_action: "DOWNLOAD_NOW",
        operation_status: "ENABLE",
      })),
    });
    await this.write("campaign/status/update/", { advertiser_id, campaign_ids: [campaign.campaign_id], operation_status: "ENABLE" });
    return { campaignExternalId: joinId(advertiser_id, campaign.campaign_id) };
  }

  async setDailyBudget(campaignExternalId: string, dailyBudgetCents: Cents): Promise<void> {
    const { accountId, campaignId } = splitId(campaignExternalId, "tiktok");
    await this.write("campaign/update/", { advertiser_id: accountId, campaign_id: campaignId, budget: Number(centsToAmount(dailyBudgetCents)) });
  }

  async pause(campaignExternalId: string): Promise<void> {
    const { accountId, campaignId } = splitId(campaignExternalId, "tiktok");
    await this.write("campaign/status/update/", { advertiser_id: accountId, campaign_ids: [campaignId], operation_status: "DISABLE" });
  }

  async stats(campaignExternalId: string, since: string, until: string): Promise<AdDailyStats[]> {
    if (this.offline || isDry(campaignExternalId)) return [];
    const { accountId, campaignId } = splitId(campaignExternalId, "tiktok");
    const today = this.clock.today();
    const out: AdDailyStats[] = [];
    for (const range of dateChunks(since, until, REPORT_MAX_DAYS)) {
      for (let page = 1, pages = 1; page <= pages; page++) {
        const data = await this.read<{ list?: ReportRow[]; page_info?: { total_page?: number } }>("report/integrated/get/", {
          advertiser_id: accountId,
          report_type: "BASIC",
          data_level: "AUCTION_CAMPAIGN",
          dimensions: JSON.stringify(["campaign_id", "stat_time_day"]),
          metrics: JSON.stringify(TIKTOK_REPORT_METRICS),
          start_date: range.start,
          end_date: range.end,
          filtering: JSON.stringify([{ field_name: "campaign_ids", filter_type: "IN", filter_value: JSON.stringify([campaignId]) }]),
          page,
          page_size: 1000,
        });
        for (const row of data.list ?? []) out.push(tiktokDailyStats(row, today));
        pages = data.page_info?.total_page ?? 1;
      }
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }

  private async identity(advertiserId: string, ref: AdCreativeRef): Promise<{ identity_type: string; identity_id: string; tiktok_item_id: string }> {
    switch (ref.kind) {
      case "spark_code": {
        if (ref.expiresAt <= this.clock.iso()) throw new Error(`Spark code for ${ref.contentId} expired ${ref.expiresAt}`);
        await this.write("tt_video/authorize/", { advertiser_id: advertiserId, auth_code: ref.code });
        if (this.offline) return { identity_type: "AUTH_CODE", identity_id: `dry_identity_${ref.contentId}`, tiktok_item_id: `dry_item_${ref.contentId}` };
        const info = await this.read<{ item_info?: { item_id?: string }; user_info?: { identity_id?: string } }>("tt_video/info/", { advertiser_id: advertiserId, auth_code: ref.code });
        const itemId = info.item_info?.item_id;
        const identityId = info.user_info?.identity_id;
        if (!itemId || !identityId) throw new Error(`Spark code for ${ref.contentId} did not resolve to a post and identity`);
        return { identity_type: "AUTH_CODE", identity_id: identityId, tiktok_item_id: String(itemId) };
      }
      case "owned_post": {
        if (ref.platform !== "tiktok") throw new Error(`TikTok can boost TikTok posts only, not ${ref.platform} (${ref.contentId})`);
        const identityId = this.opts.env.TIKTOK_ADS_IDENTITY_ID;
        if (!identityId) throw new Error("boosting owned TikTok posts needs TIKTOK_ADS_IDENTITY_ID (the linked TT_USER identity)");
        return { identity_type: "TT_USER", identity_id: identityId, tiktok_item_id: ref.externalId };
      }
      case "ig_partnership":
        throw new Error(`Instagram partnership media cannot run on TikTok (${ref.contentId})`);
      case "uploaded_video":
        throw new Error(`uploaded videos are not supported on TikTok yet; boost the post with a Spark code (${ref.contentId})`);
    }
  }

  /** The app-management id: env override, else the registered app whose store URL matches. */
  private async appId(advertiserId: string, req: CreateCampaignRequest): Promise<string> {
    const fromEnv = this.opts.env.TIKTOK_ADS_APP_ID;
    if (fromEnv) return fromEnv;
    if (this.offline) return "dry_app";
    const data = await this.read<{ apps?: { app_id: string; download_url?: string; package_name?: string }[] }>("app/list/", { advertiser_id: advertiserId });
    const needle = req.os === "ios" ? `id${req.bindings.ascAppId ?? "?"}` : req.bindings.androidPackage;
    const app = data.apps?.find((a) => (a.download_url ?? "").includes(needle) || a.package_name === needle);
    if (!app) throw new Error(`no app matching ${needle} in TikTok app management for advertiser ${advertiserId}; register it or set TIKTOK_ADS_APP_ID`);
    return String(app.app_id);
  }

  private async write<T = unknown>(path: string, json: Record<string, unknown>): Promise<T> {
    const res = await this.http.request<Envelope<T>>({ method: "POST", url: `${TIKTOK_ADS_API}/${path}`, json, headers: this.opts.dryRun ? {} : this.auth() });
    return unwrap(res.data, path);
  }

  private async read<T>(path: string, query: Record<string, string | number>): Promise<T> {
    const res = await this.http.get<Envelope<T>>(withQuery(`${TIKTOK_ADS_API}/${path}`, query), this.auth());
    return unwrap(res.data, path);
  }

  private auth(): Record<string, string> {
    const token = this.token;
    if (!token) throw new Error("TIKTOK_ADS_TOKEN is not set");
    return { "access-token": token };
  }
}
