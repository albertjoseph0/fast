/**
 * YouTube Data API v3 publishing (Shorts and regular uploads).
 *
 * Uploads use the resumable protocol: a POST to /upload/youtube/v3/videos with the video
 * resource (containsSyntheticMedia and selfDeclaredMadeForKids set explicitly) returns a
 * session URL in Location, then the file is PUT to it. videos.insert has its own bucket of
 * 100 calls per project per day; the studio's own lower cap is tracked in store quotas.
 */
import { existsSync, statSync } from "node:fs";
import type { Clock } from "../../core/ports.ts";
import type { ExternalJob, JobPoll, JobRef, OwnedAccount, PostStats } from "../../core/types.ts";
import { SystemClock } from "../../core/clock.ts";
import { HttpClient, withQuery } from "../http.ts";
import type { HttpRequest } from "../http.ts";
import { AccountTokens, captionText, clip, dryId, emptyStats, isDryId, mediaKind, num, requireAccount, requireLabels } from "./common.ts";
import type { PlatformPublisher, PublishRequest, SocialClientOptions } from "./common.ts";

export const ENV_VARS: readonly { name: string; purpose: string; required: boolean }[] = [
  { name: "<OwnedAccount.tokenSecretRef>", purpose: "Google OAuth access token with youtube.upload and youtube.readonly for the connected channel", required: true },
  { name: "<OwnedAccount.tokenSecretRef>_REFRESH_TOKEN", purpose: "Google OAuth refresh token; with the client id/secret, access tokens are refreshed automatically", required: false },
  { name: "YOUTUBE_CLIENT_ID", purpose: "Google OAuth client id of the studio's single YouTube API project (token refresh)", required: false },
  { name: "YOUTUBE_CLIENT_SECRET", purpose: "Google OAuth client secret (token refresh)", required: false },
];

export const YOUTUBE_API = "https://www.googleapis.com/youtube/v3";
export const YOUTUBE_UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
/** Platform limit for the videos.insert bucket (June 2026 quota change). */
export const YOUTUBE_INSERTS_PER_DAY = 100;
export const INSERT_QUOTA_KEY = "youtube:videos.insert";
const TITLE_MAX = 100;
const DESCRIPTION_MAX = 5_000;
/** People & Blogs. */
const CATEGORY_ID = "22";

type PrivacyStatus = "public" | "unlisted" | "private";

interface VideoResource {
  id?: string;
  status?: { uploadStatus?: "uploaded" | "processed" | "failed" | "rejected" | "deleted"; privacyStatus?: PrivacyStatus; failureReason?: string; rejectionReason?: string };
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
}

function youtubeDryRunResponse(req: HttpRequest): unknown {
  if (req.method === "PUT") return { id: dryId("ytvideo", req), status: { uploadStatus: "uploaded" } };
  return {};
}

/** YouTube rejects angle brackets in titles and descriptions. */
function clean(text: string): string {
  return text.replace(/[<>]/g, "");
}

export class YouTubeClient implements PlatformPublisher {
  private readonly http: HttpClient;
  private readonly tokens: AccountTokens;
  private readonly clock: Clock;

