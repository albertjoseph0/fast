/**
 * Public oEmbed lookups that confirm a creator post exists publicly and who authored it.
 * oEmbed only answers for public posts, so a 4xx means "not public (or gone)".
 *
 *   TikTok     https://www.tiktok.com/oembed?url=…              author_unique_id / author_url
 *   YouTube    https://www.youtube.com/oembed?url=…&format=json author_url (/@handle)
 *   Instagram  https://graph.facebook.com/v21.0/instagram_oembed?url=…&access_token=…
 *              (Meta requires an app access token; without one this returns null and the
 *              caller falls back to SideShift's tracked post)
 * Other platforms have no public oEmbed for posts and also return null.
 */
import type { Platform } from "../../core/types.ts";
import { HttpError, withQuery } from "../http.ts";
import type { HttpClient } from "../http.ts";

export interface OembedResult {
  public: boolean;
  /** Lowercase handle without "@", when the platform names one. */
  authorHandle?: string;
}

const INSTAGRAM_OEMBED = "https://graph.facebook.com/v21.0/instagram_oembed";

function endpoint(platform: Platform, url: string, instagramToken?: string): string | null {
  switch (platform) {
    case "tiktok":
      return withQuery("https://www.tiktok.com/oembed", { url });
    case "youtube":
      return withQuery("https://www.youtube.com/oembed", { url, format: "json" });
    case "instagram":
      return instagramToken ? withQuery(INSTAGRAM_OEMBED, { url, access_token: instagramToken }) : null;
    default:
      return null;
  }
}

/** Handle from an oEmbed body: TikTok's author_unique_id, else the "@handle" in author_url, else Instagram's author_name. */
export function oembedHandle(platform: Platform, body: Record<string, unknown>): string | undefined {
  const clean = (h: string) => h.trim().replace(/^@+/, "").toLowerCase() || undefined;
  if (typeof body.author_unique_id === "string") return clean(body.author_unique_id);
  if (typeof body.author_url === "string") {
    const m = /\/@([^/?#]+)/.exec(body.author_url);
    if (m) return clean(decodeURIComponent(m[1] as string));
  }
  if (platform === "instagram" && typeof body.author_name === "string") return clean(body.author_name);
  return undefined;
}

export async function verifyByOembed(http: HttpClient, req: { url: string; platform: Platform; instagramToken?: string | undefined }): Promise<OembedResult | null> {
  if (!/^https:\/\//.test(req.url)) return { public: false };
  const target = endpoint(req.platform, req.url, req.instagramToken);
  if (!target) return null;
  try {
    const res = await http.get<Record<string, unknown> | string>(target);
    const body = typeof res.data === "string" ? parseJson(res.data) : res.data;
    const handle = oembedHandle(req.platform, body);
    return { public: true, ...(handle ? { authorHandle: handle } : {}) };
  } catch (err) {
    if (err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 429) return { public: false };
    throw err;
  }
}

function parseJson(text: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
