/**
 * SideShift Platform API (REST, https://app.sideshift.app/api/oauth/v1, scoped Platform API
 * key in x-api-key) and the live CreatorRead / CreatorWrite ports.
 *
 * SideShift has no single "submission" object: a creator uploads a draft (a video
 * submission on their contract), and once it is approved they post it publicly, where
 * SideShift tracks the post and syncs its metrics from the platform. A studio submission
 * therefore has a stable external id that survives the draft → post step:
 *   vs:<campaignId>:<videoSubmissionId>   a draft, later paired with the post it became
 *   post:<campaignId>:<postId>            a tracked post with no reviewed draft before it
 * A post is paired with the creator's oldest unpaired draft approved no later than the
 * post's upload time. Pairings an earlier sync already exposed (the studio's submission has
 * the post's URL or upload time) are kept, and a post already exposed under its own post: id
 * is never paired later, so an id never changes meaning between syncs.
 *
 * SideShift's Post carries no disclosure field, so the paid-partnership check accepts an
 * explicit label when SideShift reports one, and otherwise a disclosure hashtag in the live
 * caption, which the brief asks creators to add.
 *
 * Payouts go through POST /payouts/execute with a per-contract custom amount (computed by
 * governance from verified views): first a SideShift dry run (dryRun: true) whose plan must
 * be clean, then the real execution, each with its own Idempotency-Key derived from the
 * action's key. All writes are dry-run by default ("dry_" ids); in dry-run without an API
 * key, reads return nothing.
 */
import { createHash } from "node:crypto";
import type { Clock, CreatorProfile, CreatorRead, CreatorWrite } from "../../core/ports.ts";
import type { StudioStore } from "../../core/store.ts";
import type { StudioConfig } from "../../config/schema.ts";
import { Platform } from "../../core/types.ts";
import type { Cents, CreatorCampaign, CreatorDeal, ExternalSubmission, Payout, SubmissionVerification } from "../../core/types.ts";
import { SystemClock } from "../../core/clock.ts";
import { HttpClient, HttpError, withQuery } from "../http.ts";
import type { DryRunRecorder, HttpRequest } from "../http.ts";
import { verifyByOembed } from "./oembed.ts";

export const ENV_VARS: readonly { name: string; purpose: string; required: boolean }[] = [
  {
    name: "SIDESHIFT_API_KEY",
    purpose:
      "SideShift scoped Platform API key (Settings → Integrations): campaigns, jobs, contracts, applications, video-submissions, posts, messages, payouts, wallet, recruit scopes",
    required: true,
  },
  { name: "SIDESHIFT_API_BASE", purpose: "Platform API base URL (default https://app.sideshift.app/api/oauth/v1)", required: false },
  { name: "SIDESHIFT_ACT_AS_COMPANY", purpose: "Company id sent as X-Act-As-Company when the key can act for several companies", required: false },
  {
    name: "SIDESHIFT_JOB_IMAGE_URL",
    purpose: "HTTPS cover image for marketplace job posts; without it campaigns are created but not posted to the marketplace (creators join by invite)",
    required: false,
  },
  { name: "INSTAGRAM_OEMBED_TOKEN", purpose: "Meta app access token for Instagram oEmbed author checks (TikTok and YouTube oEmbed need none)", required: false },
];

export const SIDESHIFT_API_BASE = "https://app.sideshift.app/api/oauth/v1";

export interface SideShiftOptions {
  config: StudioConfig;
  store: StudioStore;
  env: Record<string, string | undefined>;
  dryRun: boolean;
  recorder?: DryRunRecorder;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  clock?: Clock;
}

type Json = Record<string, unknown>;

interface Page<T> {
  data: T[];
  nextCursor?: string | null;
  hasMore?: boolean;
}

export interface SsVideoSubmission {
  id: string;
  contractId?: string;
  creatorId?: string;
  programId?: string;
  status?: string;
  submittedAt?: string | null;
  reviewedAt?: string | null;
  captionIdeas?: string | null;
  notes?: string | null;
  creatorName?: string | null;
}

export interface SsPost extends Json {
  id: string;
}

export interface SsContract extends Json {
  id: string;
  contractorId?: string;
  programId?: string;
  status?: string;
}

export interface SsApplication extends Json {
  id: string;
  programId?: string;
  handle?: string;
  platform?: string | null;
  status?: string;
  creator?: Json;
}

function hash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

