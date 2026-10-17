/**
 * The executor: the only holder of WritePorts. It runs approved actions write-ahead
 * (committed as `executing` before the external call, `executed` or `failed` after),
 * so a crash mid-call leaves an `executing` action that reconcile() fails loudly
 * instead of re-running a side effect blindly.
 */
import { existsSync } from "node:fs";
import type { StudioConfig } from "../config/schema.ts";
import type { Clock, WritePorts } from "../core/ports.ts";
import type { StudioStore } from "../core/store.ts";
import type {
  Action,
  ActionKind,
  ActionResults,
  AdCampaign,
  ContentPiece,
  Creator,
  CreatorCampaign,
  ExternalJob,
  HumanTaskDraft,
  JobRef,
  OwnedAccount,
  Payout,
  StorePlatform,
  StoreRecord,
  Venture,
} from "../core/types.ts";
import { deriveDisclosure } from "./disclosure.ts";
import type { LedgerSync } from "./ledger.ts";
import type { Governance } from "./outbox.ts";

export interface ExecContext {
  store: StudioStore;
  config: StudioConfig;
  clock: Clock;
  write: WritePorts;
  ledger: LedgerSync;
  governance: Governance;
}

export type Handler<K extends ActionKind> = (
  ctx: ExecContext,
  action: Action<K>,
) => Promise<{ result: ActionResults[K]; humanTask?: HumanTaskDraft; job?: JobRef }>;

const JOB_DEADLINE_DAYS = 7;
export const INTERRUPTED_ERROR = "interrupted during execution: verify externally before retrying";

// -- entity helpers ---------------------------------------------------------------

function venture(ctx: ExecContext, a: Action): Venture {
  if (!a.ventureId) throw new Error(`${a.kind} ${a.id} has no ventureId`);
  return ctx.store.ventures.require(a.ventureId);
}

function patchVenture(ctx: ExecContext, v: Venture, patch: Partial<Venture>): Venture {
  return ctx.store.ventures.put({ ...ctx.store.ventures.require(v.id), ...patch, updatedAt: ctx.clock.iso() });
}

/** The venture's record for one store, created on first use. */
function storeRecord(ctx: ExecContext, v: Venture, platform: StorePlatform): StoreRecord {
  return (
    v.stores.find((s) => s.platform === platform) ?? {
      platform,
      publisherAccountId: v.bindings.publisherAccountIds[platform] ?? "",
      bundleId: platform === "ios" ? v.bindings.bundleId : v.bindings.androidPackage,
      status: "not_created",
      territories: [],
      rejectionReasons: [],
      updatedAt: ctx.clock.iso(),
    }
  );
}

function updateStore(ctx: ExecContext, v: Venture, platform: StorePlatform, patch: Partial<StoreRecord>): void {
  const current = ctx.store.ventures.require(v.id);
  const record = { ...storeRecord(ctx, current, platform), ...patch, updatedAt: ctx.clock.iso() };
  patchVenture(ctx, current, { stores: [...current.stores.filter((s) => s.platform !== platform), record] });
}

function creatorExternalId(c: Creator): string {
  const id = c.externalIds[c.source] ?? Object.values(c.externalIds)[0];
  if (!id) throw new Error(`creator ${c.id} has no external id`);
  return id;
}

function campaignExternal(c: CreatorCampaign): string {
  if (!c.externalId) throw new Error(`creator campaign ${c.id} has no externalId`);
  return c.externalId;
}

function adExternal(c: AdCampaign): string {
  if (!c.externalId) throw new Error(`ad campaign ${c.id} has no externalId`);
  return c.externalId;
}

/** A pre-allocated job id; the executor stores the ExternalJob under it. */
function jobResult(ctx: ExecContext, job: JobRef): { result: { jobId: string }; job: JobRef } {
  return { result: { jobId: ctx.store.nextId("job") }, job };
}

/** Legal page URLs inferred from the published site's file paths. */
function legalUrls(baseUrl: string, files: { path: string }[]): Partial<Record<"privacyUrl" | "termsUrl" | "supportUrl", string>> {
  const out: Partial<Record<"privacyUrl" | "termsUrl" | "supportUrl", string>> = {};
  const base = baseUrl.replace(/\/+$/, "");
  for (const [key, name] of [["privacyUrl", "privacy"], ["termsUrl", "terms"], ["supportUrl", "support"]] as const) {
    const file = files.find((f) => new RegExp(`^/?${name}(\\.html|/index\\.html|/)?$`, "i").test(f.path));
    if (file) out[key] = `${base}/${file.path.replace(/^\/+/, "").replace(/(\/index)?\.html$|\/$/i, "")}`;
  }
  return out;
}

