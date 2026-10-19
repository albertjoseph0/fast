import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../../src/config/schema.ts";
import { SimClock } from "../../../src/core/clock.ts";
import { StudioStore } from "../../../src/core/store.ts";
import type { VentureBindings } from "../../../src/core/types.ts";
import { DryRunRecorder } from "../../../src/integrations/http.ts";
import { LiveMonetizationWrite, storeIdentifier } from "../../../src/integrations/revenuecat/client.ts";
import { fake, noFetch, noSleep } from "../posthog/fakeFetch.ts";

const bindings: VentureBindings = {
  platforms: ["ios", "android"],
  publisherAccountIds: {},
  bundleId: "com.fast.astro",
  androidPackage: "com.fast.astro",
  revenueCatProjectId: "proj1",
  ownedAccountIds: {},
  adAccountIds: {},
  products: [
    { productId: "com.fast.astro.week_699_t3", ladderId: "week_699_t3", platform: "ios", status: "created" },
    { productId: "com.fast.astro.week_699_t3", ladderId: "week_699_t3", platform: "android", status: "created" },
    { productId: "com.fast.astro.year_3999_t0", ladderId: "year_3999_t0", platform: "ios", status: "created" },
  ],
};
const productIds = ["com.fast.astro.week_699_t3", "com.fast.astro.year_3999_t0"];

function setup(f: ReturnType<typeof fake> | null, opts: { dryRun?: boolean; key?: string | null } = {}) {
  const recorder = new DryRunRecorder(null);
  const env: Record<string, string | undefined> = opts.key === null ? {} : { RC_SECRET_KEY: opts.key ?? "sk_test" };
  const port = new LiveMonetizationWrite({
    config: defaultConfig(),
    store: new StudioStore(null, new SimClock()),
    env,
    dryRun: opts.dryRun ?? false,
    recorder,
    fetch: f?.fetch ?? noFetch,
    sleep: noSleep,
  });
  return { port, recorder };
}

const list = (items: unknown[]) => ({ object: "list", items, next_page: null });

describe("RevenueCat store identifiers", () => {
  it("uses the App Store product id and Play's productId:basePlanId", () => {
    expect(storeIdentifier(bindings.products[0]!)).toBe("com.fast.astro.week_699_t3");
    expect(storeIdentifier(bindings.products[1]!)).toBe("com.fast.astro.week_699_t3:week-699-t3");
  });
});