/** Synthetic SideShift envelope for a dry-run write; ids start with "dry_". */
export function sideshiftDryRunResponse(req: HttpRequest): unknown {
  const id = `dry_ss_${hash(`${req.url} ${JSON.stringify(req.json ?? null)}`)}`;
  const body = (req.json ?? {}) as Json;
  const contractIds = Array.isArray(body.contractIds) ? (body.contractIds as string[]) : [];
  return {
    data: {
      id,
      jobId: id,
      messageId: id,
      success: true,
      dryRun: true,
      plan: [],
      results: contractIds.map((contractId) => ({ contractId, status: "dry_run", payoutId: `${id}_${contractId}` })),
    },
  };
}

/** Lowercase handle without a leading "@". */
export function normalizeHandle(handle: string): string {
  return handle.trim().replace(/^@+/, "").toLowerCase();
}

/** SideShift timestamps arrive as ISO strings, epoch seconds or epoch milliseconds. */
export function toIso(v: unknown): string | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  if (typeof v === "string" && v) {
    if (/^\d+$/.test(v)) return toIso(Number(v));
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
  }
  if (v && typeof v === "object" && "_seconds" in v) return toIso((v as { _seconds: number })._seconds);
  return undefined;
}

function s(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}

function platformOf(v: unknown): Platform | null {
  const p = s(v).toLowerCase();
  return (Platform.options as string[]).includes(p) ? (p as Platform) : null;
}

