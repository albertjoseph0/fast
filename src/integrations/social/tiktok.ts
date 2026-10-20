/**
 * TikTok Content Posting API v2 (open.tiktokapis.com).
 *
 * Owned TikTok posts go as inbox drafts (MEDIA_UPLOAD / inbox video init) that a human
 * finishes in the app, because TikTok's audit rejects uploaders for your own accounts.
 * Direct posting is refused unless this adapter is constructed with audited: true, and the
 * privacy level is always one that creator_info offers (TikTok forbids defaults otherwise).
 * Inbox drafts (video init accepts no post_info, photo MEDIA_UPLOAD ignores the toggles) carry
 * no AI or commercial labels, so the human must turn them on when posting: the first poll that
 * sees the draft reports needs_human with result.labelsToApply, and the job only resumes once a
 * human has been asked. Stats come from the Display API.
 */
import type { Clock } from "../../core/ports.ts";
import type { ExternalJob, JobPoll, JobRef, OwnedAccount, PlatformLabels, PostStats } from "../../core/types.ts";
import { SystemClock } from "../../core/clock.ts";
import { HttpClient, withQuery } from "../http.ts";
import type { HttpRequest } from "../http.ts";
import { AccountTokens, bigIntSafeFetch, captionText, clip, dryId, emptyStats, isDryId, mediaKind, num, publicUrls, requireAccount, requireLabels } from "./common.ts";
import type { PlatformPublisher, PublishRequest, SocialClientOptions } from "./common.ts";

export const ENV_VARS: readonly { name: string; purpose: string; required: boolean }[] = [
  { name: "<OwnedAccount.tokenSecretRef>", purpose: "TikTok user access token (video.upload, video.publish when audited, video.list) for the connected account", required: true },
  { name: "<OwnedAccount.tokenSecretRef>_REFRESH_TOKEN", purpose: "TikTok refresh token; with the client key/secret, access tokens are refreshed automatically", required: false },
  { name: "TIKTOK_CLIENT_KEY", purpose: "TikTok developer app client key (token refresh)", required: false },
  { name: "TIKTOK_CLIENT_SECRET", purpose: "TikTok developer app client secret (token refresh)", required: false },
];

export const TIKTOK_API = "https://open.tiktokapis.com/v2";
export const PHOTO_MAX_ITEMS = 35;
const PHOTO_TITLE_MAX = 90;
const PHOTO_DESCRIPTION_MAX = 4_000;
const VIDEO_TITLE_MAX = 2_200;

