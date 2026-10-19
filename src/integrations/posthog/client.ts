/**
 * PostHog: HogQL query API (metrics) and the feature-flags API (sticky experiment flags),
 * with the live MetricsPort and RemoteConfigWrite on top.
 *
 * One PostHog project per venture (bindings.posthogProjectId). The app reads flags named
 * exactly "paywall", "onboarding", "share" and "core" with JSON payloads per variant, and a
 * variant id doubles as the experiment cell id. Queries are reads (never dry-run); flag
 * writes are dry-run by default and answered with "dry_" ids. In dry-run without a personal
 * API key, queries return no rows instead of calling PostHog.
 */
import { createHash } from "node:crypto";
import type { CellMetricRequest, Clock, MetricsPort, RemoteConfigWrite } from "../../core/ports.ts";
import type { StudioStore } from "../../core/store.ts";
import type { StudioConfig } from "../../config/schema.ts";
import type { CohortMetrics, DailyMetrics, Iso, VentureBindings } from "../../core/types.ts";
import { EV, EXTERNAL_EVENTS } from "../../core/events.ts";
import { SystemClock, addDays } from "../../core/clock.ts";
import { HttpClient, withQuery } from "../http.ts";
import type { DryRunRecorder, HttpRequest } from "../http.ts";
import { cellMetricQuery, cohortQuery, dailyQuery, internalShareQuery, subscriptionsQuery } from "./hogql.ts";
import type { HogQLQuery } from "./hogql.ts";
import { buildCohorts, buildDaily, cellCounts, cohortPersons, dayStartMs, geoCodes, postExposure, purchases, viewExposure } from "./metrics.ts";
import type { MetricCounts } from "./metrics.ts";

export const ENV_VARS: readonly { name: string; purpose: string; required: boolean }[] = [
  { name: "POSTHOG_PERSONAL_API_KEY", purpose: "PostHog personal API key with query:read and feature_flag:write on the venture projects", required: true },
  { name: "POSTHOG_HOST", purpose: "PostHog app host for the private API (default https://us.posthog.com; EU: https://eu.posthog.com)", required: false },
];

export const DEFAULT_POSTHOG_HOST = "https://us.posthog.com";
/** Flag keys the app template reads (the remote_config.set keys). */
export const REMOTE_CONFIG_KEYS = ["paywall", "onboarding", "share", "core"] as const;

const VARIANT_KEY = /^[A-Za-z0-9_-]{1,200}$/;
/** Purchases older than this cannot still be active (annual plans), so subscriber counts look back this far. */
const SUBSCRIPTION_LOOKBACK_DAYS = 370;

export interface PostHogOptions {
  config: StudioConfig;
  store: StudioStore;
  env: Record<string, string | undefined>;
  dryRun: boolean;
  recorder?: DryRunRecorder;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  clock?: Clock;
}

export interface PostHogFlag {
  id: number | string;
  key: string;
  active?: boolean;
  filters?: unknown;
}

export interface FlagVariant {
  id: string;
  rolloutPct: number;
  payload: unknown;
}

/** Synthetic flag for a dry-run write. */
export function posthogDryRunResponse(req: HttpRequest): unknown {
  const hash = createHash("sha256").update(`${req.url} ${JSON.stringify(req.json ?? null)}`).digest("hex").slice(0, 12);
  const body = req.json && typeof req.json === "object" ? (req.json as Record<string, unknown>) : {};
  return { ...body, id: `dry_ph_${hash}`, dryRun: true };
}

/**
 * Feature flag body: a multivariate flag released to everyone, split by the variants'
 * rollout, with each variant's JSON payload. PostHog buckets by distinct id, so a person
 * keeps their variant; experience continuity keeps it across identify().
 */
export function flagBody(key: string, variants: FlagVariant[]): Record<string, unknown> {
  if (!variants.length) throw new Error(`posthog: flag ${key} needs at least one variant`);
  const ids = new Set<string>();
  for (const v of variants) {
    if (!VARIANT_KEY.test(v.id)) throw new Error(`posthog: invalid variant key ${JSON.stringify(v.id)}`);
    if (ids.has(v.id)) throw new Error(`posthog: duplicate variant ${v.id}`);
    if (!Number.isInteger(v.rolloutPct) || v.rolloutPct < 0 || v.rolloutPct > 100) throw new Error(`posthog: variant ${v.id} rollout must be an integer 0-100`);
    ids.add(v.id);
  }
  const total = variants.reduce((s, v) => s + v.rolloutPct, 0);
  if (total !== 100) throw new Error(`posthog: variant rollouts for ${key} sum to ${total}, not 100`);
  return {
    key,
    name: `Studio experiment flag: ${key}`,
    active: true,
    ensure_experience_continuity: true,
    filters: {
      groups: [{ properties: [], rollout_percentage: 100, variant: null }],
      multivariate: { variants: variants.map((v) => ({ key: v.id, name: v.id, rollout_percentage: v.rolloutPct })) },
      payloads: Object.fromEntries(variants.map((v) => [v.id, JSON.stringify(v.payload ?? null)])),
    },
  };
}

