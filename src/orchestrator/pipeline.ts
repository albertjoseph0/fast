/**
 * Build-and-ship pipeline for a venture: spec → render → icon → web/legal → bundle →
 * app record (human on iOS) → subscriptions → build → upload → listing → territories →
 * monetization → App Review → release.
 *
 * Every tick re-derives the next missing step from state and proposes it through the
 * outbox. Dedupe keys make re-proposals no-ops, and the pipeline waits while any of
 * the venture's store actions is still open, so steps never race each other.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { TickContext } from "../core/context.ts";
import type { Action, BakedBinding, HumanTask, HumanTaskDraft, Idea, SubmissionChangeArea, Venture } from "../core/types.ts";
import { OPEN_STATUSES } from "../governance/outbox.ts";
import { testGeosFor } from "../lab/audiences.ts";
import { storeProductDefs } from "../playbook/product.ts";
import { taskDraft } from "../playbook/setup.ts";
import { lintSpec } from "../principles/product.ts";
import { effectiveDomains, specDomains } from "../principles/sensitivity.ts";
import { latestJob, patch, transition } from "./lifecycle.ts";
import type { StudioDeps } from "./deps.ts";

const PLATFORM = "ios" as const;
/** Upload attempts that fail before reaching the store before a human looks. */
const MAX_UPLOAD_FAILURES = 3;

function openActions(ctx: TickContext, v: Venture, prefix: string): Action[] {
  return ctx.store.actions.list((a) => a.ventureId === v.id && a.kind.startsWith(prefix) && OPEN_STATUSES.includes(a.status));
}

/** Executed, or recorded as a dry run while dry-run is still on (after go-live those steps run for real). */
function done(ctx: TickContext, v: Venture, kind: Action["kind"], naturalSuffix?: string): boolean {
  return ctx.store.actions.list(
    (a) =>
      a.ventureId === v.id &&
      a.kind === kind &&
      (a.status === "executed" || (a.status === "dry_run" && ctx.config.dryRun)) &&
      (naturalSuffix === undefined || a.dedupeKey.endsWith(naturalSuffix)),
  ).length > 0;
}

/** Open a venture task once (an open or completed one counts). */
function ensureTask(ctx: TickContext, v: Venture, kind: HumanTask["kind"], extra?: string): boolean {
  if (taskDone(ctx, kind, v.id)) return true;
  if (!ctx.store.tasks.count((t) => t.kind === kind && t.ventureId === v.id && t.status === "open")) ctx.outbox.openTask(taskDraft(kind, v.id, extra));
  return false;
}

const BAKED: readonly BakedBinding[] = ["webBaseUrl", "deepLinkDomain", "easProjectId", "ascAppId", "backendUrl"];

/** The bindings a render bakes into the app: when one changes before the binary is built, re-render. */
function bakedBindings(v: Venture): Partial<Record<BakedBinding, string>> {
  const out: Partial<Record<BakedBinding, string>> = {};
  for (const key of BAKED) {
    const value = v.bindings[key];
    if (typeof value === "string" && value) out[key] = value;
  }
  return out;
}

/** The build job of the current spec version that is still usable (not superseded after a failed upload). */
function buildJobFor(ctx: TickContext, v: Venture) {
  return ctx.store.jobs
    .list((j) => {
      if (j.ventureId !== v.id || j.op !== "store.build" || j.result?.["superseded"] === true) return false;
      const payload = ctx.store.actions.get(j.actionId)?.payload as { specVersion?: number } | undefined;
      return payload?.specVersion === v.specVersion;
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1))
    .at(-1);
}

/** Builds of the current spec version that failed or were superseded; past the cap a human looks. */
const MAX_BUILD_ATTEMPTS = 3;

function taskDone(ctx: TickContext, kind: HumanTask["kind"], ventureId?: string): boolean {
  return ctx.store.tasks.count((t) => t.kind === kind && t.status === "done" && (ventureId === undefined || t.ventureId === ventureId)) > 0;
}

function storeRecord(v: Venture) {
  return v.stores.find((s) => s.platform === PLATFORM);
}

export function ideaFor(ctx: TickContext, v: Venture): Idea {
  return ctx.store.ideas.require(v.ideaId).idea;
}