// -- handlers -----------------------------------------------------------------------

export const HANDLERS: { [K in ActionKind]: Handler<K> } = {
  "store.register_bundle": async (ctx, a) => {
    const v = venture(ctx, a);
    const result = await ctx.write.store.registerBundleId({ bindings: v.bindings, platform: a.payload.platform, capabilities: a.payload.capabilities });
    updateStore(ctx, v, a.payload.platform, {});
    return { result };
  },

  "store.create_app": async (ctx, a) => {
    const v = venture(ctx, a);
    const p = a.payload;
    // An app id written back by the human task (or a previous run) means the app already exists.
    const known = v.stores.find((s) => s.platform === p.platform)?.appId ?? (p.platform === "ios" ? v.bindings.ascAppId : undefined);
    const r = known
      ? { appId: known }
      : await ctx.write.store.createApp({ bindings: v.bindings, platform: p.platform, name: p.name, sku: p.sku, primaryLocale: p.primaryLocale });
    if ("humanTask" in r) return { result: { appId: "" }, humanTask: r.humanTask };
    updateStore(ctx, v, p.platform, { appId: r.appId, status: "draft" });
    if (p.platform === "ios") patchVenture(ctx, v, { bindings: { ...ctx.store.ventures.require(v.id).bindings, ascAppId: r.appId } });
    return { result: { appId: r.appId } };
  },

  "store.upsert_subscriptions": async (ctx, a) => {
    const v = venture(ctx, a);
    const p = a.payload;
    const job = await ctx.write.store.upsertSubscriptions({ bindings: v.bindings, platform: p.platform, groupName: p.groupName, products: p.products });
    const products = [...v.bindings.products];
    for (const def of p.products) {
      const i = products.findIndex((x) => x.productId === def.productId);
      if (i < 0) products.push({ productId: def.productId, ladderId: def.ladderId, platform: p.platform, status: "created" });
      else if (products[i]?.status === "planned") products[i] = { ...(products[i] as (typeof products)[number]), status: "created" };
    }
    patchVenture(ctx, v, { bindings: { ...v.bindings, products } });
    return jobResult(ctx, job);
  },

  "store.start_build": async (ctx, a) => {
    const v = venture(ctx, a);
    return jobResult(ctx, await ctx.write.store.startBuild({ bindings: v.bindings, platform: a.payload.platform, projectDir: a.payload.projectDir }));
  },

  "store.submit_build": async (ctx, a) => {
    const v = venture(ctx, a);
    const job = await ctx.write.store.submitBuild({ bindings: v.bindings, platform: a.payload.platform, easBuildId: a.payload.easBuildId });
    updateStore(ctx, v, a.payload.platform, { status: "build_processing" });
    return jobResult(ctx, job);
  },

  "store.update_listing": async (ctx, a) => {
    const v = venture(ctx, a);
    const p = a.payload;
    return jobResult(ctx, await ctx.write.store.updateListing({ bindings: v.bindings, platform: p.platform, listing: p.listing, screenshotPaths: p.screenshotPaths }));
  },

  "store.set_territories": async (ctx, a) => {
    const v = venture(ctx, a);
    await ctx.write.store.setTerritories({ bindings: v.bindings, platform: a.payload.platform, territories: a.payload.territories });
    updateStore(ctx, v, a.payload.platform, { territories: [...a.payload.territories] });
    return { result: { territories: [...a.payload.territories] } };
  },

  "store.submit_review": async (ctx, a) => {
    const v = venture(ctx, a);
    const p = a.payload;
    const job = await ctx.write.store.submitForReview({ bindings: v.bindings, platform: p.platform, storeBuildId: p.storeBuildId, notesForReviewer: p.notesForReviewer });
    updateStore(ctx, v, p.platform, { status: "waiting_for_review", storeBuildId: p.storeBuildId });
    return jobResult(ctx, job);
  },

  "store.release": async (ctx, a) => {
    const v = venture(ctx, a);
    await ctx.write.store.release({ bindings: v.bindings, platform: a.payload.platform, phased: a.payload.phased });
    updateStore(ctx, v, a.payload.platform, { status: "live" });
    return { result: { released: true } };
  },

  "store.remove_from_sale": async (ctx, a) => {
    const v = venture(ctx, a);
    await ctx.write.store.removeFromSale({ bindings: v.bindings, platform: a.payload.platform });
    updateStore(ctx, v, a.payload.platform, { status: "removed" });
    return { result: { removed: true } };
  },

  "monetization.configure": async (ctx, a) => {
    const v = venture(ctx, a);
    return { result: await ctx.write.monetization.configure({ bindings: v.bindings, productIds: a.payload.productIds, entitlementId: a.payload.entitlementId }) };
  },

  "remote_config.set": async (ctx, a) => {
    const v = venture(ctx, a);
    return { result: await ctx.write.remoteConfig.setFlag({ bindings: v.bindings, key: a.payload.key, variants: a.payload.variants }) };
  },

  "web.publish_site": async (ctx, a) => {
    const v = venture(ctx, a);
    const result = await ctx.write.web.publishSite({ ventureId: v.id, files: a.payload.files });
    const inferred = legalUrls(result.baseUrl, a.payload.files);
    const current = ctx.store.ventures.require(v.id).bindings;
    patchVenture(ctx, v, {
      bindings: {
        ...current,
        webBaseUrl: result.baseUrl,
        privacyUrl: current.privacyUrl ?? inferred.privacyUrl,
        termsUrl: current.termsUrl ?? inferred.termsUrl,
        supportUrl: current.supportUrl ?? inferred.supportUrl,
      },
    });
    return { result };
  },

  "web.put_asset": async (ctx, a) => {
    const v = venture(ctx, a);
    const result = await ctx.write.web.putAsset({ ventureId: v.id, localPath: a.payload.localPath, contentType: a.payload.contentType });
    for (const piece of ctx.store.content.list((c) => c.ventureId === v.id && c.media.some((m) => m.localPath === a.payload.localPath))) {
      ctx.store.content.put({ ...piece, media: piece.media.map((m) => (m.localPath === a.payload.localPath ? { ...m, publicUrl: result.publicUrl } : m)) });
    }
    return { result };
  },

  "content.publish": async (ctx, a) => {
    const p = a.payload;
    const piece: ContentPiece = ctx.store.content.require(p.contentId);
    const account: OwnedAccount = ctx.store.accounts.require(p.accountId);
    const job = await ctx.write.social.publish({ account, platform: p.platform, piece, mode: p.mode, labels: p.labels });
    ctx.store.content.put({
      ...piece,
      accountId: account.id,
      disclosure: deriveDisclosure(piece, ctx.clock.iso()),
      status: p.mode === "inbox_draft" ? "pending_human" : "scheduled",
    });
    return jobResult(ctx, job);
  },

  "creator.campaign_create": async (ctx, a) => {
    const campaign = ctx.store.campaigns.require(a.payload.campaignId);
    const { externalId } = await ctx.write.creators.createCampaign(campaign);
    ctx.store.campaigns.put({ ...campaign, externalId, status: "open" });
    return { result: { externalId } };
  },

  "creator.campaign_close": async (ctx, a) => {
    const campaign = ctx.store.campaigns.require(a.payload.campaignId);
    await ctx.write.creators.closeCampaign({ campaignExternalId: campaignExternal(campaign) });
    ctx.store.campaigns.put({ ...campaign, status: "closed" });
    return { result: { closed: true } };
  },

  "creator.outreach": async (ctx, a) => {
    const creator = ctx.store.creators.require(a.payload.creatorId);
    await ctx.write.creators.sendMessage({ creatorExternalId: creatorExternalId(creator), text: a.payload.message });
    if (creator.status === "prospect") ctx.store.creators.put({ ...creator, status: "contacted" });
    return { result: { sent: true } };
  },

  "creator.deal_offer": async (ctx, a) => {
    const deal = ctx.store.deals.require(a.payload.dealId);
    const creator = ctx.store.creators.require(deal.creatorId);
    const campaign = ctx.store.campaigns.list((c) => c.ventureId === deal.ventureId && c.status === "open" && c.externalId !== undefined)[0];
    const { externalId } = await ctx.write.creators.offerDeal({
      creatorExternalId: creatorExternalId(creator),
      deal,
      ...(campaign?.externalId ? { campaignExternalId: campaign.externalId } : {}),
    });
    if (creator.status === "prospect" || creator.status === "contacted") ctx.store.creators.put({ ...creator, status: "negotiating" });
    return { result: { externalId } };
  },

  "creator.review_draft": async (ctx, a) => {
    const sub = ctx.store.submissions.require(a.payload.submissionId);
    await ctx.write.creators.reviewDraft({ submissionExternalId: sub.externalId, approve: a.payload.approve, note: a.payload.note });
    ctx.store.submissions.put({ ...sub, stage: a.payload.approve ? "draft_approved" : "rejected" });
    return { result: { recorded: true } };
  },

  "creator.review_post": async (ctx, a) => {
    const sub = ctx.store.submissions.require(a.payload.submissionId);
    await ctx.write.creators.reviewPost({ submissionExternalId: sub.externalId, approve: a.payload.approve, note: a.payload.note });
    ctx.store.submissions.put({ ...sub, stage: a.payload.approve ? "post_approved" : "rejected" });
    return { result: { recorded: true } };
  },

  "creator.payout": async (ctx, a) => {
    const p = a.payload;
    const sub = ctx.store.submissions.require(p.submissionId);
    const campaign = ctx.store.campaigns.require(sub.campaignId);
    const r = await ctx.write.creators.payout({ submissionExternalId: sub.externalId, amountCents: p.amountCents, idempotencyKey: a.idempotencyKey, basis: p.basis });
    const now = ctx.clock.iso();
    const payout: Payout = {
      id: ctx.store.nextId("payout"),
      submissionId: sub.id,
      amountCents: p.amountCents,
      idempotencyKey: a.idempotencyKey,
      externalId: r.payoutId,
      basis: p.basis,
      at: now,
    };
    ctx.store.payouts.put(payout);
    ctx.ledger.onPayout(payout, a.ventureId ?? campaign.ventureId);
    ctx.store.submissions.put({ ...sub, stage: "paid", payoutCents: p.amountCents });
    const creator = ctx.store.creators.get(sub.creatorId);
    if (creator) {
      ctx.store.creators.put({ ...creator, firstPaidAt: creator.firstPaidAt ?? now, stats: { ...creator.stats, paidCents: creator.stats.paidCents + p.amountCents } });
    }
    return { result: { payoutId: payout.id } };
  },

  "ads.campaign_create": async (ctx, a) => {
    const v = venture(ctx, a);
    const c = ctx.store.adCampaigns.require(a.payload.adCampaignId);
    const adAccountId = v.bindings.adAccountIds[c.network];
    if (!adAccountId) throw new Error(`venture ${v.id} has no ${c.network} ad account bound`);
    const { campaignExternalId } = await ctx.write.ads.createCampaign({
      bindings: v.bindings,
      network: c.network,
      adAccountId,
      os: c.os,
      type: c.type,
      dailyBudgetCents: c.dailyBudgetCents,
      startAt: c.startAt,
      endAt: c.endAt,
      geos: c.geos,
      creatives: c.creatives,
      keywords: c.keywords,
      name: `${v.slug}-${c.type}-${c.id}`,
    });
    ctx.store.adCampaigns.put({ ...c, externalId: campaignExternalId, status: "active" });
    return { result: { externalId: campaignExternalId } };
  },

  "ads.budget_change": async (ctx, a) => {
    const c = ctx.store.adCampaigns.require(a.payload.adCampaignId);
    await ctx.write.ads.setDailyBudget({ network: c.network, campaignExternalId: adExternal(c), dailyBudgetCents: a.payload.toDailyCents });
    ctx.store.adCampaigns.put({ ...c, dailyBudgetCents: a.payload.toDailyCents });
    return { result: { dailyBudgetCents: a.payload.toDailyCents } };
  },

  "ads.pause": async (ctx, a) => {
    const c = ctx.store.adCampaigns.require(a.payload.adCampaignId);
    await ctx.write.ads.pause({ network: c.network, campaignExternalId: adExternal(c) });
    ctx.store.adCampaigns.put({ ...c, status: "paused" });
    return { result: { paused: true } };
  },

  // Lifecycle decisions: recorded for the orchestrator's state machine, no external call.
  "venture.scale": async () => ({ result: { approved: true } }),
  "venture.kill": async () => ({ result: { killed: true } }),
  "venture.sunset": async () => ({ result: { started: true } }),
  "venture.exit_flag": async () => ({ result: { flagged: true } }),

  // No support port exists yet: the approved reply is recorded for a human to send.
  "support.reply": async () => ({ result: { sent: false } }),
};

