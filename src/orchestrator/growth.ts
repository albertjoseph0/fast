/**
 * Growth inside the tick: creator submissions (review → verify → view-lock → payout),
 * owned brand content (assets → publish within caps), the S0 attention probe and the
 * always-on creative batches for scaling ventures.
 */
import type { TickContext } from "../core/context.ts";
import type {
  Action,
  CellObservation,
  ContentDraft,
  ContentPiece,
  Creator,
  CreatorCampaign,
  CreatorSubmission,
  ExperimentPlan,
  ExternalSubmission,
  Hook,
  OwnedAccount,
  Platform,
  Venture,
} from "../core/types.ts";
import { deriveDisclosure, labelsFor } from "../governance/disclosure.ts";
import { OPEN_STATUSES } from "../governance/outbox.ts";
import { adultOnly } from "../governance/policy.ts";
import { computePayout } from "../governance/payouts.ts";
import { allocate, armsToCull, postsPerArm, probabilityBest, type ArmStats } from "../lab/creative.ts";
import { decideExperiment, evaluateCell } from "../lab/decide.ts";
import { designAttentionProbe } from "../lab/experiments.ts";
import type { StudioDeps } from "./deps.ts";
import { ideaFor } from "./pipeline.ts";
import { proposeKill } from "./labPhase.ts";
import { createHash } from "node:crypto";
import { taskDraft } from "../playbook/setup.ts";
import { lintCopy } from "../principles/copy.ts";

const DAY_MS = 86_400_000;
/** Payout attempts the marketplace may refuse before a human looks at the creator's setup. */
const MAX_PAYOUT_ATTEMPTS = 3;
/** Days a posted submission may lack a URL before a human is asked to find it. */
const POST_URL_GRACE_DAYS = 2;
/** Re-read a post's views at most this often while it waits for its view lock. */
const VIEW_REFRESH_HOURS = 20;

function addDays(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() + days * DAY_MS).toISOString();
}

function similarityKey(formatId: string, hook: string): string {
  const normalized = hook.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return `${formatId}:${createHash("sha256").update(normalized).digest("hex").slice(0, 12)}`;
}

// ---------------------------------------------------------------------------
// Creator submissions
// ---------------------------------------------------------------------------

/** The creator record for a submission; audience figures the marketplace reports fill in what is unknown. */
function upsertCreator(ctx: TickContext, v: Venture, ext: ExternalSubmission): Creator {
  const source: Creator["source"] = ctx.ports.creators.kind === "sim" ? "sim" : "sideshift";
  const existing = ctx.store.creators.list((c) => c.externalIds[source] === ext.creatorExternalId)[0];
  const audience = ext.creatorAudience;
  if (existing) {
    if (!audience || existing.audienceUnder18Share !== null || audience.under18Share === null) return existing;
    return ctx.store.creators.put({ ...existing, audienceGeo: audience.geo, audienceUnder18Share: audience.under18Share, followers: audience.followers, medianViews30d: audience.medianViews30d });
  }
  const creator: Creator = {
    id: ctx.store.nextId("creator"),
    platform: ext.platform,
    handle: ext.creatorHandle,
    externalIds: { [source]: ext.creatorExternalId },
    niche: ideaFor(ctx, v).wedge.creatorNiche,
    followers: audience?.followers ?? 0,
    medianViews30d: audience?.medianViews30d ?? 0,
    audienceGeo: audience?.geo ?? {},
    audienceUnder18Share: audience?.under18Share ?? null,
    source,
    status: "active",
    stats: { posts: 0, views: 0, attributedInstalls: 0, attributedTrials: 0, paidCents: 0 },
  };
  return ctx.store.creators.put(creator);
}

/**
 * Paid, held (outcome unknown, counted as paid until a human checks) and already-proposed payouts:
 * payouts proposed in the same tick must share the remaining budget, as the policy computes it.
 */
function committedOnCampaign(ctx: TickContext, campaign: CreatorCampaign): number {
  const subs = ctx.store.submissions.list((s) => s.campaignId === campaign.id);
  const ids = new Set(subs.map((s) => s.id));
  const paid = subs.reduce((sum, s) => sum + (s.stage === "paid" ? s.payoutCents : 0), 0);
  let pending = 0;
  for (const a of ctx.store.actions.list((x) => x.kind === "creator.payout" && ids.has((x.payload as { submissionId: string }).submissionId))) {
    if (OPEN_STATUSES.includes(a.status)) pending += (a.payload as { amountCents: number }).amountCents;
    else if (a.status === "failed") pending += -(ctx.store.ledgerEntry(`payout:unknown:${a.id}`)?.amountCents ?? 0);
  }
  return paid + pending;
}

