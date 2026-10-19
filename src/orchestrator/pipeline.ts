/**
 * Build-and-ship pipeline for a venture: spec → render → icon → web/legal → bundle →
 * app record (human on iOS) → subscriptions → build → upload → listing → territories →
 * monetization → App Review → release.
 *
 * Every tick re-derives the next missing step from state and proposes it through the
 * outbox. Dedupe keys make re-proposals no-ops, and the pipeline waits while any of
 * the venture's store actions is still open, so steps never race each other.
 */
import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { TickContext } from "../core/context.ts";
import type { Action, HumanTask, Idea, SubmissionChangeArea, Venture } from "../core/types.ts";
import { OPEN_STATUSES } from "../governance/outbox.ts";
import { testGeosFor } from "../lab/audiences.ts";
import { storeProductDefs } from "../playbook/product.ts";
import { taskDraft } from "../playbook/setup.ts";
import { effectiveDomains } from "../principles/sensitivity.ts";
import { latestJob, patch, transition } from "./lifecycle.ts";
import type { StudioDeps } from "./deps.ts";

const PLATFORM = "ios" as const;

function openActions(ctx: TickContext, v: Venture, prefix: string): Action[] {
  return ctx.store.actions.list((a) => a.ventureId === v.id && a.kind.startsWith(prefix) && OPEN_STATUSES.includes(a.status));
}

function done(ctx: TickContext, v: Venture, kind: Action["kind"], naturalSuffix?: string): boolean {
  return ctx.store.actions.list(
    (a) => a.ventureId === v.id && a.kind === kind && (a.status === "executed" || a.status === "dry_run") && (naturalSuffix === undefined || a.dedupeKey.endsWith(naturalSuffix)),
  ).length > 0;
}

function taskDone(ctx: TickContext, kind: HumanTask["kind"], ventureId?: string): boolean {
  return ctx.store.tasks.count((t) => t.kind === kind && t.status === "done" && (ventureId === undefined || t.ventureId === ventureId)) > 0;
}

function storeRecord(v: Venture) {
  return v.stores.find((s) => s.platform === PLATFORM);
}

export function ideaFor(ctx: TickContext, v: Venture): Idea {
  return ctx.store.ideas.require(v.ideaId).idea;
}

function domainsFor(ctx: TickContext, v: Venture) {
  const screening = ctx.store.screenings.get(v.screeningId);
  return screening?.sensitiveDomains ?? effectiveDomains(ideaFor(ctx, v), []);
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
  // Re-render for a new spec version, and once after the site is published so the app links to it.
  const staleUrls = v.build !== undefined && v.bindings.webBaseUrl !== undefined && v.build.webBaseUrl !== v.bindings.webBaseUrl && !v.build.easBuildId;
  if (!v.build || v.build.specVersion !== v.specVersion || staleUrls) {
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
    const build = { ...rendered, ...(v.bindings.webBaseUrl ? { webBaseUrl: v.bindings.webBaseUrl } : {}) };
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
  const buildJob = latestJob(ctx.store, v.id, "store.build");
  if (!build.easBuildId) {
    if (!buildJob || buildJob.status === "failed") {
      propose({ ...base, kind: "store.start_build", payload: { platform: PLATFORM, projectDir: build.projectDir, specVersion: v.specVersion }, naturalKey: `${PLATFORM}:v${v.specVersion}:${buildJob?.id ?? "first"}`, summary: `Build ${spec.appName} v${build.version}`, rationale: "Compile the rendered project" });
      return "starting build";
    }
    return "build running";
  }
  if (!rec?.storeBuildId) {
    if (rec?.status !== "build_processing") {
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
    propose({ ...base, kind: "monetization.configure", payload: { productIds: v.bindings.products.map((p) => p.productId), entitlementId: ctx.config.monetization.entitlementId }, naturalKey: "initial", summary: `Configure paywall products for ${spec.appName}`, rationale: "Entitlements and offerings for the price ladder" });
    return "configuring monetization";
  }
  if (!taskDone(ctx, "apple.privacy_labels", v.id)) {
    if (!ctx.store.tasks.count((t) => t.kind === "apple.privacy_labels" && t.ventureId === v.id && t.status === "open")) {
      const inventory = spec.compliance.dataInventory.map((d) => `${d.dataType} → ${d.purpose} (${d.sentTo.join(", ")})`).join("; ");
      ctx.outbox.openTask(taskDraft("apple.privacy_labels", v.id, `Data inventory for ${spec.appName}: ${inventory}. Privacy policy: ${v.bindings.privacyUrl ?? "pending"}.`));
    }
    return "waiting for App Privacy labels";
  }
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
    if (!v.blockedOn.length) {
      const task = ctx.outbox.openTask({
        kind: "legal.review",
        ventureId: v.id,
        title: `App Review rejected ${v.name}`,
        instructions: `App Review rejected the submission: ${reasons}.\n\nRead the Resolution Center message, decide whether to fix and resubmit or abandon, then mark this task done with decision "resubmit" or "abandon".`,
        inputs: [{ key: "decision", label: "resubmit or abandon", pattern: "^(resubmit|abandon)$" }],
      });
      patch(ctx.store, ctx.ports.clock, v, { blockedOn: [task.id] });
    }
    return `rejected (${reasons}); waiting for a human`;
  }
  return `in review (${rec.status})`;
}
