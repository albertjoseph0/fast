/**
 * Poll long-running external jobs (builds, processing, App Review, publishing) and fold
 * their results into the domain records the rest of the tick reads.
 */
import type { TickContext } from "../core/context.ts";
import type { ExternalJob, JobPoll, Venture } from "../core/types.ts";
import { patch } from "./lifecycle.ts";

const RETRY_SECONDS = 3_600;

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
    if (next.status === "running" && now > job.deadlineAt) next = { ...next, status: "failed", error: `deadline ${job.deadlineAt} passed` };
    ctx.store.jobs.put(next);
    if (next.status !== "running") {
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
      if (job.status !== "succeeded") return setStore({ status: "draft" });
      const storeBuildId = str(result.storeBuildId);
      return setStore({ status: "ready_to_submit", ...(storeBuildId ? { storeBuildId } : {}) });
    }
    case "store.review": {
      const state = str(result.reviewState);
      if (job.status === "succeeded" && state === "approved") {
        setStore({ status: "pending_release", rejectionReasons: [] });
        if (venture) {
          const v = store.ventures.require(venture.id);
          patch(store, clock, v, {
            bindings: {
              ...v.bindings,
              products: v.bindings.products.map((p) => (p.status === "created" || p.status === "in_review" ? { ...p, status: "approved" } : p)),
            },
          });
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
