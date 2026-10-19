/**
 * Discovery: scan the market, generate ideas, screen them against the principles and
 * create ventures for the ones that advance. Promotion from `screened` to `building`
 * respects the build slots and any human review the screening demanded.
 */
import type { TickContext } from "../core/context.ts";
import type { IdeaRecord, Screening, StorePlatform, Venture } from "../core/types.ts";
import { ladderFor, ladderSteps } from "../principles/ladder.ts";
import type { StudioDeps } from "./deps.ts";
import { overlap } from "./differentiation.ts";
import { isActive, slugify, transition } from "./lifecycle.ts";
import { studioBindings } from "./tasks.ts";
import { taskDraft } from "../playbook/setup.ts";

const DEFAULT_PLATFORMS: StorePlatform[] = ["ios"];

/** How many ventures the bankroll supports right now (scales with free cash). */
export function ventureCapacity(ctx: TickContext, freeCashCents: number): number {
  const byCash = Math.floor(Math.max(0, freeCashCents) / ctx.config.portfolio.freeCashPerActiveVentureCents);
  return Math.max(0, Math.min(ctx.config.portfolio.maxActiveVentures, byCash));
}

function takenTitles(ctx: TickContext): string[] {
  return [...new Set([...ctx.store.ideas.list().map((r) => r.idea.title), ...ctx.store.ventures.list().map((v) => v.name)])];
}

function uniqueSlug(ctx: TickContext, title: string): string {
  const base = slugify(title);
  const used = new Set(ctx.store.ventures.list().map((v) => v.slug));
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base.slice(0, 21)}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** Text overlap at which an idea counts as a re-run of an existing venture's concept. */
const NOVELTY_OVERLAP = 0.5;

function conceptText(r: IdeaRecord): string {
  return `${r.idea.title} ${r.idea.oneLiner} ${r.idea.verdictMoment} ${r.idea.aiCapability}`;
}

function nearestVenture(ctx: TickContext, record: IdeaRecord): { id: string; score: number } | null {
  let best: { id: string; score: number } | null = null;
  for (const v of ctx.store.ventures.list()) {
    const other = ctx.store.ideas.get(v.ideaId);
    if (!other) continue;
    const score = overlap(conceptText(record), conceptText(other));
    if (!best || score > best.score) best = { id: v.id, score };
  }
  return best;
}

/** Create a venture for a screened idea. Store records and bindings start empty; the pipeline fills them. */
export function createVenture(ctx: TickContext, record: IdeaRecord, screening: Screening): Venture {
  const now = ctx.ports.clock.iso();
  const slug = uniqueSlug(ctx, record.idea.title);
  const kind = ladderFor(record.idea);
  const shared = studioBindings(ctx);
  const packageSlug = slug.replace(/-/g, "");
  const publisherAccountIds: Venture["bindings"]["publisherAccountIds"] = {};
  for (const platform of DEFAULT_PLATFORMS) {
    const publisher = ctx.store.publishers.list((p) => p.platform === platform && p.status === "active")[0];
    if (publisher) publisherAccountIds[platform] = publisher.id;
  }
  const venture: Venture = {
    id: ctx.store.nextId("venture"),
    ideaId: record.id,
    screeningId: screening.id,
    name: record.idea.title,
    slug,
    wedge: record.idea.wedge.name,
    stage: "screened",
    ladder: {
      kind,
      steps: ladderSteps(kind, ctx.config),
      stepIndex: 0,
      validated: [],
      currentExperimentId: null,
      experimentIds: [],
      iteration: 0,
      harnessFixes: 0,
      stepStartedAt: null,
    },
    specVersion: 0,
    specHistory: [],
    baseline: { specVersion: 0, hookIds: [], paywallVariantId: null, onboardingVariantId: null },
    stores: [],
    bindings: {
      platforms: DEFAULT_PLATFORMS,
      publisherAccountIds,
      bundleId: `${ctx.config.company.bundleIdPrefix}.${packageSlug}`,
      androidPackage: `${ctx.config.company.bundleIdPrefix}.${packageSlug}`,
      ownedAccountIds: {},
      adAccountIds: { ...shared.adAccountIds },
      products: [],
      ...(shared.backendUrl ? { backendUrl: shared.backendUrl } : {}),
    },
    blockedOn: [],
    blockedMs: 0,
    timeboxStartedAt: null,
    history: [{ from: null, to: "screened", at: now, reason: `screened ${screening.score.toFixed(0)}/100` }],
    createdAt: now,
    updatedAt: now,
  };
  ctx.store.ventures.put(venture);
  ctx.log("venture.created", { ideaId: record.id, screeningId: screening.id, score: screening.score, ladder: kind }, venture.id);
  return venture;
}