/** Sensitive domains of the venture as built: the screening's, plus what the current spec itself says. */
function domainsFor(ctx: TickContext, v: Venture) {
  const idea = ideaFor(ctx, v);
  const screened = ctx.store.screenings.get(v.screeningId)?.sensitiveDomains ?? [];
  return v.spec ? specDomains(v.spec, idea, screened) : effectiveDomains(idea, screened);
}

/** A per-build human task: done only once a task naming this exact marker was completed. */
function ensureTaskFor(ctx: TickContext, v: Venture, kind: HumanTask["kind"], marker: string, extra: string): boolean {
  if (ctx.store.tasks.count((t) => t.kind === kind && t.ventureId === v.id && t.status === "done" && t.instructions.includes(marker)) > 0) return true;
  if (!ctx.store.tasks.count((t) => t.kind === kind && t.ventureId === v.id && t.status === "open")) ctx.outbox.openTask(taskDraft(kind, v.id, `${extra} (${marker})`));
  return false;
}

/**
 * Copy the linter cannot clear on its own (efficacy, health or money claims) goes to a person before
 * the spec ships: each distinct set of findings is reviewed once. Returns what is still pending.
 */
function specReviewPending(ctx: TickContext, v: Venture, domains: ReturnType<typeof domainsFor>): string | null {
  const spec = v.spec;
  if (!spec) return null;
  const findings = lintSpec(spec, ideaFor(ctx, v), ctx.config, domains).filter((f) => f.severity === "needs_human");
  if (!findings.length) return null;
  const lines = findings.map((f) => `${f.ruleId}: ${f.message}`).sort();
  const marker = `spec review ${createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 12)}`;
  if (!ensureTaskFor(ctx, v, "legal.review", marker, `Copy in ${spec.appName} v${v.specVersion} needs a human before it ships: ${lines.join("; ")}`)) return "copy review";
  const decided = ctx.store.tasks.list((t) => t.kind === "legal.review" && t.ventureId === v.id && t.status === "done" && t.instructions.includes(marker)).at(-1);
  return decided?.outputs?.["decision"] === "approved" ? null : "copy changes requested";
}

/**
 * The first submission carries the subscriptions for review, so they must be ready to submit: the
 * latest subscription job succeeded (a job that needs a human is waiting on missing store metadata).
 */
function subscriptionsPending(ctx: TickContext, v: Venture): string | null {
  if (done(ctx, v, "store.submit_review")) return null;
  const job = latestJob(ctx.store, v.id, "store.upsert_subscriptions");
  if (!job || job.status === "succeeded") return null;
  if (job.status === "failed") {
    // Retry once (the upsert is idempotent); after that a human fixes the store side first.
    const failures = ctx.store.jobs.count((j) => j.ventureId === v.id && j.op === "store.upsert_subscriptions" && j.status === "failed");
    if (failures < 2 || ensureTaskFor(ctx, v, "store.manual_step", `subscriptions ${job.id}`, `Creating the subscriptions for ${v.name} failed ${failures} times: ${job.error ?? "no error reported"}`)) {
      patch(ctx.store, ctx.ports.clock, v, { bindings: { ...v.bindings, products: [] } });
      return "re-creating subscriptions";
    }
    return "subscriptions (store.manual_step)";
  }
  return job.status === "needs_human" ? "subscription metadata (store.manual_step)" : "subscriptions to be ready";
}

/** The tenant file's content hash: the backend must serve this exact system prompt and config. */
function tenantMarker(v: Venture, projectDir: string): string {
  const path = join(projectDir, "server", "tenants", `${v.slug}.json`);
  const hash = existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 12) : `v${v.specVersion}`;
  return `tenant ${hash}`;
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listFiles(join(dir, e.name)) : [join(dir, e.name)]));
}

/** Seed the venture's hooks from the idea so creative batches have arms from day one. */
function seedHooks(ctx: TickContext, v: Venture, idea: Idea, formatId: string): string[] {
  const now = ctx.ports.clock.iso();
  return idea.hookExamples.map((text) => {
    const id = ctx.store.nextId("hook");
    ctx.store.hooks.put({ id, ventureId: v.id, formatId, text, angle: "idea", source: "idea", status: "exploring", createdAt: now });
    return id;
  });
}

