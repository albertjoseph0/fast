/**
 * Policy: deterministic predicates over a proposed Action, each with a citation.
 * Findings are info, warn, needs_human (a board approval bound to the payload hash
 * clears it) or block (nothing clears it but a changed world or payload).
 */
import type { StudioConfig } from "../config/schema.ts";
import type { StudioStore } from "../core/store.ts";
import type {
  Action,
  ActionKind,
  ActionPayloads,
  ActionStatus,
  AppSpec,
  Approval,
  Claim,
  ContentPiece,
  Iso,
  PolicyFinding,
  SubmissionChangeArea,
  Venture,
} from "../core/types.ts";
import { lintCopy, lintCopyAll } from "../principles/copy.ts";
import { lintSpec } from "../principles/product.ts";
import { minimumAgeFor } from "../principles/sensitivity.ts";
import { deriveDisclosure, labelsFor } from "./disclosure.ts";
import { canonicalJson } from "./hash.ts";
import type { LedgerSync } from "./ledger.ts";
import { computePayout } from "./payouts.ts";

export const POLICY_VERSION = "policy-2026-10-19.1";

export interface PolicyContext {
  config: StudioConfig;
  store: StudioStore;
  now: Iso;
  today: string;
  killSwitchActive: boolean;
  ledger: LedgerSync;
}

export interface PolicyRule {
  id: string;
  citation: string;
  applies: (a: Action) => boolean;
  check: (a: Action, ctx: PolicyContext) => PolicyFinding[];
}

type Severity = PolicyFinding["severity"];
type Flag = (severity: Severity, message: string) => PolicyFinding;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** GDPR / UK GDPR / DSA storefronts: the EU-27, the rest of the EEA and the UK. */
const EU_UK = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL",
  "PL", "PT", "RO", "SK", "SI", "ES", "SE", "IS", "LI", "NO", "GB",
]);

/** Kinds that commit studio money. */
const MONEY_KINDS: readonly ActionKind[] = [
  "creator.campaign_create",
  "creator.deal_offer",
  "creator.payout",
  "ads.campaign_create",
  "ads.budget_change",
  "venture.scale",
];

const SIGNIFICANT_CHANGES: readonly SubmissionChangeArea[] = ["new_app", "core", "monetization", "age_rating", "data_flows"];

const VENTURE_PREFIXES = ["store.", "monetization.", "remote_config.", "web.", "ads.", "venture."];
// A dry_run sent nothing, so it never counts as posted or done once dry-run is turned off.
const POSTED: readonly ActionStatus[] = ["approved", "executing", "executed"];
const DONE: readonly ActionStatus[] = ["executed"];
/** Payout actions that hold part of a campaign's budget (the outbox's open statuses; importing them would be circular). */
const PAYOUT_OPEN: readonly ActionStatus[] = ["proposed", "blocked", "awaiting_approval", "awaiting_human_task", "approved", "executing"];

/** An approval that records the needs_human rules the approver saw. Approvals without the list predate it and cover all. */
export type CoveringApproval = Approval;

function rule<K extends ActionKind = ActionKind>(
  id: string,
  citation: string,
  applies: readonly K[] | ((a: Action) => boolean),
  check: (a: Action<K>, ctx: PolicyContext, flag: Flag) => PolicyFinding[],
): PolicyRule {
  const flag: Flag = (severity, message) => ({ ruleId: id, severity, message, citation });
  return {
    id,
    citation,
    applies: typeof applies === "function" ? applies : (a) => (applies as readonly ActionKind[]).includes(a.kind),
    check: (a, ctx) => check(a as Action<K>, ctx, flag),
  };
}

// -- shared lookups -------------------------------------------------------------

function ventureOf(a: Action, ctx: PolicyContext): Venture | undefined {
  return a.ventureId ? ctx.store.ventures.get(a.ventureId) : undefined;
}

function ms(iso: Iso): number {
  return new Date(iso).getTime();
}

function actionTime(a: Action): Iso {
  return a.executedAt ?? a.decidedAt ?? a.createdAt;
}

function scalingStage(v: Venture | undefined): boolean {
  return v?.stage === "scaling" || v?.stage === "harvest";
}

/** Storefronts a venture may target autonomously (P4: never the scale market before venture.scale). */
function allowedGeos(ctx: PolicyContext, v: Venture | undefined): Set<string> {
  const lab = ctx.config.lab;
  return new Set([...lab.testGeos, ...Object.values(lab.localizedTestGeos).flat(), ...(scalingStage(v) ? lab.scaleGeos : [])]);
}

function activeClaims(ctx: PolicyContext, ventureId: string | undefined): Claim[] {
  return ctx.store.claims.list((c) => (c.ventureId === ventureId || c.ventureId === "studio") && Boolean(c.approvedBy) && c.expiresAt > ctx.now);
}

function latestSubscribers(ctx: PolicyContext, ventureId: string | undefined): number {
  if (!ventureId) return 0;
  return ctx.store.metrics(ventureId, (m) => m.cellId === null && m.geo === null).at(-1)?.activeSubscribers ?? 0;
}

function priorDone(ctx: PolicyContext, a: Action, kind: ActionKind, extra: (x: Action) => boolean = () => true): Action[] {
  return ctx.store.actions.list((x) => x.kind === kind && x.id !== a.id && x.ventureId === a.ventureId && DONE.includes(x.status) && extra(x));
}

function isFirstSubmission(a: Action, ctx: PolicyContext): boolean {
  return priorDone(ctx, a, "store.submit_review").length === 0;
}

/** Youngest intended user across the idea's wedge, the spec and the independent classifier. */
function effectiveMinAge(ctx: PolicyContext, v: Venture): number | undefined {
  const idea = ctx.store.ideas.get(v.ideaId)?.idea;
  const screening = ctx.store.latestScreening(v.ideaId);
  const ages: number[] = [];
  if (idea) ages.push(idea.wedge.minAge);
  if (v.spec) ages.push(Number(v.spec.compliance.minimumAge));
  if (screening?.sensitiveDomains.includes("minors")) ages.push(13);
  return ages.length ? Math.min(...ages) : undefined;
}

