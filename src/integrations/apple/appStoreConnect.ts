/**
 * App Store Connect API client (JSON:API, https://api.appstoreconnect.apple.com).
 *
 * Request bodies follow Apple's OpenAPI spec 4.5.1. Authentication is an ES256 team-key
 * token (ascToken) refreshed a minute before expiry. Writes are dry-run by default and
 * answered with synthetic resources whose ids start with "dry_"; reads about such ids,
 * and every read when no credentials are configured in dry-run, return nothing instead of
 * calling Apple, so a dry run works offline and still records the full write plan.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { Clock } from "../../core/ports.ts";
import type { StudioStore } from "../../core/store.ts";
import type { StudioConfig } from "../../config/schema.ts";
import { SystemClock } from "../../core/clock.ts";
import { HttpClient, HttpError, withQuery } from "../http.ts";
import type { DryRunRecorder, HttpRequest } from "../http.ts";
import { ascToken } from "./jwt.ts";
import { fromAscTerritory, toAscTerritory } from "./territories.ts";

export const ENV_VARS: readonly { name: string; purpose: string; required: boolean }[] = [
  { name: "ASC_KEY_ID", purpose: "App Store Connect team API key id (default name of secretRefs.keyId)", required: true },
  { name: "ASC_ISSUER_ID", purpose: "App Store Connect API issuer id (default name of secretRefs.issuerId)", required: true },
  { name: "ASC_PRIVATE_KEY_PATH", purpose: "Path to the AuthKey_<id>.p8 file (default name of secretRefs.privateKeyPath)", required: true },
  { name: "ASC_PRIVATE_KEY", purpose: "PEM text of the .p8 key, an alternative to the path (secretRefs.privateKey)", required: false },
];

export const ASC_BASE_URL = "https://api.appstoreconnect.apple.com";
const TOKEN_TTL_SEC = 1_140;
const TOKEN_REFRESH_MARGIN_SEC = 60;
const MAX_PAGES = 10;

export interface AscResource {
  type: string;
  id: string;
  attributes: Record<string, unknown>;
  relationships?: Record<string, { data?: { type: string; id: string } | { type: string; id: string }[] | null }>;
}

interface AscDocument {
  data?: unknown;
  included?: unknown[];
  links?: { next?: string };
}

export type ScreenshotDisplayType = "APP_IPHONE_67" | "APP_IPHONE_65" | "APP_IPHONE_61" | "APP_IPAD_PRO_3GEN_129";

export interface AscSubscriptionDef {
  productId: string;
  /** Reference name in App Store Connect (max 64 chars). */
  name: string;
  /** Customer-facing display name. */
  displayName: string;
  period: "week" | "month" | "year";
  groupLevel: number;
  reviewNote?: string;
}

export interface AscClientOptions {
  /** config and store are accepted for uniform construction with the other live clients. */
  config: StudioConfig;
  store?: StudioStore;
  env: Record<string, string | undefined>;
  dryRun: boolean;
  recorder?: DryRunRecorder;
  fetch?: typeof fetch;
  /** Env var NAMES: keyId, issuerId and privateKeyPath (or privateKey for inline PEM). */
  secretRefs: Record<string, string>;
  clock?: Clock;
  sleep?: (ms: number) => Promise<void>;
  baseUrl?: string;
}

const PERIOD: Record<AscSubscriptionDef["period"], string> = { week: "ONE_WEEK", month: "ONE_MONTH", year: "ONE_YEAR" };
const TRIAL: Record<number, string> = { 3: "THREE_DAYS", 7: "ONE_WEEK", 14: "TWO_WEEKS", 30: "ONE_MONTH", 31: "ONE_MONTH" };

/** App Store version states in which metadata and the build can still be edited. */
export const EDITABLE_VERSION_STATES = ["PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED", "INVALID_BINARY", "READY_FOR_REVIEW"];

const rel = (type: string, id: string) => ({ data: { type, id } });

function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}

function asResource(value: unknown): AscResource | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Partial<AscResource>;
  if (typeof v.id !== "string" || typeof v.type !== "string") return null;
  return { type: v.type, id: v.id, attributes: v.attributes ?? {}, ...(v.relationships ? { relationships: v.relationships } : {}) };
}

