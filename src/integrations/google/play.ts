/**
 * Google Play Developer API client (androidpublisher v3).
 *
 * Authentication is a service-account JWT assertion (RS256) exchanged at Google's token
 * endpoint and cached until a minute before expiry. Publishing goes through edits
 * (insert → change → commit). Writes are dry-run by default and answered with synthetic
 * ids starting with "dry_"; without credentials a dry run never calls Google at all.
 */
import { createHash, createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Clock } from "../../core/ports.ts";
import type { StudioStore } from "../../core/store.ts";
import type { StudioConfig } from "../../config/schema.ts";
import { SystemClock } from "../../core/clock.ts";
import { HttpClient, HttpError, withQuery } from "../http.ts";
import type { DryRunRecorder, HttpRequest } from "../http.ts";

export const ENV_VARS: readonly { name: string; purpose: string; required: boolean }[] = [
  { name: "PLAY_SERVICE_ACCOUNT_JSON", purpose: "Path to the Google service-account key JSON (default name of secretRefs.serviceAccountJsonPath)", required: true },
  { name: "PLAY_SERVICE_ACCOUNT_KEY", purpose: "Inline service-account key JSON, an alternative to the path (secretRefs.serviceAccountJson)", required: false },
];

export const PLAY_API = "https://androidpublisher.googleapis.com/androidpublisher/v3";
export const PLAY_UPLOAD_API = "https://androidpublisher.googleapis.com/upload/androidpublisher/v3";
export const PLAY_SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const TOKEN_REFRESH_MARGIN_SEC = 60;
/** Play's regional price catalogue version used when none comes back from a conversion. */
const DEFAULT_REGIONS_VERSION = "2022/02";

export type PlayTrack = "internal" | "alpha" | "beta" | "production" | (string & {});
export type ReleaseStatus = "draft" | "inProgress" | "halted" | "completed";

export interface PlayMoney {
  currencyCode: string;
  units: string;
  nanos: number;
}

export interface PlayRelease {
  name?: string;
  versionCodes?: string[];
  status: ReleaseStatus;
  userFraction?: number;
  countryTargeting?: { countries: string[]; includeRestOfWorld: boolean };
  releaseNotes?: { language: string; text: string }[];
}

export interface PlayTrackResource {
  track: string;
  releases?: PlayRelease[];
}

export interface PlayReview {
  reviewId: string;
  starRating: number;
  lastModified: string;
  language: string;
  text: string;
}

export interface PlaySubscriptionDef {
  productId: string;
  basePlanId: string;
  title: string;
  languageCode: string;
  billingPeriod: "P1W" | "P1M" | "P1Y";
  usdCents: number;
  /** Alpha-2 regions the base plan (and its trial) is sold in. */
  regions: string[];
  trialDays: number;
}

export interface PlayClientOptions {
  /** config and store are accepted for uniform construction with the other live clients. */
  config: StudioConfig;
  store?: StudioStore;
  env: Record<string, string | undefined>;
  dryRun: boolean;
  recorder?: DryRunRecorder;
  fetch?: typeof fetch;
  /** Env var NAMES: serviceAccountJsonPath (file) or serviceAccountJson (inline JSON). */
  secretRefs: Record<string, string>;
  clock?: Clock;
  sleep?: (ms: number) => Promise<void>;
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/** RS256-signed assertion for the OAuth 2.0 JWT bearer grant. */
export function serviceAccountAssertion(account: ServiceAccount, nowSec: number, scope = PLAY_SCOPE): string {
  const head = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = base64url(JSON.stringify({ iss: account.client_email, scope, aud: account.token_uri ?? DEFAULT_TOKEN_URI, iat: nowSec, exp: nowSec + 3_600 }));
  const signature = createSign("RSA-SHA256").update(`${head}.${body}`).sign(account.private_key);
  return `${head}.${body}.${base64url(signature)}`;
}

/** USD cents as a google.type.Money. */
export function usdMoney(cents: number): PlayMoney {
  return { currencyCode: "USD", units: String(Math.floor(cents / 100)), nanos: (cents % 100) * 10_000_000 };
}

function playDryRunResponse(req: HttpRequest): unknown {
  const tag = createHash("sha256").update(`${req.method} ${req.url} ${JSON.stringify(req.json ?? null)}`).digest("hex").slice(0, 12);
  const path = new URL(req.url).pathname;
  if (/\/edits$/.test(path)) return { id: `dry_edit_${tag}`, expiryTimeSeconds: "0" };
  if (/\/bundles$/.test(path)) return { versionCode: 0, sha256: `dry_${tag}` };
  if (/\/listings\/[^/]+\/[^/]+$/.test(path) && path.includes("/upload/")) return { image: { id: `dry_image_${tag}` } };
  return { ...(req.json && typeof req.json === "object" ? (req.json as object) : {}), dryRunId: `dry_${tag}` };
}

export class PlayClient {
  private readonly http: HttpClient;
  private readonly oauth: HttpClient;
  private readonly clock: Clock;
  private account: ServiceAccount | null | undefined;
  private cachedToken: { token: string; exp: number } | null = null;

