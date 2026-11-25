/**
 * Web-lane build-and-ship: spec → Stripe checkout → render → tenant → paywall products →
 * deploy to <slug>.<web.appsDomain>, geofenced to the test geos → live_test.
 *
 * No binary, no store record created by a human, no App Review: what takes days on iOS is one
 * deploy, so an idea reaches its first test cell the day its integrations are bound (P1: more
 * shots; P4: still only the test geos). The human steps left are the PostHog/RevenueCat binding
 * (once per venture), the backend tenant and the board's approval of the first public deploy.
 *
 * Like the iOS pipeline it re-derives the next missing step from state every tick and proposes
 * at most one action, waiting while any of the venture's actions is open.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TickContext } from "../core/context.ts";
import type { BakedBinding, Venture } from "../core/types.ts";
import { webDeployFiles } from "../builder/webapp.ts";
import { testGeosFor } from "../lab/audiences.ts";
import { storeProductDefs } from "../playbook/product.ts";
import type { StudioDeps } from "./deps.ts";
import { patch, transition } from "./lifecycle.ts";
import { domainsFor, done, ensureSpec, ensureTask, ensureTaskFor, ideaFor, openActions, specReviewPending } from "./pipeline.ts";

/** The host a venture's web app is served at. */
export function webHost(v: Venture, appsDomain: string): string {
  return `${v.slug}.${appsDomain.replace(/^\.+|\/+$/g, "")}`.toLowerCase();
}

/** Bindings a web render bakes into config.json: a change re-renders (and so redeploys). */
function bakedWebBindings(v: Venture): Partial<Record<BakedBinding, string>> {
  const out: Partial<Record<BakedBinding, string>> = {};
  if (v.bindings.backendUrl) out.backendUrl = v.bindings.backendUrl;
  if (v.bindings.posthogPublicKey) out.posthogPublicKey = v.bindings.posthogPublicKey;
  const links = v.bindings.checkoutLinks;
  if (links && Object.keys(links).length) {
    const canonical = Object.keys(links)
      .sort()
      .map((k) => `${k}=${links[k]?.url ?? ""}`)
      .join("\n");
    out.checkoutLinks = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  }
  return out;
}

function tenantPath(deps: StudioDeps, v: Venture): string {
  return join(deps.outRoot, v.slug, "web-server", "tenants", `${v.slug}.json`);
}

function tenantMarker(deps: StudioDeps, v: Venture): string {
  const path = tenantPath(deps, v);
  return `tenant ${existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 12) : `v${v.specVersion}`}`;
}

