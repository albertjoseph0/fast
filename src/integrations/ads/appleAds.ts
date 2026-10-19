/**
 * Apple Ads Platform API v1 (api.ads.apple.com), the successor of Campaign Management API
 * v5 (sunset January 26, 2027). Search-results campaigns only: a manual-CPT campaign holding
 * the daily budget, one ad group and its exact/broad keywords with bids.
 *
 * Auth is OAuth client credentials: the client secret is an ES256 JWT (iss team id, sub
 * client id, aud https://appleid.apple.com) exchanged at appleid.apple.com for a one-hour
 * access token. Every ad-account call carries X-AP-Context: adAccountId=<id>. Campaigns are
 * created PAUSED and enabled once their keywords exist. Campaign ids are
 * "<adAccountId>:<campaignId>".
 */
import { readFileSync } from "node:fs";
import type { Clock } from "../../core/ports.ts";
import type { AdDailyStats, Cents } from "../../core/types.ts";
import { SystemClock } from "../../core/clock.ts";
import { HttpClient } from "../http.ts";
import type { HttpRequest } from "../http.ts";
import { signEs256Jwt } from "../apple/jwt.ts";
import { amountToCents, attributionComplete, centsToAmount, dateChunks, dryId, int, isDry, joinId, splitId, validateCampaign } from "./common.ts";
import type { AdsClientOptions, CreateCampaignRequest, NetworkAdapter } from "./common.ts";

export const ENV_VARS: readonly { name: string; purpose: string; required: boolean }[] = [
  { name: "APPLE_ADS_CLIENT_ID", purpose: "Apple Ads API client id (from uploading the public key in Apple Ads account settings)", required: true },
  { name: "APPLE_ADS_TEAM_ID", purpose: "Apple Ads API team id (client secret issuer)", required: true },
  { name: "APPLE_ADS_KEY_ID", purpose: "Apple Ads API key id (client secret kid)", required: true },
  { name: "APPLE_ADS_PRIVATE_KEY_PATH", purpose: "Path to the EC P-256 private key PEM that signs the client secret", required: true },
  { name: "APPLE_ADS_PRIVATE_KEY", purpose: "Inline private key PEM, an alternative to the path", required: false },
  { name: "APPLE_ADS_API_BASE", purpose: "Override of the Platform API base URL (default https://api.ads.apple.com/v1)", required: false },
];

export const APPLE_ADS_API = "https://api.ads.apple.com/v1";
export const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/oauth2/token";
export const APPLE_ADS_SCOPE = "searchadsorg";
/** Client secrets may live up to 180 days; a fresh one per token keeps leaked secrets short-lived. */
const CLIENT_SECRET_TTL_SEC = 86_400;
/** DAILY report ranges must span 90 days or less. */
const REPORT_MAX_DAYS = 90;

interface Money {
  amount: string;
  currency: string;
}

interface ReportMetrics {
  date?: string;
  localSpend?: Money;
  impressions?: number;
  taps?: number;
  tapInstalls?: number;
  totalInstalls?: number;
}

interface ReportResponse {
  result?: { rows?: { metadata?: { id?: number | string }; totalMetrics?: ReportMetrics; granularMetrics?: ReportMetrics[] }[] };
  pagination?: { totalCount?: number; offset?: number; pageSize?: number };
}

function usd(cents: Cents): Money {
  return { amount: centsToAmount(cents), currency: "USD" };
}

/** "2026-10-20T00:00:00.000Z" → "2026-10-20T00:00:00.000" (the API's zone-less UTC format). */
export function appleTime(iso: string): string {
  return new Date(iso).toISOString().slice(0, 23);
}

function numericId(id: string): number | string {
  return /^\d{1,15}$/.test(id) ? Number(id) : id;
}

function appleDryRunResponse(req: HttpRequest): unknown {
  const path = new URL(req.url).pathname;
  if (path.endsWith("/keywords/bulk-create")) {
    const items = ((req.json as { items?: { correlationId: number; data: unknown }[] } | undefined)?.items ?? []);
    return { result: items.map((i) => ({ correlationId: i.correlationId, operation: "CREATE", success: true, result: { id: dryId(`applekw${i.correlationId}`, req) } })) };
  }
  if (req.method === "POST" && path.endsWith("/campaigns")) return { result: { id: dryId("applecampaign", req) } };
  if (req.method === "POST" && path.endsWith("/adgroups")) return { result: { id: dryId("appleadgroup", req) } };
  return { result: {} };
}