export class PostHogClient {
  private readonly http: HttpClient;
  readonly host: string;

  constructor(private readonly opts: PostHogOptions) {
    this.host = (opts.env.POSTHOG_HOST ?? DEFAULT_POSTHOG_HOST).replace(/\/+$/, "");
    this.http = new HttpClient({
      service: "posthog",
      dryRun: opts.dryRun,
      dryRunResponse: posthogDryRunResponse,
      defaultHeaders: () => this.authHeaders(),
      ...(opts.recorder ? { recorder: opts.recorder } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
    });
  }

  /** Dry-run without a key: nothing reaches PostHog and queries return no rows. */
  get offline(): boolean {
    return this.opts.dryRun && !this.opts.env.POSTHOG_PERSONAL_API_KEY;
  }

  private authHeaders(): Record<string, string> {
    const key = this.opts.env.POSTHOG_PERSONAL_API_KEY;
    if (!key) {
      if (this.opts.dryRun) return {};
      throw new Error("posthog: POSTHOG_PERSONAL_API_KEY is not set");
    }
    return { authorization: `Bearer ${key}` };
  }

  private projectUrl(projectId: string, path: string): string {
    return `${this.host}/api/projects/${encodeURIComponent(projectId)}${path}`;
  }

  /** Run a HogQL query; returns result rows. */
  async query(projectId: string, q: HogQLQuery, name?: string): Promise<unknown[][]> {
    if (this.offline) return [];
    const res = await this.http.request<{ results?: unknown[][] }>({
      method: "POST",
      url: this.projectUrl(projectId, "/query/"),
      json: { query: { kind: "HogQLQuery", query: q.query, values: q.values }, ...(name ? { name } : {}) },
      sideEffect: false,
    });
    return res.data.results ?? [];
  }

  async findFlag(projectId: string, key: string): Promise<PostHogFlag | null> {
    if (this.offline) return null;
    const res = await this.http.get<{ results?: PostHogFlag[] }>(withQuery(this.projectUrl(projectId, "/feature_flags/"), { key, limit: 100 }));
    return (res.data.results ?? []).find((f) => f.key === key) ?? null;
  }

  async createFlag(projectId: string, body: Record<string, unknown>): Promise<PostHogFlag> {
    return (await this.http.post<PostHogFlag>(this.projectUrl(projectId, "/feature_flags/"), body)).data;
  }

  async updateFlag(projectId: string, flagId: number | string, body: Record<string, unknown>): Promise<PostHogFlag> {
    return (await this.http.patch<PostHogFlag>(this.projectUrl(projectId, `/feature_flags/${encodeURIComponent(String(flagId))}/`), body)).data;
  }
}

function projectOf(bindings: VentureBindings): string {
  if (!bindings.posthogProjectId) throw new Error(`posthog: no posthogProjectId bound for ${bindings.bundleId}`);
  return bindings.posthogProjectId;
}

/** Live RemoteConfigWrite: creates or updates the venture's flag with exactly the given key. */
export class LiveRemoteConfigWrite implements RemoteConfigWrite {
  readonly kind = "live" as const;
  readonly client: PostHogClient;

  constructor(opts: PostHogOptions) {
    this.client = new PostHogClient(opts);
  }

  async setFlag(req: { bindings: VentureBindings; key: string; variants: FlagVariant[] }): Promise<{ flagKey: string }> {
    if (!(REMOTE_CONFIG_KEYS as readonly string[]).includes(req.key)) throw new Error(`posthog: flag key must be one of ${REMOTE_CONFIG_KEYS.join(", ")}, got ${req.key}`);
    const projectId = projectOf(req.bindings);
    const body = flagBody(req.key, req.variants);
    const existing = await this.client.findFlag(projectId, req.key);
    if (existing) await this.client.updateFlag(projectId, existing.id, body);
    else await this.client.createFlag(projectId, body);
    return { flagKey: req.key };
  }
}

const EXTERNAL = new Set<string>(Object.values(EXTERNAL_EVENTS));

/** Live MetricsPort: app and RevenueCat events from PostHog; views and posts from verified platform facts in the store. */
export class LiveMetricsPort implements MetricsPort {
  readonly kind = "live" as const;
  readonly client: PostHogClient;
  private readonly clock: Clock;

  constructor(private readonly opts: PostHogOptions) {
    this.client = new PostHogClient(opts);
    this.clock = opts.clock ?? new SystemClock();
  }