function relId(resource: AscResource, name: string): string | undefined {
  const data = resource.relationships?.[name]?.data;
  return data && !Array.isArray(data) ? data.id : undefined;
}

function priceCents(customerPrice: unknown): number {
  const n = Number(customerPrice);
  return Number.isFinite(n) ? Math.round(n * 100) : -1;
}

/** Synthetic JSON:API answer for a dry-run write. */
export function ascDryRunResponse(req: HttpRequest): unknown {
  const body = (req.json ?? {}) as { data?: { type?: string; id?: string; attributes?: Record<string, unknown> } };
  const type = body.data?.type ?? "resource";
  const id = body.data?.id ?? `dry_${type}_${shortHash(`${req.method} ${req.url} ${JSON.stringify(req.json ?? null)}`)}`;
  const attributes: Record<string, unknown> = { ...body.data?.attributes };
  if (type === "appScreenshots" && req.method === "POST") {
    attributes.uploadOperations = [
      { method: "PUT", url: `https://dry-run.invalid/asc-upload/${id}`, offset: 0, length: attributes.fileSize, requestHeaders: [{ name: "Content-Type", value: "image/png" }] },
    ];
  }
  return { data: { type, id, attributes } };
}

export class AscClient {
  private readonly http: HttpClient;
  /** Presigned upload operations must not carry the API bearer token. */
  private readonly uploads: HttpClient;
  private readonly clock: Clock;
  private readonly base: string;
  private creds: { keyId: string; issuerId: string; privateKeyPem: string } | null | undefined;
  private cachedToken: { token: string; exp: number } | null = null;