  constructor(private readonly opts: PlayClientOptions) {
    this.clock = opts.clock ?? new SystemClock();
    const common = {
      service: "play",
      dryRun: opts.dryRun,
      dryRunResponse: playDryRunResponse,
      ...(opts.recorder ? { recorder: opts.recorder } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
    };
    this.http = new HttpClient({ ...common, defaultHeaders: () => this.authHeaders() });
    this.oauth = new HttpClient(common);
  }

  get dryRun(): boolean {
    return this.opts.dryRun;
  }

  /** Dry-run without credentials: nothing reaches Google, reads come back empty. */
  get offline(): boolean {
    return this.opts.dryRun && this.serviceAccount() === null;
  }

  /** OAuth access token for the androidpublisher scope, cached until shortly before expiry. */
  async accessToken(): Promise<string> {
    const account = this.serviceAccount();
    if (!account) throw new Error(`Google Play credentials missing: set ${this.opts.secretRefs.serviceAccountJsonPath ?? "PLAY_SERVICE_ACCOUNT_JSON"}`);
    const nowSec = Math.floor(this.clock.now().getTime() / 1000);
    if (this.cachedToken && nowSec < this.cachedToken.exp - TOKEN_REFRESH_MARGIN_SEC) return this.cachedToken.token;
    const form = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: serviceAccountAssertion(account, nowSec) });
    const res = await this.oauth.request<{ access_token?: string; expires_in?: number }>({
      method: "POST",
      url: account.token_uri ?? DEFAULT_TOKEN_URI,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      sideEffect: false,
    });
    const token = res.data.access_token;
    if (!token) throw new Error("Google OAuth: no access_token in token response");
    this.cachedToken = { token, exp: nowSec + (res.data.expires_in ?? 3_600) };
    return token;
  }

  // -- edits ---------------------------------------------------------------------------

  /**
   * Open an edit. `readOnly` edits (used for status reads) are sent even in dry-run and
   * should be closed with deleteEdit.
   */
  async insertEdit(packageName: string, opts: { readOnly?: boolean } = {}): Promise<string> {
    if (opts.readOnly && this.offline) return "dry_edit_offline";
    const res = await this.http.request<{ id: string }>({
      method: "POST",
      url: `${this.app(packageName)}/edits`,
      json: {},
      ...(opts.readOnly ? { sideEffect: false } : {}),
    });
    return res.data.id;
  }

  async commitEdit(packageName: string, editId: string, opts: { changesNotSentForReview?: boolean } = {}): Promise<void> {
    const url = withQuery(`${this.app(packageName)}/edits/${editId}:commit`, { changesNotSentForReview: opts.changesNotSentForReview });
    await this.http.request({ method: "POST", url, json: {} });
  }

  async deleteEdit(packageName: string, editId: string, opts: { readOnly?: boolean } = {}): Promise<void> {
    if (editId.startsWith("dry_")) return;
    await this.http.request({ method: "DELETE", url: `${this.app(packageName)}/edits/${editId}`, ...(opts.readOnly ? { sideEffect: false } : {}) });
  }

  /** Run `fn` inside a read-only edit that is always discarded. */
  async withReadEdit<T>(packageName: string, fn: (editId: string) => Promise<T>): Promise<T> {
    const editId = await this.insertEdit(packageName, { readOnly: true });
    try {
      return await fn(editId);
    } finally {
      await this.deleteEdit(packageName, editId, { readOnly: true }).catch(() => undefined);
    }
  }

  async getTrack(packageName: string, editId: string, track: PlayTrack): Promise<PlayTrackResource | null> {
    return this.read<PlayTrackResource>(`${this.app(packageName)}/edits/${editId}/tracks/${track}`);
  }

  async listTracks(packageName: string, editId: string): Promise<PlayTrackResource[]> {
    return (await this.read<{ tracks?: PlayTrackResource[] }>(`${this.app(packageName)}/edits/${editId}/tracks`))?.tracks ?? [];
  }

  async updateTrack(packageName: string, editId: string, track: PlayTrack, releases: PlayRelease[]): Promise<void> {
    await this.http.request({ method: "PUT", url: `${this.app(packageName)}/edits/${editId}/tracks/${track}`, json: { track, releases } });
  }