/** Pull submissions for every live campaign and move each one one step along its review path. */
export async function syncCreatorSubmissions(ctx: TickContext, deps: StudioDeps): Promise<void> {
  const now = ctx.ports.clock.iso();
  for (const campaign of ctx.store.campaigns.list((c) => Boolean(c.externalId) && c.status !== "draft")) {
    const v = ctx.store.ventures.get(campaign.ventureId);
    if (!v) continue;
    const external = await ctx.ports.creators.listSubmissions({ campaignExternalId: campaign.externalId as string });
    for (const ext of external) {
      let sub = ctx.store.submissions.list((s) => s.externalId === ext.externalId)[0];
      if (!sub) {
        if (campaign.status === "closed") continue; // late arrivals on closed campaigns are not taken on
        const creator = upsertCreator(ctx, v, ext);
        const fresh: CreatorSubmission = {
          id: ctx.store.nextId("submission"),
          externalId: ext.externalId,
          campaignId: campaign.id,
          creatorId: creator.id,
          creatorHandle: ext.creatorHandle,
          platform: ext.platform,
          untrustedCaption: ext.stage === "posted" ? (ext.untrustedPostCaption ?? ext.untrustedCaption) : ext.untrustedCaption,
          stage: ext.stage === "posted" ? "posted" : "draft_submitted",
          payoutCents: 0,
          submittedAt: ext.submittedAt,
          ...(ext.postUrl ? { postUrl: ext.postUrl } : {}),
          ...(ext.stage === "posted" ? { postedAt: ext.postedAt ?? ext.submittedAt } : {}),
        };
        sub = ctx.store.submissions.put(fresh);
      } else if (ext.stage === "posted" && sub.stage === "draft_approved") {
        // What went live is reviewed again when it differs from the approved draft.
        const posted = ext.untrustedPostCaption ?? sub.untrustedCaption;
        const { review: draftReview, ...rest } = sub;
        sub = ctx.store.submissions.put({
          ...rest,
          ...(posted === sub.untrustedCaption && draftReview ? { review: draftReview } : {}),
          stage: "posted",
          postedAt: ext.postedAt ?? now,
          untrustedCaption: posted,
          ...(ext.postUrl ? { postUrl: ext.postUrl } : {}),
        });
      } else if (ext.views !== undefined && sub.stage === "post_approved" && sub.viewsAtLock === undefined && sub.verification && ext.views > sub.verification.viewsFromPlatform) {
        sub = ctx.store.submissions.put({ ...sub, verification: { ...sub.verification, viewsFromPlatform: ext.views, fetchedAt: now } });
      }
      await stepSubmission(ctx, deps, v, campaign, sub, ext.views !== undefined);
    }
  }
}

/** Deterministic copy rules the creator's text must pass (claims, rankings, prices), whatever the reviewer says. */
function captionProblems(text: string): string[] {
  return lintCopy({ text, surface: "content" })
    .filter((f) => f.severity === "block" || f.severity === "needs_human")
    .map((f) => f.message);
}

/**
 * Campaign fields that keep an 18+ app's creator recruitment to adult audiences: a brief line so
 * creators with young audiences don't apply, and the ceiling for marketplaces that filter on it.
 */
export function adultRecruitment(ctx: TickContext, v: Venture, brief: CreatorCampaign["brief"]): Pick<CreatorCampaign, "brief"> & Partial<Pick<CreatorCampaign, "creatorAudienceUnder18MaxPct">> {
  if (!adultOnly(ctx, v)) return { brief };
  const max = ctx.config.creators.maxAudienceUnder18Share;
  const line = `Only apply if at least ${Math.round((1 - max) * 100)}% of your audience is 18 or older: this app is for adults`;
  return { brief: { ...brief, mustInclude: [...brief.mustInclude, line] }, creatorAudienceUnder18MaxPct: max };
}

/** An 18+ app is never promoted to a mostly-young audience: such a creator's draft or post is turned down. */
function audienceProblem(ctx: TickContext, v: Venture, sub: CreatorSubmission): string | null {
  if (!adultOnly(ctx, v)) return null;
  const share = ctx.store.creators.get(sub.creatorId)?.audienceUnder18Share ?? null;
  const max = ctx.config.creators.maxAudienceUnder18Share;
  return share !== null && share > max ? `${Math.round(share * 100)}% of your audience is under 18, and this app is for adults only` : null;
}

async function reviewWithLint(ctx: TickContext, deps: StudioDeps, v: Venture, sub: CreatorSubmission, campaign: CreatorCampaign): Promise<NonNullable<CreatorSubmission["review"]>> {
  const review = await deps.agents.reviewSubmission(ctx, { submission: sub, brief: campaign.brief });
  const audience = audienceProblem(ctx, v, sub);
  const caption = captionProblems(sub.untrustedCaption);
  if (!caption.length && !audience) return { approve: review.approve, injectionAttempt: review.injectionAttempt, policyIssues: review.policyIssues, note: review.note };
  const note = audience ? `Thank you, but we can't use this: ${audience}.` : `Please remove from the caption: ${caption.join("; ")}`;
  return {
    approve: false,
    injectionAttempt: review.injectionAttempt,
    policyIssues: [...review.policyIssues, ...caption, ...(audience ? [audience] : [])],
    note: note.slice(0, 280),
  };
}