/** Spec, render and icon: the in-house part of building. Returns false when the venture was killed. */
async function ensureBuild(ctx: TickContext, deps: StudioDeps, v: Venture): Promise<Venture | null> {
  const idea = ideaFor(ctx, v);
  const clock = ctx.ports.clock;
  if (!v.spec) {
    const { spec, findings } = await deps.agents.designSpec(ctx, { idea, ventureId: v.id });
    const blocks = findings.filter((f) => f.severity === "block");
    if (blocks.length) {
      transition(ctx.store, clock, v, "killed", `spec failed lint after repair: ${blocks.map((b) => b.ruleId).join(", ")}`);
      return null;
    }
    const hookIds = seedHooks(ctx, v, idea, deps.defaultFormatId);
    v = patch(ctx.store, clock, v, {
      spec,
      specVersion: 1,
      specHistory: [{ version: 1, spec, changedBy: "designer", reason: "initial spec", at: clock.iso() }],
      baseline: { ...v.baseline, specVersion: 1, hookIds },
    });
  }
  if (!v.bindings.backendUrl) return v; // the render bakes in the backend URL; advanceBuilding waits for it
  // Re-render for a new spec version, and whenever a baked binding (site, deep-link domain, EAS project,
  // app record) changes before the binary is built, so the app links to the real ones.
  const baked = bakedBindings(v);
  const stale = v.build !== undefined && !v.build.easBuildId && JSON.stringify(v.build.baked ?? {}) !== JSON.stringify(baked);
  if (!v.build || v.build.specVersion !== v.specVersion || stale) {
    const publisherTeam = ctx.store.publishers.get(v.bindings.publisherAccountIds.ios ?? "")?.externalTeamId;
    const teamId = publisherTeam && publisherTeam !== "UNSET" ? publisherTeam : undefined;
    const record = deps.renderApp({
      venture: v,
      spec: v.spec as NonNullable<Venture["spec"]>,
      idea,
      config: ctx.config,
      domains: domainsFor(ctx, v),
      outRoot: deps.outRoot,
      templateDir: deps.templateDir,
      builtAt: clock.iso(),
      ...(teamId ? { appleTeamId: teamId } : {}),
    });
    const failed = record.checks.filter((c) => !c.passed);
    if (failed.length) {
      transition(ctx.store, clock, v, "killed", `build checks failed: ${failed.map((c) => c.name).join(", ")}`);
      return null;
    }
    const { files: _files, ...rendered } = record;
    const build = { ...rendered, baked };
    // A new spec version is a new binary: forget the previously uploaded build so the new one is uploaded.
    const stores = v.build ? v.stores.map(({ storeBuildId: _old, ...rest }) => rest) : v.stores;
    v = patch(ctx.store, clock, v, { build, stores });
    const icon = join(record.projectDir, "assets", "icon.png");
    if (!existsSync(icon)) await deps.agents.produceIcon(ctx, { ventureId: v.id, spec: v.spec as NonNullable<Venture["spec"]>, outDir: join(record.projectDir, "assets") });
  }
  return v;
}

