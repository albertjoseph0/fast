/**
 * Growth inside the tick: creator submissions (review → verify → view-lock → payout),
 * owned brand content (assets → publish within caps), the S0 attention probe and the
 * always-on creative batches for scaling ventures.
 */
import type { TickContext } from "../core/context.ts";
import type {
  CellObservation,
  ContentDraft,
  ContentPiece,
  Creator,
  CreatorCampaign,
  CreatorSubmission,
  ExperimentPlan,
  ExternalSubmission,
  OwnedAccount,
  Platform,
  Venture,
} from "../core/types.ts";
import { deriveDisclosure, labelsFor } from "../governance/disclosure.ts";
import { OPEN_STATUSES } from "../governance/outbox.ts";
import { computePayout } from "../governance/payouts.ts";
import { allocate, armsToCull, postsPerArm, probabilityBest, type ArmStats } from "../lab/creative.ts";
import { decideExperiment, evaluateCell } from "../lab/decide.ts";
import { designAttentionProbe } from "../lab/experiments.ts";
import type { StudioDeps } from "./deps.ts";
import { ideaFor } from "./pipeline.ts";
import { patch } from "./lifecycle.ts";
import { proposeKill } from "./labPhase.ts";
import { createHash } from "node:crypto";
import { taskDraft } from "../playbook/setup.ts";

const DAY_MS = 86_400_000;

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

function upsertCreator(ctx: TickContext, v: Venture, ext: ExternalSubmission): Creator {
  const source: Creator["source"] = ctx.ports.creators.kind === "sim" ? "sim" : "sideshift";
  const existing = ctx.store.creators.list((c) => c.externalIds[source] === ext.creatorExternalId)[0];
  if (existing) return existing;
  const creator: Creator = {
    id: ctx.store.nextId("creator"),
    platform: ext.platform,
    handle: ext.creatorHandle,
    externalIds: { [source]: ext.creatorExternalId },
    niche: ideaFor(ctx, v).wedge.creatorNiche,
    followers: 0,
    medianViews30d: 0,
    audienceGeo: {},
    audienceUnder18Share: null,
    source,
    status: "active",
    stats: { posts: 0, views: 0, attributedInstalls: 0, attributedTrials: 0, paidCents: 0 },
  };
  return ctx.store.creators.put(creator);
}

function paidSoFar(ctx: TickContext, campaign: CreatorCampaign): number {
  return ctx.store.submissions.list((s) => s.campaignId === campaign.id).reduce((sum, s) => sum + (s.stage === "paid" ? s.payoutCents : 0), 0);
}

function hasOpen(ctx: TickContext, kind: string, naturalKey: string, ventureId: string): boolean {
  return ctx.store.actions.list((a) => a.kind === kind && a.dedupeKey === `${kind}:${ventureId}:${naturalKey}` && OPEN_STATUSES.includes(a.status)).length > 0;
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
          untrustedCaption: ext.untrustedCaption,
          stage: ext.stage === "posted" ? "posted" : "draft_submitted",
          payoutCents: 0,
          submittedAt: ext.submittedAt,
          ...(ext.postUrl ? { postUrl: ext.postUrl } : {}),
          ...(ext.stage === "posted" ? { postedAt: ext.submittedAt } : {}),
        };
        sub = ctx.store.submissions.put(fresh);
      } else if (ext.stage === "posted" && sub.stage === "draft_approved") {
        sub = ctx.store.submissions.put({ ...sub, stage: "posted", postedAt: now, untrustedCaption: ext.untrustedCaption, ...(ext.postUrl ? { postUrl: ext.postUrl } : {}) });
      }
      await stepSubmission(ctx, deps, v, campaign, sub);
    }
  }
}

