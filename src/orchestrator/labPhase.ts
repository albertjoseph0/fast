/**
 * The lab inside the tick: register the next experiment for each live venture, staff its
 * cells with creator campaigns, observe cells every day, read decisions and apply them
 * to the venture's ladder.
 */
import type { TickContext } from "../core/context.ts";
import type { CellObservation, CreatorCampaign, ExperimentOutcome, ExperimentPlan, MetricKey, Venture } from "../core/types.ts";
import { computePayout } from "../governance/payouts.ts";
import { exposuresForPlan } from "../lab/audiences.ts";
import { activeCells, decideExperiment, evaluateCell } from "../lab/decide.ts";
import { designExperiment } from "../lab/experiments.ts";
import { ladderEntry } from "../playbook/product.ts";
import type { StudioDeps } from "./deps.ts";
import { ideaFor } from "./pipeline.ts";
import { isLiveOnStore, ORGANIC_CATEGORIES, patch, transition, windDown } from "./lifecycle.ts";

function cellCampaigns(ctx: TickContext, experimentId: string, cellId?: string): CreatorCampaign[] {
  return ctx.store.campaigns.list((c) => c.experimentId === experimentId && (cellId === undefined || c.cellId === cellId));
}

/** Money committed to a cell: paid payouts plus approved-but-unpaid creator liabilities. */
function cellSpend(ctx: TickContext, experimentId: string, cellId: string): number {
  let spend = 0;
  for (const c of cellCampaigns(ctx, experimentId, cellId)) {
    const subs = ctx.store.submissions.list((x) => x.campaignId === c.id);
    let campaignSpend = subs.reduce((sum, s) => sum + (s.stage === "paid" ? s.payoutCents : 0), 0);
    for (const s of subs.filter((x) => x.stage === "post_approved")) {
      const views = s.viewsAtLock ?? s.verification?.viewsFromPlatform ?? 0;
      campaignSpend += computePayout({ flatFeeCents: c.flatFeeCents, cpmCents: c.cpmCents, maxPayoutCents: c.maxPayoutPerVideoCents }, { viewsAtLock: views, campaignRemainingCents: Math.max(0, c.budgetCents - campaignSpend) });
    }
    spend += campaignSpend;
  }
  return spend;
}

async function observeCell(ctx: TickContext, plan: ExperimentPlan, cellId: string): Promise<CellObservation> {
  const v = ctx.store.ventures.require(plan.ventureId);
  const cell = plan.cells.find((c) => c.id === cellId);
  if (!cell) throw new Error(`cell ${cellId} not in ${plan.id}`);
  const now = ctx.ports.clock.iso();
  const since = cell.firstExposureAt ?? plan.startedAt ?? plan.registeredAt;
  const metrics: CellObservation["metrics"] = {};
  for (const m of plan.metrics) {
    metrics[m.key as MetricKey] = await ctx.ports.metrics.cellMetric({
      bindings: v.bindings,
      ventureId: v.id,
      experimentId: plan.id,
      cellId,
      geo: cell.geo,
      assignment: cell.assignment,
      numerator: m.numerator,
      denominator: m.denominator,
      maturityHours: m.maturityHours,
      ...(m.windowHours !== undefined ? { windowHours: m.windowHours } : {}),
      since,
      asOf: now,
    });
  }
  const internalShare = await ctx.ports.metrics.internalShare({ bindings: v.bindings, ventureId: v.id, cellId, geo: cell.geo, since, asOf: now });
  const views = metrics.installsPer1kViews?.trials ?? 0;
  return { cellId, metrics, exposureViews: views, spendCents: cellSpend(ctx, plan.id, cellId), internalShare, observedAt: now };
}

/**
 * A cell is exposed once the variant reaches its audience: in-geo views of the cell's posts when the plan
 * measures distribution (organic storefront installs must not start the clock), otherwise any user.
 */
