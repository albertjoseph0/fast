/**
 * RevenueCat REST API v2 (https://api.revenuecat.com/v2) and the live MonetizationWrite.
 *
 * configure() is find-or-create at every step (apps, products, entitlement, the "default"
 * offering, one package per price-ladder entry), so re-running it after a partial failure
 * only adds what is missing. Store products must already exist in App Store Connect and
 * Google Play; RevenueCat only references them by store identifier.
 *
 * Writes are dry-run by default and answered with synthetic objects whose ids start with
 * "dry_"; in dry-run without a key, reads return empty lists instead of calling RevenueCat.
 */
import { createHash } from "node:crypto";
import type { MonetizationWrite } from "../../core/ports.ts";
import type { StudioStore } from "../../core/store.ts";
import type { StudioConfig } from "../../config/schema.ts";
import type { StoreProduct, StorePlatform, VentureBindings } from "../../core/types.ts";
import { HttpClient, MissingBindingError, withQuery } from "../http.ts";
import type { DryRunRecorder, HttpRequest } from "../http.ts";

export const ENV_VARS: readonly { name: string; purpose: string; required: boolean }[] = [
  {
    name: "RC_SECRET_KEY",
    purpose: "RevenueCat REST API v2 secret key (project_configuration read_write, charts_metrics overview read)",
    required: true,
  },
];

export const RC_BASE_URL = "https://api.revenuecat.com/v2";
/** Offering every app renders (the SDK's `current` offering). */
export const DEFAULT_OFFERING = "default";

export interface RcApp {
  id: string;
  name: string;
  type: string;
  app_store?: { bundle_id?: string };
  play_store?: { package_name?: string };
}

export interface RcProduct {
  id: string;
  store_identifier: string;
  app_id: string;
  type: string;
}

export interface RcEntitlement {
  id: string;
  lookup_key: string;
  products?: { items: RcProduct[] };
}

export interface RcOffering {
  id: string;
  lookup_key: string;
  is_current?: boolean;
}

export interface RcPackage {
  id: string;
  lookup_key: string;
  products?: { items: { product: RcProduct }[] };
}

export interface RcOverviewMetric {
  id: string;
  name: string;
  unit: string;
  period: string;
  value: number;
}

interface RcList<T> {
  items: T[];
  next_page?: string | null;
}

export interface RevenueCatOptions {
  config: StudioConfig;
  store: StudioStore;
  env: Record<string, string | undefined>;
  dryRun: boolean;
  recorder?: DryRunRecorder;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  baseUrl?: string;
}

const APP_TYPE: Record<StorePlatform, "app_store" | "play_store"> = { ios: "app_store", android: "play_store" };

/** Synthetic RevenueCat object for a dry-run write: the request body echoed back with a "dry_" id. */
export function rcDryRunResponse(req: HttpRequest): unknown {
  const hash = createHash("sha256").update(`${req.url} ${JSON.stringify(req.json ?? null)}`).digest("hex").slice(0, 12);
  const body = req.json && typeof req.json === "object" ? (req.json as Record<string, unknown>) : {};
  return { ...body, id: `dry_rc_${hash}`, dryRun: true };
}

/** Google Play base plan id from a ladder id; mirrors the Play adapter ("week_699_t3" → "week-699-t3"). */
export function playBasePlanId(ladderId: string): string {
  const id = ladderId.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return (/^[a-z]/.test(id) ? id : `p-${id}`).slice(0, 63);
}

/** RevenueCat store_identifier: the App Store product id, or Play's `productId:basePlanId`. */
export function storeIdentifier(product: StoreProduct): string {
  return product.platform === "ios" ? product.productId : `${product.productId}:${playBasePlanId(product.ladderId)}`;
}

export class RevenueCatClient {
  private readonly http: HttpClient;
  private readonly base: string;

