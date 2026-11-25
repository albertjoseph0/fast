/**
 * YouTube Data API v3 as a demand source: which videos about a term drew views recently.
 *
 * One term costs search.list (100 quota units) plus one videos.list (1 unit); the default
 * project quota is 10,000 units a day, so a scan queries at most `maxTermsPerScan` terms.
 * The API key travels in the X-Goog-Api-Key header, never in the URL.
 */
import { HttpClient, withQuery } from "../http.ts";
import type { TrendObservation } from "../../core/ports.ts";
import { ageDays, arr, median, num, obj, round, samples, str, type TrendSourceClient, type TrendSourceOptions } from "./common.ts";

export const ENV_VARS: readonly { name: string; purpose: string; required: boolean }[] = [
  { name: "YOUTUBE_API_KEY", purpose: "YouTube Data API v3 key (read-only public data) for trend scans; restrict it to the YouTube Data API", required: false },
];

const API = "https://www.googleapis.com/youtube/v3";
const RESULTS_PER_TERM = 25;
/** 20 terms x 101 units = 2,020 units: room for the studio's upload and stats calls in the same project. */
export const YOUTUBE_TERMS_PER_SCAN = 20;

export function youtubeConfigured(env: Record<string, string | undefined>): boolean {
  return Boolean(env.YOUTUBE_API_KEY);
}

export class YouTubeTrendSource implements TrendSourceClient {
  readonly source = "youtube" as const;
  readonly maxTermsPerScan = YOUTUBE_TERMS_PER_SCAN;
  private readonly http: HttpClient;

  constructor(private readonly opts: TrendSourceOptions) {
    const key = opts.env.YOUTUBE_API_KEY ?? "";
    this.http = new HttpClient({
      service: "youtube_trends",
      dryRun: false,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
      defaultHeaders: () => ({ "x-goog-api-key": key }),
    });
  }

  async scanTerm(req: { term: string; country: string; sinceDays: number }): Promise<TrendObservation | null> {
    const now = this.opts.clock.now();
    const publishedAfter = new Date(now.getTime() - req.sinceDays * 86_400_000).toISOString();
    const search = await this.http.get<unknown>(
      withQuery(`${API}/search`, {
        part: "snippet",
        type: "video",
        order: "viewCount",
        q: req.term,
        publishedAfter,
        regionCode: req.country.toUpperCase(),
        maxResults: RESULTS_PER_TERM,
      }),
    );
    const ids = arr(obj(search.data).items)
      .map((i) => str(obj(obj(i).id).videoId))
      .filter(Boolean);
    if (ids.length === 0) return null;
    const videos = await this.http.get<unknown>(withQuery(`${API}/videos`, { part: "statistics,snippet", id: ids.join(","), maxResults: ids.length }));
    return youtubeObservation(req.term, arr(obj(videos.data).items), now);
  }
}

/** Raw traction of the most-viewed recent videos for a term. */
export function youtubeObservation(term: string, items: unknown[], now: Date): TrendObservation | null {
  const rows = items.map((raw) => {
    const v = obj(raw);
    const stats = obj(v.statistics);
    const snippet = obj(v.snippet);
    return {
      views: num(stats.viewCount),
      engagements: num(stats.likeCount) + num(stats.commentCount),
      age: ageDays(str(snippet.publishedAt), now),
      channel: str(snippet.channelId),
      title: str(snippet.title),
    };
  });
  const valid = rows.filter((r) => Number.isFinite(r.age));
  if (valid.length === 0) return null;
  const views = valid.reduce((s, r) => s + r.views, 0);
  const engagements = valid.reduce((s, r) => s + r.engagements, 0);
  return {
    source: "youtube",
    term,
    url: `https://www.youtube.com/results?search_query=${encodeURIComponent(term)}`,
    metrics: {
      videos: valid.length,
      channels: new Set(valid.map((r) => r.channel).filter(Boolean)).size,
      views,
      medianViews: Math.round(median(valid.map((r) => r.views))),
      viewsPerDay: Math.round(valid.reduce((s, r) => s + r.views / r.age, 0)),
      engagementRate: views > 0 ? round(engagements / views, 4) : 0,
    },
    samples: samples(valid.sort((a, b) => b.views - a.views).map((r) => r.title)),
  };
}