  async updateListing(packageName: string, editId: string, listing: { language: string; title: string; shortDescription: string; fullDescription: string }): Promise<void> {
    await this.http.request({ method: "PUT", url: `${this.app(packageName)}/edits/${editId}/listings/${listing.language}`, json: listing });
  }

  async patchDetails(packageName: string, editId: string, details: { contactEmail?: string; contactWebsite?: string; defaultLanguage?: string }): Promise<void> {
    await this.http.request({ method: "PATCH", url: `${this.app(packageName)}/edits/${editId}/details`, json: details });
  }

  async deleteAllImages(packageName: string, editId: string, language: string, imageType: "phoneScreenshots" | "featureGraphic" | "icon"): Promise<void> {
    await this.http.request({ method: "DELETE", url: `${this.app(packageName)}/edits/${editId}/listings/${language}/${imageType}` });
  }

  /** `aiGenerated` sets Play's developer-attested AI provenance; omitted, the image stays unspecified. */
  async uploadImage(
    packageName: string,
    editId: string,
    language: string,
    imageType: "phoneScreenshots" | "featureGraphic" | "icon",
    filePath: string,
    opts: { aiGenerated?: boolean } = {},
  ): Promise<void> {
    const aiGeneratedState = opts.aiGenerated === undefined ? undefined : opts.aiGenerated ? "aiGeneratedStateAiGeneratedDeveloperAttested" : "aiGeneratedStateNotAiGenerated";
    await this.http.upload({
      method: "POST",
      url: withQuery(`${PLAY_UPLOAD_API}/applications/${packageName}/edits/${editId}/listings/${language}/${imageType}`, { uploadType: "media", aiGeneratedState }),
      headers: { "content-type": filePath.toLowerCase().endsWith(".jpg") || filePath.toLowerCase().endsWith(".jpeg") ? "image/jpeg" : "image/png" },
      file: { path: filePath },
    });
  }

  /** bundles.upload (uploadType=media); returns the new version code. */
  async uploadBundle(packageName: string, editId: string, aabPath: string): Promise<number> {
    const res = await this.http.upload<{ versionCode?: number }>({
      method: "POST",
      url: `${PLAY_UPLOAD_API}/applications/${packageName}/edits/${editId}/bundles?uploadType=media`,
      headers: { "content-type": "application/octet-stream" },
      file: { path: aabPath },
    });
    return Number(res.data.versionCode ?? 0);
  }

  /** True when the package exists in Play Console and the service account can see it. */
  async appExists(packageName: string): Promise<boolean | null> {
    if (this.offline) return null;
    try {
      await this.withReadEdit(packageName, async () => undefined);
      return true;
    } catch (err) {
      if (err instanceof HttpError && (err.status === 404 || err.status === 403)) return false;
      throw err;
    }
  }

  // -- monetization --------------------------------------------------------------------

  /** Google's regional prices for a USD price, keyed by alpha-2 region. */
  async convertRegionPrices(packageName: string, usdCents: number): Promise<{ prices: Record<string, PlayMoney>; regionsVersion: string }> {
    if (this.offline) return { prices: {}, regionsVersion: DEFAULT_REGIONS_VERSION };
    const res = await this.http.request<{ convertedRegionPrices?: Record<string, { regionCode?: string; price?: PlayMoney }>; regionVersion?: { version?: string } }>({
      method: "POST",
      url: `${this.app(packageName)}/pricing:convertRegionPrices`,
      json: { price: usdMoney(usdCents) },
      sideEffect: false,
    });
    const prices: Record<string, PlayMoney> = {};
    for (const [region, converted] of Object.entries(res.data.convertedRegionPrices ?? {})) if (converted.price) prices[region] = converted.price;
    return { prices, regionsVersion: res.data.regionVersion?.version ?? DEFAULT_REGIONS_VERSION };
  }

  async getSubscription(packageName: string, productId: string): Promise<{ productId: string; basePlans?: { basePlanId: string; state?: string }[] } | null> {
    return this.read(`${this.app(packageName)}/subscriptions/${productId}`);
  }