async function stepSubmission(ctx: TickContext, deps: StudioDeps, v: Venture, campaign: CreatorCampaign, sub: CreatorSubmission, viewsReported = false): Promise<void> {
  const now = ctx.ports.clock.iso();
  const base = { ventureId: v.id, proposedBy: "creator_ops" as const, ...(campaign.experimentId ? { experimentId: campaign.experimentId } : {}), ...(campaign.cellId ? { cellId: campaign.cellId } : {}) };
  if (sub.stage === "draft_submitted" && !sub.review) {
    const review = await reviewWithLint(ctx, deps, v, sub, campaign);
    sub = ctx.store.submissions.put({ ...sub, review });
    ctx.outbox.propose({ ...base, kind: "creator.review_draft", payload: { submissionId: sub.id, approve: review.approve, note: review.note }, summary: `${review.approve ? "Approve" : "Reject"} draft from ${sub.creatorHandle}`, rationale: review.note, naturalKey: `draft:${sub.id}` });
    return;
  }
  if (sub.stage === "posted" && !sub.verification) {
    const postUrl = sub.postUrl;
    if (!postUrl) {
      // Without a link the post cannot be verified or paid: after a grace period, a human finds it.
      const since = sub.postedAt ?? sub.submittedAt;
      if (now >= addDays(since, POST_URL_GRACE_DAYS) && !ctx.store.tasks.count((t) => t.kind === "creators.verify_post" && t.instructions.includes(`submission ${sub.id}`))) {
        ctx.outbox.openTask(taskDraft("creators.verify_post", v.id, `${sub.creatorHandle} on ${sub.platform}, campaign ${campaign.id}, submission ${sub.id}, posted ${since.slice(0, 10)}`));
      }
      return;
    }
    if (!sub.review) {
      // Posted without a reviewed draft (marketplaces may skip the draft step), or posted with a
      // caption other than the approved draft's: review what went live.
      sub = ctx.store.submissions.put({ ...sub, review: await reviewWithLint(ctx, deps, v, sub, campaign) });
    }
    const verification = await ctx.ports.creators.verifyPost({ submissionExternalId: sub.externalId, postUrl, platform: sub.platform });
    sub = ctx.store.submissions.put({ ...sub, verification });
    const audience = audienceProblem(ctx, v, sub);
    const problems = captionProblems(sub.untrustedCaption);
    const ok = Boolean(!audience && sub.review?.approve && !sub.review.injectionAttempt && !problems.length && verification.postIsPublic && verification.authorHandleMatches && verification.platformDisclosureLabel);
    const why = ok
      ? "post verified on the platform of record"
      : `post failed verification (${[!verification.postIsPublic && "not public", !verification.authorHandleMatches && "author mismatch", !verification.platformDisclosureLabel && "no paid-partnership label", sub.review?.injectionAttempt && "prompt injection", problems.length && `caption: ${problems.join("; ")}`, audience, sub.review && !sub.review.approve && "review rejected"].filter(Boolean).join(", ")})`;
    ctx.outbox.propose({ ...base, kind: "creator.review_post", payload: { submissionId: sub.id, approve: ok, note: why.slice(0, 280) }, summary: `${ok ? "Approve" : "Reject"} post from ${sub.creatorHandle}`, rationale: why, naturalKey: `post:${sub.id}` });
    return;
  }
  if (sub.stage === "post_approved" && sub.postedAt && sub.postUrl) {
    if (sub.viewsAtLock === undefined) {
      if (now < addDays(sub.postedAt, ctx.config.creators.viewLockDays)) {
        // Lab reads price and count views as they stand; refresh them when the marketplace does not report them.
        const fetchedAt = sub.verification?.fetchedAt;
        if (!viewsReported && (!fetchedAt || new Date(now).getTime() - new Date(fetchedAt).getTime() >= VIEW_REFRESH_HOURS * 3_600_000)) {
          const fresh = await ctx.ports.creators.verifyPost({ submissionExternalId: sub.externalId, postUrl: sub.postUrl, platform: sub.platform });
          ctx.store.submissions.put({ ...sub, verification: { ...fresh, viewsFromPlatform: Math.max(fresh.viewsFromPlatform, sub.verification?.viewsFromPlatform ?? 0) } });
        }
        return;
      }
      if (payoutActions(ctx, v.id, sub.id).some((a) => OPEN_STATUSES.includes(a.status))) return;
      // The lock is taken once: later views, failures and rejections never move it.
      const verification = await ctx.ports.creators.verifyPost({ submissionExternalId: sub.externalId, postUrl: sub.postUrl, platform: sub.platform });
      sub = ctx.store.submissions.put({ ...sub, verification, viewsAtLock: verification.viewsFromPlatform, lockedAt: now });
    }
    proposePayout(ctx, v, campaign, sub, base);
  }
}

function payoutActions(ctx: TickContext, ventureId: string, submissionId: string): Action[] {
  return ctx.store.actions
    .list((a) => a.kind === "creator.payout" && a.ventureId === ventureId && (a.payload as { submissionId: string }).submissionId === submissionId)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
}