// -- executor -------------------------------------------------------------------------

export class Executor {
  private readonly ctx: ExecContext;
  private readonly dryRun: boolean;
  private readonly killSwitchPath: string | null;

  constructor(ctx: ExecContext & { dryRun: boolean; killSwitchPath: string | null }) {
    const { dryRun, killSwitchPath, ...rest } = ctx;
    this.ctx = rest;
    this.dryRun = dryRun;
    this.killSwitchPath = killSwitchPath;
  }

  /** Run approved actions, oldest first. Returns each action in its final state. */
  async runApproved(opts: { limit?: number } = {}): Promise<Action[]> {
    const { store, governance } = this.ctx;
    const queue = governance.list({ status: ["approved"] }).slice(0, opts.limit ?? Number.POSITIVE_INFINITY);
    const out: Action[] = [];
    for (const queued of queue) {
      if (this.killSwitchActive()) break;
      // Cash, caps and time may have moved since approval.
      const action = governance.recheck(queued.id);
      if (action.status !== "approved") {
        store.commit();
        out.push(action);
        continue;
      }
      out.push(this.dryRun ? this.recordDryRun(action) : await this.execute(action));
    }
    return out;
  }

  /** Fail actions a crash left in `executing`: their side effect may or may not have happened. */
  reconcile(): Action[] {
    const { store, governance, clock } = this.ctx;
    const stuck = governance.list({ status: ["executing"] });
    for (const a of stuck) {
      store.governanceActions().put({ ...a, status: "failed", error: INTERRUPTED_ERROR });
      store.emit("action.failed", { actionId: a.id, kind: a.kind, error: INTERRUPTED_ERROR, reconciledAt: clock.iso() }, a.ventureId);
    }
    if (stuck.length) store.commit();
    return stuck.map((a) => store.actions.require(a.id));
  }