/** One pipeline step per tick at most; returns a short status for the report. */
export async function advanceBuildingWeb(ctx: TickContext, deps: StudioDeps, venture: Venture): Promise<string> {
  const specced = await ensureSpec(ctx, deps, venture);
  if (!specced) return "killed during build";
  let v = specced;
  const spec = v.spec as NonNullable<Venture["spec"]>;
  const clock = ctx.ports.clock;
  if (!v.bindings.backendUrl) return "waiting for the verdict backend (backend.deploy)";
  if (openActions(ctx, v, "web.").length || openActions(ctx, v, "store.").length || openActions(ctx, v, "monetization.").length) return "waiting on open web actions";

  const propose = ctx.outbox.propose.bind(ctx.outbox);
  const base = { ventureId: v.id, proposedBy: "orchestrator" as const };
  const host = webHost(v, ctx.config.web.appsDomain);
  const rec = v.stores.find((s) => s.platform === "web");
  const testGeos = testGeosFor(spec.locale, ctx.config);
  // The PostHog and RevenueCat projects open as a human task right away; checkout needs neither.
  const bound = ensureTask(ctx, v, "integrations.bind_web_projects", `${spec.appName} (${v.slug})`) && Boolean(v.bindings.posthogPublicKey && v.bindings.revenueCatProjectId);

  // 1. Prices: one Stripe product, price and payment link per ladder entry (all up front, so
  //    paywall tests never need a new price).
  const ladderIds = ctx.config.monetization.ladder.map((e) => e.id);
  if (ladderIds.some((id) => !v.bindings.checkoutLinks?.[id])) {
    propose({
      ...base,
      kind: "web.setup_checkout",
      payload: { products: storeProductDefs(ctx.config, v.bindings.bundleId, testGeos), successUrl: `https://${host}/?checkout={CHECKOUT_SESSION_ID}` },
      naturalKey: `web:${ladderIds.join("-")}`,
      summary: `Create Stripe checkout for ${spec.appName}`,
      rationale: "Web checkout replaces in-app purchase; the whole price ladder exists up front",
    });
    return "creating checkout";
  }
  if (!bound) return "waiting for PostHog/RevenueCat projects (integrations.bind_web_projects)";

  // 2. Render whenever the spec or a baked binding changed since the last render.
  const baked = bakedWebBindings(v);
  if (!v.build || v.build.specVersion !== v.specVersion || JSON.stringify(v.build.baked ?? {}) !== JSON.stringify(baked)) {
    const record = deps.renderWebApp({
      venture: v,
      spec,
      idea: ideaFor(ctx, v),
      config: ctx.config,
      domains: domainsFor(ctx, v),
      outRoot: deps.outRoot,
      templateDir: deps.templateDir,
      builtAt: clock.iso(),
    });
    const failed = record.checks.filter((c) => !c.passed);
    if (failed.length) {
      transition(ctx.store, clock, v, "killed", `web build checks failed: ${failed.map((c) => `${c.name} (${c.detail})`).join(", ")}`);
      return "killed during build";
    }
    const { files: _files, ...rendered } = record;
    v = patch(ctx.store, clock, v, { build: { ...rendered, baked } });
  }
  const build = v.build as NonNullable<Venture["build"]>;

  // 3. RevenueCat: the entitlement and offering over the Stripe products, so web purchases unlock
  //    the same entitlement the backend already checks.
  if (!done(ctx, v, "monetization.configure", "web")) {
    const productIds = v.bindings.products.filter((p) => p.platform === "web").map((p) => p.productId);
    propose({ ...base, kind: "monetization.configure", payload: { productIds, entitlementId: ctx.config.monetization.entitlementId }, naturalKey: "web", summary: `Configure web paywall products for ${spec.appName}`, rationale: "Stripe purchases grant the entitlement through RevenueCat" });
    return "configuring monetization";
  }

  // 4. Human gates that cannot be automated away: the backend serves this tenant, and copy the
  //    linter could not clear has been read by a person.
  const waiting = [
    ensureTaskFor(ctx, v, "backend.add_tenant", tenantMarker(deps, v), `Tenant file: ${tenantPath(deps, v)}; backend ${v.bindings.backendUrl}. Set the env var named in revenueCatStripeKeyEnv to the RevenueCat Stripe app's public key, and WEB_ORIGIN_SUFFIX to .${ctx.config.web.appsDomain}.`) ? null : "verdict backend tenant",
    specReviewPending(ctx, v, domainsFor(ctx, v)),
  ].filter(Boolean);
  if (waiting.length) return `waiting for ${waiting.join(", ")}`;

  // 5. Deploy (the first public deploy waits for the board). A redeploy of a new spec version keeps
  //    the territories the app already has (a scaled app stays scaled).
  if (!(rec?.status === "live" && rec.versionString === build.version)) {
    if (done(ctx, v, "web.deploy_app", `web:v${v.specVersion}`) && rec?.status === "live") return "deploy recorded; waiting for the web record";
    const territories = rec?.status === "live" && rec.territories.length ? rec.territories : testGeos;
    propose({
      ...base,
      kind: "web.deploy_app",
      payload: { host, files: webDeployFiles(build.projectDir), territories, specVersion: v.specVersion, version: build.version },
      naturalKey: `web:v${v.specVersion}`,
      summary: `Deploy ${spec.appName} ${build.version} to ${host} (${territories.join(", ")})`,
      rationale: "Web lane: no store review; geofenced to the test geos (Bier P4)",
    });
    return "deploying";
  }
  transition(ctx.store, clock, v, "live_test", `web app live at https://${host} in ${rec.territories.join(", ")}`);
  return "live";
}