export type PrivacyLevel = "PUBLIC_TO_EVERYONE" | "MUTUAL_FOLLOW_FRIENDS" | "FOLLOWER_OF_CREATOR" | "SELF_ONLY";
/** Most to least reach; the first one creator_info offers wins. */
const PRIVACY_PREFERENCE: readonly PrivacyLevel[] = ["PUBLIC_TO_EVERYONE", "FOLLOWER_OF_CREATOR", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"];
/** Recorded in credential-less dry-runs only; a live post always uses creator_info's options. */
export const OFFLINE_PRIVACY = "<from creator_info>";

export interface CreatorInfo {
  creator_username?: string;
  privacy_level_options?: string[];
  comment_disabled?: boolean;
  duet_disabled?: boolean;
  stitch_disabled?: boolean;
  max_video_post_duration_sec?: number;
}

interface TikTokEnvelope<T> {
  data?: T;
  error?: { code?: string; message?: string; log_id?: string; logid?: string };
}

export interface TikTokClientOptions extends SocialClientOptions {
  /** Defence in depth: direct posting also needs the client to have passed TikTok's audit. */
  audited?: boolean;
}

/**
 * Pick the privacy level for a direct post from creator_info's options. Branded content
 * cannot be private, so SELF_ONLY is excluded when brand_content_toggle is on.
 */
export function choosePrivacy(options: readonly string[] | undefined, branded: boolean): PrivacyLevel {
  const offered = new Set(options ?? []);
  const level = PRIVACY_PREFERENCE.find((p) => offered.has(p) && !(branded && p === "SELF_ONLY"));
  if (!level) throw new Error(`TikTok creator_info offers no usable privacy level (options: ${[...offered].join(", ") || "none"}${branded ? "; branded content cannot be SELF_ONLY" : ""})`);
  return level;
}

function tiktokDryRunResponse(req: HttpRequest): unknown {
  return { data: { publish_id: dryId("ttpublish", req) }, error: { code: "ok", message: "" } };
}

function unwrap<T>(body: TikTokEnvelope<T>, what: string): T {
  const code = body.error?.code;
  if (code && code !== "ok") throw new Error(`TikTok ${what}: ${code} ${body.error?.message ?? ""} (log ${body.error?.log_id ?? body.error?.logid ?? "?"})`.trim());
  if (!body.data) throw new Error(`TikTok ${what}: empty response`);
  return body.data;
}

export class TikTokClient implements PlatformPublisher {
  private readonly http: HttpClient;
  private readonly tokens: AccountTokens;
  private readonly clock: Clock;

  constructor(private readonly opts: TikTokClientOptions) {
    this.clock = opts.clock ?? new SystemClock();
    this.http = new HttpClient({
      service: "tiktok",
      dryRun: opts.dryRun,
      dryRunResponse: tiktokDryRunResponse,
      ...(opts.recorder ? { recorder: opts.recorder } : {}),
      fetch: bigIntSafeFetch(opts.fetch ?? fetch),
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
    });
    const { TIKTOK_CLIENT_KEY: key, TIKTOK_CLIENT_SECRET: secret } = opts.env;
    this.tokens = new AccountTokens({
      env: opts.env,
      clock: this.clock,
      oauth: this.http,
      tokenUrl: `${TIKTOK_API}/oauth/token/`,
      refreshForm: (refresh) => (key && secret ? { client_key: key, client_secret: secret, grant_type: "refresh_token", refresh_token: refresh } : null),
    });
  }

  async creatorInfo(account: OwnedAccount): Promise<CreatorInfo> {
    const res = await this.http.request<TikTokEnvelope<CreatorInfo>>({
      method: "POST",
      url: `${TIKTOK_API}/post/publish/creator_info/query/`,
      headers: { ...(await this.auth(account, false)), "content-type": "application/json; charset=UTF-8" },
      sideEffect: false,
    });
    return unwrap(res.data, "creator_info");
  }

  /**
   * creator_info for a direct post. A dry-run without credentials cannot ask TikTok, so the
   * recorded body carries a placeholder that is never sent.
   */
  private async directCreatorInfo(account: OwnedAccount): Promise<CreatorInfo | "offline"> {
    if (this.opts.dryRun && !this.tokens.has(account)) return "offline";
    return this.creatorInfo(account);
  }

  async publish(req: PublishRequest): Promise<JobRef> {
    const { account, piece, mode } = req;
    if (mode === "trial_reel") throw new Error("trial reels are Instagram-only; TikTok posts are inbox drafts or direct posts");
    if (mode === "direct" && !this.opts.audited) throw new Error("TikTok direct posting refused: the API client is not audited (construct with audited: true after TikTok's content audit)");
    const labels = requireLabels(req.labels.tiktok, "tiktok", piece.id);
    const urls = publicUrls(piece);
    const kinds = piece.media.map(mediaKind);
    const isVideo = kinds[0] === "video";
    if (isVideo && urls.length !== 1) throw new Error(`content ${piece.id}: a TikTok video post takes exactly one video`);
    if (!isVideo && kinds.includes("video")) throw new Error(`content ${piece.id}: TikTok photo posts cannot mix in video`);
    if (urls.length > PHOTO_MAX_ITEMS) throw new Error(`content ${piece.id}: TikTok photo posts hold at most ${PHOTO_MAX_ITEMS} images`);

    const caption = captionText(piece);
    const info = mode === "direct" ? await this.directCreatorInfo(account) : undefined;
    let url: string;
    let body: Record<string, unknown>;
    if (isVideo) {
      const source_info = { source: "PULL_FROM_URL", video_url: urls[0] };
      if (mode === "inbox_draft") {
        url = `${TIKTOK_API}/post/publish/inbox/video/init/`;
        body = { source_info };
      } else {
        url = `${TIKTOK_API}/post/publish/video/init/`;
        body = { post_info: { title: clip(caption, VIDEO_TITLE_MAX), ...directPostInfo(info as CreatorInfo | "offline", labels, true), is_aigc: labels.is_aigc }, source_info };
      }
    } else {
      url = `${TIKTOK_API}/post/publish/content/init/`;
      const text = { title: clip(piece.draft.hook, PHOTO_TITLE_MAX), description: clip(caption, PHOTO_DESCRIPTION_MAX) };
      body = {
        media_type: "PHOTO",
        post_mode: mode === "direct" ? "DIRECT_POST" : "MEDIA_UPLOAD",
        post_info: mode === "direct" ? { ...text, ...directPostInfo(info as CreatorInfo | "offline", labels, false), auto_add_music: true } : text,
        source_info: { source: "PULL_FROM_URL", photo_cover_index: 0, photo_images: urls },
        is_aigc: labels.is_aigc,
      };
    }
    const res = await this.http.request<TikTokEnvelope<{ publish_id: string }>>({
      method: "POST",
      url,
      headers: { ...(await this.auth(account, true)), "content-type": "application/json; charset=UTF-8" },
      json: body,
      context: { ventureId: piece.ventureId },
    });
    const { publish_id } = unwrap(res.data, "post init");
    return {
      op: "social.publish",
      externalRef: {
        platform: "tiktok",
        accountId: account.id,
        contentId: piece.id,
        publishId: publish_id,
        mode,
        kind: isVideo ? "video" : "photo",
        ...(mode === "inbox_draft" ? { labelsToApplyInApp: labelList(labels).join(",") } : {}),
      },
      pollAfterSec: 30,
    };
  }

  async poll(job: ExternalJob, account: OwnedAccount | undefined): Promise<JobPoll> {
    const publishId = job.externalRef.publishId;
    if (!publishId) return { status: "failed", error: "tiktok job without publishId" };
    if (isDryId(publishId)) return { status: "succeeded", result: { externalId: publishId.replace("ttpublish", "ttpost"), moderation: "live", dryRun: true } };
    const acct = requireAccount(account, job);
    const res = await this.http.request<TikTokEnvelope<{ status: string; fail_reason?: string; publicaly_available_post_id?: (number | string)[] }>>({
      method: "POST",
      url: `${TIKTOK_API}/post/publish/status/fetch/`,
      headers: { ...(await this.auth(acct, false)), "content-type": "application/json; charset=UTF-8" },
      json: { publish_id: publishId },
      sideEffect: false,
    });
    const data = unwrap(res.data, "status fetch");
    const draft = job.externalRef.mode === "inbox_draft";
    const waiting = { moderation: "pending_human", labelsToApply: inAppLabels(job.externalRef.labelsToApplyInApp) };
    // A draft is never trusted to be labelled until a human was told exactly which labels to turn on.
    // The marker lives in job.result, which the orchestrator keeps when it re-arms the job.
    if (draft && job.result?.["labelsToApply"] === undefined && (data.status === "SEND_TO_USER_INBOX" || data.status === "PUBLISH_COMPLETE")) {
      return { status: "needs_human", result: waiting };
    }
    switch (data.status) {
      case "PROCESSING_UPLOAD":
      case "PROCESSING_DOWNLOAD":
        return { status: "running", pollAfterSec: 30 };
      case "SEND_TO_USER_INBOX":
        // The human was asked to finish the draft in the TikTok app; keep waiting for PUBLISH_COMPLETE.
        return { status: "running", pollAfterSec: 3_600, result: draft ? waiting : { moderation: "pending_human" } };
      case "PUBLISH_COMPLETE": {
        const postId = data.publicaly_available_post_id?.[0];
        if (postId === undefined) {
          // Posted but not (yet) public: still under moderation, or a private post.
          return job.attempts < 48 ? { status: "running", pollAfterSec: 1_800 } : { status: "succeeded", result: { moderation: "private" } };
        }
        const handle = acct.handle.replace(/^@/, "");
        return { status: "succeeded", result: { externalId: String(postId), url: `https://www.tiktok.com/@${handle}/${job.externalRef.kind ?? "video"}/${postId}`, moderation: "live" } };
      }
      case "FAILED":
        return { status: "failed", error: `TikTok publish failed: ${data.fail_reason ?? "unknown"}`, result: { moderation: "rejected" } };
      default:
        return { status: "running", pollAfterSec: 60 };
    }
  }

  async postStats(externalId: string, account: OwnedAccount | undefined): Promise<PostStats> {
    const asOf = this.clock.iso();
    if (isDryId(externalId) || !account || !this.tokens.has(account)) return emptyStats(asOf);
    const res = await this.http.request<TikTokEnvelope<{ videos?: { id: string; view_count?: number; like_count?: number; comment_count?: number; share_count?: number }[] }>>({
      method: "POST",
      url: withQuery(`${TIKTOK_API}/video/query/`, { fields: "id,view_count,like_count,comment_count,share_count" }),
      headers: { ...(await this.auth(account, false)), "content-type": "application/json; charset=UTF-8" },
      json: { filters: { video_ids: [externalId] } },
      sideEffect: false,
    });
    const v = unwrap(res.data, "video query").videos?.find((x) => String(x.id) === externalId);
    if (!v) return emptyStats(asOf);
    return { asOf, views: num(v.view_count), likes: num(v.like_count), comments: num(v.comment_count), shares: num(v.share_count), saves: null, profileVisits: null, linkClicks: null };
  }

  /** Dry-run writes are never sent, so they never need (or refresh) a token. */
  private async auth(account: OwnedAccount, write: boolean): Promise<Record<string, string>> {
    if (this.opts.dryRun && (write || !this.tokens.has(account))) return {};
    return { authorization: `Bearer ${await this.tokens.get(account)}` };
  }
}

/** Interaction settings honour what the creator disabled; everything else starts unchecked. */
function directPostInfo(creator: CreatorInfo | "offline", labels: NonNullable<PlatformLabels["tiktok"]>, video: boolean): Record<string, unknown> {
  const info: CreatorInfo = creator === "offline" ? {} : creator;
  return {
    privacy_level: creator === "offline" ? OFFLINE_PRIVACY : choosePrivacy(info.privacy_level_options, labels.brand_content_toggle),
    disable_comment: Boolean(info.comment_disabled),
    ...(video ? { disable_duet: Boolean(info.duet_disabled), disable_stitch: Boolean(info.stitch_disabled) } : {}),
    brand_content_toggle: labels.brand_content_toggle,
    brand_organic_toggle: labels.brand_organic_toggle,
  };
}

function labelList(labels: NonNullable<PlatformLabels["tiktok"]>): string[] {
  return [labels.is_aigc ? "ai_generated" : "", labels.brand_organic_toggle ? "your_brand" : "", labels.brand_content_toggle ? "branded_content" : ""].filter(Boolean);
}

/** The settings a human turns on in the TikTok app, named as the app names them. */
const IN_APP_LABEL: Record<string, string> = {
  ai_generated: "AI-generated content",
  your_brand: "Content disclosure: Your brand",
  branded_content: "Content disclosure: Branded content",
};

/** In-app label names for a job's labelsToApplyInApp ids. */
function inAppLabels(ids: string | undefined): string[] {
  return (ids ?? "").split(",").filter(Boolean).map((id) => IN_APP_LABEL[id] ?? id);
}