  private slug(ventureId: string): string {
    const v = this.opts.store.ventures.get(ventureId);
    if (!v) throw new Error(`posthog: unknown venture ${ventureId}`);
    return v.slug;
  }

  async cellMetric(req: CellMetricRequest): Promise<MetricCounts> {
    if (req.denominator === EV.view) return this.viewMetric(req);
    if (req.denominator === EV.post) return postExposure(this.opts.store, req, this.opts.config.lab.attentionProbe.hitViews);
    if (EXTERNAL.has(req.denominator)) return { successes: 0, trials: 0, bySource: {} };
    const q = cellMetricQuery({
      appSlug: this.slug(req.ventureId),
      numerator: req.numerator,
      denominator: req.denominator,
      maturityHours: req.maturityHours,
      ...(req.windowHours !== undefined ? { windowHours: req.windowHours } : {}),
      since: req.since,
      asOf: req.asOf,
      cell: req.assignment === "geo" ? { kind: "geo", geoCodes: geoCodes(req.geo) } : { kind: "user_random", cellId: req.cellId },
    });
    return cellCounts(await this.client.query(projectOf(req.bindings), q, `cell:${req.experimentId}:${req.cellId}:${req.numerator}/${req.denominator}`));
  }

  /**
   * In-storefront installs per in-geo view. Views are the cell's mature posts (platform-verified);
   * installs count from the day the first mature post went up. Installs carry no post-level
   * referrer, so their sources come from the person property source_id.
   */
  private async viewMetric(req: CellMetricRequest): Promise<MetricCounts> {
    const views = viewExposure(this.opts.store, req);
    if (views.trials === 0 || views.firstPostedAt === null) return { successes: 0, trials: 0, bySource: {} };
    const from = Math.max(new Date(req.since).getTime(), dayStartMs(new Date(views.firstPostedAt).toISOString()));
    const q = cellMetricQuery({
      appSlug: this.slug(req.ventureId),
      numerator: EV.install,
      denominator: EV.install,
      maturityHours: 0,
      since: new Date(from).toISOString(),
      asOf: req.asOf,
      cell: { kind: "geo", geoCodes: geoCodes(req.geo) },
    });
    const installs = cellCounts(await this.client.query(projectOf(req.bindings), q, `views:${req.experimentId}:${req.cellId}`));
    const out: MetricCounts = { successes: installs.trials, trials: views.trials, bySource: {} };
    for (const [source, trials] of Object.entries(views.bySource)) out.bySource[source] = { successes: 0, trials };
    for (const [source, c] of Object.entries(installs.bySource)) (out.bySource[source] ??= { successes: 0, trials: 0 }).successes += c.trials;
    return out;
  }

  async internalShare(req: { bindings: VentureBindings; ventureId: string; cellId: string; geo: string; since: Iso; asOf: Iso }): Promise<number> {
    const q = internalShareQuery({ appSlug: this.slug(req.ventureId), cellId: req.cellId, geoCodes: geoCodes(req.geo), since: req.since, asOf: req.asOf });
    const [row] = await this.client.query(projectOf(req.bindings), q, `internal:${req.cellId}`);
    const internal = Number(row?.[0] ?? 0);
    const total = Number(row?.[1] ?? 0);
    return total > 0 ? internal / total : 0;
  }

  async daily(req: { bindings: VentureBindings; ventureId: string; since: string; until: string }): Promise<DailyMetrics[]> {
    const projectId = projectOf(req.bindings);
    const rows = await this.client.query(projectId, dailyQuery({ appSlug: this.slug(req.ventureId), since: req.since, until: req.until }), `daily:${req.ventureId}`);
    const subs = await this.client.query(projectId, subscriptionsQuery({ since: addDays(req.since, -SUBSCRIPTION_LOOKBACK_DAYS), until: req.until }), `subscriptions:${req.ventureId}`);
    return buildDaily({
      ventureId: req.ventureId,
      since: req.since,
      until: req.until,
      completeThrough: addDays(this.clock.today(), -this.opts.config.lab.revenueLagDays),
      config: this.opts.config,
      rows,
      purchases: purchases(subs),
    });
  }

  async cohorts(req: { bindings: VentureBindings; ventureId: string; cohortSince: string; cohortUntil: string; maxAgeDays: number }): Promise<CohortMetrics[]> {
    const asOf = this.clock.iso();
    const q = cohortQuery({ appSlug: this.slug(req.ventureId), cohortSince: req.cohortSince, cohortUntil: req.cohortUntil, asOf });
    const rows = await this.client.query(projectOf(req.bindings), q, `cohorts:${req.ventureId}`);
    return buildCohorts({ ventureId: req.ventureId, persons: cohortPersons(rows), asOf, maxAgeDays: req.maxAgeDays, config: this.opts.config });
  }
}