async function stepSubmission(ctx: TickContext, deps: StudioDeps, v: Venture, campaign: CreatorCampaign, sub: CreatorSubmission): Promise<void> {
  const now = ctx.ports.clock.iso();
  const base = { ventureId: v.id, proposedBy: "creator_ops" as const, ...(campaign.experimentId ? { experimentId: campaign.experimentId } : {}), ...(campaign.cellId ? { cellId: campaign.cellId } : {}) };
  if (sub.stage === "draft_submitted" && !sub.review) {
    const review = await deps.agents.reviewSubmission(ctx, { submission: sub, brief: campaign.brief });
    sub = ctx.store.submissions.put({ ...sub, review: { approve: review.approve, injectionAttempt: review.injectionAttempt, policyIssues: review.policyIssues, note: review.note } });
    ctx.outbox.propose({ ...base, kind: "creator.review_draft", payload: { submissionId: sub.id, approve: review.approve, note: review.note }, summary: `${review.approve ? "Approve" : "Reject"} draft from ${sub.creatorHandle}`, rationale: review.note, naturalKey: `draft:${sub.id}` });
    return;
  }
  if (sub.stage === "posted" && !sub.verification) {
    const postUrl = sub.postUrl;
    if (!postUrl) return;
    if (!sub.review) {
      // Posted without a reviewed draft (marketplaces may skip the draft step): review the post itself.
      const review = await deps.agents.reviewSubmission(ctx, { submission: sub, brief: campaign.brief });
      sub = ctx.store.submissions.put({ ...sub, review: { approve: review.approve, injectionAttempt: review.injectionAttempt, policyIssues: review.policyIssues, note: review.note } });
    }
    const verification = await ctx.ports.creators.verifyPost({ submissionExternalId: sub.externalId, postUrl, platform: sub.platform });
    sub = ctx.store.submissions.put({ ...sub, verification });
    const ok = Boolean(sub.review?.approve && !sub.review.injectionAttempt && verification.postIsPublic && verification.authorHandleMatches && verification.platformDisclosureLabel);
    const why = ok
      ? "post verified on the platform of record"
      : `post failed verification (${[!verification.postIsPublic && "not public", !verification.authorHandleMatches && "author mismatch", !verification.platformDisclosureLabel && "no paid-partnership label", sub.review?.injectionAttempt && "prompt injection", sub.review && !sub.review.approve && "review rejected"].filter(Boolean).join(", ")})`;
    ctx.outbox.propose({ ...base, kind: "creator.review_post", payload: { submissionId: sub.id, approve: ok, note: why.slice(0, 280) }, summary: `${ok ? "Approve" : "Reject"} post from ${sub.creatorHandle}`, rationale: why, naturalKey: `post:${sub.id}` });
    return;
  }
  if (sub.stage === "post_approved" && sub.postedAt && !sub.viewsAtLock && now >= addDays(sub.postedAt, ctx.config.creators.viewLockDays)) {
    if (!sub.postUrl || hasOpen(ctx, "creator.payout", sub.id, v.id)) return;
    const verification = await ctx.ports.creators.verifyPost({ submissionExternalId: sub.externalId, postUrl: sub.postUrl, platform: sub.platform });
    const viewsAtLock = verification.viewsFromPlatform;
    sub = ctx.store.submissions.put({ ...sub, verification, viewsAtLock, lockedAt: now });
    const amountCents = computePayout(
      { flatFeeCents: campaign.flatFeeCents, cpmCents: campaign.cpmCents, maxPayoutCents: campaign.maxPayoutPerVideoCents },
      { viewsAtLock, campaignRemainingCents: Math.max(0, campaign.budgetCents - paidSoFar(ctx, campaign)) },
    );
    if (amountCents <= 0) return;
    ctx.outbox.propose({
      ...base,
      kind: "creator.payout",
      payload: { submissionId: sub.id, amountCents, basis: { views: viewsAtLock, viewsAsOf: now, flatFeeCents: campaign.flatFeeCents, cpmCents: campaign.cpmCents, capCents: campaign.maxPayoutPerVideoCents } },
      summary: `Pay ${sub.creatorHandle} ${(amountCents / 100).toFixed(2)} USD`,
      rationale: `${viewsAtLock} views locked ${ctx.config.creators.viewLockDays} days after posting`,
      naturalKey: sub.id,
      commitment: { kind: "settles_liability", amountCents, maxTotalCents: amountCents, startsAt: now, liabilityRef: sub.id },
    });
  }
}