/**
 * One discovery cycle, every `discoveryEveryTicks` ticks while the portfolio has room:
 * scout → ideate → screen (critics + classifier + deterministic gates) → ventures.
 */
export async function runDiscovery(ctx: TickContext, deps: StudioDeps, freeCashCents: number): Promise<string> {
  const p = ctx.config.portfolio;
  if ((ctx.tick - 1) % p.discoveryEveryTicks !== 0) return "not a discovery tick"; // ticks 1, 1+N, 1+2N, ...
  // Harvested and sunsetting ventures get no growth work or spend: they take no slot.
  const active = ctx.store.ventures.list((v) => isActive(v) && v.stage !== "sunsetting" && v.stage !== "harvest").length;
  const slots = ventureCapacity(ctx, freeCashCents) - active;
  if (slots <= 0) return `portfolio full (${active} active)`;

  const signals = await deps.agents.scanMarket(ctx);
  for (const s of signals) ctx.store.signals.put(s);
  const records = await deps.agents.generateIdeas(ctx, { signals, count: p.ideasPerCycle, avoidTitles: takenTitles(ctx) });
  const screened: { record: IdeaRecord; screening: Screening }[] = [];
  for (const record of records) {
    ctx.store.ideas.put(record);
    ctx.log("idea.created", { ideaId: record.id, title: record.idea.title, coreNeed: record.idea.coreNeed }, undefined);
    // An idea the portfolio already tried (live or dead) under another name is not a new shot on goal.
    const twin = nearestVenture(ctx, record);
    if (twin && twin.score >= NOVELTY_OVERLAP) {
      ctx.log("idea.screened", { ideaId: record.id, verdict: "reject", score: 0, reasons: [`near-duplicate of ${twin.id} (${Math.round(twin.score * 100)}% overlap)`] });
      continue;
    }
    const screening = await deps.agents.screen(ctx, record, { exposures: ctx.store.exposures(), existingTitles: takenTitles(ctx).filter((t) => t !== record.idea.title) });
    ctx.store.screenings.put(screening);
    ctx.log("idea.screened", { ideaId: record.id, verdict: screening.verdict, score: screening.score, reasons: screening.reasons.slice(0, 6) });
    if (screening.verdict !== "reject") screened.push({ record, screening });
  }
  screened.sort((a, b) => b.screening.score - a.screening.score || (a.record.id < b.record.id ? -1 : 1));
  const created: string[] = [];
  for (const { record, screening } of screened.slice(0, slots)) {
    const v = createVenture(ctx, record, screening);
    if (screening.verdict === "needs_human") {
      const why = screening.reasons.filter((r) => /compliance|needs_human/i.test(r)).join("; ") || screening.reasons.join("; ");
      ctx.outbox.openTask(
        taskDraft(
          "legal.review",
          v.id,
          `Idea "${record.idea.title}" was flagged before build (${why}). Sensitive domains: ${screening.sensitiveDomains.join(", ") || "none"}. Wedge: ${record.idea.wedge.name}, ages ${record.idea.wedge.minAge}-${record.idea.wedge.maxAge}. Approve only if it can ship with the required age rating, disclosures and data handling.`,
        ),
      );
    }
    created.push(v.id);
  }
  return `${signals.length} signals, ${records.length} ideas, ${screened.length} advanced, created ${created.join(", ") || "none"}`;
}

/** Move screened ventures into building while build slots are free, best screening score first. */
export function promoteScreened(ctx: TickContext): string[] {
  const inFlight = ctx.store.ventures.list((v) => v.stage === "building").length;
  let free = ctx.config.portfolio.maxBuildsInFlight - inFlight;
  const promoted: string[] = [];
  const waiting = ctx.store.ventures
    .list((v) => v.stage === "screened")
    .map((v) => ({ v, score: ctx.store.screenings.get(v.screeningId)?.score ?? 0 }))
    .sort((a, b) => b.score - a.score || (a.v.id < b.v.id ? -1 : 1));
  for (const { v } of waiting) {
    const review = ctx.store.tasks.list((t) => t.ventureId === v.id && t.kind === "legal.review").sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))[0];
    if (review && (review.status !== "done" || review.outputs?.["decision"] !== "approved")) continue; // tasks.ts acts on rejections
    if (free <= 0) break;
    transition(ctx.store, ctx.ports.clock, v, "building", "build slot available");
    promoted.push(v.id);
    free--;
  }
  return promoted;
}