function hasExposure(plan: ExperimentPlan, obs: CellObservation): boolean {
  if (plan.metrics.some((m) => m.denominator === "view")) return obs.exposureViews > 0;
  return Object.values(obs.metrics).some((m) => (m?.trials ?? 0) > 0);
}

/** Register the venture's next ladder experiment if it has none running. */
export async function ensureExperiment(ctx: TickContext, deps: StudioDeps, v: Venture): Promise<string> {
  if (v.ladder.currentExperimentId) return "experiment running";
  // Optional setup (a brand account for owned content) never holds up the creator-led ladder.
  if (v.blockedOn.some((id) => ctx.store.tasks.get(id)?.kind !== "social.connect_account")) return "blocked on a human";
  const stages = v.ladder.steps[v.ladder.stepIndex];
  if (!stages) return "ladder complete";
  const idea = ideaFor(ctx, v);
  const pending = v.pendingVariant;
  if (pending && !pending.readyAt) return `waiting for ${pending.variableUnderTest} variant to ship`;
  const now = ctx.ports.clock.iso();
  const design = designExperiment({
    experimentId: ctx.store.nextId("experiment"),
    cellIds: [ctx.store.nextId("cell"), ctx.store.nextId("cell"), ctx.store.nextId("cell")],
    venture: v,
    idea,
    stages,
    hypothesis: pending?.hypothesis ?? `${v.name} earns installs from ${idea.wedge.creatorNiche} creators that activate and start trials at or above the floors`,
    variableUnderTest: pending?.variableUnderTest ?? "baseline",
    variant: pending?.variant ?? { baseline: `spec_v${v.specVersion}` },
    deliveryMode: pending?.deliveryMode ?? "native_build",
    config: ctx.config,
    now,
    exposures: ctx.store.exposures(),
    ...(pending?.geos ? { geos: pending.geos } : {}),
    ...(pending?.parentExperimentId ? { parentExperimentId: pending.parentExperimentId } : {}),
  });
  if (!design.ok) {
    if (/infeasible/.test(design.reason)) {
      proposeKill(ctx, v, `no feasible experiment: ${design.reason}`);
      return design.reason;
    }
    return `cannot register yet: ${design.reason}`;
  }
  const plan: ExperimentPlan = { ...design.plan, status: "running", startedAt: now };
  ctx.store.experiments.put(plan);
  for (const e of exposuresForPlan(plan, v.wedge, now)) ctx.store.recordExposure(e);
  const { pendingVariant: _done, ...rest } = ctx.store.ventures.require(v.id);
  ctx.store.ventures.put({
    ...rest,
    ladder: {
      ...v.ladder,
      currentExperimentId: plan.id,
      experimentIds: [...v.ladder.experimentIds, plan.id],
      stepStartedAt: v.ladder.stepStartedAt ?? now,
    },
    updatedAt: now,
  });
  ctx.log("experiment.registered", { experimentId: plan.id, stages, variable: plan.variableUnderTest, cells: plan.cells.map((c) => c.geo), budgetCents: plan.maxBudgetCents, minSample: plan.minSamplePerCell }, v.id);
  const registered = ctx.store.ventures.require(v.id);
  if (registered.stage === "iterating") transition(ctx.store, ctx.ports.clock, registered, "live_test", `${plan.variableUnderTest} variant under test in ${plan.id}`);
  await staffCells(ctx, deps, plan, plan.cells.filter((c) => c.phase === 1).map((c) => c.id));
  return `registered ${plan.id} in ${plan.cells.map((c) => c.geo).join(", ")}`;
}