  constructor(private readonly opts: RevenueCatOptions) {
    this.base = opts.baseUrl ?? RC_BASE_URL;
    this.http = new HttpClient({
      service: "revenuecat",
      dryRun: opts.dryRun,
      dryRunResponse: rcDryRunResponse,
      defaultHeaders: () => this.authHeaders(),
      ...(opts.recorder ? { recorder: opts.recorder } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
    });
  }

  /** Dry-run without a key: nothing reaches RevenueCat and reads come back empty. */
  get offline(): boolean {
    return this.opts.dryRun && !this.opts.env.RC_SECRET_KEY;
  }

  private authHeaders(): Record<string, string> {
    const key = this.opts.env.RC_SECRET_KEY;
    if (!key) {
      if (this.opts.dryRun) return {};
      throw new Error("revenuecat: RC_SECRET_KEY is not set");
    }
    return { authorization: `Bearer ${key}` };
  }

  private url(path: string, query: Record<string, string | number | undefined> = {}): string {
    return withQuery(`${this.base}${path}`, query);
  }

  /** Every page of a list endpoint (RevenueCat paginates forward with next_page). */
  async list<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T[]> {
    if (this.offline) return [];
    const out: T[] = [];
    let next: string | null = this.url(path, { limit: 100, ...query });
    while (next) {
      const res: { data: RcList<T> } = await this.http.get<RcList<T>>(next);
      out.push(...(res.data.items ?? []));
      next = res.data.next_page ? new URL(res.data.next_page, this.base).toString() : null;
    }
    return out;
  }

  private async create<T>(path: string, body: unknown): Promise<T> {
    return (await this.http.post<T>(this.url(path), body)).data;
  }

  listApps(projectId: string): Promise<RcApp[]> {
    return this.list<RcApp>(`/projects/${enc(projectId)}/apps`);
  }

  createApp(projectId: string, req: { name: string; platform: StorePlatform; storeId: string }): Promise<RcApp> {
    const type = APP_TYPE[req.platform];
    const details = req.platform === "ios" ? { bundle_id: req.storeId } : { package_name: req.storeId };
    return this.create<RcApp>(`/projects/${enc(projectId)}/apps`, { name: req.name, type, [type]: details });
  }

  listProducts(projectId: string, appId?: string): Promise<RcProduct[]> {
    return this.list<RcProduct>(`/projects/${enc(projectId)}/products`, { app_id: appId });
  }

  createProduct(projectId: string, req: { appId: string; storeIdentifier: string; displayName: string }): Promise<RcProduct> {
    return this.create<RcProduct>(`/projects/${enc(projectId)}/products`, {
      store_identifier: req.storeIdentifier,
      app_id: req.appId,
      type: "subscription",
      display_name: req.displayName,
    });
  }

  listEntitlements(projectId: string): Promise<RcEntitlement[]> {
    return this.list<RcEntitlement>(`/projects/${enc(projectId)}/entitlements`, { expand: "items.product" });
  }

  createEntitlement(projectId: string, lookupKey: string): Promise<RcEntitlement> {
    return this.create<RcEntitlement>(`/projects/${enc(projectId)}/entitlements`, { lookup_key: lookupKey, display_name: lookupKey });
  }

  async attachEntitlementProducts(projectId: string, entitlementId: string, productIds: string[]): Promise<void> {
    for (const chunk of chunks(productIds, 50)) {
      await this.http.post(this.url(`/projects/${enc(projectId)}/entitlements/${enc(entitlementId)}/actions/attach_products`), { product_ids: chunk });
    }
  }

  listOfferings(projectId: string): Promise<RcOffering[]> {
    return this.list<RcOffering>(`/projects/${enc(projectId)}/offerings`);
  }

  createOffering(projectId: string, lookupKey: string, displayName: string): Promise<RcOffering> {
    return this.create<RcOffering>(`/projects/${enc(projectId)}/offerings`, { lookup_key: lookupKey, display_name: displayName });
  }

  async makeCurrent(projectId: string, offeringId: string): Promise<void> {
    await this.http.post(this.url(`/projects/${enc(projectId)}/offerings/${enc(offeringId)}`), { is_current: true });
  }

  listPackages(projectId: string, offeringId: string): Promise<RcPackage[]> {
    if (offeringId.startsWith("dry_")) return Promise.resolve([]);
    return this.list<RcPackage>(`/projects/${enc(projectId)}/offerings/${enc(offeringId)}/packages`, { expand: "items.product" });
  }

  createPackage(projectId: string, offeringId: string, req: { lookupKey: string; displayName: string; position: number }): Promise<RcPackage> {
    return this.create<RcPackage>(`/projects/${enc(projectId)}/offerings/${enc(offeringId)}/packages`, {
      lookup_key: req.lookupKey,
      display_name: req.displayName,
      position: req.position,
    });
  }

  async attachPackageProducts(projectId: string, packageId: string, productIds: string[]): Promise<void> {
    const products = productIds.map((product_id) => ({ product_id, eligibility_criteria: "all" }));
    for (const chunk of chunks(products, 50)) {
      await this.http.post(this.url(`/projects/${enc(projectId)}/packages/${enc(packageId)}/actions/attach_products`), { products: chunk });
    }
  }

  /** Charts & Metrics overview (active trials, active subscriptions, MRR, revenue, new customers, ...). */
  async overviewMetrics(projectId: string, currency = "USD"): Promise<RcOverviewMetric[]> {
    if (this.offline) return [];
    const res = await this.http.get<{ metrics?: RcOverviewMetric[] }>(this.url(`/projects/${enc(projectId)}/metrics/overview`, { currency }));
    return res.data.metrics ?? [];
  }
}

export interface RevenueOverview {
  /** Overview metric value by metric id (e.g. mrr, revenue, active_trials, active_subscriptions). */
  values: Record<string, number>;
  /** Integer cents for metrics whose unit is "$". */
  cents: Record<string, number>;
}

/** Live MonetizationWrite on RevenueCat. */
export class LiveMonetizationWrite implements MonetizationWrite {
  readonly kind = "live" as const;
  readonly client: RevenueCatClient;