  constructor(private readonly opts: SocialClientOptions) {
    this.clock = opts.clock ?? new SystemClock();
    this.http = new HttpClient({
      service: "youtube",
      dryRun: opts.dryRun,
      dryRunResponse: youtubeDryRunResponse,
      ...(opts.recorder ? { recorder: opts.recorder } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
    });
    const { YOUTUBE_CLIENT_ID: id, YOUTUBE_CLIENT_SECRET: secret } = opts.env;
    this.tokens = new AccountTokens({
      env: opts.env,
      clock: this.clock,
      oauth: this.http,
      tokenUrl: GOOGLE_TOKEN_URL,
      refreshForm: (refresh) => (id && secret ? { client_id: id, client_secret: secret, refresh_token: refresh, grant_type: "refresh_token" } : null),
    });
  }

  /** Daily insert cap: the studio's configured share of the 100/day project bucket. */
  get insertLimit(): number {
    return Math.min(this.opts.config.distribution.youtubeProjectInsertsPerDay, YOUTUBE_INSERTS_PER_DAY);
  }

  /** Inserts left today (the window is the UTC day, a conservative stand-in for Google's Pacific-time reset). */
  insertsRemaining(): number {
    const q = this.opts.store.quota(INSERT_QUOTA_KEY);
    const used = q && q.windowStart === this.clock.today() ? q.used : 0;
    return Math.max(0, this.insertLimit - used);
  }

  async publish(req: PublishRequest): Promise<JobRef> {
    const { account, piece, mode } = req;
    if (mode === "trial_reel") throw new Error("trial reels are Instagram-only; YouTube uploads are direct or private drafts");
    const labels = requireLabels(req.labels.youtube, "youtube", piece.id);
    const media = piece.media[0];
    if (piece.media.length !== 1 || !media || mediaKind(media) !== "video") throw new Error(`content ${piece.id}: a YouTube upload takes exactly one video`);
    const exists = existsSync(media.localPath);
    if (!exists && !this.opts.dryRun) throw new Error(`content ${piece.id}: ${media.localPath} does not exist`);
    const size = exists ? statSync(media.localPath).size : 0;
    if (!this.opts.dryRun) this.consumeInsert();

    // A draft is uploaded private; the human makes it public after review in Studio.
    const privacyStatus: PrivacyStatus = mode === "inbox_draft" ? "private" : "public";
    const parts = ["snippet", "status", ...(labels.hasPaidProductPlacement ? ["paidProductPlacementDetails"] : [])];
    const resource = {
      snippet: {
        title: clip(clean(piece.draft.hook), TITLE_MAX),
        description: clip(clean(captionText(piece)), DESCRIPTION_MAX),
        tags: piece.draft.hashtags.map((t) => t.replace(/^#/, "")),
        categoryId: CATEGORY_ID,
      },
      status: { privacyStatus, selfDeclaredMadeForKids: labels.selfDeclaredMadeForKids, containsSyntheticMedia: labels.containsSyntheticMedia },
      ...(labels.hasPaidProductPlacement ? { paidProductPlacementDetails: { hasPaidProductPlacement: true } } : {}),
    };
    const context = { ventureId: piece.ventureId };
    const auth = await this.auth(account, true);
    const session = await this.http.request({
      method: "POST",
      url: `${YOUTUBE_UPLOAD_URL}?uploadType=resumable&part=${parts.join(",")}`,
      headers: { ...auth, "x-upload-content-length": String(size), "x-upload-content-type": media.mediaType },
      json: resource,
      context,
    });
    const uploadUrl = session.headers.get("location") ?? (session.dryRun ? `${YOUTUBE_UPLOAD_URL}?uploadType=resumable&upload_id=dry_session` : null);
    if (!uploadUrl) throw new Error("YouTube resumable upload: no Location header in the session response");
    const uploaded = await this.http.upload<VideoResource>({
      method: "PUT",
      url: uploadUrl,
      headers: { ...auth, "content-type": media.mediaType },
      file: { path: media.localPath, length: size },
      context,
    });
    const videoId = uploaded.data.id;
    if (!videoId) throw new Error("YouTube upload finished without a video id");
    return {
      op: "social.publish",
      externalRef: { platform: "youtube", accountId: account.id, contentId: piece.id, videoId, privacyStatus },
      pollAfterSec: 120,
    };
  }

  async poll(job: ExternalJob, account: OwnedAccount | undefined): Promise<JobPoll> {
    const videoId = job.externalRef.videoId;
    if (!videoId) return { status: "failed", error: "youtube job without videoId" };
    if (isDryId(videoId)) return { status: "succeeded", result: { externalId: videoId, moderation: "live", dryRun: true } };
    const acct = requireAccount(account, job);
    const res = await this.http.get<{ items?: VideoResource[] }>(withQuery(`${YOUTUBE_API}/videos`, { part: "status", id: videoId }), await this.auth(acct, false));
    const status = res.data.items?.[0]?.status;
    const done = { externalId: videoId, url: `https://www.youtube.com/shorts/${videoId}` };
    switch (status?.uploadStatus) {
      case undefined:
      case "uploaded":
        return { status: "running", pollAfterSec: 300 };
      case "processed":
        if (status.privacyStatus === "private") return { status: "running", pollAfterSec: 3_600, result: { ...done, moderation: "pending_human" } };
        return { status: "succeeded", result: { ...done, moderation: "live" } };
      case "rejected":
        return { status: "failed", error: `YouTube rejected ${videoId}: ${status.rejectionReason ?? "unknown"}`, result: { ...done, moderation: "rejected" } };
      case "failed":
        return { status: "failed", error: `YouTube processing failed for ${videoId}: ${status.failureReason ?? "unknown"}` };
      case "deleted":
        return { status: "failed", error: `YouTube video ${videoId} was deleted`, result: { moderation: "removed" } };
    }
  }

  async postStats(externalId: string, account: OwnedAccount | undefined): Promise<PostStats> {
    const asOf = this.clock.iso();
    if (isDryId(externalId) || !account || !this.tokens.has(account)) return emptyStats(asOf);
    const res = await this.http.get<{ items?: VideoResource[] }>(withQuery(`${YOUTUBE_API}/videos`, { part: "statistics", id: externalId }), await this.auth(account, false));
    const s = res.data.items?.[0]?.statistics;
    if (!s) return emptyStats(asOf);
    return { asOf, views: num(s.viewCount), likes: num(s.likeCount), comments: num(s.commentCount), shares: null, saves: null, profileVisits: null, linkClicks: null };
  }

  private consumeInsert(): void {
    const today = this.clock.today();
    const q = this.opts.store.quota(INSERT_QUOTA_KEY);
    const used = q && q.windowStart === today ? q.used : 0;
    if (used >= this.insertLimit) throw new Error(`YouTube videos.insert quota spent for ${today} (${used}/${this.insertLimit})`);
    // Counted before the call: a failed insert may still have consumed Google's quota.
    this.opts.store.setQuota(INSERT_QUOTA_KEY, { windowStart: today, used: used + 1, limit: this.insertLimit });
  }

  /** Dry-run writes are never sent, so they never need (or refresh) a token. */
  private async auth(account: OwnedAccount, write: boolean): Promise<Record<string, string>> {
    if (this.opts.dryRun && (write || !this.tokens.has(account))) return {};
    return { authorization: `Bearer ${await this.tokens.get(account)}` };
  }
}