/**
 * Pay a locked submission. A payout the marketplace refused outright is retried daily under a new
 * idempotency key (the old key would replay the refusal); one whose outcome is unknown waits for a
 * human check, a board rejection stands, and repeated refusals go to a human.
 */
function proposePayout(ctx: TickContext, v: Venture, campaign: CreatorCampaign, sub: CreatorSubmission, base: { ventureId: string; proposedBy: "creator_ops"; experimentId?: string; cellId?: string }): void {
  const now = ctx.ports.clock.iso();
  const viewsAtLock = sub.viewsAtLock;
  if (viewsAtLock === undefined) return;
  // A payout blocked only because its amount went stale (another payout on the campaign was rejected
  // or failed since) is withdrawn and proposed again at the recomputed amount.
  for (const a of payoutActions(ctx, v.id, sub.id).filter((x) => x.status === "blocked")) {
    const blocks = a.findings.filter((f) => f.severity === "block");
    if (blocks.length && blocks.every((f) => f.ruleId === "creator.payout_eligibility" && f.message.startsWith("Amount "))) ctx.outbox.cancel(a.id, "amount out of date: re-proposed at the computed payout");
  }
  const prior = payoutActions(ctx, v.id, sub.id);
  if (prior.some((a) => OPEN_STATUSES.includes(a.status) || a.status === "executed" || a.status === "rejected" || (a.status === "dry_run" && ctx.config.dryRun))) return;
  const failed = prior.filter((a) => a.status === "failed");
  const held = failed.filter((a) => (ctx.store.ledgerEntry(`payout:unknown:${a.id}`)?.amountCents ?? 0) !== 0);
  if (held.length) {
    // The money may have left: a human checks the marketplace before anything is paid again.
    for (const a of held.filter((x) => !ctx.store.tasks.count((t) => t.kind === "creators.verify_payout" && t.blocksActionIds.includes(x.id)))) {
      ctx.outbox.openTask(taskDraft("creators.verify_payout", v.id, `${sub.creatorHandle} (${sub.id}) on ${campaign.id}: ${(a.payload as { amountCents: number }).amountCents} cents, action ${a.id} (${a.error ?? "outcome unknown"})`), [a.id]);
    }
    return;
  }
  const forgiven = new Set(
    ctx.store.tasks.list((t) => t.kind === "creators.payout_failed" && t.status === "done" && t.outputs?.["decision"] === "retry").flatMap((t) => t.blocksActionIds),
  );
  const counted = failed.filter((a) => !forgiven.has(a.id));
  const last = failed.at(-1);
  if (counted.length >= MAX_PAYOUT_ATTEMPTS && last) {
    if (!ctx.store.tasks.count((t) => t.kind === "creators.payout_failed" && t.blocksActionIds.includes(last.id))) {
      ctx.outbox.openTask(taskDraft("creators.payout_failed", v.id, `${sub.creatorHandle} (${sub.id}) on ${campaign.id}: ${last.error ?? "refused"}`), counted.map((a) => a.id));
    }
    return;
  }
  if (last && now < addDays(last.createdAt, 1)) return;
  const amountCents = computePayout(
    { flatFeeCents: campaign.flatFeeCents, cpmCents: campaign.cpmCents, maxPayoutCents: campaign.maxPayoutPerVideoCents },
    { viewsAtLock, campaignRemainingCents: Math.max(0, campaign.budgetCents - committedOnCampaign(ctx, campaign)) },
  );
  if (amountCents <= 0) return;
  const viewsAsOf = sub.lockedAt ?? now;
  ctx.outbox.propose({
    ...base,
    kind: "creator.payout",
    payload: { submissionId: sub.id, amountCents, basis: { views: viewsAtLock, viewsAsOf, flatFeeCents: campaign.flatFeeCents, cpmCents: campaign.cpmCents, capCents: campaign.maxPayoutPerVideoCents } },
    summary: `Pay ${sub.creatorHandle} ${(amountCents / 100).toFixed(2)} USD`,
    rationale: `${viewsAtLock} views locked ${ctx.config.creators.viewLockDays} days after posting${prior.length ? ` (attempt ${prior.length + 1})` : ""}`,
    naturalKey: prior.length ? `${sub.id}:attempt${prior.length + 1}` : sub.id,
    commitment: { kind: "settles_liability", amountCents, maxTotalCents: amountCents, startsAt: now, liabilityRef: sub.id },
  });
}

// ---------------------------------------------------------------------------
// Owned content
// ---------------------------------------------------------------------------

