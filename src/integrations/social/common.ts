/**
 * Shared pieces of the social publishing adapters: per-platform adapter contract, account
 * tokens (static or refreshed), media classification and dry-run synthetic ids.
 */
import { createHash } from "node:crypto";
import type { Clock, SocialWrite } from "../../core/ports.ts";
import type { StudioStore } from "../../core/store.ts";
import type { ContentPiece, ExternalJob, JobPoll, JobRef, MediaRef, OwnedAccount, PostStats } from "../../core/types.ts";
import type { StudioConfig } from "../../config/schema.ts";
import type { DryRunRecorder, HttpClient, HttpRequest } from "../http.ts";

export type PublishRequest = Parameters<SocialWrite["publish"]>[0];

/** Uniform constructor options for the live social clients (composed in integrations/live.ts). */
export interface SocialClientOptions {
  config: StudioConfig;
  store: StudioStore;
  env: Record<string, string | undefined>;
  dryRun: boolean;
  recorder?: DryRunRecorder;
  fetch?: typeof fetch;
  clock?: Clock;
  sleep?: (ms: number) => Promise<void>;
}

/** One platform's publishing surface; LiveSocialRead/LiveSocialWrite dispatch to these. */
export interface PlatformPublisher {
  publish(req: PublishRequest): Promise<JobRef>;
  poll(job: ExternalJob, account: OwnedAccount | undefined): Promise<JobPoll>;
  postStats(externalId: string, account: OwnedAccount | undefined): Promise<PostStats>;
}

/** Deterministic synthetic id for a dry-run write, always prefixed "dry_". */
export function dryId(kind: string, req: Pick<HttpRequest, "method" | "url" | "json" | "body">): string {
  const body = req.json !== undefined ? JSON.stringify(req.json) : typeof req.body === "string" ? req.body : "";
  const tag = createHash("sha256").update(`${req.method} ${req.url} ${body}`).digest("hex").slice(0, 12);
  return `dry_${kind}_${tag}`;
}

export function isDryId(id: string | undefined): boolean {
  return Boolean(id?.startsWith("dry_"));
}

/** Stats for a post whose numbers cannot be read (dry-run ids, missing tokens). */
export function emptyStats(asOf: string): PostStats {
  return { asOf, views: null, likes: null, comments: null, shares: null, saves: null, profileVisits: null, linkClicks: null };
}

export function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

export type MediaKind = "image" | "video";

export function mediaKind(m: MediaRef): MediaKind {
  if (m.mediaType.startsWith("video/")) return "video";
  if (m.mediaType.startsWith("image/")) return "image";
  throw new Error(`unsupported media type ${m.mediaType} (${m.localPath})`);
}

/** Every piece of media must be hosted publicly before a platform can pull it. */
export function publicUrls(piece: ContentPiece): string[] {
  if (!piece.media.length) throw new Error(`content ${piece.id} has no media`);
  return piece.media.map((m) => {
    if (!m.publicUrl) throw new Error(`content ${piece.id}: ${m.localPath} has no publicUrl (run web.put_asset first)`);
    return m.publicUrl;
  });
}

/** Caption with hashtags appended once each, normalised to a leading "#". */
export function captionText(piece: ContentPiece): string {
  const tags = piece.draft.hashtags.map((t) => (t.startsWith("#") ? t : `#${t}`)).filter((t) => !piece.draft.caption.includes(t));
  return [piece.draft.caption.trim(), tags.join(" ")].filter(Boolean).join("\n\n");
}

/** Truncate to at most `max` UTF-16 code units without splitting a surrogate pair. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return cut;
}

export function requireLabels<T>(labels: T | undefined, platform: string, contentId: string): T {
  if (!labels) throw new Error(`content ${contentId}: no ${platform} disclosure labels; refusing to publish unlabeled content`);
  return labels;
}

/**
 * Access tokens for owned accounts. The account's tokenSecretRef names the env var holding
 * the access token; when `${ref}_REFRESH_TOKEN` and the platform client credentials are
 * present, a fresh token is obtained through the refresh grant and cached until near expiry.
 */
export class AccountTokens {
  private readonly cache = new Map<string, { token: string; exp: number }>();

  constructor(
    private readonly opts: {
      env: Record<string, string | undefined>;
      clock: Clock;
      oauth: HttpClient;
      tokenUrl: string;
      /** Builds the refresh form from the refresh token, or null when client credentials are missing. */
      refreshForm: (refreshToken: string) => Record<string, string> | null;
    },
  ) {}

  /** Whether any credential exists for the account (dry-runs without one never touch the network). */
  has(account: OwnedAccount | undefined): boolean {
    const ref = account?.tokenSecretRef;
    return Boolean(ref && (this.opts.env[ref] || this.opts.env[`${ref}_REFRESH_TOKEN`]));
  }

  async get(account: OwnedAccount): Promise<string> {
    const ref = account.tokenSecretRef;
    if (!ref) throw new Error(`account ${account.id} (${account.platform}) has no tokenSecretRef`);
    const refresh = this.opts.env[`${ref}_REFRESH_TOKEN`];
    const form = refresh ? this.opts.refreshForm(refresh) : null;
    if (!form) {
      const token = this.opts.env[ref];
      if (!token) throw new Error(`account ${account.id}: env ${ref} is not set`);
      return token;
    }
    const nowSec = Math.floor(this.opts.clock.now().getTime() / 1000);
    const cached = this.cache.get(account.id);
    if (cached && nowSec < cached.exp - 60) return cached.token;
    const res = await this.opts.oauth.request<{ access_token?: string; expires_in?: number }>({
      method: "POST",
      url: this.opts.tokenUrl,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
      sideEffect: false,
    });
    const token = res.data.access_token;
    if (!token) throw new Error(`${account.platform} token refresh for ${account.id}: no access_token`);
    this.cache.set(account.id, { token, exp: nowSec + (res.data.expires_in ?? 3_600) });
    return token;
  }
}

const BIG_INT = /([:[,]\s*)(-?\d{16,})(?=\s*[,\]}])/g;

/**
 * Wrap fetch so JSON integers too large for a double (TikTok's int64 post ids) arrive as
 * strings instead of silently losing digits in JSON.parse.
 */
export function bigIntSafeFetch(inner: typeof fetch): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const res = await inner(input, init);
    if (!(res.headers.get("content-type") ?? "").includes("json")) return res;
    const text = await res.text();
    return new Response(text.replace(BIG_INT, '$1"$2"'), { status: res.status, statusText: res.statusText, headers: res.headers });
  }) as typeof fetch;
}

export function requireAccount(account: OwnedAccount | undefined, job: ExternalJob): OwnedAccount {
  if (!account) throw new Error(`job ${job.id}: account ${job.externalRef.accountId ?? "?"} not found`);
  return account;
}