/** One creator campaign per cell, restricted to the cell's storefront country (P4). */
async function staffCells(ctx: TickContext, deps: StudioDeps, plan: ExperimentPlan, cellIds: string[]): Promise<void> {
  const v = ctx.store.ventures.require(plan.ventureId);
  const idea = ideaFor(ctx, v);
  const spec = v.spec;
  if (!spec) return;
  const hooks = ctx.store.hooks.list((h) => h.ventureId === v.id && h.status !== "culled").map((h) => h.text);
  const brief = await deps.agents.writeBrief(ctx, { idea, spec, topHooks: hooks.slice(0, 6) });
  const deal = ctx.config.creators.defaultDeal;
  for (const cell of plan.cells.filter((c) => cellIds.includes(c.id))) {
    const campaign: CreatorCampaign = {
      id: ctx.store.nextId("campaign"),
      ventureId: v.id,
      brief,
      platforms: ["tiktok", "instagram"],
      targetCountries: [cell.geo],
      creatorAudienceCountryMinPct: ctx.config.lab.minCreatorGeoShare,
      flatFeeCents: deal.flatFeeCents,
      cpmCents: deal.cpmCents,
      maxPayoutPerVideoCents: deal.maxPayoutCents,
      payoutMaturityDays: ctx.config.creators.viewLockDays,
      budgetCents: cell.budgetCents,
      status: "draft",
      experimentId: plan.id,
      cellId: cell.id,
      createdAt: ctx.ports.clock.iso(),
    };
    ctx.store.campaigns.put(campaign);
    ctx.outbox.propose({
      kind: "creator.campaign_create",
      ventureId: v.id,
      payload: { campaignId: campaign.id },
      summary: `Creator batch for ${v.name} in ${cell.geo} (${plan.id})`,
      rationale: `Staff cell ${cell.id} of ${plan.id}: ${ctx.config.lab.creatorBatch.creatorsPerCell} creators x ${ctx.config.lab.creatorBatch.postsPerCreator} posts`,
      proposedBy: "lab",
      naturalKey: campaign.id,
      commitment: { kind: "lifetime_cap", amountCents: cell.budgetCents, maxTotalCents: cell.budgetCents, startsAt: ctx.ports.clock.iso() },
      experimentId: plan.id,
      cellId: cell.id,
    });
  }
}

function closeCampaigns(ctx: TickContext, plan: ExperimentPlan): void {
  for (const c of cellCampaigns(ctx, plan.id)) {
    if (c.status === "open") {
      ctx.outbox.propose({ kind: "creator.campaign_close", ventureId: plan.ventureId, payload: { campaignId: c.id }, summary: `Close ${c.id}`, rationale: `${plan.id} decided`, proposedBy: "lab", naturalKey: c.id });
    }
  }
}

const DAY_MS = 86_400_000;

/** Last 28 days of contribution without acquisition spend: what the app earns if growth spending stops. */
export function organicContributionCents(ctx: TickContext, v: Venture): number {
  const since = new Date(new Date(ctx.ports.clock.iso()).getTime() - 28 * DAY_MS).toISOString();
  return ctx.store.net({ ventureId: v.id, since, categories: ORGANIC_CATEGORIES });
}

/**
 * Stop testing a venture. An app with paying users and positive organic contribution is harvested
 * (no further growth spend) rather than shut off; one with paying users otherwise goes to a human
 * sunset decision; one without users is killed.
 */
export function proposeKill(ctx: TickContext, v: Venture, reason: string): void {
  const latest = ctx.store.metrics(v.id, (m) => m.cellId === null && m.geo === null).at(-1);
  const subscribers = latest?.activeSubscribers ?? 0;
  if (subscribers > 0 && isLiveOnStore(v) && organicContributionCents(ctx, v) > 0) {
    windDown(ctx, v, reason);
    transition(ctx.store, ctx.ports.clock, ctx.store.ventures.require(v.id), "harvest", `${reason}; organic contribution is positive, harvesting without growth spend`);
    return;
  }
  if (subscribers > 0) {
    ctx.outbox.propose({ kind: "venture.sunset", ventureId: v.id, payload: { activeSubscribers: subscribers, plan: "serve_until_lapse", reason }, summary: `Sunset ${v.name}`, rationale: reason, proposedBy: "lab", naturalKey: "sunset" });
  } else {
    ctx.outbox.propose({ kind: "venture.kill", ventureId: v.id, payload: { reason }, summary: `Kill ${v.name}`, rationale: reason, proposedBy: "lab", naturalKey: "kill" });
  }
}

