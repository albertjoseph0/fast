/**
 * Instagram content publishing (Instagram API with Facebook Login, Graph API v26.0).
 *
 * Publishing is two-phase: publish() creates the media container(s) and returns a job;
 * poll() waits for the container's status_code to reach FINISHED and then calls
 * media_publish, which completes the already-approved content.publish action. AI and
 * paid-partnership labels go on the published container only (carousel children reject
 * is_ai_generated). A trial reel needs exactly one video, so a trial_reel request for slides
 * is published directly instead (as a single image or a carousel) and externalRef.mode says
 * which mode was used. Writes are dry-run by default and answered with "dry_" ids.
 */
import { createHash } from "node:crypto";
import type { Clock } from "../../core/ports.ts";
import type { ExternalJob, JobPoll, JobRef, OwnedAccount, PostStats } from "../../core/types.ts";
import { SystemClock } from "../../core/clock.ts";
import { HttpClient, HttpError, withQuery } from "../http.ts";
import type { HttpRequest } from "../http.ts";
import { AccountTokens, captionText, dryId, emptyStats, isDryId, mediaKind, num, publicUrls, requireAccount, requireLabels } from "./common.ts";
import type { PlatformPublisher, PublishRequest, SocialClientOptions } from "./common.ts";

export const ENV_VARS: readonly { name: string; purpose: string; required: boolean }[] = [
  {
    name: "<OwnedAccount.tokenSecretRef>",
    purpose: "Instagram (Facebook Login) user or system-user access token with instagram_basic, instagram_content_publish and instagram_manage_insights, one env var per connected account",
    required: true,
  },
];

export const GRAPH_VERSION = "v26.0";
export const GRAPH_API = `https://graph.facebook.com/${GRAPH_VERSION}`;
export const CAROUSEL_MAX_ITEMS = 10;
const CAPTION_MAX = 2_200;
const INSIGHT_METRICS = ["views", "likes", "comments", "shares", "saved", "profile_visits"] as const;
/** profile_visits is not reported for every media product type; the retry drops it. */
const BASE_INSIGHT_METRICS = ["views", "likes", "comments", "shares", "saved"] as const;

type ContainerStatus = "EXPIRED" | "ERROR" | "FINISHED" | "IN_PROGRESS" | "PUBLISHED";

