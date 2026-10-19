/**
 * Meta Marketing API (Graph API v26.0) app-install campaigns.
 *
 * Since v25.0 the legacy Advantage+ app campaign (smart_promotion_type) cannot be created;
 * the Advantage+ state now follows from three levers: a campaign-level budget, Advantage+
 * audience (targeting_automation.advantage_audience = 1) and no placement targeting.
 * Campaigns are created PAUSED and switched on only once every ad exists, so a half-built
 * campaign never spends. Creatives boost existing Instagram posts (owned or partnership).
 */
import type { Clock } from "../../core/ports.ts";
import type { AdCreativeRef, AdDailyStats, Cents } from "../../core/types.ts";
import { SystemClock } from "../../core/clock.ts";
import { HttpClient, withQuery } from "../http.ts";
import type { HttpRequest } from "../http.ts";
import { amountToCents, attributionComplete, dryId, int, isDry, storeUrl, validateCampaign } from "./common.ts";
import type { AdsClientOptions, CreateCampaignRequest, NetworkAdapter } from "./common.ts";

export const ENV_VARS: readonly { name: string; purpose: string; required: boolean }[] = [
  { name: "META_ADS_TOKEN", purpose: "System-user access token with ads_management and ads_read on the venture ad accounts", required: true },
  { name: "META_ADS_PAGE_ID", purpose: "Facebook Page that fronts the ads (object_id of every creative)", required: true },
  { name: "META_ADS_INSTAGRAM_USER_ID", purpose: "Brand Instagram user id: sponsor of partnership ads and identity of owned-post ads when the post's account is unknown", required: false },
];

export const META_GRAPH_VERSION = "v26.0";
export const META_API = `https://graph.facebook.com/${META_GRAPH_VERSION}`;
/** Outcome-driven objective for app installs (the ODAX name of the legacy APP_INSTALLS). */
export const META_APP_OBJECTIVE = "OUTCOME_APP_PROMOTION";
export const META_INSTALL_ACTION = "mobile_app_install";
export const META_PURCHASE_ACTIONS = ["app_custom_event.fb_mobile_purchase", "omni_purchase"] as const;

interface ActionRow {
  action_type: string;
  value: string;
}

interface InsightRow {
  date_start: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  actions?: ActionRow[];
  action_values?: ActionRow[];
}

function metaDryRunResponse(req: HttpRequest): unknown {
  const edge = new URL(req.url).pathname.split("/").pop() ?? "";
  const kind = { campaigns: "metacampaign", adsets: "metaadset", adcreatives: "metacreative", ads: "metaad" }[edge];
  return kind ? { id: dryId(kind, req) } : { success: true };
}

function actId(adAccountId: string): string {
  return adAccountId.startsWith("act_") ? adAccountId : `act_${adAccountId}`;
}

function actionValue(rows: ActionRow[] | undefined, types: readonly string[]): number | null {
  if (!rows) return null;
  for (const t of types) {
    const row = rows.find((r) => r.action_type === t);
    if (row) return Number(row.value);
  }
  return 0;
}

/** One insights row (time_increment=1) → AdDailyStats. Spend is in the account currency (USD). */
export function metaDailyStats(row: InsightRow, today: string): AdDailyStats {
  const purchases = actionValue(row.actions, META_PURCHASE_ACTIONS);
  const revenue = actionValue(row.action_values, META_PURCHASE_ACTIONS);
  return {
    date: row.date_start,
    spendCents: amountToCents(row.spend),
    impressions: int(row.impressions),
    taps: int(row.clicks),
    installs: int(actionValue(row.actions, [META_INSTALL_ACTION])),
    conversions: purchases === null ? null : int(purchases),
    revenueCents: revenue === null ? null : amountToCents(revenue),
    attributionComplete: attributionComplete(row.date_start, today),
  };
}

export class MetaAdsClient implements NetworkAdapter {
  private readonly http: HttpClient;
  private readonly clock: Clock;