/** One pipeline step per tick at most; returns a short status for the report. */
export async function advanceBuilding(ctx: TickContext, deps: StudioDeps, venture: Venture): Promise<string> {
  const built = await ensureBuild(ctx, deps, venture);
  if (!built) return "killed during build";
  let v = built;
  if (!v.build) return "waiting for the verdict backend (backend.deploy)";
  if (openActions(ctx, v, "store.").length || openActions(ctx, v, "web.").length || openActions(ctx, v, "monetization.").length) {
    return "waiting on open store actions";
  }
  const spec = v.spec as NonNullable<Venture["spec"]>;
  const build = v.build as NonNullable<Venture["build"]>;
  const rec = storeRecord(v);
  const propose = ctx.outbox.propose.bind(ctx.outbox);
  const base = { ventureId: v.id, proposedBy: "orchestrator" as const };
  const inventory = spec.compliance.dataInventory.map((d) => `${d.dataType} → ${d.purpose} (${d.sentTo.join(", ")})`).join("; ");
  const domains = domainsFor(ctx, v);
  const tenantFile = join(build.projectDir, "server", "tenants", `${v.slug}.json`);
  const tenant = tenantMarker(v, build.projectDir);
  const tenantTask = () => ensureTaskFor(ctx, v, "backend.add_tenant", tenant, `Tenant file: ${tenantFile}; backend ${v.bindings.backendUrl ?? "(not deployed)"}.`);
  // Human steps open as soon as their inputs exist, so people work while the API steps run.
  if (v.bindings.webBaseUrl && !build.easBuildId) {
    ensureTask(ctx, v, "integrations.bind_projects", `${spec.appName} (${v.slug})`);
    ensureTask(ctx, v, "web.deploy_site", `Serve ${v.bindings.webBaseUrl} at the root of the venture's own domain; the app's universal links use that domain.`);
  }
  tenantTask();
  if (rec?.appId || v.bindings.ascAppId) {
    ensureTask(ctx, v, "apple.privacy_labels", `Data inventory for ${spec.appName}: ${inventory}. Privacy policy: ${v.bindings.privacyUrl ?? "pending"}.`);
    ensureTask(ctx, v, "apple.app_info", `${spec.appName}: minimum age ${spec.compliance.minimumAge}+; sensitive domains ${domains.join(", ") || "none"}; category ${spec.category}; copyright ${new Date(ctx.ports.clock.iso()).getUTCFullYear()} ${ctx.config.company.legalName}.`);
  }

  // Public legal pages, support page and deep-link files come first: listings need their URLs.
  if (!v.bindings.webBaseUrl) {
    const siteDir = join(build.projectDir, "..", "site");
    const files = listFiles(siteDir).map((localPath) => ({ path: relative(siteDir, localPath), localPath }));
    propose({ ...base, kind: "web.publish_site", payload: { files }, naturalKey: `site:v${v.specVersion}`, summary: `Publish ${v.name} site`, rationale: "Store listings require privacy, terms and support URLs" });
    return "publishing site";
  }
  if (!done(ctx, v, "store.register_bundle")) {
    propose({ ...base, kind: "store.register_bundle", payload: { platform: PLATFORM, bundleId: v.bindings.bundleId, capabilities: ["push", "associated_domains"] }, naturalKey: PLATFORM, summary: `Register ${v.bindings.bundleId}`, rationale: "Bundle id needed before the app record" });
    return "registering bundle id";
  }
  if (!rec?.appId && !v.bindings.ascAppId) {
    propose({
      ...base,
      kind: "store.create_app",
      payload: { platform: PLATFORM, bundleId: v.bindings.bundleId, name: spec.appName, sku: `${v.slug}-${v.id}`, primaryLocale: spec.locale },
      naturalKey: PLATFORM,
      summary: `Create the App Store record for ${spec.appName}`,
      rationale: "App Store Connect cannot create apps by API; a human creates the record",
    });
    return "waiting for app record";
  }
  if (v.bindings.products.length === 0) {
    if (!taskDone(ctx, "apple.paid_apps_agreement")) return "waiting for the Paid Apps Agreement";
    const territories = testGeosFor(spec.locale, ctx.config);
    propose({
      ...base,
      kind: "store.upsert_subscriptions",
      payload: { platform: PLATFORM, groupName: `${spec.appName} Pro`, products: storeProductDefs(ctx.config, v.bindings.bundleId, territories) },
      naturalKey: PLATFORM,
      summary: `Create the price ladder for ${spec.appName}`,
      rationale: "All ladder SKUs exist up front so paywall tests never need new IAP review",
    });
    return "creating subscriptions";
  }
  if (!build.easBuildId) {
    // Everything baked into the binary must exist first; the tasks run in parallel.
    const missing = [
      ensureTask(ctx, v, "integrations.bind_projects", `${spec.appName} (${v.slug})`) && v.bindings.easProjectId ? null : "EAS/PostHog/RevenueCat projects",
      ensureTask(ctx, v, "web.deploy_site", `Serve ${v.bindings.webBaseUrl} at the root of the venture's own domain; the app's universal links use that domain.`) && v.bindings.deepLinkDomain ? null : "deep-link domain",
    ].filter(Boolean);
    if (missing.length) return `waiting for ${missing.join(" and ")}`;
    const buildJob = buildJobFor(ctx, v);
    if (!buildJob || buildJob.status === "failed") {
      const attempts = ctx.store.jobs.count((j) => j.ventureId === v.id && j.op === "store.build" && (j.status === "failed" || j.result?.["superseded"] === true) && (ctx.store.actions.get(j.actionId)?.payload as { specVersion?: number } | undefined)?.specVersion === v.specVersion);
      if (attempts >= MAX_BUILD_ATTEMPTS) {
        ctx.outbox.openTask(taskDraft("store.manual_step", v.id, `${attempts} builds of ${spec.appName} v${build.version} failed or were rejected at processing; check the EAS build logs and App Store Connect, fix the cause, then confirm to retry.`));
        return `build failed ${attempts} times; waiting for a human`;
      }
      propose({ ...base, kind: "store.start_build", payload: { platform: PLATFORM, projectDir: build.projectDir, specVersion: v.specVersion }, naturalKey: `${PLATFORM}:v${v.specVersion}:attempt${attempts + 1}`, summary: `Build ${spec.appName} v${build.version}`, rationale: "Compile the rendered project" });
      return "starting build";
    }
    return "build running";
  }
  if (!rec?.storeBuildId) {
    if (rec?.status !== "build_processing") {
      // An upload that keeps failing before it starts (credentials, eas-cli) goes to a human after a few tries.
      const marker = `upload ${build.easBuildId}`;
      const lastFix = ctx.store.tasks
        .list((t) => t.kind === "store.manual_step" && t.ventureId === v.id && t.status === "done" && t.instructions.includes(marker))
        .map((t) => t.completedAt ?? "")
        .sort()
        .at(-1);
      const failures = ctx.store.actions.list((a) => a.ventureId === v.id && a.kind === "store.submit_build" && a.status === "failed" && a.dedupeKey.endsWith(`${PLATFORM}:${build.easBuildId}`) && (!lastFix || a.createdAt > lastFix));
      if (failures.length >= MAX_UPLOAD_FAILURES) {
        if (!ctx.store.tasks.count((t) => t.kind === "store.manual_step" && t.ventureId === v.id && t.status === "open")) {
          ctx.outbox.openTask(taskDraft("store.manual_step", v.id, `Uploading ${spec.appName} build ${build.easBuildId} failed ${failures.length} times (${marker}): ${failures.at(-1)?.error ?? "no error reported"}`));
        }
        return `upload failed ${failures.length} times; waiting for a human`;
      }
      propose({ ...base, kind: "store.submit_build", payload: { platform: PLATFORM, easBuildId: build.easBuildId }, naturalKey: `${PLATFORM}:${build.easBuildId}`, summary: `Upload build ${build.easBuildId}`, rationale: "Upload to App Store Connect for processing" });
      return "uploading build";
    }
    return "build processing";
  }
  const listingJob = latestJob(ctx.store, v.id, "store.update_listing");
  const listingDone = done(ctx, v, "store.update_listing", `v${v.specVersion}`) && listingJob?.status === "succeeded";
  if (!listingDone) {
    if (!v.bindings.privacyUrl || !v.bindings.supportUrl) {
      // The executor derives these from the published site's privacy/terms/support pages.
      throw new Error(`site published at ${v.bindings.webBaseUrl} without privacy or support pages; the listing cannot be submitted`);
    }
    if (listingJob?.status === "running") return "listing processing";
    const screenshots = listFiles(join(build.projectDir, "..", "store", "screenshots"));
    propose({
      ...base,
      kind: "store.update_listing",
      payload: {
        platform: PLATFORM,
        listing: {
          locale: spec.locale,
          name: spec.appName,
          subtitle: spec.subtitle,
          description: spec.aso.description,
          keywords: spec.aso.keywords.join(","),
          promotionalText: spec.aso.promotionalText,
          supportUrl: v.bindings.supportUrl,
          privacyUrl: v.bindings.privacyUrl,
          ...(v.bindings.webBaseUrl ? { marketingUrl: v.bindings.webBaseUrl } : {}),
        },
        screenshotPaths: screenshots,
      },
      naturalKey: `${PLATFORM}:v${v.specVersion}`,
      summary: `Update the ${spec.appName} listing`,
      rationale: "Metadata and screenshots for review",
    });
    return "updating listing";
  }
  const territories = testGeosFor(spec.locale, ctx.config);
  if (!rec || rec.territories.join(",") !== territories.join(",")) {
    propose({ ...base, kind: "store.set_territories", payload: { platform: PLATFORM, territories }, naturalKey: `${PLATFORM}:${territories.join("-")}`, summary: `Limit ${spec.appName} to test storefronts ${territories.join(", ")}`, rationale: "Bier P4: never test in the scale market" });
    return "setting test territories";
  }
  if (!done(ctx, v, "monetization.configure")) {
    // RevenueCat needs the venture's project; without it the action would fail on every tick.
    if (!v.bindings.revenueCatProjectId) return ensureTask(ctx, v, "integrations.bind_projects", `${spec.appName} (${v.slug})`) ? "waiting for the RevenueCat project binding" : "waiting for EAS/PostHog/RevenueCat projects";
    propose({ ...base, kind: "monetization.configure", payload: { productIds: v.bindings.products.map((p) => p.productId), entitlementId: ctx.config.monetization.entitlementId }, naturalKey: "initial", summary: `Configure paywall products for ${spec.appName}`, rationale: "Entitlements and offerings for the price ladder" });
    return "configuring monetization";
  }
  // Console-only steps before the first submission (opened above as soon as possible).
  const waiting = [
    ensureTask(ctx, v, "apple.privacy_labels", `Data inventory for ${spec.appName}: ${inventory}. Privacy policy: ${v.bindings.privacyUrl ?? "pending"}.`) ? null : "App Privacy labels",
    ensureTask(ctx, v, "apple.app_info", `${spec.appName}: minimum age ${spec.compliance.minimumAge}+; sensitive domains ${domains.join(", ") || "none"}; category ${spec.category}; copyright ${new Date(ctx.ports.clock.iso()).getUTCFullYear()} ${ctx.config.company.legalName}.`) ? null : "App Store information",
    tenantTask() ? null : "verdict backend tenant",
    specReviewPending(ctx, v, domains),
    subscriptionsPending(ctx, v),
  ].filter(Boolean);
  if (waiting.length) return `waiting for ${waiting.join(", ")}`;
  const changedAreas: SubmissionChangeArea[] = v.specVersion === 1 ? ["new_app"] : changedAreasFor(v);
  propose({
    ...base,
    kind: "store.submit_review",
    payload: {
      platform: PLATFORM,
      storeBuildId: rec.storeBuildId,
      notesForReviewer: reviewerNotes(spec),
      changedAreas,
      differentiationReport: await deps.differentiationReport(ctx, v),
    },
    naturalKey: `${PLATFORM}:${rec.storeBuildId}`,
    summary: `Submit ${spec.appName} ${build.version} for review`,
    rationale: "Build, listing, territories and products are ready",
  });
  transition(ctx.store, ctx.ports.clock, v, "in_review", "submitted for App Review");
  return "submitted for review";
}