/** Push approved owned content: host its media publicly, then publish within the account's daily cap. */
export function publishOwnedContent(ctx: TickContext): void {
  const now = ctx.ports.clock.iso();
  const dayAgo = addDays(now, -1);
  requeueFailedPublishes(ctx);
  for (const account of ctx.store.accounts.list((a) => a.status === "active")) {
    const cap = ctx.config.distribution.postCaps[account.platform]?.perAccountPerDay ?? 0;
    const recent = ctx.store.actions.list(
      (a) => a.kind === "content.publish" && a.createdAt >= dayAgo && (a.payload as { accountId: string }).accountId === account.id && a.status !== "rejected" && a.status !== "cancelled",
    ).length;
    let slots = Math.max(0, cap - recent);
    const queue = ctx.store.content
      .list((c) => c.accountId === account.id && c.status === "approved")
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    for (const piece of queue) {
      if (slots <= 0) break;
      const missing = piece.media.filter((m) => !m.publicUrl);
      if (missing.length) {
        for (const m of missing) {
          ctx.outbox.propose({ kind: "web.put_asset", ventureId: piece.ventureId, payload: { localPath: m.localPath, contentType: m.mediaType }, summary: `Host media for ${piece.id}`, rationale: "Platforms pull media from public URLs", proposedBy: "content", naturalKey: m.sha256 });
        }
        continue;
      }
      ctx.outbox.propose({
        kind: "content.publish",
        ventureId: piece.ventureId,
        payload: {
          contentId: piece.id,
          accountId: account.id,
          platform: account.platform,
          mode: publishMode(ctx, account, piece),
          labels: labelsFor(account.platform, deriveDisclosure(piece, now)),
          mediaSha256: piece.media.map((m) => m.sha256),
        },
        summary: `Post ${piece.id} to ${account.handle}`,
        rationale: piece.experimentId ? `${piece.experimentId} attention probe` : "owned brand content",
        proposedBy: "content",
        naturalKey: piece.id,
        ...(piece.experimentId ? { experimentId: piece.experimentId } : {}),
        ...(piece.cellId ? { cellId: piece.cellId } : {}),
      });
      ctx.store.content.put({ ...piece, status: "scheduled" });
      slots--;
    }
  }
}

/** Attempts a piece gets before it is dropped from the queue. */
const MAX_PUBLISH_ATTEMPTS = 2;

/** A piece whose publish failed or was withdrawn goes back to the queue once, then out of it. */
function requeueFailedPublishes(ctx: TickContext): void {
  for (const piece of ctx.store.content.list((c) => c.status === "scheduled")) {
    const attempts = ctx.store.actions
      .list((a) => a.kind === "content.publish" && a.dedupeKey === `content.publish:${piece.ventureId}:${piece.id}`)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
    const last = attempts.at(-1);
    if (!last || !(last.status === "failed" || last.status === "rejected" || last.status === "cancelled")) continue;
    const failures = attempts.filter((a) => a.status === "failed").length;
    const retry = last.status === "failed" && failures < MAX_PUBLISH_ATTEMPTS;
    ctx.store.content.put({ ...piece, status: retry ? "approved" : "rejected" });
    ctx.log("content.requeued", { contentId: piece.id, status: retry ? "approved" : "rejected", reason: last.error ?? last.status }, piece.ventureId);
  }
}

function publishMode(ctx: TickContext, account: OwnedAccount, piece: ContentPiece): "direct" | "inbox_draft" | "trial_reel" {
  if (account.platform === "tiktok") return ctx.config.distribution.tiktokAudited ? ctx.config.distribution.tiktokOwnedMode : "inbox_draft";
  // Trial reels take exactly one video; slides go up as a regular carousel.
  const singleVideo = piece.media.length === 1 && (piece.media[0]?.mediaType ?? "").startsWith("video/");
  if (account.platform === "instagram" && piece.experimentId && singleVideo) return "trial_reel";
  return "direct";
}

/** Refresh stats for posted owned content. */
export async function syncContentStats(ctx: TickContext): Promise<void> {
  for (const piece of ctx.store.content.list((c) => c.status === "posted" && Boolean(c.externalId))) {
    const account = piece.accountId ? ctx.store.accounts.get(piece.accountId) : undefined;
    const stats = await ctx.ports.social.postStats({ platform: piece.platform, externalId: piece.externalId as string, ...(account ? { account } : {}) });
    ctx.store.content.put({ ...piece, stats });
  }
}

async function contentFromDrafts(ctx: TickContext, deps: StudioDeps, v: Venture, drafts: ContentDraft[], account: OwnedAccount, plan?: ExperimentPlan): Promise<void> {
  for (const draft of drafts) {
    const id = ctx.store.nextId("content");
    const media = await deps.agents.renderDraft(ctx, { ventureId: v.id, draft, outDir: `${deps.mediaRoot}/${v.id}/${id}`, maxSlides: ctx.config.media.maxSlidesRenderedPerDraft });
    const piece: ContentPiece = {
      id,
      ventureId: v.id,
      formatId: draft.formatId,
      draft,
      media,
      channel: "owned_social",
      platform: account.platform,
      accountId: account.id,
      similarityKey: similarityKey(draft.formatId, draft.hook),
      status: "approved",
      ...(plan ? { experimentId: plan.id, cellId: plan.cells[0]?.id as string } : {}),
    };
    ctx.store.content.put({ ...piece, disclosure: deriveDisclosure(piece, ctx.ports.clock.iso()) });
  }
}

// ---------------------------------------------------------------------------
// S0 attention probe
// ---------------------------------------------------------------------------