  private killSwitchActive(): boolean {
    return (this.killSwitchPath !== null && existsSync(this.killSwitchPath)) || this.ctx.governance.killSwitchActive();
  }

  private recordDryRun(a: Action): Action {
    const { store, clock } = this.ctx;
    const next: Action = { ...a, status: "dry_run", result: { dryRun: true } as unknown as Action["result"], executedAt: clock.iso() };
    store.governanceActions().put(next);
    store.emit("action.executed", { actionId: a.id, kind: a.kind, dryRun: true }, a.ventureId);
    store.commit();
    return next;
  }

  private async execute(a: Action): Promise<Action> {
    const { store, clock, governance } = this.ctx;
    const actions = store.governanceActions();
    actions.put({ ...a, status: "executing" });
    store.commit();
    try {
      const handler = HANDLERS[a.kind] as Handler<ActionKind>;
      const out = await handler(this.ctx, a);
      if (out.humanTask) {
        governance.openTask({ ...out.humanTask, ...(a.ventureId && !out.humanTask.ventureId ? { ventureId: a.ventureId } : {}) }, [a.id]);
      } else {
        actions.put({ ...actions.require(a.id), status: "executed", result: out.result, executedAt: clock.iso() });
        if (out.job) this.putJob(a, out.job, out.result);
        store.emit("action.executed", { actionId: a.id, kind: a.kind }, a.ventureId);
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      actions.put({ ...actions.require(a.id), status: "failed", error });
      store.emit("action.failed", { actionId: a.id, kind: a.kind, error }, a.ventureId);
    }
    store.commit();
    return actions.require(a.id);
  }

  private putJob(a: Action, ref: JobRef, result: unknown): void {
    const { store, clock } = this.ctx;
    const nowMs = clock.now().getTime();
    const preallocated = (result as { jobId?: unknown } | undefined)?.jobId;
    const job: ExternalJob = {
      id: typeof preallocated === "string" && preallocated ? preallocated : store.nextId("job"),
      op: ref.op,
      actionId: a.id,
      externalRef: ref.externalRef,
      status: "running",
      nextPollAt: new Date(nowMs + ref.pollAfterSec * 1000).toISOString(),
      deadlineAt: new Date(nowMs + JOB_DEADLINE_DAYS * 86_400_000).toISOString(),
      attempts: 0,
      createdAt: clock.iso(),
      ...(a.ventureId ? { ventureId: a.ventureId } : {}),
    };
    store.jobs.put(job);
    store.emit("job.updated", { jobId: job.id, op: job.op, actionId: a.id, status: job.status }, a.ventureId);
  }
}