function sensitiveHits(ctx: PolicyContext, v: Venture): string[] {
  const domains = ctx.store.latestScreening(v.ideaId)?.sensitiveDomains ?? [];
  return domains.filter((d) => ctx.config.autonomy.humanReviewDomains.includes(d));
}

/** Product ids a monetization.configure or paywall remote_config.set references. */
function referencedProductIds(a: Action): string[] {
  if (a.kind === "monetization.configure") return [...(a.payload as ActionPayloads["monetization.configure"]).productIds];
  const ids = new Set<string>();
  for (const v of (a.payload as ActionPayloads["remote_config.set"]).variants) {
    const p = v.payload as { productIds?: unknown; highlightedProductId?: unknown } | null;
    if (!p || typeof p !== "object") continue;
    if (Array.isArray(p.productIds)) for (const id of p.productIds) if (typeof id === "string") ids.add(id);
    if (typeof p.highlightedProductId === "string") ids.add(p.highlightedProductId);
  }
  return [...ids];
}

function isPaywallConfig(a: Action): boolean {
  return a.kind === "monetization.configure" || (a.kind === "remote_config.set" && (a.payload as ActionPayloads["remote_config.set"]).key === "paywall");
}

function sameSet(x: string[], y: string[]): boolean {
  const a = [...new Set(x)].sort();
  const b = [...new Set(y)].sort();
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function postsOnAccount(ctx: PolicyContext, a: Action, accountId: string): Action<"content.publish">[] {
  return ctx.store.actions.list(
    (x) =>
      x.kind === "content.publish" &&
      x.id !== a.id &&
      POSTED.includes(x.status) &&
      (x.payload as ActionPayloads["content.publish"]).accountId === accountId,
  ) as Action<"content.publish">[];
}

/** Freeze scopes an action falls under: the studio, its venture, and its platform, network or account. */
function freezeScopes(a: Action, ctx: PolicyContext): string[] {
  const scopes = ["studio"];
  if (a.ventureId) scopes.push(`venture:${a.ventureId}`);
  const p = a.payload as { platform?: unknown; accountId?: unknown; adCampaignId?: unknown; campaignId?: unknown };
  if (typeof p.platform === "string") scopes.push(`platform:${p.platform}`);
  if (typeof p.accountId === "string") scopes.push(`account:${p.accountId}`);
  if (typeof p.adCampaignId === "string") {
    const network = ctx.store.adCampaigns.get(p.adCampaignId)?.network;
    if (network) scopes.push(`network:${network}`);
  }
  if (typeof p.campaignId === "string") for (const platform of ctx.store.campaigns.get(p.campaignId)?.platforms ?? []) scopes.push(`platform:${platform}`);
  return scopes;
}

function contentCopy(piece: ContentPiece): { text: string; path: string }[] {
  const d = piece.draft;
  return [
    { text: d.hook, path: "draft.hook" },
    { text: d.caption, path: "draft.caption" },
    { text: d.script, path: "draft.script" },
    { text: d.callToAction, path: "draft.callToAction" },
    ...d.slides.map((s, i) => ({ text: s.text, path: `draft.slides[${i}].text` })),
    ...(d.hashtags ?? []).map((h, i) => ({ text: h, path: `draft.hashtags[${i}]` })),
  ].filter((i) => i.text.trim().length > 0);
}

/** Open payouts for other submissions on a campaign: the orchestrator sizes each payout after them. */
function otherOpenPayoutsOnCampaign(ctx: PolicyContext, a: Action<"creator.payout">, campaignId: string): number {
  const subIds = new Set(ctx.store.submissions.list((s) => s.campaignId === campaignId && s.id !== a.payload.submissionId).map((s) => s.id));
  return ctx.store.actions
    .list((x) => x.kind === "creator.payout" && x.id !== a.id && PAYOUT_OPEN.includes(x.status) && subIds.has((x.payload as ActionPayloads["creator.payout"]).submissionId))
    .reduce((s, x) => s + (x.payload as ActionPayloads["creator.payout"]).amountCents, 0);
}

/** An 18+ app: adult-only screening domains or wedge, or an 18+ store rating in the spec. */
function adultOnly(ctx: PolicyContext, v: Venture): boolean {
  if (v.spec?.compliance.minimumAge === "18") return true;
  const idea = ctx.store.ideas.get(v.ideaId)?.idea;
  return idea !== undefined && minimumAgeFor(idea, ctx.store.latestScreening(v.ideaId)?.sensitiveDomains ?? []) === 18;
}

type VariantSurface = "paywall" | "onboarding" | "share";

/** Spec-lint findings that belong to the surface a remote-config key replaces. */
const SURFACE_FINDING: Record<VariantSurface, (f: PolicyFinding) => boolean> = {
  paywall: (f) => f.ruleId.startsWith("spec.paywall_") || f.message.includes(" at paywall."),
  onboarding: (f) => f.ruleId.startsWith("onboarding."),
  share: (f) => f.ruleId.startsWith("spec.share_") || f.message.includes(" at share."),
};

/** The spec with one remote-config variant applied: onboarding is replaced, paywall and share are merged. */
function specWithVariant(spec: AppSpec, key: VariantSurface, payload: unknown): AppSpec | string {
  if (key === "onboarding") return Array.isArray(payload) ? { ...spec, onboarding: payload } : "onboarding variant must be a list of steps";
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return `${key} variant must be an object`;
  return { ...spec, [key]: { ...spec[key], ...payload } };
}

// -- rules ----------------------------------------------------------------------

export const RULES: PolicyRule[] = [
  rule("kill_switch", "ARCHITECTURE s.9: the kill switch halts every external action", () => true, (_a, ctx, flag) =>
    ctx.killSwitchActive ? [flag("block", "Kill switch is active: no external actions run until it is removed")] : [],
  ),

  rule("freeze", "Research brief s.5.4/5.6: strikes and tripwires freeze automation on a scope until a human clears it", () => true, (a, ctx, flag) =>
    ctx.store.freezes(freezeScopes(a, ctx)).map((f) => flag("block", `Automation frozen on ${f.scope} by ${f.by}: ${f.reason}`)),
  ),

  rule("venture.exists", "ARCHITECTURE s.2.3: every action is scoped to a known venture", () => true, (a, ctx, flag) => {
    if (a.ventureId) return ctx.store.ventures.get(a.ventureId) ? [] : [flag("block", `Venture ${a.ventureId} not found`)];
    const needsVenture = VENTURE_PREFIXES.some((p) => a.kind.startsWith(p)) || a.kind === "content.publish" || a.kind === "creator.campaign_create";
    return needsVenture ? [flag("block", `${a.kind} requires a ventureId`)] : [];
  }),

  rule("hard_cap", "autonomy.hardActionCapCents: no single action may commit more, approved or not", () => true, (a, ctx, flag) => {
    const cap = ctx.config.autonomy.hardActionCapCents;
    return a.costCents > cap ? [flag("block", `Cost ${a.costCents} exceeds the hard per-action cap of ${cap} cents`)] : [];
  }),

  rule(
    "reserve",
    "ARCHITECTURE s.8: every spend is checked against free cash above the reserve",
    (a) => MONEY_KINDS.includes(a.kind) || a.commitment !== undefined,
    (a, ctx, flag) => {
      if (a.costCents <= 0) return [];
      // A payout settles a liability free cash already deducted: only what it pays beyond that accrual
      // reduces free cash, so money already owed is never held back by the reserve.
      const settled = a.kind === "creator.payout" ? ctx.ledger.accruedFor((a.payload as ActionPayloads["creator.payout"]).submissionId) : 0;
      const net = a.costCents - settled;
      if (net <= 0) return [];
      const freeCash = ctx.ledger.freeCash(ctx.now);
      const reserve = ctx.ledger.reserve(ctx.now);
      const headroom = freeCash - reserve;
      return net > headroom
        ? [flag("block", `Cost ${a.costCents}${settled ? ` (${net} beyond the accrued liability)` : ""} exceeds free cash ${freeCash} minus reserve ${reserve} (headroom ${headroom} cents)`)]
        : [];
    },
  ),

  rule(
    "daily_cap",
    "budgets.dailySpendCapCents / dailySpendCapShareOfFreeCash: daily distribution spend cap",
    (a) => a.kind === "creator.payout" || a.kind === "creator.campaign_create" || a.commitment?.kind === "daily" || a.commitment?.kind === "one_time",
    (a, ctx, flag) => {
      const cap = ctx.ledger.dailySpendCap(ctx.now);
      // Payouts settle money already owed and campaigns commit a lifetime budget, so neither is blocked
      // until a cheaper day that may never come: over the cap, a human decides.
      if (a.kind === "creator.payout") {
        const spent = ctx.ledger.spentToday(ctx.today);
        const amount = (a.payload as ActionPayloads["creator.payout"]).amountCents;
        return spent + amount > cap ? [flag("needs_human", `Spent today ${spent} + payout ${amount} exceeds the daily spend cap of ${cap} cents`)] : [];
      }
      if (a.kind === "creator.campaign_create") {
        const committed = ctx.store.actions
          .list((x) => x.kind === "creator.campaign_create" && x.id !== a.id && (x.status === "executing" || (x.status === "executed" && x.executedAt?.slice(0, 10) === ctx.today)))
          .reduce((s, x) => s + x.costCents, 0);
        return committed + a.costCents > cap
          ? [flag("needs_human", `Creator campaigns committed today ${committed} + ${a.costCents} exceed the daily spend cap of ${cap} cents`)]
          : [];
      }
      const c = a.commitment;
      if (!c || (c.kind === "one_time" && c.startsAt.slice(0, 10) !== ctx.today)) return [];
      const spent = ctx.ledger.spentToday(ctx.today);
      return spent + c.amountCents > cap
        ? [flag("block", `Spent today ${spent} + ${c.amountCents} exceeds the daily spend cap of ${cap} cents`)]
        : [];
    },
  ),

  rule("always_approve", "autonomy.alwaysApprove: kinds that always wait for the board", () => true, (a, ctx, flag) =>
    ctx.config.autonomy.alwaysApprove.includes(a.kind) ? [flag("needs_human", `${a.kind} always needs a board approval`)] : [],
  ),

  rule("auto_approve_threshold", "autonomy.autoApproveBelowCentsByKind: spend above the threshold needs a human", () => true, (a, ctx, flag) => {
    const auto = ctx.config.autonomy;
    const threshold = auto.autoApproveBelowCentsByKind[a.kind] ?? auto.defaultAutoApproveBelowCents;
    return a.costCents > threshold ? [flag("needs_human", `Cost ${a.costCents} is above the auto-approve threshold of ${threshold} cents`)] : [];
  }),

  // -- stores --------------------------------------------------------------------

  rule(
    "store.first_submission",
    "autonomy.approveFirstSubmission / approveResubmitAfterRejection; App Review Guidelines 2.1, 4.3",
    ["store.submit_review"],
    (a, ctx, flag) => {
      const v = ventureOf(a, ctx);
      if (!v) return [];
      const out: PolicyFinding[] = [];
      if (ctx.config.autonomy.approveFirstSubmission && isFirstSubmission(a, ctx)) {
        out.push(flag("needs_human", "First store submission for this venture needs a board approval"));
      }
      const record = v.stores.find((s) => s.platform === a.payload.platform);
      const rejected = record && (record.status === "rejected" || record.status === "metadata_rejected" || record.rejectionReasons.length > 0);
      if (ctx.config.autonomy.approveResubmitAfterRejection && rejected) {
        out.push(flag("needs_human", `Resubmission after a store rejection (${record.rejectionReasons.join("; ") || record.status}) needs a board approval`));
      }
      return out;
    },
  ),

  rule("store.significant_change", "Apple 2.5.19 / 4.3; SB 2420 significant change: such updates need a human", ["store.submit_review"], (a, _ctx, flag) => {
    const areas = (a.payload.changedAreas ?? []).filter((x) => SIGNIFICANT_CHANGES.includes(x));
    return areas.length ? [flag("needs_human", `Submission changes ${areas.join(", ")} and needs a board approval`)] : [];
  }),

  rule("store.territories", "P4 no nationwide tests; privacy.euUkEnabled (GDPR Art. 27, DSA Art. 30)", ["store.set_territories"], (a, ctx, flag) => {
    const v = ventureOf(a, ctx);
    const allowed = allowedGeos(ctx, v);
    const out: PolicyFinding[] = [];
    const outside = a.payload.territories.filter((t) => !allowed.has(t));
    if (outside.length) out.push(flag("needs_human", `Territories outside the test storefronts need a human: ${outside.join(", ")}`));
    const euUk = a.payload.territories.filter((t) => EU_UK.has(t));
    if (euUk.length && !ctx.config.privacy.euUkEnabled) {
      out.push(flag("block", `EU/UK storefronts stay off until privacy.euUkEnabled: ${euUk.join(", ")}`));
    }
    return out;
  }),

  rule("store.listing", "Apple 1.5 / 5.1.1(i) support and privacy URLs; copy lint (FTC Act s.5, Apple 2.3.1)", ["store.update_listing"], (a, ctx, flag) => {
    const v = ventureOf(a, ctx);
    const out: PolicyFinding[] = [];
    if (v && !v.bindings.privacyUrl) out.push(flag("block", "Venture has no privacy policy URL bound"));
    if (v && !v.bindings.supportUrl) out.push(flag("block", "Venture has no support URL bound"));
    const l = a.payload.listing;
    if (!l.privacyUrl || !l.supportUrl) out.push(flag("block", "Listing must carry the privacy and support URLs"));
    const items = [
      { text: l.name, path: "listing.name" },
      { text: l.subtitle, path: "listing.subtitle" },
      { text: l.description, path: "listing.description" },
      { text: l.keywords, path: "listing.keywords" },
      { text: l.promotionalText, path: "listing.promotionalText" },
    ];
    return [...out, ...lintCopyAll(items, "aso", activeClaims(ctx, a.ventureId))];
  }),

  rule("store.publisher", "ARCHITECTURE s.9: one organization publisher account per store, registered by a human", ["store.create_app"], (a, ctx, flag) => {
    const v = ventureOf(a, ctx);
    if (!v) return [];
    const id = v.bindings.publisherAccountIds[a.payload.platform];
    const pub = id ? ctx.store.publishers.get(id) : undefined;
    return pub && pub.platform === a.payload.platform && pub.status === "active"
      ? []
      : [flag("block", `No active ${a.payload.platform} publisher account is bound to this venture`)];
  }),

  // -- owned content -------------------------------------------------------------

  rule("content.account", "ARCHITECTURE s.2.5: brand accounts are human-connected with standing consent", ["content.publish"], (a, ctx, flag) => {
    const acct = ctx.store.accounts.get(a.payload.accountId);
    if (!acct) return [flag("block", `Owned account ${a.payload.accountId} not found`)];
    const out: PolicyFinding[] = [];
    if (acct.status !== "active") out.push(flag("block", `Owned account ${acct.handle} is ${acct.status}`));
    if (!(acct.standingConsent.expiresAt > ctx.now)) out.push(flag("block", `Standing consent for ${acct.handle} expired at ${acct.standingConsent.expiresAt}`));
    if (acct.platform !== a.payload.platform) out.push(flag("block", `Account ${acct.handle} is on ${acct.platform}, not ${a.payload.platform}`));
    if (a.ventureId && acct.ventureId !== a.ventureId) out.push(flag("block", `Account ${acct.handle} belongs to another venture`));
    return out;
  }),

  rule(
    "content.labels",
    "Derived disclosure: TikTok AIGC/branded content, Instagram AI info/paid partnership, YouTube synthetic media; FTC 255.5",
    ["content.publish"],
    (a, ctx, flag) => {
      const piece = ctx.store.content.get(a.payload.contentId);
      if (!piece) return [flag("block", `Content ${a.payload.contentId} not found`)];
      const out: PolicyFinding[] = [];
      const expected = labelsFor(a.payload.platform, deriveDisclosure(piece, ctx.now));
      if (canonicalJson(a.payload.labels) !== canonicalJson(expected)) {
        out.push(flag("block", `Labels ${canonicalJson(a.payload.labels)} differ from the derived labels ${canonicalJson(expected)}`));
      }
      if (piece.platform !== a.payload.platform) out.push(flag("block", `Content was made for ${piece.platform}, not ${a.payload.platform}`));
      if (!sameSet(a.payload.mediaSha256, piece.media.map((m) => m.sha256))) {
        out.push(flag("block", "Media hashes differ from the content piece's media"));
      }
      return out;
    },
  ),

  rule("content.tiktok_audit", "TikTok Content Posting API: unaudited clients may only post private or inbox drafts", ["content.publish"], (a, ctx, flag) =>
    a.payload.platform === "tiktok" && a.payload.mode === "direct" && !ctx.config.distribution.tiktokAudited
      ? [flag("block", "Direct TikTok posting needs an audited client; use inbox_draft")]
      : [],
  ),

  rule("content.post_caps", "distribution.postCaps: posting caps sit well under platform limits", ["content.publish"], (a, ctx, flag) => {
    const cap = ctx.config.distribution.postCaps[a.payload.platform];
    const now = ms(ctx.now);
    const times = postsOnAccount(ctx, a, a.payload.accountId).map((x) => ms(actionTime(x)));
    const out: PolicyFinding[] = [];
    const last24h = times.filter((t) => t > now - DAY_MS).length;
    if (last24h >= cap.perAccountPerDay) out.push(flag("block", `${last24h} posts in 24h already reach the cap of ${cap.perAccountPerDay} for ${a.payload.platform}`));
    const last = Math.max(...times, Number.NEGATIVE_INFINITY);
    const minutesSince = (now - last) / 60_000;
    if (minutesSince < cap.minMinutesBetween) {
      out.push(flag("block", `Last post was ${Math.floor(minutesSince)} minutes ago; minimum is ${cap.minMinutesBetween}`));
    }
    return out;
  }),

  rule("content.near_duplicate", "distribution.maxNearDuplicatePerAccountPer7d: spam and unoriginal-content policies", ["content.publish"], (a, ctx, flag) => {
    const piece = ctx.store.content.get(a.payload.contentId);
    if (!piece) return [];
    const since = ms(ctx.now) - 7 * DAY_MS;
    const max = ctx.config.distribution.maxNearDuplicatePerAccountPer7d;
    const uses = postsOnAccount(ctx, a, a.payload.accountId).filter(
      (x) => ms(actionTime(x)) > since && ctx.store.content.get(x.payload.contentId)?.similarityKey === piece.similarityKey,
    ).length;
    return uses >= max ? [flag("block", `Near-duplicate ${piece.similarityKey} already posted ${uses} times in 7 days (max ${max})`)] : [];
  }),

  rule("content.copy", "principles/copy.ts: claim-free copy (FTC 16 CFR 465, Apple 2.3.1)", ["content.publish"], (a, ctx) => {
    const piece = ctx.store.content.get(a.payload.contentId);
    return piece ? lintCopyAll(contentCopy(piece), "content", activeClaims(ctx, a.ventureId)) : [];
  }),

  // -- creators ------------------------------------------------------------------

  rule("creator.payout_eligibility", "ARCHITECTURE s.7.1: payouts only from platform-verified, view-locked, post-approved submissions", ["creator.payout"], (a, ctx, flag) => {
    const sub = ctx.store.submissions.get(a.payload.submissionId);
    if (!sub) return [flag("block", `Submission ${a.payload.submissionId} not found`)];
    const campaign = ctx.store.campaigns.get(sub.campaignId);
    if (!campaign) return [flag("block", `Campaign ${sub.campaignId} not found`)];
    const out: PolicyFinding[] = [];
    if (sub.stage !== "post_approved") out.push(flag("block", `Submission stage is ${sub.stage}, not post_approved`));
    const ver = sub.verification;
    if (!ver) out.push(flag("block", "Submission has no platform verification"));
    else {
      if (!ver.postIsPublic) out.push(flag("block", "Post is not public"));
      if (!ver.authorHandleMatches) out.push(flag("block", "Post author does not match the creator"));
      if (!ver.platformDisclosureLabel) out.push(flag("block", "Post lacks the platform's paid-partnership label"));
    }
    if (!sub.review?.approve) out.push(flag("block", "Submission review did not approve the post"));
    if (sub.review?.injectionAttempt) out.push(flag("block", "Submission attempted to instruct the reviewer"));
    const postedAt = sub.postedAt ?? ver?.postedAt;
    const lockDays = ctx.config.creators.viewLockDays;
    if (!postedAt) out.push(flag("block", "Post time unknown; views cannot be locked"));
    else if (ms(ctx.now) < ms(postedAt) + lockDays * DAY_MS) out.push(flag("block", `Views lock ${lockDays} days after ${postedAt}`));
    if (sub.viewsAtLock === undefined) out.push(flag("block", "Views at lock are not recorded"));
    else {
      const terms = { flatFeeCents: campaign.flatFeeCents, cpmCents: campaign.cpmCents, maxPayoutCents: campaign.maxPayoutPerVideoCents };
      const remaining = Math.max(0, campaign.budgetCents - ctx.ledger.paidOnCampaign(campaign.id) - otherOpenPayoutsOnCampaign(ctx, a, campaign.id));
      const expected = computePayout(terms, { viewsAtLock: sub.viewsAtLock, campaignRemainingCents: remaining });
      if (a.payload.amountCents !== expected) out.push(flag("block", `Amount ${a.payload.amountCents} differs from the computed payout ${expected} cents`));
      const b = a.payload.basis;
      if (b.views !== sub.viewsAtLock || b.flatFeeCents !== terms.flatFeeCents || b.cpmCents !== terms.cpmCents || b.capCents !== terms.maxPayoutCents) {
        out.push(flag("block", "Payout basis does not match the locked views and campaign terms"));
      }
    }
    if (ctx.store.payouts.list((p) => p.submissionId === sub.id).length) out.push(flag("block", "Submission was already paid"));
    for (const u of ctx.ledger.unknownPayouts().filter((x) => x.submissionId === sub.id)) {
      out.push(flag("block", `Payout ${u.actionId} for this submission may have been sent: verify it with the marketplace before paying again`));
    }
    return out;
  }),

  rule("creator.first_payout", "creators.firstPayoutToNewCreatorNeedsHuman", ["creator.payout"], (a, ctx, flag) => {
    const sub = ctx.store.submissions.get(a.payload.submissionId);
    const creator = sub ? ctx.store.creators.get(sub.creatorId) : undefined;
    if (!sub) return [];
    return ctx.config.creators.firstPayoutToNewCreatorNeedsHuman && !creator?.firstPaidAt
      ? [flag("needs_human", `First payout to creator ${sub.creatorHandle} needs a board approval`)]
      : [];
  }),

  rule("creator.payout_30d_cap", "creators.maxPayoutPerCreatorPer30dCents", ["creator.payout"], (a, ctx, flag) => {
    const sub = ctx.store.submissions.get(a.payload.submissionId);
    if (!sub) return [];
    const since = ms(ctx.now) - 30 * DAY_MS;
    const creatorSubs = new Set(ctx.store.submissions.list((s) => s.creatorId === sub.creatorId).map((s) => s.id));
    const booked = ctx.store.payouts.list((p) => creatorSubs.has(p.submissionId) && ms(p.at) >= since).reduce((s, p) => s + p.amountCents, 0);
    const unknown = ctx.ledger.unknownPayouts().filter((u) => creatorSubs.has(u.submissionId) && ms(u.at) >= since).reduce((s, u) => s + u.amountCents, 0);
    const paid = booked + unknown;
    const cap = ctx.config.creators.maxPayoutPerCreatorPer30dCents;
    return paid + a.payload.amountCents > cap
      ? [flag("needs_human", `Creator paid ${paid} in 30 days; +${a.payload.amountCents} exceeds ${cap} cents`)]
      : [];
  }),

  rule(
    "creator.audience_minors",
    "creators.maxAudienceUnder18Share; FTC Endorsement Guides 255, TikTok branded content policy: 18+ apps are not promoted to minors",
    ["creator.review_post", "creator.payout"],
    (a, ctx, flag) => {
      if (a.kind === "creator.review_post" && !(a.payload as ActionPayloads["creator.review_post"]).approve) return [];
      const v = ventureOf(a, ctx);
      const sub = ctx.store.submissions.get(a.payload.submissionId);
      if (!v || !sub || !adultOnly(ctx, v)) return [];
      const share = ctx.store.creators.get(sub.creatorId)?.audienceUnder18Share ?? null;
      const max = ctx.config.creators.maxAudienceUnder18Share;
      if (share === null) return [flag("needs_human", `Under-18 audience share of ${sub.creatorHandle} is unknown and the app is 18+`)];
      return share > max ? [flag("block", `${Math.round(share * 100)}% of ${sub.creatorHandle}'s audience is under 18 (max ${Math.round(max * 100)}%) and the app is 18+`)] : [];
    },
  ),

  rule("creator.campaign_live", "ARCHITECTURE s.6-7: a creator campaign staffs a running experiment or an open creative batch", ["creator.campaign_create"], (a, ctx, flag) => {
    const campaign = ctx.store.campaigns.get(a.payload.campaignId);
    if (!campaign) return [];
    const out: PolicyFinding[] = [];
    if (campaign.experimentId) {
      const status = ctx.store.experiments.get(campaign.experimentId)?.status;
      if (status !== "registered" && status !== "running") out.push(flag("block", `Experiment ${campaign.experimentId} is ${status ?? "missing"}: its campaign must not open`));
    }
    if (campaign.batchId) {
      const status = ctx.store.batches.get(campaign.batchId)?.status;
      if (status !== "open") out.push(flag("block", `Creative batch ${campaign.batchId} is ${status ?? "missing"}: its campaign must not open`));
    }
    return out;
  }),

  rule("creator.campaign_geo", "P4 no nationwide tests: creator campaigns target cell geos only", ["creator.campaign_create"], (a, ctx, flag) => {
    const campaign = ctx.store.campaigns.get(a.payload.campaignId);
    if (!campaign) return [flag("block", `Creator campaign ${a.payload.campaignId} not found`)];
    const allowed = allowedGeos(ctx, ventureOf(a, ctx));
    const outside = campaign.targetCountries.filter((g) => !allowed.has(g));
    if (!campaign.targetCountries.length) return [flag("block", "Campaign has no target countries")];
    return outside.length ? [flag("block", `Target countries outside the allowed geos: ${outside.join(", ")}`)] : [];
  }),

  rule("creator.brief", "Copy lint (FTC 16 CFR 465); FTC Endorsement Guides 255.5: paid partnerships are disclosed", ["creator.campaign_create"], (a, ctx, flag) => {
    const campaign = ctx.store.campaigns.get(a.payload.campaignId);
    if (!campaign) return [];
    const b = campaign.brief;
    const items = [
      { text: b.title, path: "brief.title" },
      { text: b.productSummary, path: "brief.productSummary" },
      { text: b.audience, path: "brief.audience" },
      { text: b.deliverables, path: "brief.deliverables" },
      ...b.formats.map((t, i) => ({ text: t, path: `brief.formats[${i}]` })),
      ...b.hooks.map((t, i) => ({ text: t, path: `brief.hooks[${i}]` })),
      ...b.mustInclude.map((t, i) => ({ text: t, path: `brief.mustInclude[${i}]` })),
    ];
    const out = lintCopyAll(items, "brief", activeClaims(ctx, a.ventureId));
    if (!b.mustInclude.some((t) => /partnership|branded content|#ad/i.test(t))) {
      out.push(flag("block", "Brief must require the platform's paid-partnership label"));
    }
    return out;
  }),

  // -- paid acquisition ----------------------------------------------------------

  rule("ads.campaign_shape", "ARCHITECTURE s.7.4: ad budgets are never open-ended", ["ads.campaign_create"], (a, ctx, flag) => {
    const c = ctx.store.adCampaigns.get(a.payload.adCampaignId);
    if (!c) return [flag("block", `Ad campaign ${a.payload.adCampaignId} not found`)];
    return c.endAt && ms(c.endAt) > ms(c.startAt) ? [] : [flag("block", "Ad campaign needs an endAt after startAt")];
  }),

  rule("ads.proven_creatives", "ARCHITECTURE s.7.4: paid amplification of proven winners only; brand-defense search is capped", ["ads.campaign_create"], (a, ctx, flag) => {
    const c = ctx.store.adCampaigns.get(a.payload.adCampaignId);
    if (!c) return [];
    const unproven = c.creatives.filter((cr) => !ctx.store.content.get(cr.contentId)?.economics?.provenAt).map((cr) => cr.contentId);
    const allProven = c.creatives.length > 0 && unproven.length === 0;
    if (c.type === "creative") {
      if (!c.creatives.length) return [flag("block", "Creative campaign has no creatives")];
      return unproven.length ? [flag("block", `Creatives are not proven: ${unproven.join(", ")}`)] : [];
    }
    const cap = ctx.config.growth.brandDefenseDailyCents;
    return allProven || c.dailyBudgetCents <= cap
      ? []
      : [flag("block", `Search campaign without proven creatives is capped at ${cap} cents a day (asked ${c.dailyBudgetCents})`)];
  }),

  rule("ads.store_live", "Ads drive installs to a live store listing only", ["ads.campaign_create"], (a, ctx, flag) => {
    const c = ctx.store.adCampaigns.get(a.payload.adCampaignId);
    const v = ventureOf(a, ctx);
    if (!c || !v) return [];
    return v.stores.some((s) => s.platform === c.os && s.status === "live") ? [] : [flag("block", `Venture has no live ${c.os} store listing`)];
  }),

  rule("ads.geo", "P4 no nationwide tests; privacy.euUkEnabled", ["ads.campaign_create"], (a, ctx, flag) => {
    const c = ctx.store.adCampaigns.get(a.payload.adCampaignId);
    if (!c) return [];
    const allowed = allowedGeos(ctx, ventureOf(a, ctx));
    const out: PolicyFinding[] = [];
    if (!c.geos.length) out.push(flag("block", "Ad campaign has no geos"));
    const outside = c.geos.filter((g) => !allowed.has(g));
    if (outside.length) out.push(flag("block", `Ad geos outside the allowed storefronts: ${outside.join(", ")}`));
    const euUk = c.geos.filter((g) => EU_UK.has(g));
    if (euUk.length && !ctx.config.privacy.euUkEnabled) out.push(flag("block", `EU/UK geos stay off until privacy.euUkEnabled: ${euUk.join(", ")}`));
    return out;
  }),

  rule("ads.first_per_network", "autonomy.firstAdCampaignPerNetworkNeedsHuman", ["ads.campaign_create"], (a, ctx, flag) => {
    const c = ctx.store.adCampaigns.get(a.payload.adCampaignId);
    if (!c || !ctx.config.autonomy.firstAdCampaignPerNetworkNeedsHuman) return [];
    const prior = priorDone(ctx, a, "ads.campaign_create", (x) => {
      const id = (x.payload as ActionPayloads["ads.campaign_create"]).adCampaignId;
      return ctx.store.adCampaigns.get(id)?.network === c.network;
    });
    return prior.length ? [] : [flag("needs_human", `First ${c.network} ad campaign for this venture needs a board approval`)];
  }),

  rule("ads.budget_ramp", "budgets.scaleRampMaxStepPct / scaleRampMinDaysBetweenSteps", ["ads.budget_change"], (a, ctx, flag) => {
    const p = a.payload;
    const b = ctx.config.budgets;
    const out: PolicyFinding[] = [];
    const c = ctx.store.adCampaigns.get(p.adCampaignId);
    if (!c) return [flag("block", `Ad campaign ${p.adCampaignId} not found`)];
    if (c.dailyBudgetCents !== p.fromDailyCents) out.push(flag("block", `Stale proposal: campaign budget is ${c.dailyBudgetCents}, not ${p.fromDailyCents}`));
    if (p.toDailyCents <= p.fromDailyCents) return out;
    const maxTo = Math.floor(p.fromDailyCents * (1 + b.scaleRampMaxStepPct));
    if (p.toDailyCents > maxTo) out.push(flag("block", `Increase to ${p.toDailyCents} exceeds the ${Math.round(b.scaleRampMaxStepPct * 100)}% ramp step (max ${maxTo})`));
    const since = ms(ctx.now) - b.scaleRampMinDaysBetweenSteps * DAY_MS;
    const recent = priorDone(ctx, a, "ads.budget_change", (x) => {
      const xp = x.payload as ActionPayloads["ads.budget_change"];
      return xp.adCampaignId === p.adCampaignId && xp.toDailyCents > xp.fromDailyCents && ms(actionTime(x)) > since;
    });
    if (recent.length) out.push(flag("block", `Budget was raised less than ${b.scaleRampMinDaysBetweenSteps} days ago`));
    return out;
  }),

  // -- monetization --------------------------------------------------------------

  rule("monetization.products", "monetization.priceGrid / allowedTrialDays; Apple 3.1.2 (approved subscriptions only)", isPaywallConfig, (a, ctx, flag) => {
    const v = ventureOf(a, ctx);
    if (!v) return [];
    const grid = ctx.config.monetization.priceGrid;
    const out: PolicyFinding[] = [];
    for (const id of referencedProductIds(a)) {
      const product = v.bindings.products.find((p) => p.productId === id || p.ladderId === id);
      if (!product) {
        out.push(flag("block", `Product ${id} is not bound to this venture`));
        continue;
      }
      // Setup may map products still awaiting review (Apple reviews the first subscriptions with the first
      // build, and the reviewer must be able to buy them); live paywalls may only offer approved products.
      const usable = a.kind === "monetization.configure" ? ["created", "in_review", "approved"] : ["approved"];
      if (!usable.includes(product.status)) out.push(flag("block", `Product ${id} is ${product.status}, not ${a.kind === "monetization.configure" ? "created" : "approved"}`));
      const entry = ctx.config.monetization.ladder.find((l) => l.id === product.ladderId);
      if (!entry) {
        out.push(flag("block", `Product ${id} has no price-ladder entry ${product.ladderId}`));
        continue;
      }
      const [lo, hi] = grid[entry.period];
      if (entry.usdCents < lo || entry.usdCents > hi) out.push(flag("block", `Price ${entry.usdCents} for ${id} is outside the ${entry.period} grid [${lo}, ${hi}]`));
      if (!ctx.config.monetization.allowedTrialDays.includes(entry.trialDays)) out.push(flag("block", `Trial of ${entry.trialDays} days for ${id} is not allowed`));
    }
    return out;
  }),

  rule("monetization.subscriber_change", "ROSCA; Apple 3.1.2: price changes that affect paying subscribers need a human", (a) => a.kind === "remote_config.set" && isPaywallConfig(a), (a, ctx, flag) => {
    if (latestSubscribers(ctx, a.ventureId) <= 0) return [];
    const current = priorDone(ctx, a, "remote_config.set", (x) => (x.payload as ActionPayloads["remote_config.set"]).key === "paywall")
      .sort((x, y) => (actionTime(x) < actionTime(y) ? -1 : 1))
      .at(-1);
    const spec = ventureOf(a, ctx)?.spec?.paywall;
    const currentIds = current ? referencedProductIds(current) : spec ? [...spec.productIds, spec.highlightedProductId] : [];
    return sameSet(currentIds, referencedProductIds(a)) ? [] : [flag("needs_human", "Changing paywall products on a venture with paying subscribers needs a board approval")];
  }),

  rule("remote_config.core", "Apple 2.5.2 / 2.5.19: core behaviour ships as a reviewed build, never as a remote flag", ["remote_config.set"], (a, _ctx, flag) =>
    a.payload.key === "core" ? [flag("block", "Core changes ship as a reviewed build, not remote config")] : [],
  ),

  rule(
    "remote_config.spec_lint",
    "principles/product.ts lintSpec: a remote-config variant meets the same paywall, onboarding, share and copy rules as a build",
    (a) => a.kind === "remote_config.set" && (a.payload as ActionPayloads["remote_config.set"]).key !== "core",
    (a, ctx, flag) => {
      const v = ventureOf(a, ctx);
      if (!v) return [];
      const idea = ctx.store.ideas.get(v.ideaId)?.idea;
      if (!v.spec || !idea) return [flag("needs_human", "Venture has no spec to lint the variant against")];
      const p = a.payload as ActionPayloads["remote_config.set"];
      const key = p.key as VariantSurface;
      const domains = ctx.store.latestScreening(v.ideaId)?.sensitiveDomains;
      return p.variants.flatMap((variant) => {
        const spec = specWithVariant(v.spec as AppSpec, key, variant.payload);
        if (typeof spec === "string") return [flag("block", `Variant ${variant.id}: ${spec}`)];
        let findings: PolicyFinding[];
        try {
          findings = lintSpec(spec, idea, ctx.config, domains);
        } catch (err) {
          return [flag("block", `Variant ${variant.id} cannot be linted: ${err instanceof Error ? err.message : String(err)}`)];
        }
        return findings
          .filter((f) => (f.severity === "block" || f.severity === "needs_human") && SURFACE_FINDING[key](f))
          .map((f) => flag(f.severity, `Variant ${variant.id}: ${f.ruleId}: ${f.message}`));
      });
    },
  ),

  rule("venture.kill_with_subscribers", "ARCHITECTURE s.8: apps with paying users are sunset, never killed", ["venture.kill"], (a, ctx, flag) => {
    const subs = latestSubscribers(ctx, a.ventureId);
    return subs > 0 ? [flag("block", `Venture has ${subs} active subscribers: use venture.sunset`)] : [];
  }),

  // -- audience safety -----------------------------------------------------------

  rule("minors", "autonomy.autonomousMinAge; COPPA; Apple 1.3; FTC Endorsement Guides 255 (minor audiences)", ["store.submit_review", "creator.campaign_create", "ads.campaign_create"], (a, ctx, flag) => {
    const v = ventureOf(a, ctx);
    if (!v) return [];
    const minAge = effectiveMinAge(ctx, v);
    const floor = ctx.config.autonomy.autonomousMinAge;
    return minAge !== undefined && minAge < floor ? [flag("needs_human", `Audience minimum age ${minAge} is under ${floor}`)] : [];
  }),

  rule("sensitive_domains", "autonomy.humanReviewDomains; Apple 1.4 / 5.1.1", ["store.submit_review", "ads.campaign_create"], (a, ctx, flag) => {
    const v = ventureOf(a, ctx);
    if (!v || (a.kind === "store.submit_review" && !isFirstSubmission(a, ctx))) return [];
    const hits = sensitiveHits(ctx, v);
    return hits.length ? [flag("needs_human", `Sensitive domains need human review: ${hits.join(", ")}`)] : [];
  }),

  rule("red_category", "autonomy.redCategoryDomains; research brief s.5.5 gate 3 (Apple 4.3, FTC Genesis Tech, state chatbot laws)", ["store.submit_review", "ads.campaign_create"], (a, ctx, flag) => {
    const v = ventureOf(a, ctx);
    if (!v) return [];
    const domains = ctx.store.latestScreening(v.ideaId)?.sensitiveDomains ?? [];
    const hits = domains.filter((d) => ctx.config.autonomy.redCategoryDomains.includes(d));
    return hits.length ? [flag("needs_human", `Red-category venture (${hits.join(", ")}): every submission and ad campaign needs a human`)] : [];
  }),

  rule("support.ai_disclosure", "Utah AI Policy Act / California BOT Act: AI replies are disclosed", ["support.reply"], (a, _ctx, flag) => {
    const out = a.payload.aiDisclosed ? [] : [flag("block", "Support replies written by AI must disclose it")];
    return [...out, ...lintCopy({ text: a.payload.reply, surface: "support", path: "reply" })];
  }),
];

/** Every finding the rules produce for an action, in rule order. */
export function evaluateAction(a: Action, ctx: PolicyContext): PolicyFinding[] {
  return RULES.filter((r) => r.applies(a)).flatMap((r) => r.check(a, ctx));
}

/**
 * Status implied by findings, open human tasks and approvals. An approval clears the needs_human
 * rules it was given for, on the payload it was given for; a rule that fires later needs a new one.
 */
export function statusFor(a: Action, findings: PolicyFinding[]): ActionStatus {
  if (findings.some((f) => f.severity === "block")) return "blocked";
  if (a.blockedByTaskIds.length > 0) return "awaiting_human_task";
  const needed = new Set(findings.filter((f) => f.severity === "needs_human").map((f) => f.ruleId));
  if (needed.size === 0) return "approved";
  const covered = new Set<string>();
  for (const ap of a.approvals as CoveringApproval[]) {
    if (ap.payloadHash !== a.payloadHash) continue;
    if (!ap.coveredRuleIds) return "approved";
    for (const id of ap.coveredRuleIds) covered.add(id);
  }
  return [...needed].every((id) => covered.has(id)) ? "approved" : "awaiting_approval";
}