/** Observe and read every running experiment. */
export async function runExperiments(ctx: TickContext, deps: StudioDeps): Promise<ExperimentOutcome[]> {
  const outcomes: ExperimentOutcome[] = [];
  for (const plan0 of ctx.store.experiments.list((e) => e.status === "running")) {
    let plan = plan0;
    const v = ctx.store.ventures.get(plan.ventureId);
    if (!v || v.stage === "killed" || v.stage === "exited") {
      ctx.store.experiments.put({ ...plan, status: "aborted" });
      continue;
    }
    if (plan.stages.includes("S0_attention")) continue; // the attention probe is read in the growth phase
    const now = ctx.ports.clock.iso();
    const previous = ctx.store.outcomes(plan.id);
    const active = activeCells(plan, previous);
    const observations = new Map<string, CellObservation>();
    for (const cell of active) {
      const obs = await observeCell(ctx, plan, cell.id);
      ctx.store.addObservation(plan.id, obs);
      observations.set(cell.id, obs);
      if (!cell.firstExposureAt && hasExposure(plan, obs)) {
        plan = { ...plan, cells: plan.cells.map((c) => (c.id === cell.id ? { ...c, firstExposureAt: now } : c)) };
      }
    }
    ctx.store.experiments.put(plan);
    const replicatedAt = previous.find((o) => o.decision === "replicate")?.decidedAt;
    // The exposure SLA runs from when the cell's creator campaign went live, not from registration:
    // approvals and marketplace setup are not the audience's fault.
    const launchedAt = (cellId: string): string | null => {
      const campaigns = cellCampaigns(ctx, plan.id, cellId);
      if (!campaigns.length) return null;
      const executed = campaigns
        .map((c) => ctx.store.actions.list((a) => a.kind === "creator.campaign_create" && (a.payload as { campaignId: string }).campaignId === c.id && (a.status === "executed" || a.status === "dry_run"))[0]?.executedAt)
        .filter((t): t is string => Boolean(t))
        .sort();
      return executed[0] ?? now;
    };
    const verdicts = active.map((cell) =>
      evaluateCell({
        plan,
        cell: plan.cells.find((c) => c.id === cell.id) ?? cell,
        obs: observations.get(cell.id),
        config: ctx.config,
        now,
        clockStart: launchedAt(cell.id) ?? (cell.phase === 2 && replicatedAt ? replicatedAt : (plan.startedAt ?? plan.registeredAt)),
      }),
    );
    const spec = v.spec;
    const pricing = spec ? { entry: ladderEntry(ctx.config, spec.paywall.highlightedProductId), platform: "ios" as const } : undefined;
    const outcome = decideExperiment({
      plan,
      verdicts,
      observations,
      ladder: v.ladder,
      config: ctx.config,
      now,
      previousOutcomes: previous,
      ...(pricing ? { pricing } : {}),
      rng: ctx.rng.fork(`decide:${plan.id}:${now}`),
    });
    if (outcome.decision === "continue") continue;
    ctx.store.addOutcome(outcome);
    ctx.log("experiment.decided", { experimentId: plan.id, decision: outcome.decision, rationale: outcome.rationale, cells: outcome.cells.map((c) => ({ cellId: c.cellId, decision: c.decision })), unitEconomics: outcome.unitEconomics ?? null }, v.id);
    outcomes.push(outcome);
    await applyOutcome(ctx, deps, plan, outcome);
  }
  return outcomes;
}