/** What a resubmission changes, from the variant being shipped (Apple 2.5.19 gates core changes on a human). */
function changedAreasFor(v: Venture): SubmissionChangeArea[] {
  const kind = v.pendingVariant?.variableUnderTest ?? "";
  if (/core/.test(kind)) return ["core"];
  if (/paywall|price/.test(kind)) return ["monetization"];
  if (/positioning|hooks|copy/.test(kind)) return ["copy"];
  return ["other"];
}

function reviewerNotes(spec: NonNullable<Venture["spec"]>): string {
  return [
    `${spec.appName} is a single-purpose AI app: ${spec.core.inputLabel}.`,
    `Access requires a subscription after onboarding (hard paywall); prices and renewal terms are shown from StoreKit on the paywall, with Restore and Manage Subscription.`,
    `Users explicitly consent before any data is sent to the AI provider (5.1.2(i)). Results are labelled as AI-generated and can be reported.`,
    `No account is required; there is no user-generated content shared between users.`,
  ].join(" ");
}

/** in_review: release when approved; escalate rejections instead of arguing with App Review. */
export function advanceInReview(ctx: TickContext, v: Venture): string {
  const rec = storeRecord(v);
  if (!rec) return "no store record";
  if (rec.status === "pending_release") {
    ctx.outbox.propose({ ventureId: v.id, proposedBy: "orchestrator", kind: "store.release", payload: { platform: PLATFORM, phased: false }, naturalKey: `${PLATFORM}:${rec.storeBuildId ?? "na"}`, summary: `Release ${v.name}`, rationale: "Approved by App Review" });
    return "releasing";
  }
  if (rec.status === "live") {
    transition(ctx.store, ctx.ports.clock, v, "live_test", "live in test storefronts");
    return "live";
  }
  if (rec.status === "rejected" || rec.status === "metadata_rejected") {
    const reasons = rec.rejectionReasons.join("; ") || "unspecified";
    if (/4\.3|spam|2\.5\.19|5\.6/i.test(reasons)) {
      ctx.outbox.propose({ ventureId: v.id, proposedBy: "orchestrator", kind: "venture.kill", payload: { reason: `App Review: ${reasons}` }, naturalKey: "review-rejection", summary: `Kill ${v.name} after a spam/conduct rejection`, rationale: "Fighting 4.3/5.6 rejections risks the developer account" });
      return `rejected (${reasons}); proposing kill`;
    }
    const decided = ctx.store.tasks.list((t) => t.ventureId === v.id && t.kind === "legal.review" && t.status === "done" && (t.completedAt ?? "") >= rec.updatedAt);
    if (decided.length) return `rejected (${reasons}); human decision recorded`;
    // The live API exposes no guideline numbers, so the human records them; 4.3, 5.6 and 2.5.19 still kill.
    ctx.outbox.openTask(rejectionTask(v, `App Review rejected the submission: ${reasons}.`));
    return `rejected (${reasons}); waiting for a human`;
  }
  // A submission that never reached Apple (declined by the board, or a failed call) must not strand the venture.
  if (rec.status === "ready_to_submit" || rec.status === "draft") {
    const submissions = ctx.store.actions.list((a) => a.ventureId === v.id && a.kind === "store.submit_review" && a.dedupeKey.endsWith(`${PLATFORM}:${rec.storeBuildId ?? ""}`));
    if (submissions.some((a) => OPEN_STATUSES.includes(a.status) || a.status === "executed" || (a.status === "dry_run" && ctx.config.dryRun))) return `in review (${rec.status})`;
    const last = submissions.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)).at(-1);
    if (last?.status === "rejected") {
      const decided = ctx.store.tasks.list((t) => t.ventureId === v.id && t.kind === "legal.review" && t.status === "done" && (t.completedAt ?? "") >= (last.decidedAt ?? last.createdAt));
      if (decided.length) return "submission declined; human decision recorded";
      const note = last.findings.find((f) => f.ruleId === "board.rejected")?.message;
      ctx.outbox.openTask(rejectionTask(v, `The board declined the App Review submission${note ? ` (${note})` : ""}.`));
      return "submission declined by the board; waiting for a human";
    }
    transition(ctx.store, ctx.ports.clock, v, "building", `submission ${last?.status ?? "missing"}; retrying from the pipeline`);
    return "submission did not go through; back to building";
  }
  return `in review (${rec.status})`;
}

function rejectionTask(v: Venture, what: string): HumanTaskDraft {
  return {
    kind: "legal.review",
    ventureId: v.id,
    title: `Decide on ${v.name}'s rejected submission`,
    instructions: `${what}\n\nRead the Resolution Center message, then record the guideline numbers it cites (or "none") and decide whether to fix and resubmit or abandon. Rejections under 4.3, 5.6 or 2.5.19 end the venture whatever the decision: fighting them risks the developer account.`,
    inputs: [
      { key: "decision", label: "resubmit or abandon", pattern: "^(resubmit|abandon)$" },
      { key: "guidelines", label: "Guidelines cited, comma separated (e.g. 2.1, 3.1.2) or none", pattern: GUIDELINES_PATTERN },
    ],
  };
}

/** Guideline ids such as 2.1, 3.1.2 or 4.3(a), comma separated, or "none". */
export const GUIDELINES_PATTERN = "^(none|\\d+(\\.\\d+)*(\\([a-z]\\))?(\\s*,\\s*\\d+(\\.\\d+)*(\\([a-z]\\))?)*)$";
