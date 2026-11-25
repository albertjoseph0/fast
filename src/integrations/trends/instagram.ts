/**
 * Instagram hashtag search (Instagram API with Facebook Login, Graph API) as a demand source:
 * how much engagement the top posts under a term's hashtag draw, and how recent they are.
 *
 * Meta allows 30 unique hashtags per Instagram account in a rolling 7 days; repeating a hashtag
 * already searched in the window is free. A scan therefore queries at most 25 terms, taken in a
 * stable (sorted) order so repeated scans reuse the same hashtags.
 */
import { GRAPH_API } from "../social/instagram.ts";
import { HttpClient, withQuery } from "../http.ts";
import type { TrendObservation } from "../../core/ports.ts";
import { ageDays, arr, hashtagFor, median, num, obj, samples, str, type TrendSourceClient, type TrendSourceOptions } from "./common.ts";

export const ENV_VARS: readonly { name: string; purpose: string; required: boolean }[] = [
  {
    name: "INSTAGRAM_TRENDS_TOKEN",
    purpose: "Access token of the studio's Instagram professional account with instagram_basic and the Instagram Public Content Access feature (hashtag search)",
    required: false,
  },
  { name: "INSTAGRAM_TRENDS_USER_ID", purpose: "Instagram user id of that account (hashtag queries are made on its behalf)", required: false },
];

/** Under Meta's 30 unique hashtags per 7 days, with room for a manual search. */
export const INSTAGRAM_TERMS_PER_SCAN = 25;
const MEDIA_FIELDS = "id,caption,like_count,comments_count,timestamp,permalink,media_type";

export function instagramConfigured(env: Record<string, string | undefined>): boolean {
  return Boolean(env.INSTAGRAM_TRENDS_TOKEN && env.INSTAGRAM_TRENDS_USER_ID);
}

export class InstagramTrendSource implements TrendSourceClient {
  readonly source = "instagram" as const;
  readonly maxTermsPerScan = INSTAGRAM_TERMS_PER_SCAN;
  private readonly http: HttpClient;
  private readonly userId: string;

  constructor(private readonly opts: TrendSourceOptions) {
    const token = opts.env.INSTAGRAM_TRENDS_TOKEN ?? "";
    this.userId = opts.env.INSTAGRAM_TRENDS_USER_ID ?? "";
    this.http = new HttpClient({
      service: "instagram_trends",
      dryRun: false,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
      defaultHeaders: () => ({ authorization: `Bearer ${token}` }),
    });
  }

  async scanTerm(req: { term: string; country: string; sinceDays: number }): Promise<TrendObservation | null> {
    const tag = hashtagFor(req.term);
    if (!tag) return null;
    const found = await this.http.get<unknown>(withQuery(`${GRAPH_API}/ig_hashtag_search`, { user_id: this.userId, q: tag }));
    const id = str(obj(arr(obj(found.data).data)[0]).id);
    if (!id) return null;
    const media = await this.http.get<unknown>(withQuery(`${GRAPH_API}/${id}/top_media`, { user_id: this.userId, fields: MEDIA_FIELDS, limit: 50 }));
    return instagramObservation(req.term, tag, arr(obj(media.data).data), this.opts.clock.now(), req.sinceDays);
  }
}

/** Engagement of a hashtag's top posts. Like counts hidden by the poster read as 0. */
export function instagramObservation(term: string, tag: string, items: unknown[], now: Date, sinceDays: number): TrendObservation | null {
  const posts = items.map((raw) => {
    const m = obj(raw);
    return { engagement: num(m.like_count) + num(m.comments_count), age: ageDays(str(m.timestamp), now), caption: str(m.caption) };
  });
  if (posts.length === 0) return null;
  const recent = posts.filter((p) => p.age <= sinceDays);
  return {
    source: "instagram",
    term,
    url: `https://www.instagram.com/explore/tags/${encodeURIComponent(tag)}/`,
    metrics: {
      posts: posts.length,
      recentPosts: recent.length,
      engagement: posts.reduce((s, p) => s + p.engagement, 0),
      medianEngagement: Math.round(median(posts.map((p) => p.engagement))),
      recentMedianEngagement: Math.round(median(recent.map((p) => p.engagement))),
    },
    samples: samples(posts.sort((a, b) => b.engagement - a.engagement).map((p) => p.caption)),
  };
}