  constructor(private readonly opts: AscClientOptions) {
    this.clock = opts.clock ?? new SystemClock();
    this.base = opts.baseUrl ?? ASC_BASE_URL;
    const common = {
      service: "asc",
      dryRun: opts.dryRun,
      dryRunResponse: ascDryRunResponse,
      ...(opts.recorder ? { recorder: opts.recorder } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
    };
    this.http = new HttpClient({ ...common, defaultHeaders: () => this.authHeaders() });
    this.uploads = new HttpClient({ ...common, timeoutMs: 300_000 });
  }

  get dryRun(): boolean {
    return this.opts.dryRun;
  }

  /** Dry-run without credentials: nothing reaches Apple, reads come back empty. */
  get offline(): boolean {
    return this.opts.dryRun && this.credentials() === null;
  }

  /** A bearer token, reused until a minute before it expires. */
  token(): string {
    const creds = this.credentials();
    if (!creds) throw new Error(`App Store Connect credentials missing: set ${this.missingVars().join(", ")}`);
    const nowSec = Math.floor(this.clock.now().getTime() / 1000);
    if (this.cachedToken && nowSec < this.cachedToken.exp - TOKEN_REFRESH_MARGIN_SEC) return this.cachedToken.token;
    const token = ascToken({ ...creds, nowSec, ttlSec: TOKEN_TTL_SEC });
    this.cachedToken = { token, exp: nowSec + TOKEN_TTL_SEC };
    return token;
  }

  // -- apps and bundle ids ---------------------------------------------------------

  async findAppByBundleId(bundleId: string): Promise<AscResource | null> {
    const apps = await this.list("/v1/apps", { "filter[bundleId]": bundleId, limit: 10 });
    return apps.find((a) => a.attributes.bundleId === bundleId) ?? null;
  }

  async getApp(appId: string): Promise<AscResource | null> {
    return this.one(`/v1/apps/${appId}`);
  }

  async findBundleId(identifier: string): Promise<AscResource | null> {
    const ids = await this.list("/v1/bundleIds", { "filter[identifier]": identifier, limit: 10 });
    return ids.find((b) => b.attributes.identifier === identifier) ?? null;
  }

  /** Register (or reuse) a bundle id and enable any missing capabilities. */
  async registerBundleId(req: { identifier: string; name: string; platform?: "IOS" | "UNIVERSAL"; capabilities: string[] }): Promise<{ id: string; enabled: string[] }> {
    const existing = await this.findBundleId(req.identifier);
    const bundle =
      existing ??
      (await this.create("/v1/bundleIds", {
        data: { type: "bundleIds", attributes: { identifier: req.identifier, name: sanitizeBundleName(req.name), platform: req.platform ?? "IOS" } },
      }));
    const have = new Set(existing ? (await this.list(`/v1/bundleIds/${bundle.id}/bundleIdCapabilities`)).map((c) => String(c.attributes.capabilityType)) : []);
    const enabled: string[] = [];
    for (const capability of req.capabilities) {
      if (have.has(capability)) continue;
      await this.enableCapability(bundle.id, capability);
      enabled.push(capability);
    }
    return { id: bundle.id, enabled };
  }

  async enableCapability(bundleIdResourceId: string, capabilityType: string): Promise<AscResource> {
    return this.create("/v1/bundleIdCapabilities", {
      data: { type: "bundleIdCapabilities", attributes: { capabilityType }, relationships: { bundleId: rel("bundleIds", bundleIdResourceId) } },
    });
  }

  // -- app info (name, subtitle, privacy policy) -------------------------------------

  /** The app info record that is still editable (the one not yet live), else the only one. */
  async getAppInfo(appId: string): Promise<AscResource | null> {
    const infos = await this.list(`/v1/apps/${appId}/appInfos`, { limit: 10 });
    return infos.find((i) => !["READY_FOR_DISTRIBUTION", "REPLACED_WITH_NEW_INFO"].includes(String(i.attributes.state))) ?? infos[0] ?? null;
  }

  async upsertAppInfoLocalization(appInfoId: string, locale: string, attributes: { name?: string; subtitle?: string; privacyPolicyUrl?: string }): Promise<AscResource> {
    const existing = (await this.list(`/v1/appInfos/${appInfoId}/appInfoLocalizations`, { "filter[locale]": locale })).find((l) => l.attributes.locale === locale);
    if (existing) return this.update("/v1/appInfoLocalizations", { type: "appInfoLocalizations", id: existing.id, attributes });
    return this.create("/v1/appInfoLocalizations", {
      data: { type: "appInfoLocalizations", attributes: { locale, ...attributes, name: attributes.name ?? "" }, relationships: { appInfo: rel("appInfos", appInfoId) } },
    });
  }

  // -- versions ----------------------------------------------------------------------

  async findVersions(appId: string, states: string[]): Promise<AscResource[]> {
    return this.list(`/v1/apps/${appId}/appStoreVersions`, { "filter[platform]": "IOS", "filter[appVersionState]": states.join(","), limit: 10 });
  }

  async latestVersion(appId: string): Promise<AscResource | null> {
    const versions = await this.list(`/v1/apps/${appId}/appStoreVersions`, { "filter[platform]": "IOS", limit: 5 }, 1);
    return versions.sort((a, b) => String(b.attributes.createdDate ?? "").localeCompare(String(a.attributes.createdDate ?? "")))[0] ?? null;
  }

  async getVersion(versionId: string): Promise<AscResource | null> {
    return this.one(`/v1/appStoreVersions/${versionId}`);
  }

  async createVersion(appId: string, versionString: string): Promise<AscResource> {
    return this.create("/v1/appStoreVersions", {
      data: { type: "appStoreVersions", attributes: { platform: "IOS", versionString, releaseType: "MANUAL" }, relationships: { app: rel("apps", appId) } },
    });
  }

  /** The editable version, renamed to `versionString` if needed, or a new one. */
  async ensureEditableVersion(appId: string, versionString: string): Promise<AscResource> {
    const editable = (await this.findVersions(appId, EDITABLE_VERSION_STATES))[0];
    if (!editable) return this.createVersion(appId, versionString);
    if (editable.attributes.versionString === versionString) return editable;
    return this.updateVersion(editable.id, { versionString });
  }

  async updateVersion(versionId: string, attributes: { versionString?: string; releaseType?: "MANUAL" | "AFTER_APPROVAL" | "SCHEDULED"; copyright?: string }): Promise<AscResource> {
    return this.update("/v1/appStoreVersions", { type: "appStoreVersions", id: versionId, attributes });
  }

  async upsertVersionLocalization(
    versionId: string,
    locale: string,
    attributes: { description?: string; keywords?: string; promotionalText?: string; supportUrl?: string; marketingUrl?: string; whatsNew?: string },
  ): Promise<AscResource> {
    const existing = (await this.list(`/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations`, { "filter[locale]": locale })).find(
      (l) => l.attributes.locale === locale,
    );
    if (existing) return this.update("/v1/appStoreVersionLocalizations", { type: "appStoreVersionLocalizations", id: existing.id, attributes });
    return this.create("/v1/appStoreVersionLocalizations", {
      data: { type: "appStoreVersionLocalizations", attributes: { locale, ...attributes }, relationships: { appStoreVersion: rel("appStoreVersions", versionId) } },
    });
  }

  async attachBuild(versionId: string, buildId: string): Promise<void> {
    await this.http.request({ method: "PATCH", url: `${this.base}/v1/appStoreVersions/${versionId}/relationships/build`, json: { data: { type: "builds", id: buildId } } });
  }

  async upsertReviewDetail(versionId: string, attributes: { notes?: string; contactEmail?: string; contactFirstName?: string; contactLastName?: string; contactPhone?: string; demoAccountRequired?: boolean }): Promise<AscResource> {
    const existing = await this.one(`/v1/appStoreVersions/${versionId}/appStoreReviewDetail`);
    if (existing) return this.update("/v1/appStoreReviewDetails", { type: "appStoreReviewDetails", id: existing.id, attributes });
    return this.create("/v1/appStoreReviewDetails", {
      data: { type: "appStoreReviewDetails", attributes, relationships: { appStoreVersion: rel("appStoreVersions", versionId) } },
    });
  }

  // -- screenshots -------------------------------------------------------------------

  async ensureScreenshotSet(localizationId: string, displayType: ScreenshotDisplayType): Promise<AscResource> {
    const sets = await this.list(`/v1/appStoreVersionLocalizations/${localizationId}/appScreenshotSets`, { "filter[screenshotDisplayType]": displayType });
    const existing = sets.find((s) => s.attributes.screenshotDisplayType === displayType);
    if (existing) return existing;
    return this.create("/v1/appScreenshotSets", {
      data: {
        type: "appScreenshotSets",
        attributes: { screenshotDisplayType: displayType },
        relationships: { appStoreVersionLocalization: rel("appStoreVersionLocalizations", localizationId) },
      },
    });
  }

  /** Reserve → PUT each upload operation with Apple's headers → commit with the MD5 checksum. */
  async uploadScreenshot(setId: string, filePath: string): Promise<AscResource> {
    const fileSize = statSync(filePath).size;
    const reservation = await this.create("/v1/appScreenshots", {
      data: { type: "appScreenshots", attributes: { fileName: basename(filePath), fileSize }, relationships: { appScreenshotSet: rel("appScreenshotSets", setId) } },
    });
    const ops = Array.isArray(reservation.attributes.uploadOperations) ? (reservation.attributes.uploadOperations as UploadOperation[]) : [];
    for (const op of ops) {
      const headers: Record<string, string> = {};
      for (const h of op.requestHeaders ?? []) headers[h.name] = h.value;
      await this.uploads.upload({
        method: (op.method ?? "PUT").toUpperCase() as "PUT" | "POST" | "PATCH",
        url: op.url,
        headers,
        file: { path: filePath, offset: op.offset ?? 0, length: op.length ?? fileSize },
      });
    }
    const checksum = createHash("md5").update(readFileSync(filePath)).digest("hex");
    return this.update("/v1/appScreenshots", { type: "appScreenshots", id: reservation.id, attributes: { uploaded: true, sourceFileChecksum: checksum } });
  }

  /** Replace every screenshot of one display type on a version localization. */
  async replaceScreenshots(localizationId: string, paths: string[], displayType: ScreenshotDisplayType = "APP_IPHONE_67"): Promise<string[]> {
    const set = await this.ensureScreenshotSet(localizationId, displayType);
    for (const old of await this.list(`/v1/appScreenshotSets/${set.id}/appScreenshots`)) await this.remove(`/v1/appScreenshots/${old.id}`);
    const ids: string[] = [];
    for (const path of paths) ids.push((await this.uploadScreenshot(set.id, path)).id);
    return ids;
  }

  async getScreenshot(id: string): Promise<AscResource | null> {
    return this.one(`/v1/appScreenshots/${id}`);
  }

  // -- availability ------------------------------------------------------------------

  async getAppAvailability(appId: string): Promise<AscResource | null> {
    return this.one(`/v1/apps/${appId}/appAvailabilityV2`);
  }

  /** Alpha-2 codes of the territories where the app is currently available. */
  async availableTerritories(appId: string): Promise<string[] | null> {
    const availability = await this.getAppAvailability(appId);
    if (!availability) return null;
    const rows = await this.list(`/v2/appAvailabilities/${availability.id}/territoryAvailabilities`, { include: "territory", limit: 200 });
    return rows.filter((r) => r.attributes.available === true).map((r) => fromAscTerritory(relId(r, "territory") ?? "")).sort();
  }

  /**
   * Make the app available in exactly `territories` (alpha-2). An empty list removes the
   * app from sale everywhere.
   */
  async setTerritories(appId: string, territories: string[]): Promise<void> {
    const wanted = new Set(territories.map(toAscTerritory));
    const availability = await this.getAppAvailability(appId);
    if (!availability) {
      const known = (await this.list("/v1/territories", { limit: 200 })).map((t) => t.id);
      const all = [...new Set([...known, ...wanted])].sort();
      const included = all.map((t) => ({
        type: "territoryAvailabilities",
        id: `\${ta-${t}}`,
        attributes: { available: wanted.has(t) },
        relationships: { territory: rel("territories", t) },
      }));
      await this.create("/v2/appAvailabilities", {
        data: {
          type: "appAvailabilities",
          attributes: { availableInNewTerritories: false },
          relationships: { app: rel("apps", appId), territoryAvailabilities: { data: included.map((i) => ({ type: i.type, id: i.id })) } },
        },
        included,
      });
      return;
    }
    const rows = await this.list(`/v2/appAvailabilities/${availability.id}/territoryAvailabilities`, { include: "territory", limit: 200 });
    for (const row of rows) {
      const available = wanted.has(relId(row, "territory") ?? "");
      if (row.attributes.available === available) continue;
      await this.update("/v1/territoryAvailabilities", { type: "territoryAvailabilities", id: row.id, attributes: { available } });
    }
  }

  // -- subscriptions -----------------------------------------------------------------

  async ensureSubscriptionGroup(appId: string, referenceName: string, localization?: { locale: string; name: string }): Promise<AscResource> {
    const groups = await this.list(`/v1/apps/${appId}/subscriptionGroups`, { "filter[referenceName]": referenceName });
    const group =
      groups.find((g) => g.attributes.referenceName === referenceName) ??
      (await this.create("/v1/subscriptionGroups", { data: { type: "subscriptionGroups", attributes: { referenceName }, relationships: { app: rel("apps", appId) } } }));
    if (localization) {
      const locs = await this.list(`/v1/subscriptionGroups/${group.id}/subscriptionGroupLocalizations`);
      if (!locs.some((l) => l.attributes.locale === localization.locale)) {
        await this.create("/v1/subscriptionGroupLocalizations", {
          data: {
            type: "subscriptionGroupLocalizations",
            attributes: { locale: localization.locale, name: localization.name },
            relationships: { subscriptionGroup: rel("subscriptionGroups", group.id) },
          },
        });
      }
    }
    return group;
  }

  async ensureSubscription(groupId: string, def: AscSubscriptionDef, locale: string): Promise<{ subscription: AscResource; created: boolean }> {
    const found = (await this.list(`/v1/subscriptionGroups/${groupId}/subscriptions`, { "filter[productId]": def.productId })).find(
      (s) => s.attributes.productId === def.productId,
    );
    const subscription =
      found ??
      (await this.create("/v1/subscriptions", {
        data: {
          type: "subscriptions",
          attributes: {
            name: def.name.slice(0, 64),
            productId: def.productId,
            subscriptionPeriod: PERIOD[def.period],
            groupLevel: def.groupLevel,
            familySharable: false,
            ...(def.reviewNote ? { reviewNote: def.reviewNote } : {}),
          },
          relationships: { group: rel("subscriptionGroups", groupId) },
        },
      }));
    const locs = found ? await this.list(`/v1/subscriptions/${subscription.id}/subscriptionLocalizations`) : [];
    if (!locs.some((l) => l.attributes.locale === locale)) {
      await this.create("/v1/subscriptionLocalizations", {
        data: { type: "subscriptionLocalizations", attributes: { locale, name: def.displayName }, relationships: { subscription: rel("subscriptions", subscription.id) } },
      });
    }
    return { subscription, created: !found };
  }

  async getSubscription(id: string): Promise<AscResource | null> {
    return this.one(`/v1/subscriptions/${id}`);
  }

  /** Whether any price is scheduled; re-pricing a live subscription would move subscribers. */
  async subscriptionHasPrices(id: string): Promise<boolean> {
    return (await this.list(`/v1/subscriptions/${id}/prices`, { limit: 1 }, 1)).length > 0;
  }

  async subscriptionHasAvailability(id: string): Promise<boolean> {
    return (await this.list(`/v1/subscriptions/${id}/planAvailabilities`, { limit: 1 }, 1)).length > 0;
  }

  /** The price point in `territory` (alpha-3) whose customer price is exactly `cents`. */
  async findPricePoint(subscriptionId: string, territory: string, cents: number): Promise<AscResource | null> {
    const points = await this.list(`/v1/subscriptions/${subscriptionId}/pricePoints`, { "filter[territory]": territory, limit: 200 });
    return points.find((p) => priceCents(p.attributes.customerPrice) === cents) ?? null;
  }

  /**
   * Price the subscription at `usdCents` in the US and at Apple's equalized price in each
   * other territory (alpha-2 codes).
   */
  async setSubscriptionPrices(subscriptionId: string, usdCents: number, territories: string[]): Promise<number> {
    const usPoint = await this.findPricePoint(subscriptionId, "USA", usdCents);
    if (!usPoint && !this.opts.dryRun) throw new Error(`No App Store price point at ${(usdCents / 100).toFixed(2)} USD for subscription ${subscriptionId}`);
    const usPointId = usPoint?.id ?? `dry_subscriptionPricePoints_USA_${usdCents}`;
    const others = [...new Set(territories.map(toAscTerritory))].filter((t) => t !== "USA");
    const byTerritory = new Map<string, string>([["USA", usPointId]]);
    if (others.length > 0) {
      const equalized = await this.list(`/v1/subscriptionPricePoints/${usPointId}/equalizations`, {
        "filter[territory]": others.join(","),
        include: "territory",
        limit: 200,
      });
      for (const point of equalized) {
        const t = relId(point, "territory");
        if (t) byTerritory.set(t, point.id);
      }
      for (const t of others) {
        if (byTerritory.has(t)) continue;
        if (!this.opts.dryRun) throw new Error(`No equalized App Store price point for ${t}`);
        byTerritory.set(t, `dry_subscriptionPricePoints_${t}_${usdCents}`);
      }
    }
    for (const [territory, pointId] of byTerritory) {
      await this.create("/v1/subscriptionPrices", {
        data: {
          type: "subscriptionPrices",
          attributes: { preserveCurrentPrice: false },
          relationships: {
            subscription: rel("subscriptions", subscriptionId),
            territory: rel("territories", territory),
            subscriptionPricePoint: rel("subscriptionPricePoints", pointId),
          },
        },
      });
    }
    return byTerritory.size;
  }

  async setSubscriptionAvailability(subscriptionId: string, territories: string[]): Promise<AscResource> {
    return this.create("/v1/subscriptionPlanAvailabilities", {
      data: {
        type: "subscriptionPlanAvailabilities",
        attributes: { availableInNewTerritories: false, planType: "UPFRONT" },
        relationships: {
          subscription: rel("subscriptions", subscriptionId),
          availableTerritories: { data: [...new Set(territories.map(toAscTerritory))].map((t) => ({ type: "territories", id: t })) },
        },
      },
    });
  }

  /** A one-period FREE_TRIAL introductory offer in each territory that lacks one. */
  async ensureFreeTrial(subscriptionId: string, trialDays: number, territories: string[]): Promise<number> {
    const duration = TRIAL[trialDays];
    if (!duration) throw new Error(`Unsupported App Store free-trial length: ${trialDays} days`);
    const existing = new Set(
      (await this.list(`/v1/subscriptions/${subscriptionId}/introductoryOffers`, { include: "territory", limit: 200 })).map((o) => relId(o, "territory")),
    );
    let created = 0;
    for (const territory of [...new Set(territories.map(toAscTerritory))]) {
      if (existing.has(territory)) continue;
      await this.create("/v1/subscriptionIntroductoryOffers", {
        data: {
          type: "subscriptionIntroductoryOffers",
          attributes: { duration, offerMode: "FREE_TRIAL", numberOfPeriods: 1 },
          relationships: { subscription: rel("subscriptions", subscriptionId), territory: rel("territories", territory) },
        },
      });
      created++;
    }
    return created;
  }

  // -- builds, review, release -------------------------------------------------------

  /** The newest build of `version` (CFBundleVersion), optionally of one marketing version. */
  async findBuild(appId: string, req: { version: string; shortVersion?: string }): Promise<AscResource | null> {
    const builds = await this.list("/v1/builds", {
      "filter[app]": appId,
      "filter[version]": req.version,
      "filter[preReleaseVersion.version]": req.shortVersion,
      "filter[preReleaseVersion.platform]": "IOS",
      sort: "-uploadedDate",
      limit: 5,
    });
    return builds[0] ?? null;
  }

  async getBuild(buildId: string): Promise<AscResource | null> {
    return this.one(`/v1/builds/${buildId}`);
  }

  /** reviewSubmissions: reuse an unsent submission or create one, add the version, submit. */
  async submitForReview(appId: string, versionId: string): Promise<string> {
    const open = (await this.list(`/v1/apps/${appId}/reviewSubmissions`, { "filter[platform]": "IOS", "filter[state]": "READY_FOR_REVIEW", limit: 5 }))[0];
    const submission =
      open ??
      (await this.create("/v1/reviewSubmissions", { data: { type: "reviewSubmissions", attributes: { platform: "IOS" }, relationships: { app: rel("apps", appId) } } }));
    try {
      await this.create("/v1/reviewSubmissionItems", {
        data: {
          type: "reviewSubmissionItems",
          relationships: { reviewSubmission: rel("reviewSubmissions", submission.id), appStoreVersion: rel("appStoreVersions", versionId) },
        },
      });
    } catch (err) {
      // 409: the version is already an item of this submission.
      if (!(err instanceof HttpError && err.status === 409)) throw err;
    }
    await this.update("/v1/reviewSubmissions", { type: "reviewSubmissions", id: submission.id, attributes: { submitted: true } });
    return submission.id;
  }

  async getReviewSubmission(id: string): Promise<AscResource | null> {
    return this.one(`/v1/reviewSubmissions/${id}`);
  }

  /** Release an approved version that waits for manual release. */
  async requestRelease(versionId: string): Promise<void> {
    await this.create("/v1/appStoreVersionReleaseRequests", {
      data: { type: "appStoreVersionReleaseRequests", relationships: { appStoreVersion: rel("appStoreVersions", versionId) } },
    });
  }

  /** Seven-day phased release for automatic updates. */
  async enablePhasedRelease(versionId: string): Promise<AscResource> {
    const existing = await this.one(`/v1/appStoreVersions/${versionId}/appStoreVersionPhasedRelease`);
    if (existing) return this.update("/v1/appStoreVersionPhasedReleases", { type: "appStoreVersionPhasedReleases", id: existing.id, attributes: { phasedReleaseState: "ACTIVE" } });
    return this.create("/v1/appStoreVersionPhasedReleases", {
      data: { type: "appStoreVersionPhasedReleases", attributes: { phasedReleaseState: "ACTIVE" }, relationships: { appStoreVersion: rel("appStoreVersions", versionId) } },
    });
  }

  /** Ratings since `since` (ISO date or timestamp), newest first. */
  async customerReviews(appId: string, since: string): Promise<{ id: string; rating: number; territory: string; createdDate: string; title: string; body: string }[]> {
    const out: { id: string; rating: number; territory: string; createdDate: string; title: string; body: string }[] = [];
    let url: string | undefined = withQuery(`${this.base}/v1/apps/${appId}/customerReviews`, { sort: "-createdDate", limit: 200 });
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const doc = await this.readUrl(url);
      if (!doc) break;
      const rows = (Array.isArray(doc.data) ? doc.data : []).map(asResource).filter((r): r is AscResource => r !== null);
      for (const r of rows) {
        const createdDate = String(r.attributes.createdDate ?? "");
        if (createdDate < since) return out;
        out.push({
          id: r.id,
          rating: Number(r.attributes.rating),
          territory: fromAscTerritory(String(r.attributes.territory ?? "")),
          createdDate,
          title: String(r.attributes.title ?? ""),
          body: String(r.attributes.body ?? ""),
        });
      }
      url = doc.links?.next;
    }
    return out;
  }