  constructor(private readonly opts: AdsClientOptions) {
    this.clock = opts.clock ?? new SystemClock();
    this.http = new HttpClient({
      service: "meta_ads",
      dryRun: opts.dryRun,
      dryRunResponse: metaDryRunResponse,
      ...(opts.recorder ? { recorder: opts.recorder } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
    });
  }

  private get token(): string | undefined {
    return this.opts.env.META_ADS_TOKEN;
  }

  /** Dry-run without a token: nothing reaches Meta, reads come back empty. */
  get offline(): boolean {
    return this.opts.dryRun && !this.token;
  }

  async createCampaign(req: CreateCampaignRequest): Promise<{ campaignExternalId: string }> {
    validateCampaign(req);
    if (req.type !== "creative") throw new Error("Meta has no search campaigns; use Apple Ads for search");
    if (!req.creatives.length) throw new Error(`campaign ${req.name}: Meta app campaigns need at least one creative`);
    const applicationId = req.bindings.metaAppId;
    if (!applicationId) throw new Error("Meta app campaigns need bindings.metaAppId (the app registered with Meta)");
    const pageId = this.opts.env.META_ADS_PAGE_ID;
    if (!pageId) throw new Error("META_ADS_PAGE_ID is not set");
    const act = actId(req.adAccountId);
    const objectStoreUrl = storeUrl(req);
    const creatives = req.creatives.map((c) => this.creativeSpec(c, pageId, objectStoreUrl, req.name));
    await this.assertUsd(act);

    const campaign = await this.write<{ id: string }>(`${META_API}/${act}/campaigns`, {
      name: req.name,
      objective: META_APP_OBJECTIVE,
      status: "PAUSED",
      special_ad_categories: [],
      buying_type: "AUCTION",
      daily_budget: req.dailyBudgetCents,
      bid_strategy: "LOWEST_COST_WITHOUT_CAP",
    });
    const adset = await this.write<{ id: string }>(`${META_API}/${act}/adsets`, {
      name: `${req.name}-adset`,
      campaign_id: campaign.id,
      status: "ACTIVE",
      optimization_goal: "APP_INSTALLS",
      billing_event: "IMPRESSIONS",
      promoted_object: { application_id: applicationId, object_store_url: objectStoreUrl },
      targeting: { geo_locations: { countries: req.geos }, targeting_automation: { advantage_audience: 1 } },
      start_time: req.startAt,
      end_time: req.endAt,
    });
    for (const [i, spec] of creatives.entries()) {
      const creative = await this.write<{ id: string }>(`${META_API}/${act}/adcreatives`, spec);
      await this.write(`${META_API}/${act}/ads`, { name: `${req.name}-ad-${i + 1}`, adset_id: adset.id, creative: { creative_id: creative.id }, status: "ACTIVE" });
    }
    await this.write(`${META_API}/${campaign.id}`, { status: "ACTIVE" });
    return { campaignExternalId: campaign.id };
  }

  async setDailyBudget(campaignExternalId: string, dailyBudgetCents: Cents): Promise<void> {
    if (!Number.isInteger(dailyBudgetCents) || dailyBudgetCents <= 0) throw new Error(`daily budget must be positive integer cents, got ${dailyBudgetCents}`);
    await this.write(`${META_API}/${campaignExternalId}`, { daily_budget: dailyBudgetCents });
  }

  async pause(campaignExternalId: string): Promise<void> {
    await this.write(`${META_API}/${campaignExternalId}`, { status: "PAUSED" });
  }

  async stats(campaignExternalId: string, since: string, until: string): Promise<AdDailyStats[]> {
    if (this.offline || isDry(campaignExternalId)) return [];
    const today = this.clock.today();
    const out: AdDailyStats[] = [];
    let url: string | undefined = withQuery(`${META_API}/${campaignExternalId}/insights`, {
      level: "campaign",
      fields: "spend,impressions,clicks,actions,action_values",
      time_increment: 1,
      time_range: JSON.stringify({ since, until }),
      limit: 100,
    });
    while (url) {
      const res: { data: { data?: InsightRow[]; paging?: { next?: string } } } = await this.http.get(url, this.auth());
      for (const row of res.data.data ?? []) out.push(metaDailyStats(row, today));
      url = res.data.paging?.next;
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }

  private creativeSpec(ref: AdCreativeRef, pageId: string, objectStoreUrl: string, name: string): Record<string, unknown> {
    const call_to_action = { type: "INSTALL_MOBILE_APP", value: { link: objectStoreUrl } };
    const brandIg = this.opts.env.META_ADS_INSTAGRAM_USER_ID;
    switch (ref.kind) {
      case "owned_post": {
        if (ref.platform !== "instagram") throw new Error(`Meta can boost Instagram posts only, not ${ref.platform} (${ref.contentId})`);
        const igUserId = this.ownedIgUserId(ref.contentId) ?? brandIg;
        if (!igUserId) throw new Error(`no Instagram user id for ${ref.contentId}: connect the account or set META_ADS_INSTAGRAM_USER_ID`);
        return { name: `${name}-${ref.contentId}`, object_id: pageId, instagram_user_id: igUserId, source_instagram_media_id: ref.externalId, call_to_action };
      }
      case "ig_partnership":
        if (!brandIg) throw new Error("partnership ads need META_ADS_INSTAGRAM_USER_ID (the sponsoring brand account)");
        return {
          name: `${name}-${ref.contentId}`,
          object_id: pageId,
          source_instagram_media_id: ref.mediaId,
          instagram_branded_content: { sponsor_id: brandIg },
          facebook_branded_content: { sponsor_page_id: pageId },
          call_to_action,
        };
      case "spark_code":
        throw new Error(`Spark codes are TikTok-only (${ref.contentId})`);
      case "uploaded_video":
        throw new Error(`uploaded videos are not supported on Meta yet; boost the Instagram post instead (${ref.contentId})`);
    }
  }

  private ownedIgUserId(contentId: string): string | undefined {
    const piece = this.opts.store.content.get(contentId);
    const account = piece?.accountId ? this.opts.store.accounts.get(piece.accountId) : undefined;
    return account?.platform === "instagram" ? account.externalId : undefined;
  }

  /** daily_budget is in the account currency's minor units; the studio books USD cents. */
  private async assertUsd(act: string): Promise<void> {
    if (this.offline) return;
    const res = await this.http.get<{ currency?: string }>(withQuery(`${META_API}/${act}`, { fields: "currency" }), this.auth());
    if (res.data.currency && res.data.currency !== "USD") throw new Error(`Meta ad account ${act} bills in ${res.data.currency}; only USD accounts are supported`);
  }

  private async write<T = unknown>(url: string, json: Record<string, unknown>): Promise<T> {
    const res = await this.http.request<T>({ method: "POST", url, json, headers: this.opts.dryRun ? {} : this.auth() });
    return res.data;
  }

  private auth(): Record<string, string> {
    const token = this.token;
    if (!token) throw new Error("META_ADS_TOKEN is not set");
    return { authorization: `Bearer ${token}` };
  }
}