/** Report metrics (granular row, or totals for a single-day request) → AdDailyStats. */
export function appleDailyStats(m: ReportMetrics, date: string, today: string): AdDailyStats {
  return {
    date,
    spendCents: amountToCents(m.localSpend?.amount),
    impressions: int(m.impressions),
    taps: int(m.taps),
    installs: int(m.totalInstalls ?? m.tapInstalls),
    conversions: null,
    revenueCents: null,
    attributionComplete: attributionComplete(date, today),
  };
}

export class AppleAdsClient implements NetworkAdapter {
  private readonly http: HttpClient;
  private readonly oauth: HttpClient;
  private readonly clock: Clock;
  private cachedToken: { token: string; exp: number } | null = null;

  constructor(private readonly opts: AdsClientOptions) {
    this.clock = opts.clock ?? new SystemClock();
    const common = {
      service: "apple_ads",
      dryRun: opts.dryRun,
      dryRunResponse: appleDryRunResponse,
      ...(opts.recorder ? { recorder: opts.recorder } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
    };
    this.http = new HttpClient(common);
    this.oauth = new HttpClient(common);
  }

  private get base(): string {
    return (this.opts.env.APPLE_ADS_API_BASE ?? APPLE_ADS_API).replace(/\/+$/, "");
  }

  private credentials(): { clientId: string; teamId: string; keyId: string; privateKeyPem: string } | null {
    const { APPLE_ADS_CLIENT_ID: clientId, APPLE_ADS_TEAM_ID: teamId, APPLE_ADS_KEY_ID: keyId, APPLE_ADS_PRIVATE_KEY: inline, APPLE_ADS_PRIVATE_KEY_PATH: path } = this.opts.env;
    if (!clientId || !teamId || !keyId || (!inline && !path)) return null;
    return { clientId, teamId, keyId, privateKeyPem: inline ?? readFileSync(path as string, "utf8") };
  }

  /** Dry-run without credentials: nothing reaches Apple, reads come back empty. */
  get offline(): boolean {
    return this.opts.dryRun && this.credentials() === null;
  }

  /** ES256 client secret for the client-credentials grant. */
  clientSecret(nowSec: number): string {
    const c = this.credentials();
    if (!c) throw new Error("Apple Ads credentials missing: set APPLE_ADS_CLIENT_ID, APPLE_ADS_TEAM_ID, APPLE_ADS_KEY_ID and APPLE_ADS_PRIVATE_KEY_PATH");
    return signEs256Jwt({ kid: c.keyId }, { sub: c.clientId, aud: "https://appleid.apple.com", iat: nowSec, exp: nowSec + CLIENT_SECRET_TTL_SEC, iss: c.teamId }, c.privateKeyPem);
  }

  async accessToken(): Promise<string> {
    const nowSec = Math.floor(this.clock.now().getTime() / 1000);
    if (this.cachedToken && nowSec < this.cachedToken.exp - 60) return this.cachedToken.token;
    const clientId = this.opts.env.APPLE_ADS_CLIENT_ID as string;
    const form = new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: this.clientSecret(nowSec), scope: APPLE_ADS_SCOPE });
    const res = await this.oauth.request<{ access_token?: string; expires_in?: number }>({
      method: "POST",
      url: APPLE_TOKEN_URL,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      sideEffect: false,
    });
    const token = res.data.access_token;
    if (!token) throw new Error("Apple Ads OAuth: no access_token in token response");
    this.cachedToken = { token, exp: nowSec + (res.data.expires_in ?? 3_600) };
    return token;
  }

  async createCampaign(req: CreateCampaignRequest): Promise<{ campaignExternalId: string }> {
    validateCampaign(req);
    if (req.type !== "search") throw new Error("Apple Ads creative (Today tab) campaigns need custom product pages and are not supported; use type search");
    if (req.os !== "ios") throw new Error("Apple Ads promotes App Store apps only");
    const adamId = req.bindings.ascAppId;
    if (!adamId) throw new Error("Apple Ads campaigns need bindings.ascAppId (the app's Adam id)");
    if (!req.keywords.length) throw new Error(`campaign ${req.name}: search campaigns need keywords`);
    for (const k of req.keywords) if (!Number.isInteger(k.bidCents) || k.bidCents <= 0) throw new Error(`keyword "${k.text}": bid must be positive integer cents`);
    const account = req.adAccountId;
    const startTime = appleTime(req.startAt);
    const endTime = appleTime(req.endAt);

    const campaign = await this.write<{ id: number | string }>(account, "POST", "/campaigns", {
      name: req.name,
      adAccountId: numericId(account),
      startTime,
      endTime,
      status: "PAUSED",
      billingEvent: "TAPS",
      promotedObjectType: "APPSTORE_APP",
      promotedObjectId: adamId,
      dailyBudget: { value: usd(req.dailyBudgetCents) },
      targeting: { countryOrRegion: { include: req.geos }, supplyPlacement: { include: ["APPSTORE_SEARCH_RESULTS"] } },
      bidStrategy: { bidStrategyType: "MANUAL_CPT", bidStrategyGoal: "TAP" },
    });
    const maxBid = Math.max(...req.keywords.map((k) => k.bidCents));
    const adGroup = await this.write<{ id: number | string }>(account, "POST", "/adgroups", {
      name: `${req.name}-adgroup`,
      campaignId: campaign.id,
      pricingModel: "CPT",
      status: "ENABLED",
      startTime,
      endTime,
      automatedKeywordsOptIn: false,
      bidStrategy: { bidStrategyType: "MANUAL_CPT", bidStrategyGoal: "TAP", bid: usd(maxBid) },
      targeting: { deviceClass: { include: ["IPHONE", "IPAD"] } },
    });
    const created = await this.write<{ correlationId: number; success: boolean; errors?: unknown }[]>(account, "POST", "/keywords/bulk-create", {
      items: req.keywords.map((k, i) => ({
        correlationId: i,
        data: { adGroupId: adGroup.id, text: k.text, matchType: k.match === "exact" ? "EXACT" : "BROAD", bid: usd(k.bidCents), status: "ENABLED" },
      })),
    });
    const failed = created.filter((r) => !r.success);
    if (failed.length) {
      const texts = failed.map((f) => req.keywords[f.correlationId]?.text ?? `#${f.correlationId}`);
      throw new Error(`Apple Ads keywords rejected for campaign ${campaign.id} (left paused): ${texts.join(", ")}`);
    }
    await this.write(account, "PUT", `/campaigns/${campaign.id}`, { status: "ENABLED" });
    return { campaignExternalId: joinId(account, String(campaign.id)) };
  }

  async setDailyBudget(campaignExternalId: string, dailyBudgetCents: Cents): Promise<void> {
    if (!Number.isInteger(dailyBudgetCents) || dailyBudgetCents <= 0) throw new Error(`daily budget must be positive integer cents, got ${dailyBudgetCents}`);
    const { accountId, campaignId } = splitId(campaignExternalId, "apple");
    await this.write(accountId, "PUT", `/campaigns/${campaignId}`, { dailyBudget: { value: usd(dailyBudgetCents) } });
  }

  async pause(campaignExternalId: string): Promise<void> {
    const { accountId, campaignId } = splitId(campaignExternalId, "apple");
    await this.write(accountId, "PUT", `/campaigns/${campaignId}`, { status: "PAUSED" });
  }

  async stats(campaignExternalId: string, since: string, until: string): Promise<AdDailyStats[]> {
    if (this.offline || isDry(campaignExternalId)) return [];
    const { accountId, campaignId } = splitId(campaignExternalId, "apple");
    const today = this.clock.today();
    const out: AdDailyStats[] = [];
    for (const range of dateChunks(since, until, REPORT_MAX_DAYS)) {
      // A single-day range must omit granularity and is answered in totalMetrics only.
      const single = range.start === range.end;
      const res = await this.http.request<ReportResponse>({
        method: "POST",
        url: `${this.base}/reports/apps/campaigns/query`,
        headers: { ...(await this.auth(accountId, false)) },
        json: {
          pagination: { offset: 0, pageSize: 1000 },
          filters: [{ field: "campaignId", operator: "EQUALS", value: campaignId }],
          timeRange: { start: range.start, end: range.end, timeZone: "UTC", ...(single ? {} : { granularity: "DAILY" }) },
        },
        sideEffect: false,
      });
      for (const row of res.data.result?.rows ?? []) {
        if (single) {
          if (row.totalMetrics) out.push(appleDailyStats(row.totalMetrics, range.start, today));
          continue;
        }
        for (const m of row.granularMetrics ?? []) if (m.date) out.push(appleDailyStats(m, m.date, today));
      }
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }

  private async write<T = unknown>(accountId: string, method: "POST" | "PUT", path: string, json: Record<string, unknown>): Promise<T> {
    const res = await this.http.request<{ result?: T }>({ method, url: `${this.base}${path}`, json, headers: await this.auth(accountId, true) });
    return res.data.result as T;
  }

  /** Dry-run writes are never sent, so they never fetch a token; the context header is still recorded. */
  private async auth(accountId: string, write: boolean): Promise<Record<string, string>> {
    const context = { "x-ap-context": `adAccountId=${accountId}` };
    if (this.opts.dryRun && write) return context;
    return { ...context, authorization: `Bearer ${await this.accessToken()}` };
  }
}
