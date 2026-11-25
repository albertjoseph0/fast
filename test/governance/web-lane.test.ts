import { describe, expect, it } from "vitest";
import type { StoreProductDef, Venture } from "../../src/core/types.ts";
import { Executor } from "../../src/governance/executor.ts";
import { fakeWrite, input, makeVenture, makeWorld, type World } from "./fixtures.ts";

function webVenture(patch: Partial<Venture> = {}): Venture {
  const base = makeVenture();
  return makeVenture({ stage: "building", stores: [], bindings: { ...base.bindings, platforms: ["web"], products: [] }, ...patch });
}
function world(): World {
  const w = makeWorld();
  w.store.ventures.put(webVenture());
  return w;
}
function run(w: World, write = fakeWrite()) {
  return { write, done: new Executor({ store: w.store, config: w.config, clock: w.clock, write, ledger: w.ledger, governance: w.gov, dryRun: false, killSwitchPath: null }).runApproved() };
}
const product = (patch: Partial<StoreProductDef> = {}): StoreProductDef => ({
  productId: "com.faststudio.astra.week_699_t3",
  ladderId: "week_699_t3",
  period: "week",
  usdCents: 699,
  trialDays: 3,
  displayName: "Astra Weekly",
  territories: [],
  ...patch,
});
const deployInput = (territories = ["CA", "NZ"], naturalKey = "web:v1") =>
  input("web.deploy_app", { host: "astra.apps.example.com", files: [{ path: "index.html", localPath: "/tmp/x/index.html" }], territories, specVersion: 1, version: "1.0.0" }, { naturalKey });
const ruleHits = (w: World, id: string) => w.store.governanceActions().list().flatMap((a) => a.findings.filter((f) => f.ruleId === id).map((f) => f.severity));

describe("web lane policy", () => {
  it("holds the first public deploy for the board, not later ones", async () => {
    const w = world();
    const first = w.gov.propose(deployInput());
    expect(first.findings.map((f) => f.ruleId)).toContain("web.first_launch");
    expect(first.status).toBe("awaiting_approval");
    w.gov.approve(first.id, "owner");
    await run(w).done;
    const second = w.gov.propose(deployInput(["CA", "NZ"], "web:v2"));
    expect(second.findings.filter((f) => f.ruleId === "web.first_launch")).toEqual([]);
  });

  it("geofences deploys like store territories", () => {
    const w = world();
    const a = w.gov.propose(deployInput(["CA", "US"]));
    expect(a.findings.filter((f) => f.ruleId === "store.territories").map((f) => f.severity)).toEqual(["needs_human"]);
  });

  it("only sells ladder prices inside the grid with allowed trials", () => {
    const w = world();
    const checkout = (products: StoreProductDef[]) => w.gov.propose(input("web.setup_checkout", { products, successUrl: "https://astra.apps.example.com/?checkout={CHECKOUT_SESSION_ID}" }, { naturalKey: `web:${Math.random()}` }));
    expect(checkout([product()]).findings).toEqual([]);
    expect(checkout([]).findings.map((f) => f.severity)).toEqual(["block"]);
    expect(checkout([product({ usdCents: 1999 })]).findings.map((f) => f.message).join(" ")).toMatch(/does not match.*outside the week grid/);
    expect(checkout([product({ trialDays: 14 })]).findings.map((f) => f.message).join(" ")).toMatch(/does not match/);
    expect(checkout([product({ ladderId: "nope" })]).findings.map((f) => f.message).join(" ")).toMatch(/no price-ladder entry/);
    expect(ruleHits(w, "web.checkout_prices").every((s) => s === "block")).toBe(true);
  });
});

describe("web lane execution", () => {
  it("stores payment links and marks the web products approved", async () => {
    const w = world();
    w.gov.propose(input("web.setup_checkout", { products: [product()], successUrl: "https://astra.apps.example.com/?checkout={CHECKOUT_SESSION_ID}" }));
    const { done } = run(w);
    expect((await done)[0]).toMatchObject({ status: "executed" });
    const v = w.store.ventures.require("ven_000001");
    expect(v.bindings.checkoutLinks?.week_699_t3).toEqual({ url: "https://buy.stripe.com/test_0", linkId: "plink_0", priceId: "price_0", stripeProductId: "prod_0" });
    expect(v.bindings.products).toContainEqual(expect.objectContaining({ ladderId: "week_699_t3", platform: "web", status: "approved" }));
  });

  it("deploys, then moves territories by redeploying and stops sales by deactivating links", async () => {
    const w = world();
    const write = fakeWrite();
    const first = w.gov.propose(deployInput());
    w.gov.approve(first.id, "owner");
    await run(w, write).done;
    let v = w.store.ventures.require("ven_000001");
    expect(v.bindings.webAppUrl).toBe("https://astra.apps.example.com");
    expect(v.stores.find((s) => s.platform === "web")).toMatchObject({ status: "live", territories: ["CA", "NZ"], versionString: "1.0.0", appId: "astra.apps.example.com" });

    const widen = w.gov.propose(input("store.set_territories", { platform: "web", territories: ["CA", "NZ", "AU"] }, { naturalKey: "web:CA,NZ,AU" }));
    if (widen.status === "awaiting_approval") w.gov.approve(widen.id, "owner");
    await run(w, write).done;
    expect(write.webApp.deployApp).toHaveBeenLastCalledWith(expect.objectContaining({ host: "astra.apps.example.com", territories: ["CA", "NZ", "AU"] }));
    expect(w.store.ventures.require("ven_000001").stores.find((s) => s.platform === "web")?.territories).toEqual(["CA", "NZ", "AU"]);

    w.store.ventures.put({ ...w.store.ventures.require("ven_000001"), bindings: { ...w.store.ventures.require("ven_000001").bindings, checkoutLinks: { week_699_t3: { url: "u", linkId: "plink_9", priceId: "p", stripeProductId: "s" } } } });
    const stop = w.gov.propose(input("store.remove_from_sale", { platform: "web", reason: "killed" }));
    if (stop.status === "awaiting_approval") w.gov.approve(stop.id, "owner");
    await run(w, write).done;
    expect(write.checkout.deactivate).toHaveBeenCalledWith({ linkIds: ["plink_9"] });
    v = w.store.ventures.require("ven_000001");
    expect(v.stores.find((s) => s.platform === "web")?.status).toBe("removed");
  });
});