function ownedAccount(ctx: TickContext, v: Venture, platform: Platform): OwnedAccount | undefined {
  const id = v.bindings.ownedAccountIds[platform];
  return id ? ctx.store.accounts.get(id) : undefined;
}

/** Start (or read) the kill-only attention probe while a venture is being built. */
export async function runAttentionProbe(ctx: TickContext, deps: StudioDeps, v: Venture): Promise<string> {
  if (!ctx.config.lab.attentionProbe.enabled) return "probe disabled";
  const existing = ctx.store.experiments.list((e) => e.ventureId === v.id && e.stages[0] === "S0_attention")[0];
  if (!existing) {
    const account = ownedAccount(ctx, v, "instagram");
    if (!account) {
      if (!ctx.store.tasks.list((t) => t.ventureId === v.id && t.kind === "social.connect_account").length) {
        ctx.outbox.openTask(taskDraft("social.connect_account", v.id, `Platform: instagram. ${v.name} needs a disclosed brand account for its attention probe and owned content.`));
      }
      return "waiting for a brand account";
    }
    const plan = designAttentionProbe({ experimentId: ctx.store.nextId("experiment"), cellId: ctx.store.nextId("cell"), venture: v, idea: ideaFor(ctx, v), accountId: account.id, config: ctx.config, now: ctx.ports.clock.iso() });
    ctx.store.experiments.put({ ...plan, status: "running", startedAt: ctx.ports.clock.iso() });
    ctx.log("experiment.registered", { experimentId: plan.id, stages: plan.stages, posts: ctx.config.lab.attentionProbe.posts }, v.id);
    const idea = ideaFor(ctx, v);
    const drafts = await deps.agents.draftContent(ctx, { ventureId: v.id, idea, ...(v.spec ? { spec: v.spec } : {}), purpose: "attention_probe", platform: "instagram", count: ctx.config.lab.attentionProbe.posts, hooks: idea.hookExamples });
    await contentFromDrafts(ctx, deps, v, drafts, account, plan);
    return `attention probe ${plan.id} started with ${drafts.length} posts`;
  }
  if (existing.status !== "running") return `probe ${existing.status}`;
  return readAttentionProbe(ctx, v, existing);
}

function readAttentionProbe(ctx: TickContext, v: Venture, plan: ExperimentPlan): string {
  const now = ctx.ports.clock.iso();
  const cell = plan.cells[0];
  if (!cell) return "probe has no cell";
  const matureBefore = addDays(now, -2);
  const posts = ctx.store.content.list((c) => c.experimentId === plan.id && c.status === "posted" && Boolean(c.postedAt) && (c.postedAt as string) <= matureBefore);
  const hit = (c: ContentPiece) => (c.stats?.views ?? 0) >= ctx.config.lab.attentionProbe.hitViews;
  const bySource = Object.fromEntries(posts.map((p) => [p.id, { successes: hit(p) ? 1 : 0, trials: 1 }]));
  const firstPost = ctx.store.content.list((c) => c.experimentId === plan.id && Boolean(c.postedAt)).map((c) => c.postedAt as string).sort()[0];
  let current = plan;
  if (firstPost && !cell.firstExposureAt) {
    current = { ...plan, cells: [{ ...cell, firstExposureAt: firstPost }] };
    ctx.store.experiments.put(current);
  }
  const obs: CellObservation = {
    cellId: cell.id,
    metrics: { attentionHitRate: { successes: posts.filter(hit).length, trials: posts.length, bySource } },
    exposureViews: posts.reduce((s, p) => s + (p.stats?.views ?? 0), 0),
    spendCents: 0,
    internalShare: 0,
    observedAt: now,
  };
  ctx.store.addObservation(plan.id, obs);
  const verdict = evaluateCell({ plan: current, cell: current.cells[0] ?? cell, obs, config: ctx.config, now, clockStart: plan.startedAt ?? plan.registeredAt });
  const outcome = decideExperiment({ plan: current, verdicts: [verdict], observations: new Map([[cell.id, obs]]), ladder: v.ladder, config: ctx.config, now, previousOutcomes: ctx.store.outcomes(plan.id), rng: ctx.rng.fork(`probe:${plan.id}`) });
  if (outcome.decision === "continue") return `probe reading (${posts.length} mature posts)`;
  ctx.store.addOutcome(outcome);
  ctx.store.experiments.put({ ...current, status: "decided", decidedAt: now });
  ctx.log("experiment.decided", { experimentId: plan.id, decision: outcome.decision, rationale: outcome.rationale }, v.id);
  if (outcome.decision === "kill") proposeKill(ctx, v, outcome.rationale);
  return `probe ${outcome.decision}`;
}

// ---------------------------------------------------------------------------
// Creative loop (scaling ventures)
// ---------------------------------------------------------------------------