/** Post URL from a tracked post (the schema is permissive; these are the names SideShift uses elsewhere). */
export function postUrlOf(post: Json): string | undefined {
  for (const k of ["url", "postUrl", "videoUrl", "link", "permalink"]) {
    const v = post[k];
    if (typeof v === "string" && /^https:\/\//.test(v)) return v;
  }
  return undefined;
}

const DISCLOSURE_KEYS = ["isBrandedContent", "brandedContent", "paidPartnership", "isPaidPartnership", "isAd", "adLabel", "commercialContent", "isCommercialContent"];
const DISCLOSURE_TAG = /(^|[^\p{L}\p{N}_])#(ad|sponsored|paidpartnership|advertisement)(?![\p{L}\p{N}_])/iu;
/** Caption line the brief asks for, so the live caption check has something to find. */
export const DISCLOSURE_REQUIREMENT = "Disclosure: turn on the platform's paid-partnership or branded-content label and put #ad in the caption.";

/** True when the post explicitly carries a paid-partnership label, or its live caption discloses with #ad (or #sponsored). */
export function disclosureLabelOf(post: Json): boolean {
  return DISCLOSURE_KEYS.some((k) => post[k] === true) || DISCLOSURE_TAG.test(s(post.title));
}

export class SideShiftClient {
  private readonly http: HttpClient;
  readonly base: string;

  constructor(private readonly opts: SideShiftOptions) {
    this.base = (opts.env.SIDESHIFT_API_BASE ?? SIDESHIFT_API_BASE).replace(/\/+$/, "");
    this.http = new HttpClient({
      service: "sideshift",
      dryRun: opts.dryRun,
      dryRunResponse: sideshiftDryRunResponse,
      defaultHeaders: () => this.authHeaders(),
      ...(opts.recorder ? { recorder: opts.recorder } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
    });
  }

  /** Dry-run without a key: nothing reaches SideShift and reads come back empty. */
  get offline(): boolean {
    return this.opts.dryRun && !this.opts.env.SIDESHIFT_API_KEY;
  }

  private authHeaders(): Record<string, string> {
    const key = this.opts.env.SIDESHIFT_API_KEY;
    if (!key) {
      if (this.opts.dryRun) return {};
      throw new Error("sideshift: SIDESHIFT_API_KEY is not set");
    }
    const company = this.opts.env.SIDESHIFT_ACT_AS_COMPANY;
    return { "x-api-key": key, ...(company ? { "x-act-as-company": company } : {}) };
  }

  url(path: string, query: Record<string, string | number | boolean | undefined> = {}): string {
    return withQuery(`${this.base}${path}`, query);
  }

  async get<T>(path: string, query: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
    return (await this.http.get<T>(this.url(path, query))).data;
  }

  /** Writes always carry an Idempotency-Key so a retry can never apply twice. */
  async write<T>(method: "POST" | "PATCH", path: string, json: unknown, idempotencyKey: string): Promise<T> {
    return (await this.http.request<T>({ method, url: this.url(path), json, idempotencyKey })).data;
  }

  /** Read-only POST (searches). */
  async search<T>(path: string, json: unknown): Promise<T> {
    if (this.offline) return { data: {} } as T;
    return (await this.http.request<T>({ method: "POST", url: this.url(path), json, sideEffect: false })).data;
  }

  /** Every page of a cursor-paginated list. */
  async list<T>(path: string, query: Record<string, string | number | boolean | undefined> = {}): Promise<T[]> {
    if (this.offline) return [];
    const out: T[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.get<Page<T>>(path, { ...query, limit: 100, cursor });
      out.push(...(page.data ?? []));
      cursor = page.hasMore && page.nextCursor ? page.nextCursor : undefined;
    } while (cursor);
    return out;
  }

  async listVideoSubmissions(programId: string): Promise<SsVideoSubmission[]> {
    if (this.offline) return [];
    const out: SsVideoSubmission[] = [];
    let startAfter: string | undefined;
    do {
      const res = await this.get<{ data: { submissions?: SsVideoSubmission[]; pagination?: { hasMore?: boolean; nextCursor?: string } } }>("/video-submissions", {
        programId,
        orderBy: "submittedAt",
        orderDirection: "asc",
        limit: 100,
        startAfter,
      });
      out.push(...(res.data.submissions ?? []));
      startAfter = res.data.pagination?.hasMore ? res.data.pagination.nextCursor : undefined;
    } while (startAfter);
    return out;
  }

  async getPost(id: string): Promise<SsPost | null> {
    if (this.offline || id.startsWith("dry_")) return null;
    try {
      return (await this.get<{ data: SsPost }>(`/posts/${encodeURIComponent(id)}`)).data;
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return null;
      throw err;
    }
  }

  async walletBalanceCents(): Promise<Cents> {
    if (this.offline) return 0;
    const res = await this.get<{ data: { balanceCents?: number } }>("/wallet/balance");
    return Math.max(0, Math.round(res.data.balanceCents ?? 0));
  }
}

/** One campaign's drafts, posts and creators, with posts paired to drafts. */
export interface CampaignSnapshot {
  campaignId: string;
  drafts: SsVideoSubmission[];
  posts: SsPost[];
  /** draft id → paired post */
  pairedPost: Map<string, SsPost>;
  /** post id → paired draft id */
  pairedDraft: Map<string, string>;
  contractOfCreator: Map<string, string>;
  /** creator id → the handles from their applications to this campaign, one per platform */
  handlesOfCreator: Map<string, { handle: string; platform: Platform | null }[]>;
  creatorOfPost: Map<string, string>;
}

/** The creator's handle on a platform, else their only handle when the platform is unknown. */
function handleOn(snap: CampaignSnapshot, creator: string, platform: Platform | null): string | undefined {
  const known = snap.handlesOfCreator.get(creator) ?? [];
  return (known.find((k) => k.platform === platform) ?? (platform === null && known.length === 1 ? known[0] : undefined))?.handle;
}

function ms(iso: string | undefined): number {
  return iso ? new Date(iso).getTime() : Number.NaN;
}

function creatorIdOf(app: SsApplication): string {
  const c = app.creator ?? {};
  return s(c.id) || s(c.contractorId) || s(c.userId) || s(c.creatorId);
}

/** Pairings earlier syncs exposed: draft id → its post id (null when that post is no longer listed), and posts exposed on their own. */
export interface PriorPairing {
  drafts: Map<string, string | null>;
  standalone: Set<string>;
}

/**
 * Pair each post with the creator's oldest unpaired draft approved at or before the post's
 * upload. Prior pairings stand; their drafts and posts, and standalone posts, are never re-paired.
 */
export function pairPosts(
  drafts: SsVideoSubmission[],
  posts: SsPost[],
  creatorOfPost: Map<string, string>,
  prior: PriorPairing = { drafts: new Map(), standalone: new Set() },
): { pairedPost: Map<string, SsPost>; pairedDraft: Map<string, string> } {
  const pairedPost = new Map<string, SsPost>();
  const pairedDraft = new Map<string, string>();
  for (const [draftId, postId] of prior.drafts) {
    const post = postId === null ? undefined : posts.find((p) => p.id === postId);
    if (!post) continue;
    pairedPost.set(draftId, post);
    pairedDraft.set(post.id, draftId);
  }
  const approved = drafts
    .filter((d) => d.status === "approved" && d.creatorId && Number.isFinite(ms(toIso(d.reviewedAt))))
    .sort((a, b) => ms(toIso(a.reviewedAt)) - ms(toIso(b.reviewedAt)) || a.id.localeCompare(b.id));
  const ordered = [...posts].sort((a, b) => (ms(toIso(a.uploadedAt)) || 0) - (ms(toIso(b.uploadedAt)) || 0) || a.id.localeCompare(b.id));
  for (const post of ordered) {
    if (pairedDraft.has(post.id) || prior.standalone.has(post.id)) continue;
    const creator = creatorOfPost.get(post.id);
    const uploaded = ms(toIso(post.uploadedAt));
    if (!creator || !Number.isFinite(uploaded)) continue;
    const draft = approved.find((d) => d.creatorId === creator && !pairedPost.has(d.id) && !prior.drafts.has(d.id) && ms(toIso(d.reviewedAt)) <= uploaded);
    if (!draft) continue;
    pairedPost.set(draft.id, post);
    pairedDraft.set(post.id, draft.id);
  }
  return { pairedPost, pairedDraft };
}

export function parseSubmissionId(externalId: string): { kind: "vs" | "post"; campaignId: string; id: string } {
  const m = /^(vs|post):([^:]+):(.+)$/.exec(externalId);
  if (!m) throw new Error(`sideshift: not a SideShift submission id: ${externalId}`);
  return { kind: m[1] as "vs" | "post", campaignId: m[2] as string, id: m[3] as string };
}

class Snapshots {
  private readonly cache = new Map<string, CampaignSnapshot>();

  constructor(
    private readonly client: SideShiftClient,
    private readonly store: StudioStore,
  ) {}

  /**
   * What the studio already holds for this campaign: a vs: submission with a post URL or post
   * time was paired, and keeps the post that URL (else upload time and creator) names.
   */
  private prior(campaignId: string, drafts: SsVideoSubmission[], posts: SsPost[], creatorOfPost: Map<string, string>): PriorPairing {
    const out: PriorPairing = { drafts: new Map(), standalone: new Set() };
    for (const sub of this.store.submissions.list((x) => x.externalId.startsWith(`vs:${campaignId}:`) || x.externalId.startsWith(`post:${campaignId}:`))) {
      const ref = parseSubmissionId(sub.externalId);
      if (ref.kind === "post") {
        out.standalone.add(ref.id);
        continue;
      }
      if (!sub.postUrl && !sub.postedAt) continue;
      const creator = drafts.find((d) => d.id === ref.id)?.creatorId;
      const post =
        (sub.postUrl ? posts.find((p) => postUrlOf(p) === sub.postUrl) : undefined) ??
        (sub.postedAt && creator ? posts.find((p) => creatorOfPost.get(p.id) === creator && toIso(p.uploadedAt) === sub.postedAt) : undefined);
      out.drafts.set(ref.id, post?.id ?? null);
    }
    return out;
  }

  async load(campaignId: string): Promise<CampaignSnapshot> {
    const c = this.client;
    const [drafts, posts, contracts, applications] = await Promise.all([
      c.listVideoSubmissions(campaignId),
      c.list<SsPost>("/posts", { program: campaignId }),
      c.list<SsContract>("/contracts", { programId: campaignId }),
      c.list<SsApplication>("/applications"),
    ]);
    const contractOfCreator = new Map<string, string>();
    const creatorOfContract = new Map<string, string>();
    for (const k of contracts) {
      const creator = s(k.contractorId);
      if (!creator) continue;
      creatorOfContract.set(k.id, creator);
      if (!contractOfCreator.has(creator) || k.status === "active") contractOfCreator.set(creator, k.id);
    }
    for (const d of drafts) if (d.creatorId && d.contractId && !contractOfCreator.has(d.creatorId)) contractOfCreator.set(d.creatorId, d.contractId);
    const handlesOfCreator = new Map<string, { handle: string; platform: Platform | null }[]>();
    const creatorOfHandle = new Map<string, string>();
    for (const a of applications) {
      if (a.programId !== campaignId || !a.handle) continue;
      const creator = creatorIdOf(a);
      if (!creator) continue;
      const entry = { handle: normalizeHandle(a.handle), platform: platformOf(a.platform) };
      const known = handlesOfCreator.get(creator) ?? [];
      const i = known.findIndex((k) => k.platform === entry.platform);
      if (i < 0) known.push(entry);
      else if (a.status === "approved") known[i] = entry;
      handlesOfCreator.set(creator, known);
      creatorOfHandle.set(entry.handle, creator);
    }
    const creatorOfPost = new Map<string, string>();
    for (const p of posts) {
      const creator = creatorOfContract.get(s(p.contractId)) || s(p.creatorId) || s(p.contractorId) || creatorOfHandle.get(normalizeHandle(s(p.creator)));
      if (creator) creatorOfPost.set(p.id, creator);
    }
    const prior = this.prior(campaignId, drafts, posts, creatorOfPost);
    const snap: CampaignSnapshot = { campaignId, drafts, posts, ...pairPosts(drafts, posts, creatorOfPost, prior), contractOfCreator, handlesOfCreator, creatorOfPost };
    this.cache.set(campaignId, snap);
    return snap;
  }

  /** Cached snapshot, refreshed when it does not know the id (or its post) yet. */
  async resolve(externalId: string, needPost: boolean): Promise<{ snap: CampaignSnapshot; draft?: SsVideoSubmission; post?: SsPost }> {
    const ref = parseSubmissionId(externalId);
    const find = (snap: CampaignSnapshot) => {
      if (ref.kind === "post") {
        const post = snap.posts.find((p) => p.id === ref.id);
        return post ? { snap, post } : null;
      }
      const draft = snap.drafts.find((d) => d.id === ref.id);
      if (!draft) return null;
      const post = snap.pairedPost.get(draft.id);
      if (needPost && !post) return null;
      return { snap, draft, ...(post ? { post } : {}) };
    };
    const cached = this.cache.get(ref.campaignId);
    const hit = cached ? find(cached) : null;
    if (hit) return hit;
    const fresh = await this.load(ref.campaignId);
    const found = find(fresh);
    if (!found) throw new Error(`sideshift: ${externalId} not found${needPost ? " with a tracked post" : ""}`);
    return found;
  }
}

function caption(d: SsVideoSubmission): string {
  return [d.captionIdeas, d.notes].filter((x): x is string => typeof x === "string" && x.length > 0).join("\n");
}

/** Live-post facts the marketplace reports: when it went up, its caption and its current views. */
function postFacts(post: SsPost): Pick<ExternalSubmission, "postUrl" | "postedAt" | "untrustedPostCaption" | "views"> {
  const url = postUrlOf(post);
  const postedAt = toIso(post.uploadedAt);
  const views = Number(post.views);
  return {
    ...(url ? { postUrl: url } : {}),
    ...(postedAt ? { postedAt } : {}),
    ...(typeof post.title === "string" ? { untrustedPostCaption: post.title } : {}),
    ...(post.views !== undefined && post.views !== null && Number.isFinite(views) ? { views: Math.max(0, Math.round(views)) } : {}),
  };
}

/** Snapshot → port submissions: unpaired drafts, drafts that became posts, and posts without a draft. */
export function toExternalSubmissions(snap: CampaignSnapshot): ExternalSubmission[] {
  const out: ExternalSubmission[] = [];
  // A post's own platform wins; a draft takes the platform of the creator's application.
  const who = (creator: string, fallbackHandle: string, post: SsPost | undefined) => {
    const known = snap.handlesOfCreator.get(creator) ?? [];
    const platform = platformOf(post?.platform) ?? (post ? null : (known.find((k) => k.platform)?.platform ?? null));
    const handle = handleOn(snap, creator, platform) ?? (normalizeHandle(fallbackHandle) || known[0]?.handle || "");
    return { handle, platform: platform ?? known[0]?.platform ?? "tiktok" };
  };
  for (const d of snap.drafts) {
    if (!d.creatorId) continue;
    const post = snap.pairedPost.get(d.id);
    const { handle, platform } = who(d.creatorId, s(post?.creator) || s(d.creatorName), post);
    out.push({
      externalId: `vs:${snap.campaignId}:${d.id}`,
      campaignExternalId: snap.campaignId,
      creatorExternalId: d.creatorId,
      creatorHandle: handle,
      platform,
      untrustedCaption: caption(d),
      stage: post ? "posted" : "draft_submitted",
      submittedAt: (post ? toIso(post.uploadedAt) : undefined) ?? toIso(d.submittedAt) ?? new Date(0).toISOString(),
      ...(post ? postFacts(post) : {}),
    });
  }
  for (const p of snap.posts) {
    const creator = snap.creatorOfPost.get(p.id);
    if (!creator || snap.pairedDraft.has(p.id)) continue;
    const { handle, platform } = who(creator, s(p.creator), p);
    out.push({
      externalId: `post:${snap.campaignId}:${p.id}`,
      campaignExternalId: snap.campaignId,
      creatorExternalId: creator,
      creatorHandle: handle,
      platform,
      untrustedCaption: s(p.title),
      stage: "posted",
      submittedAt: toIso(p.uploadedAt) ?? new Date(0).toISOString(),
      ...postFacts(p),
    });
  }
  return out;
}

/** Live CreatorRead on SideShift, with post facts from SideShift's platform sync and public oEmbed. */
export class LiveCreatorRead implements CreatorRead {
  readonly kind = "live" as const;
  readonly client: SideShiftClient;
  private readonly snapshots: Snapshots;
  private readonly clock: Clock;
  private readonly oembed: HttpClient;

  constructor(private readonly opts: SideShiftOptions) {
    this.client = new SideShiftClient(opts);
    this.snapshots = new Snapshots(this.client, opts.store);
    this.clock = opts.clock ?? new SystemClock();
    this.oembed = new HttpClient({ service: "oembed", dryRun: opts.dryRun, ...(opts.fetch ? { fetch: opts.fetch } : {}), ...(opts.sleep ? { sleep: opts.sleep } : {}) });
  }

  /**
   * SideShift's recruit search (POST /recruit/students). The marketplace exposes total
   * views but not follower counts, 30-day medians or audience geography, so those come
   * back as 0 / {} / null and creators qualify for geo cells only once a platform reports
   * their audience.
   */
  async searchCreators(req: { niche: string; platform: Platform; minMedianViews: number; geo: string; limit: number }): Promise<CreatorProfile[]> {
    if (req.platform !== "tiktok" && req.platform !== "instagram") return [];
    const res = await this.client.search<{ data: { students?: Json[] } }>("/recruit/students", {
      batchSize: Math.min(25, Math.max(1, req.limit)),
      page: 1,
      sort: "views",
      filters: {
        niches: [req.niche],
        countries: [req.geo.toUpperCase()],
        ...(req.platform === "tiktok" ? { hasTikTok: true } : { hasInstagram: true }),
        ...(req.minMedianViews > 0 ? { views: { min: req.minMedianViews } } : {}),
      },
    });
    return (res.data.students ?? [])
      .map((st) => ({ st, handle: normalizeHandle(s(req.platform === "tiktok" ? st.tiktok : st.instagram)) }))
      .filter(({ st, handle }) => handle && s(st.userId))
      .slice(0, req.limit)
      .map(({ st, handle }) => ({
        externalId: s(st.userId),
        platform: req.platform,
        handle,
        niche: Array.isArray(st.niches) && typeof st.niches[0] === "string" ? st.niches[0] : req.niche,
        followers: 0,
        medianViews30d: 0,
        audienceGeo: {},
        audienceUnder18Share: null,
      }));
  }

  async listSubmissions(req: { campaignExternalId: string }): Promise<ExternalSubmission[]> {
    if (req.campaignExternalId.startsWith("dry_")) return [];
    return toExternalSubmissions(await this.snapshots.load(req.campaignExternalId));
  }

  /**
   * Public status and author from oEmbed where available; the post's current views and its
   * labels from SideShift's platform sync. The author must be the creator's handle on the
   * post's own platform.
   */
  async verifyPost(req: { submissionExternalId: string; postUrl: string; platform: Platform }): Promise<SubmissionVerification> {
    const { snap, post: tracked } = await this.snapshots.resolve(req.submissionExternalId, true);
    const post = (tracked ? await this.client.getPost(tracked.id) : null) ?? tracked ?? null;
    const creator = post ? snap.creatorOfPost.get(post.id) : undefined;
    const expected = (creator ? handleOn(snap, creator, platformOf(post?.platform) ?? req.platform) : undefined) ?? normalizeHandle(s(post?.creator));
    const oembed = await verifyByOembed(this.oembed, { url: req.postUrl, platform: req.platform, instagramToken: this.opts.env.INSTAGRAM_OEMBED_TOKEN });
    const postedAt = post ? toIso(post.uploadedAt) : undefined;
    const trackedHandle = normalizeHandle(s(post?.creator));
    return {
      fetchedAt: this.clock.iso(),
      postIsPublic: oembed ? oembed.public : Boolean(post),
      authorHandleMatches: Boolean(expected) && (oembed?.authorHandle ? oembed.authorHandle === expected : trackedHandle === expected),
      platformDisclosureLabel: post ? disclosureLabelOf(post) : false,
      viewsFromPlatform: Math.max(0, Math.round(Number(post?.views ?? 0)) || 0),
      ...(postedAt ? { postedAt } : {}),
    };
  }

  async balance(): Promise<{ availableCents: Cents }> {
    return { availableCents: await this.client.walletBalanceCents() };
  }
}

function dollars(cents: Cents): number {
  return Math.round(cents) / 100;
}

/** Brief rendered as the campaign description creators read. */
export function briefText(c: CreatorCampaign): string {
  const b = c.brief;
  const list = (title: string, items: string[]) => (items.length ? `${title}:\n${items.map((x) => `- ${x}`).join("\n")}` : "");
  return [b.productSummary, `Audience: ${b.audience}`, list("Formats", b.formats), list("Hooks", b.hooks), list("Must include", b.mustInclude), list("Must avoid", b.mustAvoid), `Deliverables: ${b.deliverables}`, DISCLOSURE_REQUIREMENT]
    .filter(Boolean)
    .join("\n\n");
}

/** Campaign body: CPM on views with a flat fee per video, capped per video. */
export function campaignBody(c: CreatorCampaign): Json {
  return {
    name: c.brief.title,
    description: briefText(c),
    startsAt: c.createdAt.slice(0, 10),
    status: "active",
    campaignType: "ugc",
    paymentStructure: {
      type: c.cpmCents > 0 ? "cpm" : "fixed",
      paymentBasis: "views",
      cpmRate: dollars(c.cpmCents),
      fixedAmount: dollars(c.flatFeeCents),
      maxPayoutPerPost: dollars(c.maxPayoutPerVideoCents),
      crosspostMaturityDays: c.payoutMaturityDays,
    },
    requirements: {
      platforms: c.platforms,
      countries: c.targetCountries,
      minAudienceCountryPct: Math.round(c.creatorAudienceCountryMinPct * 100),
      budget: dollars(c.budgetCents),
    },
  };
}

const PLATFORM_FOCUS: Partial<Record<Platform, string>> = { tiktok: "TikTok", instagram: "Instagram", youtube: "YouTube", x: "Twitter", snapchat: "Snapchat" };

/** Marketplace job that posts the campaign so creators can discover it and apply. */
export function jobBody(c: CreatorCampaign, programId: string, imageUrl: string): Json {
  const cpm = c.cpmCents > 0;
  const flat = c.flatFeeCents > 0;
  return {
    title: c.brief.title,
    description: briefText(c),
    jobType: "Content Creator",
    creatorType: "ugc_ads",
    paymentType: cpm && flat ? "mixed" : cpm ? "performance" : "pay-per-post",
    ...(cpm && flat ? { mixedBaseType: "per-post" } : {}),
    ...(cpm ? { cpmRate: dollars(c.cpmCents).toFixed(2) } : {}),
    ...(flat ? { perPostRate: dollars(c.flatFeeCents).toFixed(2) } : {}),
    contentType: "UGC",
    accountType: "personal_account",
    ageRequirement: "18+",
    isApp: true,
    platformFocus: c.platforms.map((p) => PLATFORM_FOCUS[p]).filter(Boolean),
    tiktokRequired: c.platforms.includes("tiktok"),
    instagramRequired: c.platforms.includes("instagram"),
    programId,
    imageUrl,
  };
}

/** Contract payment terms for a deal (SideShift rates are in dollars). */
export function dealPaymentStructure(deal: CreatorDeal): Json {
  if (deal.kind === "cpm") return { type: "cpm", paymentBasis: "views", cpmRate: dollars(deal.cpmCents), fixedAmount: dollars(deal.flatFeeCents), maxPayout: dollars(deal.maxPayoutCents) };
  if (deal.kind === "retainer") return { type: "retainer", fixedAmount: dollars(deal.monthlyRetainerCents), postsPerMonth: deal.postsPerMonth, maxPayout: dollars(deal.maxPayoutCents) };
  return { type: "fixed", fixedAmount: dollars(deal.flatFeeCents), guaranteedViews: deal.guaranteedViews, maxPayout: dollars(deal.maxPayoutCents) };
}

interface PayoutEntry extends Json {
  contractId?: string;
  status?: string;
  error?: unknown;
  payoutId?: string;
  id?: string;
  transferId?: string;
  amountCents?: number;
}

function entries(data: Json): PayoutEntry[] {
  return [...(Array.isArray(data.plan) ? data.plan : []), ...(Array.isArray(data.results) ? data.results : [])].filter((e): e is PayoutEntry => Boolean(e) && typeof e === "object");
}

function failure(e: PayoutEntry): string | null {
  if (e.error) return typeof e.error === "string" ? e.error : JSON.stringify(e.error);
  if (e.status === "error" || e.status === "failed") return e.status;
  return null;
}

/** Live CreatorWrite on SideShift. */
export class LiveCreatorWrite implements CreatorWrite {
  readonly kind = "live" as const;
  readonly client: SideShiftClient;
  private readonly snapshots: Snapshots;

  constructor(private readonly opts: SideShiftOptions) {
    this.client = new SideShiftClient(opts);
    this.snapshots = new Snapshots(this.client, opts.store);
  }

  async createCampaign(campaign: CreatorCampaign): Promise<{ externalId: string }> {
    const res = await this.client.write<{ data: { id: string } }>("POST", "/campaigns", campaignBody(campaign), `campaign:${campaign.id}`);
    const programId = res.data.id;
    const image = this.opts.env.SIDESHIFT_JOB_IMAGE_URL;
    if (image) await this.client.write("POST", "/jobs", jobBody(campaign, programId, image), `job:${campaign.id}`);
    return { externalId: programId };
  }

  async closeCampaign(req: { campaignExternalId: string }): Promise<void> {
    await this.client.write("POST", `/campaigns/${encodeURIComponent(req.campaignExternalId)}/archive`, {}, `archive:${req.campaignExternalId}`);
  }

  async sendMessage(req: { creatorExternalId: string; text: string }): Promise<void> {
    await this.client.write("POST", "/messages", { creatorId: req.creatorExternalId, content: req.text }, `message:${hash(`${req.creatorExternalId}\n${req.text}`)}`);
  }

  async offerDeal(req: { creatorExternalId: string; deal: CreatorDeal; campaignExternalId?: string }): Promise<{ externalId: string }> {
    if (!req.campaignExternalId) throw new Error("sideshift: contracts must belong to a campaign (no campaignExternalId)");
    const creator = this.opts.store.creators.list((c) => c.externalIds.sideshift === req.creatorExternalId)[0];
    const res = await this.client.write<{ data: { id: string } }>(
      "POST",
      "/contracts",
      { programId: req.campaignExternalId, contractorId: req.creatorExternalId, contractorName: creator?.handle ?? req.creatorExternalId, paymentStructure: dealPaymentStructure(req.deal) },
      `deal:${req.deal.id}`,
    );
    return { externalId: res.data.id };
  }

  async reviewDraft(req: { submissionExternalId: string; approve: boolean; note: string }): Promise<void> {
    const ref = parseSubmissionId(req.submissionExternalId);
    if (ref.kind !== "vs") throw new Error(`sideshift: ${req.submissionExternalId} has no draft to review`);
    const body = { status: req.approve ? "approved" : "rejected", ...(req.note ? { feedback: req.note } : {}) };
    await this.client.write("POST", `/video-submissions/${encodeURIComponent(ref.id)}/review`, body, `draft:${hash(`${req.submissionExternalId}\n${JSON.stringify(body)}`)}`);
  }

  async reviewPost(req: { submissionExternalId: string; approve: boolean; note: string }): Promise<void> {
    const { snap, post } = await this.snapshots.resolve(req.submissionExternalId, true);
    if (!post) throw new Error(`sideshift: no tracked post for ${req.submissionExternalId}`);
    const creator = snap.creatorOfPost.get(post.id);
    const contractId = creator ? snap.contractOfCreator.get(creator) : undefined;
    const body = { status: req.approve ? "approved" : "rejected", ...(!req.approve && req.note ? { reason: req.note } : {}), ...(contractId ? { contract_id: contractId } : {}) };
    await this.client.write("POST", `/posts/${encodeURIComponent(post.id)}/approval`, body, `post:${hash(`${req.submissionExternalId}\n${JSON.stringify(body)}`)}`);
  }

  /** SideShift dry run first (its plan must be clean), then the real execution; both keyed for replay safety. */
  async payout(req: { submissionExternalId: string; amountCents: Cents; idempotencyKey: string; basis: Payout["basis"] }): Promise<{ payoutId: string }> {
    if (!Number.isSafeInteger(req.amountCents) || req.amountCents <= 0) throw new Error(`sideshift: invalid payout amount ${req.amountCents}`);
    const { snap, draft, post } = await this.snapshots.resolve(req.submissionExternalId, false);
    const creator = draft?.creatorId ?? (post ? snap.creatorOfPost.get(post.id) : undefined);
    const contractId = draft?.contractId ?? (creator ? snap.contractOfCreator.get(creator) : undefined);
    if (!contractId) throw new Error(`sideshift: no contract for ${req.submissionExternalId}`);
    const body = {
      contractIds: [contractId],
      customAmounts: { [contractId]: req.amountCents },
      messages: { [contractId]: `Payout for ${req.basis.views} views as of ${req.basis.viewsAsOf.slice(0, 10)}` },
      includeContinuedCpm: false,
      includeContinuedBonuses: false,
    };
    const plan = await this.client.write<{ data: Json }>("POST", "/payouts/execute", { ...body, dryRun: true }, `${req.idempotencyKey}:plan`);
    for (const e of entries(plan.data)) {
      const why = failure(e);
      if (why) throw new Error(`sideshift: payout plan for ${contractId} failed: ${why}`);
      if (typeof e.amountCents === "number" && e.amountCents !== req.amountCents) throw new Error(`sideshift: payout plan amount ${e.amountCents} != ${req.amountCents}`);
    }
    const res = await this.client.write<{ data: Json }>("POST", "/payouts/execute", { ...body, dryRun: false }, req.idempotencyKey);
    const results = entries(res.data);
    const mine = results.find((e) => e.contractId === contractId) ?? results[0];
    const why = mine ? failure(mine) : null;
    if (why) throw new Error(`sideshift: payout for ${contractId} failed: ${why}`);
    const payoutId = s(mine?.payoutId) || s(mine?.id) || s(mine?.transferId) || `sideshift:${req.idempotencyKey}`;
    return { payoutId };
  }
}
