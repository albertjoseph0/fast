/**
 * Fold completed human tasks into domain state: connected brand accounts, studio-wide
 * resources (backend URL, ad accounts) and review decisions. Idempotent per tick.
 */
import type { TickContext } from "../core/context.ts";
import type { AdNetwork, HumanTask, OwnedAccount, Platform, Venture } from "../core/types.ts";
import { taskDraft } from "../playbook/setup.ts";
import { isActive, patch, transition } from "./lifecycle.ts";
import { proposeKill } from "./labPhase.ts";

const YEAR_MS = 365 * 86_400_000;

/** Entity-scoped tasks the studio needs before its first venture ships. */
export const BOOTSTRAP_TASKS = ["apple.paid_apps_agreement", "backend.deploy", "creators.fund_wallet"] as const;

/** Open the studio-level setup tasks once (no-ops when they are open or done). */
export function openBootstrapTasks(ctx: TickContext): string[] {
  const opened: string[] = [];
  for (const kind of BOOTSTRAP_TASKS) {
    if (ctx.store.tasks.count((t) => t.kind === kind && !t.ventureId && t.status !== "cancelled") > 0) continue;
    opened.push(ctx.outbox.openTask(taskDraft(kind)).id);
  }
  return opened;
}

function latestDone(ctx: TickContext, kind: HumanTask["kind"], filter: (t: HumanTask) => boolean = () => true): HumanTask | undefined {
  return ctx.store.tasks
    .list((t) => t.kind === kind && t.status === "done" && filter(t))
    .sort((a, b) => ((a.completedAt ?? "") < (b.completedAt ?? "") ? -1 : 1))
    .at(-1);
}

/** Studio-wide bindings every venture inherits (the verdict backend, ad accounts). */
export function studioBindings(ctx: TickContext): Partial<Pick<Venture["bindings"], "backendUrl" | "adAccountIds">> {
  const backend = latestDone(ctx, "backend.deploy", (t) => !t.ventureId);
  const adAccountIds: Partial<Record<AdNetwork, string>> = {};
  for (const t of ctx.store.tasks.list((x) => x.kind === "ads.billing_setup" && x.status === "done")) {
    const network = t.outputs?.["network"] as AdNetwork | undefined;
    const id = t.outputs?.["adAccountId"];
    if (network && id) adAccountIds[network] = id;
  }
  return { ...(backend?.outputs?.["backendUrl"] ? { backendUrl: backend.outputs["backendUrl"] } : {}), adAccountIds };
}

function adoptAccount(ctx: TickContext, t: HumanTask): string | null {
  if (!t.ventureId || !t.outputs) return null;
  const v = ctx.store.ventures.get(t.ventureId);
  if (!v) return null;
  const platform = t.outputs["platform"] as Platform;
  if (v.bindings.ownedAccountIds[platform]) return null;
  const at = t.completedAt ?? ctx.ports.clock.iso();
  const account: OwnedAccount = {
    id: ctx.store.nextId("account"),
    ventureId: v.id,
    platform,
    handle: (t.outputs["handle"] ?? "").replace(/^@/, ""),
    publishMode: platform === "tiktok" && !ctx.config.distribution.tiktokAudited ? "draft_for_human" : "business_api",
    bioDisclosesBrand: true,
    standingConsent: { scopes: ["publish"], grantedAt: at, expiresAt: new Date(new Date(at).getTime() + YEAR_MS).toISOString(), grantedBy: t.completedBy ?? "board" },
    ...(t.outputs["tokenSecretRef"] ? { tokenSecretRef: t.outputs["tokenSecretRef"] } : {}),
    status: "active",
  };
  ctx.store.accounts.put(account);
  patch(ctx.store, ctx.ports.clock, v, { bindings: { ...v.bindings, ownedAccountIds: { ...v.bindings.ownedAccountIds, [platform]: account.id } } });
  return `${v.id} connected ${platform} @${account.handle}`;
}

/** Act on review decisions recorded in legal.review tasks. */
function applyReviewDecision(ctx: TickContext, t: HumanTask): string | null {
  if (!t.ventureId) return null;
  const v = ctx.store.ventures.get(t.ventureId);
  if (!v || !isActive(v)) return null;
  const decision = t.outputs?.["decision"];
  const done = t.completedAt ?? "";
  // Each decision applies once: skip when the venture changed stage after the task completed.
  if (v.history.some((h) => h.at > done)) return null;
  switch (decision) {
    case "abandon":
    case "kill":
      proposeKill(ctx, v, `human decision on ${t.id}: ${decision}`);
      return `${v.id} kill proposed`;
    case "changes_requested":
      if (v.stage === "screened") {
        proposeKill(ctx, v, `human review ${t.id} requested changes before build`);
        return `${v.id} kill proposed`;
      }
      return null;
    case "resubmit": {
      if (v.stage !== "in_review") return null;
      transition(ctx.store, ctx.ports.clock, v, "building", `${t.id}: resubmit after App Review rejection`);
      return `${v.id} resubmitting`;
    }
    default:
      return null;
  }
}

export function applyTaskOutcomes(ctx: TickContext): string[] {
  const out: string[] = [];
  for (const t of ctx.store.tasks.list((x) => x.status === "done" && x.kind === "social.connect_account")) {
    const r = adoptAccount(ctx, t);
    if (r) out.push(r);
  }
  for (const t of ctx.store.tasks.list((x) => x.status === "done" && x.kind === "legal.review")) {
    const r = applyReviewDecision(ctx, t);
    if (r) out.push(r);
  }
  const shared = studioBindings(ctx);
  for (const v of ctx.store.ventures.list(isActive)) {
    const missingBackend = shared.backendUrl && !v.bindings.backendUrl;
    const missingAds = Object.entries(shared.adAccountIds ?? {}).some(([n, id]) => v.bindings.adAccountIds[n as AdNetwork] !== id);
    if (!missingBackend && !missingAds) continue;
    patch(ctx.store, ctx.ports.clock, v, {
      bindings: {
        ...v.bindings,
        ...(missingBackend ? { backendUrl: shared.backendUrl as string } : {}),
        adAccountIds: { ...v.bindings.adAccountIds, ...shared.adAccountIds },
      },
    });
  }
  return out;
}