function igDryRunResponse(req: HttpRequest): unknown {
  const path = new URL(req.url).pathname;
  if (path.endsWith("/media_publish")) return { id: dryId("igmedia", req) };
  return { id: dryId("igcontainer", req) };
}

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export class InstagramClient implements PlatformPublisher {
  private readonly http: HttpClient;
  private readonly tokens: AccountTokens;
  private readonly clock: Clock;

  constructor(private readonly opts: SocialClientOptions) {
    this.clock = opts.clock ?? new SystemClock();
    this.http = new HttpClient({
      service: "instagram",
      dryRun: opts.dryRun,
      dryRunResponse: igDryRunResponse,
      ...(opts.recorder ? { recorder: opts.recorder } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
    });
    // Long-lived Facebook Login tokens are exchanged by the operator; no refresh grant here.
    this.tokens = new AccountTokens({ env: opts.env, clock: this.clock, oauth: this.http, tokenUrl: GRAPH_API, refreshForm: () => null });
  }

  async publish(req: PublishRequest): Promise<JobRef> {
    const { account, piece } = req;
    if (req.mode === "inbox_draft") throw new Error("Instagram has no draft API: publish as direct or trial_reel");
    const labels = requireLabels(req.labels.instagram, "instagram", piece.id);
    const igUserId = account.externalId;
    if (!igUserId) throw new Error(`instagram account ${account.id} has no externalId (IG user id)`);
    const urls = publicUrls(piece);
    const kinds = piece.media.map(mediaKind);
    const mode = req.mode === "trial_reel" && !(urls.length === 1 && kinds[0] === "video") ? "direct" : req.mode;
    const caption = captionText(piece).slice(0, CAPTION_MAX);
    const disclosure = { is_ai_generated: labels.is_ai_generated, is_paid_partnership: labels.is_paid_partnership };
    const ctx = { ventureId: piece.ventureId };

    let containerId: string;
    if (urls.length === 1) {
      const url = urls[0] as string;
      if (kinds[0] === "video") {
        containerId = await this.container(account, igUserId, {
          media_type: "REELS",
          video_url: url,
          caption,
          ...disclosure,
          ...(mode === "trial_reel" ? { trial_params: { graduation_strategy: "SS_PERFORMANCE" } } : {}),
        }, ctx);
      } else {
        containerId = await this.container(account, igUserId, { image_url: url, caption, ...disclosure }, ctx);
      }
    } else {
      if (urls.length > CAROUSEL_MAX_ITEMS) throw new Error(`content ${piece.id}: carousels hold at most ${CAROUSEL_MAX_ITEMS} items, got ${urls.length}`);
      const children: string[] = [];
      for (const [i, url] of urls.entries()) {
        const child = kinds[i] === "video" ? { media_type: "VIDEO", video_url: url, is_carousel_item: true } : { image_url: url, is_carousel_item: true };
        children.push(await this.container(account, igUserId, child, ctx));
      }
      containerId = await this.container(account, igUserId, { media_type: "CAROUSEL", children: children.join(","), caption, ...disclosure }, ctx);
    }
    return {
      op: "social.publish",
      externalRef: { platform: "instagram", accountId: account.id, contentId: piece.id, igUserId, containerId, captionSha: sha(caption), mode },
      pollAfterSec: kinds.includes("video") ? 60 : 10,
    };
  }

  async poll(job: ExternalJob, account: OwnedAccount | undefined): Promise<JobPoll> {
    const { containerId, igUserId } = job.externalRef;
    if (!containerId || !igUserId) return { status: "failed", error: "instagram job without containerId/igUserId" };
    if (isDryId(containerId)) {
      const res = await this.http.request<{ id: string }>({ method: "POST", url: `${GRAPH_API}/${igUserId}/media_publish`, json: { creation_id: containerId } });
      return { status: "succeeded", result: { externalId: res.data.id, moderation: "live", dryRun: true } };
    }
    const acct = requireAccount(account, job);
    const auth = await this.auth(acct);
    const status = await this.http.get<{ status_code?: ContainerStatus; status?: string }>(withQuery(`${GRAPH_API}/${containerId}`, { fields: "status_code,status" }), auth);
    switch (status.data.status_code) {
      case "IN_PROGRESS":
        return { status: "running", pollAfterSec: 60 };
      case "ERROR":
        return { status: "failed", error: `instagram container ${containerId}: ${status.data.status ?? "ERROR"}`, result: { moderation: "rejected" } };
      case "EXPIRED":
        return { status: "failed", error: `instagram container ${containerId} expired before publishing` };
      case "PUBLISHED": {
        // A previous poll published but its result was lost: recover the media by caption.
        const media = await this.findPublished(igUserId, job.externalRef.captionSha, auth);
        if (!media) return { status: "failed", error: `instagram container ${containerId} is published but its media was not found` };
        return { status: "succeeded", result: { externalId: media.id, ...(media.permalink ? { url: media.permalink } : {}), moderation: "live" } };
      }
      case "FINISHED": {
        const res = await this.http.request<{ id: string }>({
          method: "POST",
          url: `${GRAPH_API}/${igUserId}/media_publish`,
          headers: auth,
          json: { creation_id: containerId },
          context: { ...(job.ventureId ? { ventureId: job.ventureId } : {}), actionId: job.actionId },
        });
        const mediaId = res.data.id;
        const link = await this.http.get<{ permalink?: string }>(withQuery(`${GRAPH_API}/${mediaId}`, { fields: "permalink" }), auth);
        return { status: "succeeded", result: { externalId: mediaId, ...(link.data.permalink ? { url: link.data.permalink } : {}), moderation: "live" } };
      }
      default:
        return { status: "running", pollAfterSec: 60 };
    }
  }

  async postStats(externalId: string, account: OwnedAccount | undefined): Promise<PostStats> {
    const asOf = this.clock.iso();
    if (isDryId(externalId) || !account || !this.tokens.has(account)) return emptyStats(asOf);
    const auth = await this.auth(account);
    const fetchInsights = (metrics: readonly string[]) =>
      this.http.get<{ data?: { name: string; values?: { value: unknown }[]; total_value?: { value: unknown } }[] }>(
        withQuery(`${GRAPH_API}/${externalId}/insights`, { metric: metrics.join(",") }),
        auth,
      );
    let res;
    try {
      res = await fetchInsights(INSIGHT_METRICS);
    } catch (err) {
      if (!(err instanceof HttpError) || err.status !== 400) throw err;
      res = await fetchInsights(BASE_INSIGHT_METRICS);
    }
    const values: Record<string, number | null> = {};
    for (const row of res.data.data ?? []) values[row.name] = num(row.total_value?.value ?? row.values?.[0]?.value);
    return {
      asOf,
      views: values.views ?? null,
      likes: values.likes ?? null,
      comments: values.comments ?? null,
      shares: values.shares ?? null,
      saves: values.saved ?? null,
      profileVisits: values.profile_visits ?? null,
      linkClicks: null,
    };
  }

  private async container(account: OwnedAccount, igUserId: string, body: Record<string, unknown>, context: HttpRequest["context"]): Promise<string> {
    const res = await this.http.request<{ id: string }>({
      method: "POST",
      url: `${GRAPH_API}/${igUserId}/media`,
      headers: await this.auth(account),
      json: body,
      ...(context ? { context } : {}),
    });
    return res.data.id;
  }

  private async findPublished(igUserId: string, captionSha: string | undefined, auth: Record<string, string>): Promise<{ id: string; permalink?: string } | undefined> {
    const res = await this.http.get<{ data?: { id: string; caption?: string; permalink?: string }[] }>(
      withQuery(`${GRAPH_API}/${igUserId}/media`, { fields: "id,caption,permalink", limit: 25 }),
      auth,
    );
    return res.data.data?.find((m) => captionSha !== undefined && sha(m.caption ?? "") === captionSha);
  }

  private async auth(account: OwnedAccount): Promise<Record<string, string>> {
    if (this.opts.dryRun && !this.tokens.has(account)) return {};
    return { authorization: `Bearer ${await this.tokens.get(account)}` };
  }
}
