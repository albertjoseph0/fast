/**
 * Apple public market data: App Store top charts (Apple Marketing Tools RSS v2) and the
 * iTunes Search / Lookup API. Unauthenticated and read-only. Apple documents roughly 20
 * Search API calls per minute, so every request passes one shared sliding-window limiter.
 */
import type { AppLookup, ChartApp, Clock, TrendPort } from "../../core/ports.ts";
import type { StudioStore } from "../../core/store.ts";
import type { StudioConfig } from "../../config/schema.ts";
import { SystemClock } from "../../core/clock.ts";
import { HttpClient, withQuery } from "../http.ts";
import type { DryRunRecorder } from "../http.ts";

export const ENV_VARS: readonly { name: string; purpose: string; required: boolean }[] = [];

const RSS_BASE = "https://rss.marketingtools.apple.com/api/v2";
const ITUNES_BASE = "https://itunes.apple.com";
const MAX_LIMIT = 200;

/** Sliding-window limiter: at most `max` acquisitions per `windowMs`. */
export class RateLimiter {
  private readonly stamps: number[] = [];

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly clock: Clock,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {}

  async acquire(): Promise<void> {
    for (;;) {
      const now = this.clock.now().getTime();
      while (this.stamps.length > 0 && (this.stamps[0] as number) <= now - this.windowMs) this.stamps.shift();
      if (this.stamps.length < this.max) {
        this.stamps.push(now);
        return;
      }
      await this.sleep((this.stamps[0] as number) + this.windowMs - now);
    }
  }
}

export interface AppleTrendPortOptions {
  /** Accepted for uniform construction with the other live clients; charts are public reads. */
  config?: StudioConfig;
  store?: StudioStore;
  env?: Record<string, string | undefined>;
  dryRun?: boolean;
  recorder?: DryRunRecorder;
  fetch?: typeof fetch;
  clock?: Clock;
  sleep?: (ms: number) => Promise<void>;
  /** Requests per minute across charts, search and lookup (default 20). */
  maxPerMinute?: number;
}

type Json = Record<string, unknown>;

function asObject(value: unknown): Json {
  if (typeof value === "string") {
    try {
      return asObject(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

function num(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : 0;
}

function clampLimit(limit: number): number {
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}

/** Parse an RSS v2 apps feed. Entries without an id or name are dropped. */
export function parseChart(body: unknown): ChartApp[] {
  const results = asObject(asObject(body).feed).results;
  if (!Array.isArray(results)) return [];
  const out: ChartApp[] = [];
  results.forEach((raw, i) => {
    const r = asObject(raw);
    const id = str(r.id);
    const name = str(r.name);
    if (!id || !name) return;
    const genres = Array.isArray(r.genres) ? r.genres.map(asObject) : [];
    out.push({ id, name, artist: str(r.artistName), genre: str(genres[0]?.name), rank: i + 1, url: str(r.url) });
  });
  return out;
}

/** Parse an iTunes Search or Lookup response, keeping software results only. */
export function parseLookup(body: unknown): AppLookup[] {
  const results = asObject(body).results;
  if (!Array.isArray(results)) return [];
  const out: AppLookup[] = [];
  for (const raw of results) {
    const r = asObject(raw);
    const id = str(r.trackId);
    const name = str(r.trackName);
    const kind = str(r.kind);
    if (!id || !name || (kind && kind !== "software" && kind !== "mac-software")) continue;
    out.push({
      id,
      name,
      seller: str(r.sellerName) || str(r.artistName),
      genre: str(r.primaryGenreName),
      ratingCount: Math.round(num(r.userRatingCount)),
      rating: num(r.averageUserRating),
      priceCents: Math.round(num(r.price) * 100),
      releaseDate: str(r.releaseDate),
      description: str(r.description),
      url: str(r.trackViewUrl),
    });
  }
  return out;
}

export class AppleTrendPort implements TrendPort {
  readonly kind = "apple_public" as const;
  private readonly http: HttpClient;
  private readonly limiter: RateLimiter;

  constructor(opts: AppleTrendPortOptions = {}) {
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.http = new HttpClient({ service: "itunes", dryRun: false, sleep, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
    this.limiter = new RateLimiter(opts.maxPerMinute ?? 20, 60_000, opts.clock ?? new SystemClock(), sleep);
  }

  async topApps(req: { country: string; chart: "top-free" | "top-paid"; limit: number }): Promise<ChartApp[]> {
    const url = `${RSS_BASE}/${encodeURIComponent(req.country.toLowerCase())}/apps/${req.chart}/${clampLimit(req.limit)}/apps.json`;
    return parseChart(await this.get(url));
  }

  async searchApps(req: { term: string; country: string; limit: number }): Promise<AppLookup[]> {
    const url = withQuery(`${ITUNES_BASE}/search`, { term: req.term, entity: "software", country: req.country.toLowerCase(), limit: clampLimit(req.limit) });
    return parseLookup(await this.get(url));
  }

  /** Look up apps by App Store id. */
  async lookupApps(req: { ids: string[]; country: string }): Promise<AppLookup[]> {
    if (req.ids.length === 0) return [];
    const url = withQuery(`${ITUNES_BASE}/lookup`, { id: req.ids.join(","), entity: "software", country: req.country.toLowerCase() });
    return parseLookup(await this.get(url));
  }

  private async get(url: string): Promise<unknown> {
    await this.limiter.acquire();
    // iTunes answers with text/javascript, so the body may arrive as an unparsed string.
    return (await this.http.get<unknown>(url)).data;
  }
}