async function applyOutcome(ctx: TickContext, deps: StudioDeps, plan: ExperimentPlan, outcome: ExperimentOutcome): Promise<void> {
  const clock = ctx.ports.clock;
  let v = ctx.store.ventures.require(plan.ventureId);
  if (outcome.decision === "replicate") {
    await staffCells(ctx, deps, plan, plan.cells.filter((c) => c.phase === 2).map((c) => c.id));
    return;
  }
  ctx.store.experiments.put({ ...ctx.store.experiments.require(plan.id), status: "decided", decidedAt: outcome.decidedAt });
  closeCampaigns(ctx, plan);
  const ladder = { ...v.ladder, currentExperimentId: null };
  switch (outcome.decision) {
    case "pass": {
      const validated = [...new Set([...v.ladder.validated, ...plan.stages])];
      const stepIndex = v.ladder.stepIndex + 1;
      v = patch(ctx.store, clock, v, { ladder: { ...ladder, validated, stepIndex, iteration: 0, harnessFixes: 0, stepStartedAt: null } });
      if (stepIndex >= v.ladder.steps.length) {
        ctx.outbox.propose({
          kind: "venture.scale",
          ventureId: v.id,
          payload: {
            evidence: `${v.name} validated ${validated.join(", ")}. ${outcome.rationale}`,
            experimentIds: v.ladder.experimentIds,
            proposedDailyCents: Math.min(ctx.config.budgets.scaleDailyCapCents, 10_000),
            addTerritories: ctx.config.lab.scaleGeos,
          },
          summary: `Scale ${v.name}`,
          rationale: outcome.rationale,
          proposedBy: "lab",
          naturalKey: "scale",
        });
      }
      return;
    }
    case "iterate": {
      v = patch(ctx.store, clock, v, { ladder: { ...ladder, iteration: v.ladder.iteration + 1 } });
      transition(ctx.store, clock, v, "iterating", outcome.rationale);
      await prepareVariant(ctx, deps, ctx.store.ventures.require(v.id), plan, outcome);
      return;
    }
    case "kill": {
      patch(ctx.store, clock, v, { ladder });
      proposeKill(ctx, v, outcome.rationale);
      return;
    }
    case "fix_harness": {
      const variant = plan.cells[0]?.variant ?? { baseline: "rerun" };
      patch(ctx.store, clock, v, {
        ladder: { ...ladder, harnessFixes: v.ladder.harnessFixes + 1 },
        pendingVariant: {
          variableUnderTest: plan.variableUnderTest,
          variant,
          hypothesis: `${plan.hypothesis} (harness re-run: ${outcome.rationale})`,
          deliveryMode: "content_only",
          parentExperimentId: plan.id,
          geos: plan.cells.map((c) => c.geo),
          readyAt: clock.iso(),
        },
      });
      return;
    }
    case "escalate": {
      const task = ctx.outbox.openTask({
        kind: "legal.review",
        ventureId: v.id,
        title: `Experiment ${plan.id} for ${v.name} needs a human read`,
        instructions: `${outcome.rationale}\n\nDiagnostics:\n${(outcome.diagnostics ?? []).map((d) => `- ${d.id}: ${d.detail}`).join("\n") || "- none"}\n\nComplete with decision "rerun" to re-run the step or "kill" to stop the venture.`,
        inputs: [{ key: "decision", label: "rerun or kill", pattern: "^(rerun|kill)$" }],
      });
      patch(ctx.store, clock, v, { ladder, blockedOn: [...v.blockedOn, task.id] });
      return;
    }
    default:
      return;
  }
}