  constructor(opts: RevenueCatOptions) {
    this.client = new RevenueCatClient(opts);
  }

  async configure(req: { bindings: VentureBindings; productIds: string[]; entitlementId: string }): Promise<{ offeringIds: Record<string, string> }> {
    const { bindings } = req;
    const projectId = bindings.revenueCatProjectId;
    if (!projectId) throw new MissingBindingError("revenuecat", "revenueCatProjectId", bindings.bundleId);
    const wanted = new Set(req.productIds);
    const products = bindings.products.filter((p) => wanted.has(p.productId));
    const known = new Set(products.map((p) => p.productId));
    const unknown = req.productIds.filter((id) => !known.has(id));
    if (unknown.length) throw new Error(`revenuecat: products not bound to the venture: ${unknown.join(", ")}`);

    const c = this.client;
    const apps = await c.listApps(projectId);
    const rcProductIds = new Map<StoreProduct, string>();
    for (const platform of bindings.platforms) {
      const mine = products.filter((p) => p.platform === platform);
      if (!mine.length) continue;
      const app = await this.ensureApp(projectId, bindings, platform, apps);
      const existing = await c.listProducts(projectId, app.id);
      for (const p of mine) {
        const ident = storeIdentifier(p);
        const found = existing.find((x) => x.store_identifier === ident && x.app_id === app.id);
        const product = found ?? (await c.createProduct(projectId, { appId: app.id, storeIdentifier: ident, displayName: p.ladderId }));
        rcProductIds.set(p, product.id);
      }
    }

    const entitlements = await c.listEntitlements(projectId);
    const entitlement = entitlements.find((e) => e.lookup_key === req.entitlementId) ?? (await c.createEntitlement(projectId, req.entitlementId));
    const attached = new Set((entitlement.products?.items ?? []).map((p) => p.id));
    const toAttach = [...rcProductIds.values()].filter((id) => !attached.has(id));
    if (toAttach.length) await c.attachEntitlementProducts(projectId, entitlement.id, toAttach);

    const offerings = await c.listOfferings(projectId);
    const offering = offerings.find((o) => o.lookup_key === DEFAULT_OFFERING) ?? (await c.createOffering(projectId, DEFAULT_OFFERING, "Default"));
    if (!offering.is_current) await c.makeCurrent(projectId, offering.id);
    const packages = await c.listPackages(projectId, offering.id);
    const ladderIds = [...new Set(products.map((p) => p.ladderId))];
    for (const [i, ladderId] of ladderIds.entries()) {
      const pkg = packages.find((p) => p.lookup_key === ladderId) ?? (await c.createPackage(projectId, offering.id, { lookupKey: ladderId, displayName: ladderId, position: i + 1 }));
      const inPackage = new Set((pkg.products?.items ?? []).map((x) => x.product.id));
      const ids = products.filter((p) => p.ladderId === ladderId).map((p) => rcProductIds.get(p) as string);
      const missing = ids.filter((id) => !inPackage.has(id));
      if (missing.length) await c.attachPackageProducts(projectId, pkg.id, missing);
    }
    return { offeringIds: { [DEFAULT_OFFERING]: offering.id } };
  }

  /** Overview metrics for a RevenueCat project, with "$" metrics also in integer cents. */
  async revenueOverview(projectId: string): Promise<RevenueOverview> {
    const metrics = await this.client.overviewMetrics(projectId);
    const out: RevenueOverview = { values: {}, cents: {} };
    for (const m of metrics) {
      out.values[m.id] = m.value;
      if (m.unit === "$") out.cents[m.id] = Math.round(m.value * 100);
    }
    return out;
  }

  private async ensureApp(projectId: string, bindings: VentureBindings, platform: StorePlatform, apps: RcApp[]): Promise<RcApp> {
    const bound = bindings.revenueCatAppIds?.[platform];
    const storeId = platform === "ios" ? bindings.bundleId : bindings.androidPackage;
    const found = apps.find((a) =>
      bound ? a.id === bound : a.type === APP_TYPE[platform] && (a.app_store?.bundle_id === storeId || a.play_store?.package_name === storeId),
    );
    if (found) return found;
    if (bound) return { id: bound, name: storeId, type: APP_TYPE[platform] };
    const app = await this.client.createApp(projectId, { name: `${storeId} (${platform})`, platform, storeId });
    apps.push(app);
    return app;
  }
}

function enc(id: string): string {
  return encodeURIComponent(id);
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