  /**
   * Create a subscription with one auto-renewing base plan priced per region (from
   * convertRegionPrices), activate it, and add an activated free-trial offer when
   * trialDays > 0. Existing subscriptions are left as they are.
   */
  async upsertSubscription(packageName: string, def: PlaySubscriptionDef): Promise<{ created: boolean }> {
    if (await this.getSubscription(packageName, def.productId)) return { created: false };
    const { prices, regionsVersion } = await this.convertRegionPrices(packageName, def.usdCents);
    const regions = [...new Set(def.regions.map((r) => r.toUpperCase()))];
    const regionalConfigs = regions.map((regionCode) => ({
      regionCode,
      newSubscriberAvailability: true,
      // Offline dry-run cannot convert; the recorded body shows the USD price as a placeholder.
      price: prices[regionCode] ?? (regionCode === "US" || this.opts.dryRun ? usdMoney(def.usdCents) : missingPrice(regionCode)),
    }));
    await this.http.request({
      method: "POST",
      url: withQuery(`${this.app(packageName)}/subscriptions`, { productId: def.productId, "regionsVersion.version": regionsVersion }),
      json: {
        packageName,
        productId: def.productId,
        listings: [{ languageCode: def.languageCode, title: def.title.slice(0, 55) }],
        basePlans: [{ basePlanId: def.basePlanId, autoRenewingBasePlanType: { billingPeriodDuration: def.billingPeriod }, regionalConfigs }],
      },
    });
    const basePlan = `${this.app(packageName)}/subscriptions/${def.productId}/basePlans/${def.basePlanId}`;
    await this.http.request({ method: "POST", url: `${basePlan}:activate`, json: { packageName, productId: def.productId, basePlanId: def.basePlanId } });
    if (def.trialDays > 0) {
      const offerId = `trial-${def.trialDays}d`;
      await this.http.request({
        method: "POST",
        url: withQuery(`${basePlan}/offers`, { offerId, "regionsVersion.version": regionsVersion }),
        json: {
          packageName,
          productId: def.productId,
          basePlanId: def.basePlanId,
          offerId,
          phases: [{ recurrenceCount: 1, duration: `P${def.trialDays}D`, regionalConfigs: regions.map((regionCode) => ({ regionCode, free: {} })) }],
          regionalConfigs: regions.map((regionCode) => ({ regionCode, newSubscriberAvailability: true })),
          targeting: { acquisitionRule: { scope: { thisSubscription: {} } } },
        },
      });
      await this.http.request({
        method: "POST",
        url: `${basePlan}/offers/${offerId}:activate`,
        json: { packageName, productId: def.productId, basePlanId: def.basePlanId, offerId },
      });
    }
    return { created: true };
  }

  // -- reviews -------------------------------------------------------------------------

  /** Reviews with comments, newest pages first (Play returns roughly the last week). */
  async listReviews(packageName: string, maxPages = 10): Promise<PlayReview[]> {
    const out: PlayReview[] = [];
    let token: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const doc = await this.read<{ reviews?: RawReview[]; tokenPagination?: { nextPageToken?: string } }>(
        withQuery(`${this.app(packageName)}/reviews`, { maxResults: 100, token }),
      );
      for (const r of doc?.reviews ?? []) {
        const user = r.comments?.find((c) => c.userComment)?.userComment;
        if (!user || !r.reviewId) continue;
        out.push({
          reviewId: r.reviewId,
          starRating: Number(user.starRating ?? 0),
          lastModified: new Date(Number(user.lastModified?.seconds ?? 0) * 1000).toISOString(),
          language: user.reviewerLanguage ?? "",
          text: user.text ?? "",
        });
      }
      token = doc?.tokenPagination?.nextPageToken;
      if (!token) break;
    }
    return out;
  }

  // -- transport -----------------------------------------------------------------------

  private app(packageName: string): string {
    return `${PLAY_API}/applications/${packageName}`;
  }

  private serviceAccount(): ServiceAccount | null {
    if (this.account !== undefined) return this.account;
    const { env, secretRefs } = this.opts;
    const path = env[secretRefs.serviceAccountJsonPath ?? "PLAY_SERVICE_ACCOUNT_JSON"];
    const inline = secretRefs.serviceAccountJson ? env[secretRefs.serviceAccountJson] : undefined;
    const raw = inline ?? (path ? readFileSync(path, "utf8") : undefined);
    const parsed = raw ? (JSON.parse(raw) as Partial<ServiceAccount>) : null;
    this.account = parsed?.client_email && parsed.private_key ? { client_email: parsed.client_email, private_key: parsed.private_key, ...(parsed.token_uri ? { token_uri: parsed.token_uri } : {}) } : null;
    return this.account;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    if (this.offline) return {};
    return { authorization: `Bearer ${await this.accessToken()}` };
  }

  private async read<T>(url: string): Promise<T | null> {
    if (this.offline || /\/dry_/.test(url)) return null;
    try {
      return (await this.http.get<T>(url)).data;
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return null;
      throw err;
    }
  }
}

interface RawReview {
  reviewId?: string;
  comments?: { userComment?: { text?: string; starRating?: number; reviewerLanguage?: string; lastModified?: { seconds?: string | number } } }[];
}

function missingPrice(region: string): never {
  throw new Error(`Google Play returned no converted price for region ${region}`);
}