function armStats(ctx: TickContext, batchId: string): ArmStats[] {
  const batch = ctx.store.batches.require(batchId);
  return batch.arms.map((arm) => {
    const campaigns = ctx.store.campaigns.list((c) => c.batchId === batchId && armOf(ctx, c) === arm);
    const subs = campaigns.flatMap((c) => ctx.store.submissions.list((s) => s.campaignId === c.id && (s.stage === "post_approved" || s.stage === "paid")));
    const views = subs.reduce((s, x) => s + (x.viewsAtLock ?? x.verification?.viewsFromPlatform ?? 0), 0);
    const installs = attributedInstalls(ctx, batch.ventureId, campaigns, subs);
    return { arm, posts: subs.length, views, installs };
  });
}

function armOf(ctx: TickContext, c: CreatorCampaign): string {
  const hook = ctx.store.hooks.list((h) => h.ventureId === c.ventureId && h.text === c.brief.hooks[0])[0];
  return `${c.brief.formats[0] ?? "format"}:${hook?.id ?? "hook"}`;
}

/** Installs attributed to campaigns via cohort lanes whose source id names the campaign or one of its posts. */
function attributedInstalls(ctx: TickContext, ventureId: string, campaigns: CreatorCampaign[], subs: CreatorSubmission[]): number {
  const ids = new Set([...campaigns.map((c) => c.id), ...campaigns.map((c) => c.externalId ?? ""), ...subs.map((s) => s.externalId)].filter(Boolean));
  const latest = new Map<string, number>();
  for (const row of ctx.store.cohorts(ventureId)) {
    const source = row.lane.split("|").at(-1) ?? "";
    if (!ids.has(source)) continue;
    const key = `${row.cohortDate}|${row.lane}`;
    latest.set(key, Math.max(latest.get(key) ?? 0, row.installs));
  }
  return [...latest.values()].reduce((s, n) => s + n, 0);
}

const MIN_LIVE_HOOKS = 3;

/** Known arms keep their Thompson share; arms new this week split the exploration share. */
function armShares(arms: string[], allocation: Record<string, number> | undefined, exploreShare: number): Record<string, number> {
  if (!allocation) return Object.fromEntries(arms.map((a) => [a, 1 / arms.length]));
  const fresh = arms.filter((a) => !(a in allocation));
  const known = arms.filter((a) => a in allocation);
  const knownTotal = known.reduce((s, a) => s + (allocation[a] ?? 0), 0);
  const freshShare = fresh.length ? (known.length ? exploreShare : 1) : 0;
  const out: Record<string, number> = {};
  for (const a of known) out[a] = knownTotal > 0 ? ((allocation[a] ?? 0) / knownTotal) * (1 - freshShare) : (1 - freshShare) / known.length;
  for (const a of fresh) out[a] = freshShare / fresh.length;
  return out;
}

/** New hooks riffing on the current winners, so culling never leaves the bandit without arms. */
async function refreshHooks(ctx: TickContext, deps: StudioDeps, v: Venture, live: Hook[], count: number): Promise<Hook[]> {
  const idea = ideaFor(ctx, v);
  const seeds = live.length ? live.map((h) => h.text) : idea.hookExamples;
  const drafts = await deps.agents.draftContent(ctx, { ventureId: v.id, idea, ...(v.spec ? { spec: v.spec } : {}), purpose: "creator_reference", platform: "tiktok", count, hooks: seeds });
  const taken = new Set(ctx.store.hooks.list((h) => h.ventureId === v.id).map((h) => h.text.toLowerCase()));
  const now = ctx.ports.clock.iso();
  const added: Hook[] = [];
  for (const d of drafts) {
    if (taken.has(d.hook.toLowerCase())) continue;
    taken.add(d.hook.toLowerCase());
    added.push(ctx.store.hooks.put({ id: ctx.store.nextId("hook"), ventureId: v.id, formatId: d.formatId, text: d.hook, angle: d.angle, ...(live[0] ? { parentHookId: live[0].id } : {}), source: "generated", status: "exploring", createdAt: now }));
  }
  return added.slice(0, count);
}

/**
 * Weekly creator batches for a scaling venture: close the last batch (cull losing hooks),
 * then open a new one with posts allocated by Thompson sampling.
 */