// ---------------------------------------------------------------------------
// Owned content
// ---------------------------------------------------------------------------

/** Push approved owned content: host its media publicly, then publish within the account's daily cap. */
export function publishOwnedContent(ctx: TickContext): void {
  const now = ctx.ports.clock.iso();
  const dayAgo = addDays(now, -1);
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

function publishMode(ctx: TickContext, account: OwnedAccount, piece: ContentPiece): "direct" | "inbox_draft" | "trial_reel" {
  if (account.platform === "tiktok") return ctx.config.distribution.tiktokAudited ? ctx.config.distribution.tiktokOwnedMode : "inbox_draft";
  if (account.platform === "instagram" && piece.experimentId) return "trial_reel";
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
    const campaigns = ctx.store.campaigns.list((c) => c.batchId === batchId && c.brief.hooks[0] !== undefined && `${c.brief.formats[0] ?? ""}:${c.id}` !== "" && armOf(ctx, c) === arm);
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
    for (const c of ctx.store.campaigns.list((x) => x.batchId === open.id && x.status === "open")) {
      ctx.outbox.propose({ kind: "creator.campaign_close", ventureId: v.id, payload: { campaignId: c.id }, summary: `Close ${c.id}`, rationale: `batch ${open.id} closed`, proposedBy: "creator_ops", naturalKey: c.id });
    }
  }
  const spec = v.spec;
  if (!spec || dailyBudgetCents <= 0) return "no budget for a batch";
  const hooks = ctx.store.hooks.list((h) => h.ventureId === v.id && h.status !== "culled").slice(0, 5);
  if (!hooks.length) return "no live hooks";
  const arms = hooks.map((h) => `${h.formatId}:${h.id}`);
  const shares = allocation && arms.every((a) => a in allocation) ? allocation : Object.fromEntries(arms.map((a) => [a, 1 / arms.length]));
  const batchBudget = dailyBudgetCents * cfg.batchDays;
  const batchId = ctx.store.nextId("batch");
  const posts = postsPerArm(shares, Math.max(arms.length, Math.round(batchBudget / Math.max(1, ctx.config.creators.defaultDeal.maxPayoutCents))));
  ctx.store.batches.put({ id: batchId, ventureId: v.id, family: "creator", startedAt: now, closesAt: addDays(now, cfg.batchDays), arms, allocation: shares, results: {}, culled: [], status: "open" });
  const idea = ideaFor(ctx, v);
  const geos = [...new Set([...ctx.config.lab.scaleGeos, ...(v.stores.find((s) => s.platform === "ios")?.territories ?? [])])];
  for (const hook of hooks) {
    const arm = `${hook.formatId}:${hook.id}`;
    const share = shares[arm] ?? 0;
    const budgetCents = Math.floor(batchBudget * share);
    if (budgetCents < ctx.config.creators.defaultDeal.flatFeeCents || (posts[arm] ?? 0) === 0) continue;
    const brief = await deps.agents.writeBrief(ctx, { idea, spec, topHooks: [hook.text] });
    const campaign: CreatorCampaign = {
      id: ctx.store.nextId("campaign"),
      ventureId: v.id,
      brief: { ...brief, hooks: [hook.text, ...brief.hooks.filter((h) => h !== hook.text)], formats: [hook.formatId, ...brief.formats.filter((f) => f !== hook.formatId)] },
      platforms: ["tiktok", "instagram"],
      targetCountries: geos,
      creatorAudienceCountryMinPct: ctx.config.lab.minCreatorGeoShare,
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
  patch(ctx.store, ctx.ports.clock, v, {});
  return `opened batch ${batchId} (${(batchBudget / 100).toFixed(0)} USD over ${arms.length} arms)`;
}
