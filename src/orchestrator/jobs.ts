/**
 * Poll long-running external jobs (builds, processing, App Review, publishing) and fold
 * their results into the domain records the rest of the tick reads.
 */
import type { TickContext } from "../core/context.ts";
import type { ExternalJob, JobPoll, Venture } from "../core/types.ts";
import { taskDraft } from "../playbook/setup.ts";
import { patch } from "./lifecycle.ts";

const RETRY_SECONDS = 3_600;
const REVIEW_EXTENSION_MS = 7 * 86_400_000;
/** Polls before a still-undecided App Review goes to a human (about a month at hourly-to-daily polling). */
const MAX_REVIEW_POLLS = 60;
/** Upload failures of one binary before it is rebuilt instead of re-uploaded. */
const MAX_UPLOADS_PER_BUILD = 2;

/** The human task a job waiting on a person needs: posting an inbox draft with its labels, or a console step. */
function humanStepFor(ctx: TickContext, job: ExternalJob, next: ExternalJob) {
  const ventureId = job.ventureId as string;
  if (job.op === "social.publish") {
    const labels = next.result?.["labelsToApply"] ?? next.result?.["labelsToApplyInApp"];
    const contentId = str((ctx.store.actions.get(job.actionId)?.payload as { contentId?: string } | undefined)?.contentId) ?? job.externalRef["contentId"] ?? "";
    return taskDraft("social.finish_draft", ventureId, `Draft for ${contentId} (${job.id}). Labels to turn on: ${labels ? JSON.stringify(labels) : "AI-generated content and your brand"}.`);
  }
  return taskDraft("store.manual_step", ventureId, `${job.op} (${job.id}): ${next.error ?? "the store needs a console step"}`);
}