  // -- transport -----------------------------------------------------------------------

  private credentials(): { keyId: string; issuerId: string; privateKeyPem: string } | null {
    if (this.creds !== undefined) return this.creds;
    const { env, secretRefs } = this.opts;
    const keyId = secretRefs.keyId ? env[secretRefs.keyId] : undefined;
    const issuerId = secretRefs.issuerId ? env[secretRefs.issuerId] : undefined;
    const keyPath = secretRefs.privateKeyPath ? env[secretRefs.privateKeyPath] : undefined;
    const inline = secretRefs.privateKey ? env[secretRefs.privateKey]?.replace(/\\n/g, "\n") : undefined;
    const privateKeyPem = inline ?? (keyPath ? readFileSync(keyPath, "utf8") : undefined);
    this.creds = keyId && issuerId && privateKeyPem ? { keyId, issuerId, privateKeyPem } : null;
    return this.creds;
  }

  private missingVars(): string[] {
    const { env, secretRefs: refs } = this.opts;
    const names = [refs.keyId ?? "ASC_KEY_ID", refs.issuerId ?? "ASC_ISSUER_ID"];
    if (!(refs.privateKey && env[refs.privateKey])) names.push(refs.privateKeyPath ?? "ASC_PRIVATE_KEY_PATH");
    return names.filter((n) => !env[n]);
  }