describe("LiveMonetizationWrite.configure", () => {
  it("creates apps, products, entitlement, offering and packages with Bearer auth", async () => {
    let n = 0;
    const id = (prefix: string) => `${prefix}${++n}`;
    const f = fake([
      { method: "GET", match: "/projects/proj1/apps", json: list([]) },
      { method: "POST", match: "/projects/proj1/apps", json: (c) => ({ id: id("app"), ...c.json }) },
      { method: "GET", match: "/projects/proj1/products", json: list([]) },
      { method: "POST", match: "/projects/proj1/products", json: (c) => ({ id: id("prod"), ...c.json }) },
      { method: "GET", match: "/projects/proj1/entitlements", json: list([]) },
      { method: "POST", match: /\/entitlements\/[^/]+\/actions\/attach_products/, json: {} },
      { method: "POST", match: "/projects/proj1/entitlements", json: (c) => ({ id: "entl1", ...c.json }) },
      { method: "GET", match: "/projects/proj1/offerings/ofr1/packages", json: list([]) },
      { method: "GET", match: "/projects/proj1/offerings", json: list([]) },
      { method: "POST", match: "/projects/proj1/offerings/ofr1/packages", json: (c) => ({ id: id("pkg"), ...c.json }) },
      { method: "POST", match: /\/offerings\/ofr1$/, json: { id: "ofr1", is_current: true } },
      { method: "POST", match: "/projects/proj1/offerings", json: (c) => ({ id: "ofr1", is_current: false, ...c.json }) },
      { method: "POST", match: /\/packages\/[^/]+\/actions\/attach_products/, json: {} },
    ]);
    const { port } = setup(f);
    const out = await port.configure({ bindings, productIds, entitlementId: "pro" });
    expect(out).toEqual({ offeringIds: { default: "ofr1" } });
    expect(f.calls.every((c) => c.headers.authorization === "Bearer sk_test")).toBe(true);
    expect(f.calls.every((c) => c.url.startsWith("https://api.revenuecat.com/v2/"))).toBe(true);

    const posts = f.writes().map((c) => [new URL(c.url).pathname, c.json]);
    expect(posts).toContainEqual(["/v2/projects/proj1/apps", { name: "com.fast.astro (ios)", type: "app_store", app_store: { bundle_id: "com.fast.astro" } }]);
    expect(posts).toContainEqual(["/v2/projects/proj1/apps", { name: "com.fast.astro (android)", type: "play_store", play_store: { package_name: "com.fast.astro" } }]);
    expect(posts).toContainEqual([
      "/v2/projects/proj1/products",
      { store_identifier: "com.fast.astro.week_699_t3:week-699-t3", app_id: "app4", type: "subscription", display_name: "week_699_t3" },
    ]);
    expect(posts).toContainEqual(["/v2/projects/proj1/entitlements", { lookup_key: "pro", display_name: "pro" }]);
    const attach = posts.find(([p]) => String(p).endsWith("/entitlements/entl1/actions/attach_products"));
    expect((attach?.[1] as { product_ids: string[] }).product_ids).toHaveLength(3);
    expect(posts).toContainEqual(["/v2/projects/proj1/offerings", { lookup_key: "default", display_name: "Default" }]);
    expect(posts).toContainEqual(["/v2/projects/proj1/offerings/ofr1", { is_current: true }]);
    const pkgs = posts.filter(([p]) => p === "/v2/projects/proj1/offerings/ofr1/packages").map(([, b]) => b);
    expect(pkgs).toEqual([
      { lookup_key: "week_699_t3", display_name: "week_699_t3", position: 1 },
      { lookup_key: "year_3999_t0", display_name: "year_3999_t0", position: 2 },
    ]);
    const weekly = posts.find(([p, b]) => String(p).includes("/actions/attach_products") && String(p).includes("/packages/") && (b as { products: unknown[] }).products.length === 2);
    expect((weekly?.[1] as { products: { eligibility_criteria: string }[] }).products.every((x) => x.eligibility_criteria === "all")).toBe(true);
  });

  it("only adds what is missing on a re-run", async () => {
    const f = fake([
      { method: "GET", match: "/projects/proj1/apps", json: list([{ id: "appI", type: "app_store", app_store: { bundle_id: "com.fast.astro" } }, { id: "appA", type: "play_store", play_store: { package_name: "com.fast.astro" } }]) },
      {
        method: "GET",
        match: "/projects/proj1/products",
        json: list([
          { id: "p1", store_identifier: "com.fast.astro.week_699_t3", app_id: "appI", type: "subscription" },
          { id: "p2", store_identifier: "com.fast.astro.week_699_t3:week-699-t3", app_id: "appA", type: "subscription" },
          { id: "p3", store_identifier: "com.fast.astro.year_3999_t0", app_id: "appI", type: "subscription" },
        ]),
      },
      { method: "GET", match: "/projects/proj1/entitlements", json: list([{ id: "e1", lookup_key: "pro", products: { items: [{ id: "p1" }, { id: "p2" }, { id: "p3" }] } }]) },
      { method: "GET", match: "/offerings/o1/packages", json: list([{ id: "k1", lookup_key: "week_699_t3", products: { items: [{ product: { id: "p1" } }, { product: { id: "p2" } }] } }]) },
      { method: "GET", match: "/projects/proj1/offerings", json: list([{ id: "o1", lookup_key: "default", is_current: true }]) },
      { method: "POST", match: "/offerings/o1/packages", json: { id: "k2", lookup_key: "year_3999_t0" } },
      { method: "POST", match: "/packages/k2/actions/attach_products", json: {} },
    ]);
    const { port } = setup(f);
    expect(await port.configure({ bindings, productIds, entitlementId: "pro" })).toEqual({ offeringIds: { default: "o1" } });
    expect(f.writes().map((c) => new URL(c.url).pathname)).toEqual(["/v2/projects/proj1/offerings/o1/packages", "/v2/projects/proj1/packages/k2/actions/attach_products"]);
    expect(f.writes()[1]?.json).toEqual({ products: [{ product_id: "p3", eligibility_criteria: "all" }] });
  });

  it("dry-run records every write without calling fetch for it and returns dry_ ids", async () => {
    const f = fake([
      { method: "GET", match: "/apps", json: list([]) },
      { method: "GET", match: "/products", json: list([]) },
      { method: "GET", match: "/entitlements", json: list([]) },
      { method: "GET", match: "/offerings", json: list([]) },
    ]);
    const { port, recorder } = setup(f, { dryRun: true });
    const out = await port.configure({ bindings, productIds, entitlementId: "pro" });
    expect(out.offeringIds.default).toMatch(/^dry_rc_/);
    expect(f.writes()).toHaveLength(0);
    expect(recorder.list().length).toBeGreaterThan(8);
    expect(recorder.list().every((r) => r.service === "revenuecat" && r.headers.authorization === "<redacted>")).toBe(true);
  });

  it("dry-run without a key works offline", async () => {
    const { port, recorder } = setup(null, { dryRun: true, key: null });
    const out = await port.configure({ bindings, productIds, entitlementId: "pro" });
    expect(out.offeringIds.default).toMatch(/^dry_/);
    expect(recorder.list().length).toBeGreaterThan(0);
  });

  it("refuses products that are not bound to the venture and a missing project", async () => {
    const { port } = setup(fake());
    await expect(port.configure({ bindings, productIds: ["com.other.x"], entitlementId: "pro" })).rejects.toThrow(/not bound/);
    await expect(port.configure({ bindings: { ...bindings, revenueCatProjectId: undefined }, productIds, entitlementId: "pro" })).rejects.toThrow(/revenueCatProjectId/);
  });

  it("revenueOverview reads the overview metrics", async () => {
    const f = fake([
      {
        method: "GET",
        match: "/projects/proj1/metrics/overview",
        json: { object: "overview_metrics", currency: "USD", metrics: [{ id: "mrr", name: "MRR", unit: "$", period: "P28D", value: 123.45 }, { id: "active_trials", name: "Active Trials", unit: "#", period: "P0D", value: 7 }] },
      },
    ]);
    const { port } = setup(f);
    expect(await port.revenueOverview("proj1")).toEqual({ values: { mrr: 123.45, active_trials: 7 }, cents: { mrr: 12345 } });
    expect(f.calls[0]?.url).toBe("https://api.revenuecat.com/v2/projects/proj1/metrics/overview?currency=USD");
  });
});