export async function pollDueJobs(ctx: TickContext): Promise<ExternalJob[]> {
  const now = ctx.ports.clock.iso();
  const due = ctx.store.jobs.list((j) => j.status === "running" && j.nextPollAt <= now);
  const updated: ExternalJob[] = [];
  for (const job of due) {
    let poll: JobPoll;
    try {
      poll = job.op === "social.publish" ? await ctx.ports.social.poll(job) : await ctx.ports.store.poll(job);
    } catch (err) {
      poll = { status: "running", error: String(err), pollAfterSec: RETRY_SECONDS };
    }
    let next: ExternalJob = {
      ...job,
      attempts: job.attempts + 1,
      status: poll.status,
      nextPollAt: new Date(new Date(now).getTime() + (poll.pollAfterSec ?? RETRY_SECONDS) * 1000).toISOString(),
      ...(poll.result ? { result: poll.result } : {}),
      ...(poll.error ? { error: poll.error } : {}),
    };
    if (next.status === "running" && now > job.deadlineAt) {
      // App Review of a new app or account can take weeks: a long review is not a rejection.
      next =
        job.op === "store.review" && job.attempts < MAX_REVIEW_POLLS
          ? { ...next, deadlineAt: new Date(new Date(job.deadlineAt).getTime() + REVIEW_EXTENSION_MS).toISOString() }
          : job.op === "store.review"
            ? { ...next, status: "needs_human", error: `App Review has not decided since ${job.createdAt}` }
            : { ...next, status: "failed", error: `deadline ${job.deadlineAt} passed` };
    }
    ctx.store.jobs.put(next);
    if (next.status === "needs_human") {
      ctx.log("job.updated", { jobId: job.id, op: job.op, status: next.status, error: next.error ?? null }, job.ventureId);
      if (job.ventureId) ctx.outbox.openTask(humanStepFor(ctx, job, next));
    } else if (next.status !== "running") {
      ctx.log("job.updated", { jobId: job.id, op: job.op, status: next.status, result: next.result ?? null, error: next.error ?? null }, job.ventureId);
      applyJobResult(ctx, next);
    }
    updated.push(next);
  }
  return updated;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Fold a finished job into ventures, stores and content. */
export function applyJobResult(ctx: TickContext, job: ExternalJob): void {
  const { store } = ctx;
  const clock = ctx.ports.clock;
  const venture: Venture | undefined = job.ventureId ? store.ventures.get(job.ventureId) : undefined;
  const result = job.result ?? {};
  // Adapters choose their own externalRef keys; the originating action is the reliable source.
  const action = store.actions.get(job.actionId);
  const payload = (action?.payload ?? {}) as Record<string, unknown>;
  const platform = (str(payload.platform) ?? str(job.externalRef.platform) ?? "ios") as "ios" | "android";
  const setStore = (changes: Partial<Venture["stores"][number]>) => {
    if (!venture) return;
    const v = store.ventures.require(venture.id);
    const existing = v.stores.find((s) => s.platform === platform);
    if (!existing) return;
    patch(store, clock, v, { stores: v.stores.map((s) => (s.platform === platform ? { ...s, ...changes, updatedAt: clock.iso() } : s)) });
  };

  switch (job.op) {
    case "store.build": {
      if (!venture || job.status !== "succeeded") return;
      const easBuildId = str(result.easBuildId) ?? str(job.externalRef.easBuildId);
      const v = store.ventures.require(venture.id);
      if (v.build && easBuildId) patch(store, clock, v, { build: { ...v.build, easBuildId, ...(str(result.artifactUrl) ? { artifactUrl: str(result.artifactUrl) as string } : {}) } });
      return;
    }
    case "store.submit_build": {
      if (job.status !== "succeeded") {
        supersedeFailedBinary(ctx, job);
        return setStore({ status: "draft" });
      }
      const storeBuildId = str(result.storeBuildId);
      return setStore({ status: "ready_to_submit", ...(storeBuildId ? { storeBuildId } : {}) });
    }
    case "store.review": {
      const state = str(result.reviewState);
      if (job.status === "succeeded" && state === "approved") {
        setStore({ status: "pending_release", rejectionReasons: [] });
        if (venture) {
          const v = store.ventures.require(venture.id);
          // Subscriptions are reviewed with the app but decided one by one: follow the store's state per
          // product when it reports one (App Store Connect), otherwise the app's approval approves them.
          const states = result.productStates && typeof result.productStates === "object" ? (result.productStates as Record<string, unknown>) : undefined;
          const next = (p: (typeof v.bindings.products)[number]): (typeof v.bindings.products)[number] => {
            if (p.status !== "created" && p.status !== "in_review") return p;
            if (!states) return { ...p, status: "approved" };
            const state = String(states[p.productId] ?? "");
            if (state === "APPROVED") return { ...p, status: "approved" };
            if (state === "REJECTED" || state === "DEVELOPER_ACTION_NEEDED") return { ...p, status: "rejected" };
            return ["WAITING_FOR_REVIEW", "IN_REVIEW", "PENDING_BINARY_APPROVAL"].includes(state) ? { ...p, status: "in_review" } : p;
          };
          patch(store, clock, v, { bindings: { ...v.bindings, products: v.bindings.products.map(next) } });
        }
        return;
      }
      const reasons = Array.isArray(result.rejectionReasons) ? result.rejectionReasons.map(String) : job.error ? [job.error] : ["review failed"];
      return setStore({ status: state === "metadata_rejected" ? "metadata_rejected" : "rejected", rejectionReasons: reasons });
    }
    case "social.publish": {
      const contentId = str(payload.contentId) ?? str(job.externalRef.contentId);
      const piece = contentId ? store.content.get(contentId) : undefined;
      if (!piece) return;
      const moderation = str(result.moderation);
      if (job.status === "succeeded" && (moderation === "live" || moderation === undefined)) {
        store.content.put({
          ...piece,
          status: "posted",
          postedAt: clock.iso(),
          ...(str(result.externalId) ? { externalId: str(result.externalId) as string } : {}),
          ...(str(result.url) ? { url: str(result.url) as string } : {}),
        });
      } else {
        store.content.put({ ...piece, status: "rejected" });
      }
      return;
    }
    default:
      return;
  }
}

/**
 * Apple processing rejected the binary (or uploads keep failing): mark its build job superseded so
 * the pipeline starts a fresh build (with a new build number) instead of re-uploading the same one.
 */
function supersedeFailedBinary(ctx: TickContext, job: ExternalJob): void {
  const easBuildId = str((ctx.store.actions.get(job.actionId)?.payload as { easBuildId?: string } | undefined)?.easBuildId);
  if (!easBuildId || !job.ventureId) return;
  const state = str(job.result?.["processingState"]);
  const failures = ctx.store.jobs.count((j) => j.ventureId === job.ventureId && j.op === "store.submit_build" && j.status === "failed" && (ctx.store.actions.get(j.actionId)?.payload as { easBuildId?: string } | undefined)?.easBuildId === easBuildId);
  if (job.result?.["rebuild"] !== true && state !== "INVALID" && state !== "FAILED" && failures < MAX_UPLOADS_PER_BUILD) return;
  for (const b of ctx.store.jobs.list((j) => j.ventureId === job.ventureId && j.op === "store.build" && (str(j.result?.["easBuildId"]) ?? j.externalRef["easBuildId"]) === easBuildId)) {
    ctx.store.jobs.put({ ...b, result: { ...b.result, superseded: true } });
  }
  const v = ctx.store.ventures.get(job.ventureId);
  if (v?.build?.easBuildId === easBuildId) {
    const { easBuildId: _bad, ...build } = v.build;
    patch(ctx.store, ctx.ports.clock, v, { build });
  }
}