/** Ask the designer for one change, apply it, and start delivering it. */
async function prepareVariant(ctx: TickContext, deps: StudioDeps, v: Venture, plan: ExperimentPlan, outcome: ExperimentOutcome): Promise<void> {
  const clock = ctx.ports.clock;
  const spec = v.spec;
  if (!spec) return;
  const tried = v.ladder.experimentIds.map((id) => ctx.store.experiments.get(id)?.variableUnderTest).filter((x): x is string => Boolean(x));
  const { proposal, deliveryMode: proposedMode } = await deps.agents.proposeVariant(ctx, {
    venture: v,
    idea: ideaFor(ctx, v),
    spec,
    outcomeSummary: outcome.rationale,
    failedStages: plan.stages,
    triedVariables: tried,
  });
  // Apple 2.5.19: changing core behaviour by remote config is a bait-and-switch; ship it as a reviewed build.
  const deliveryMode = proposal.change.kind === "core" ? "native_build" : proposedMode;
  const kind = proposal.change.kind;
  const variantId = `${kind}_v${v.specVersion + 1}`;
  const now = clock.iso();
  const pending: NonNullable<Venture["pendingVariant"]> = {
    variableUnderTest: kind,
    variant: { [kind]: variantId },
    hypothesis: proposal.hypothesis,
    deliveryMode,
    parentExperimentId: plan.id,
  };
  if (kind === "hooks" || kind === "positioning") {
    const hooks = kind === "hooks" ? proposal.change.hooks : proposal.change.hooks;
    for (const h of ctx.store.hooks.list((x) => x.ventureId === v.id && x.status !== "culled")) ctx.store.hooks.put({ ...h, status: "culled" });
    for (const text of hooks) ctx.store.hooks.put({ id: ctx.store.nextId("hook"), ventureId: v.id, formatId: deps.defaultFormatId, text, angle: proposal.variableUnderTest, source: "variant", status: "exploring", createdAt: now });
  }
  const nextSpec = deps.agents.applyVariant(spec, proposal);
  const changed = JSON.stringify(nextSpec) !== JSON.stringify(spec);
  const specVersion = changed ? v.specVersion + 1 : v.specVersion;
  v = patch(ctx.store, clock, v, {
    spec: nextSpec,
    specVersion,
    specHistory: changed ? [...v.specHistory, { version: specVersion, spec: nextSpec, changedBy: "designer", reason: `variant:${kind}: ${proposal.hypothesis}`, at: now }] : v.specHistory,
    baseline: { ...v.baseline, specVersion },
    pendingVariant: deliveryMode === "content_only" ? { ...pending, readyAt: now } : pending,
  });
  if (deliveryMode === "remote_config" && (kind === "paywall" || kind === "onboarding" || kind === "share")) {
    const payload = kind === "paywall" ? nextSpec.paywall : kind === "onboarding" ? nextSpec.onboarding : nextSpec.share;
    ctx.outbox.propose({
      kind: "remote_config.set",
      ventureId: v.id,
      payload: { key: kind, variants: [{ id: variantId, rolloutPct: 100, payload }], experimentId: plan.id },
      summary: `Ship ${kind} variant ${variantId} for ${v.name}`,
      rationale: proposal.hypothesis,
      proposedBy: "designer",
      naturalKey: variantId,
    });
  } else if (deliveryMode === "store_metadata" || deliveryMode === "native_build") {
    transition(ctx.store, clock, ctx.store.ventures.require(v.id), "building", `shipping ${kind} variant as a new build`);
  }
}

/** Mark remote-config variants ready once their action executed; resume ventures whose new build is live. */
export function settleVariants(ctx: TickContext, v: Venture): string {
  const pending = v.pendingVariant;
  if (!pending || pending.readyAt) return pending ? "variant ready" : "no variant";
  const now = ctx.ports.clock.iso();
  if (pending.deliveryMode === "remote_config") {
    const variantId = String(Object.values(pending.variant)[0] ?? "");
    const executed = ctx.store.actions.list((a) => a.ventureId === v.id && a.kind === "remote_config.set" && a.dedupeKey.endsWith(variantId) && (a.status === "executed" || a.status === "dry_run"));
    if (executed.length) {
      patch(ctx.store, ctx.ports.clock, v, { pendingVariant: { ...pending, readyAt: now } });
      if (v.stage === "iterating") transition(ctx.store, ctx.ports.clock, ctx.store.ventures.require(v.id), "live_test", `${pending.variableUnderTest} variant live`);
      return "variant live";
    }
    return "waiting for remote config";
  }
  if (pending.deliveryMode === "content_only") return "variant ready";
  // Builds: ready once the venture is live again (the pipeline moves it back through review).
  const rec = v.stores.find((s) => s.platform === "ios");
  if (v.stage === "live_test" && rec?.status === "live") {
    patch(ctx.store, ctx.ports.clock, v, { pendingVariant: { ...pending, readyAt: now } });
    return "variant live";
  }
  return "waiting for build";
}