export async function runCreativeLoop(ctx: TickContext, deps: StudioDeps, v: Venture, dailyBudgetCents: number): Promise<string> {
  const now = ctx.ports.clock.iso();
  const cfg = ctx.config.growth.creative;
  const open = ctx.store.batches.list((b) => b.ventureId === v.id && b.status === "open")[0];
  if (open && open.closesAt > now) return `batch ${open.id} running`;
  let allocation: Record<string, number> | undefined;
  if (open) {
    const stats = armStats(ctx, open.id);
    const pBest = probabilityBest(stats, ctx.rng.fork(`batch:${open.id}`));
    const culled = armsToCull(stats, pBest, cfg);
    for (const arm of culled) {
      const hookId = arm.split(":")[1];
      const hook = hookId ? ctx.store.hooks.get(hookId) : undefined;
      if (hook) ctx.store.hooks.put({ ...hook, status: "culled" });
    }
    const results = Object.fromEntries(stats.map((s) => [s.arm, { posts: s.posts, views: s.views, attributedInstalls: s.installs, attributedTrials: 0, spendCents: 0 }]));
    ctx.store.batches.put({ ...open, status: "closed", results, culled });
    ctx.log("creative.batch_closed", { batchId: open.id, culled, pBest }, v.id);
    const survivors = Object.fromEntries(Object.entries(pBest).filter(([arm]) => !culled.includes(arm)));
    allocation = allocate(survivors, cfg.exploreShare);
    for (const c of ctx.store.campaigns.list((x) => x.batchId === open.id)) {
      if (c.status === "open" || c.status === "paused") {
        ctx.outbox.propose({ kind: "creator.campaign_close", ventureId: v.id, payload: { campaignId: c.id }, summary: `Close ${c.id}`, rationale: `batch ${open.id} closed`, proposedBy: "creator_ops", naturalKey: c.id });
      } else if (c.status === "draft") {
        // A create still waiting (blocked on cash, awaiting approval) must not launch for a closed batch.
        for (const a of ctx.store.actions.list((x) => x.kind === "creator.campaign_create" && (x.payload as { campaignId: string }).campaignId === c.id && OPEN_STATUSES.includes(x.status) && x.status !== "executing")) {
          ctx.outbox.cancel(a.id, `batch ${open.id} closed before ${c.id} launched`);
        }
      }
    }
  }
  const spec = v.spec;
  if (!spec || dailyBudgetCents <= 0) return "no budget for a batch";
  const idea = ideaFor(ctx, v);
  let hooks = ctx.store.hooks.list((h) => h.ventureId === v.id && h.status !== "culled").slice(0, 5);
  if (hooks.length < MIN_LIVE_HOOKS) hooks = [...hooks, ...(await refreshHooks(ctx, deps, v, hooks, MIN_LIVE_HOOKS - hooks.length))];
  if (!hooks.length) return "no live hooks";
  const arms = hooks.map((h) => `${h.formatId}:${h.id}`);
  const shares = armShares(arms, allocation, cfg.exploreShare);
  const batchBudget = dailyBudgetCents * cfg.batchDays;
  const batchId = ctx.store.nextId("batch");
  const posts = postsPerArm(shares, Math.max(arms.length, Math.round(batchBudget / Math.max(1, ctx.config.creators.defaultDeal.maxPayoutCents))));
  ctx.store.batches.put({ id: batchId, ventureId: v.id, family: "creator", startedAt: now, closesAt: addDays(now, cfg.batchDays), arms, allocation: shares, results: {}, culled: [], status: "open" });
  const geos = [...new Set([...ctx.config.lab.scaleGeos, ...(v.stores.find((s) => s.platform === "ios")?.territories ?? [])])];
  for (const hook of hooks) {
    const arm = `${hook.formatId}:${hook.id}`;
    const share = shares[arm] ?? 0;
    // Never above the hard per-action cap; batches are not split to slip under approval thresholds.
    const budgetCents = Math.min(Math.floor(batchBudget * share), ctx.config.autonomy.hardActionCapCents);
    if (budgetCents < ctx.config.creators.defaultDeal.flatFeeCents || (posts[arm] ?? 0) === 0) continue;
    const brief = await deps.agents.writeBrief(ctx, { idea, spec, topHooks: [hook.text] });
    const campaign: CreatorCampaign = {
      id: ctx.store.nextId("campaign"),
      ventureId: v.id,
      platforms: ["tiktok", "instagram"],
      targetCountries: geos,
      creatorAudienceCountryMinPct: ctx.config.lab.minCreatorGeoShare,
      ...adultRecruitment(ctx, v, { ...brief, hooks: [hook.text, ...brief.hooks.filter((h) => h !== hook.text)], formats: [hook.formatId, ...brief.formats.filter((f) => f !== hook.formatId)] }),
      flatFeeCents: ctx.config.creators.defaultDeal.flatFeeCents,
      cpmCents: ctx.config.creators.defaultDeal.cpmCents,
      maxPayoutPerVideoCents: ctx.config.creators.defaultDeal.maxPayoutCents,
      payoutMaturityDays: ctx.config.creators.viewLockDays,
      budgetCents,
      status: "draft",
      batchId,
      createdAt: now,
    };
    ctx.store.campaigns.put(campaign);
    ctx.outbox.propose({
      kind: "creator.campaign_create",
      ventureId: v.id,
      payload: { campaignId: campaign.id },
      summary: `Batch ${batchId}: "${hook.text.slice(0, 40)}" for ${v.name}`,
      rationale: `Thompson share ${(share * 100).toFixed(0)}% of a ${(batchBudget / 100).toFixed(0)} USD weekly batch`,
      proposedBy: "allocator",
      naturalKey: campaign.id,
      commitment: { kind: "lifetime_cap", amountCents: budgetCents, maxTotalCents: budgetCents, startsAt: now, endsAt: addDays(now, cfg.batchDays + ctx.config.creators.viewLockDays) },
    });
  }
  return `opened batch ${batchId} (${(batchBudget / 100).toFixed(0)} USD over ${arms.length} arms)`;
}