  private authHeaders(): Record<string, string> {
    if (this.offline) return {};
    return { authorization: `Bearer ${this.token()}` };
  }

  private skipRead(url: string): boolean {
    return this.offline || /(^|[/=,])dry_/.test(decodeURIComponent(url));
  }

  private async readUrl(url: string): Promise<AscDocument | null> {
    if (this.skipRead(url)) return null;
    try {
      return (await this.http.get<AscDocument>(url)).data;
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return null;
      throw err;
    }
  }

  private async one(path: string, query: Record<string, string | number | undefined> = {}): Promise<AscResource | null> {
    const doc = await this.readUrl(withQuery(`${this.base}${path}`, query));
    const data = doc?.data;
    return asResource(Array.isArray(data) ? data[0] : data);
  }

  /** Every resource of a collection, following `links.next`; included resources are ignored. */
  private async list(path: string, query: Record<string, string | number | undefined> = {}, maxPages = MAX_PAGES): Promise<AscResource[]> {
    const out: AscResource[] = [];
    let url: string | undefined = withQuery(`${this.base}${path}`, query);
    for (let page = 0; url && page < maxPages; page++) {
      const doc = await this.readUrl(url);
      if (!doc) break;
      const data = Array.isArray(doc.data) ? doc.data : doc.data ? [doc.data] : [];
      for (const item of data) {
        const r = asResource(item);
        if (r) out.push(r);
      }
      url = doc.links?.next;
    }
    return out;
  }

  private async create(path: string, body: unknown): Promise<AscResource> {
    const res = await this.http.request<AscDocument>({ method: "POST", url: `${this.base}${path}`, json: body });
    const resource = asResource(res.data?.data);
    if (!resource) throw new Error(`asc POST ${path}: response has no resource`);
    return resource;
  }

  private async update(path: string, data: { type: string; id: string; attributes: Record<string, unknown> }): Promise<AscResource> {
    const res = await this.http.request<AscDocument>({ method: "PATCH", url: `${this.base}${path}/${data.id}`, json: { data } });
    return asResource(res.data?.data) ?? { type: data.type, id: data.id, attributes: data.attributes };
  }

  private async remove(path: string): Promise<void> {
    await this.http.request({ method: "DELETE", url: `${this.base}${path}` });
  }
}

interface UploadOperation {
  method?: string;
  url: string;
  offset?: number;
  length?: number;
  requestHeaders?: { name: string; value: string }[];
}

/** Bundle id names allow letters, digits and spaces only. */
export function sanitizeBundleName(name: string): string {
  const clean = name.replace(/[^A-Za-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  return (clean || "App").slice(0, 60);
}
