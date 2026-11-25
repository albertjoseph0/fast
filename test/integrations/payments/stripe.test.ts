import { describe, expect, it } from "vitest";
import type { StoreProductDef, VentureBindings } from "../../../src/core/types.ts";
import { DryRunRecorder } from "../../../src/integrations/http.ts";
import { StripeCheckoutWrite, paymentLinkForm } from "../../../src/integrations/payments/stripe.ts";
import { fakeFetch, forbiddenFetch } from "../apple/fakeFetch.ts";

const API = "https://api.stripe.com";
const bindings = (patch: Partial<VentureBindings> = {}): VentureBindings => ({
  platforms: ["web"],
  publisherAccountIds: {},
  bundleId: "com.fast.astra",
  androidPackage: "com.fast.astra",
  ownedAccountIds: {},
  adAccountIds: {},
  products: [],
  ...patch,
});
const weekly: StoreProductDef = { productId: "astra_weekly", ladderId: "weekly", displayName: "Astra Weekly", period: "week", usdCents: 499, trialDays: 3 } as StoreProductDef;
const yearly: StoreProductDef = { productId: "astra_yearly", ladderId: "yearly", displayName: "Astra Yearly", period: "year", usdCents: 2999, trialDays: 0 } as StoreProductDef;
const form = (body?: string) => Object.fromEntries(new URLSearchParams(body ?? ""));
const SUCCESS = "https://astra.apps.example.com/?checkout={CHECKOUT_SESSION_ID}";

describe("stripe checkout", () => {
  it("omits the trial when a product has none", () => {
    expect(paymentLinkForm({ priceId: "price_1", trialDays: 0, successUrl: SUCCESS, ventureId: "ven_1", productId: "p" })).not.toHaveProperty("subscription_data[trial_period_days]");
    expect(paymentLinkForm({ priceId: "price_1", trialDays: 7, successUrl: SUCCESS, ventureId: "ven_1", productId: "p" })["subscription_data[trial_period_days]"]).toBe("7");
  });

  it("creates a product, a recurring price and a redirecting payment link per ladder entry, idempotently", async () => {
    let n = 0;
    const f = fakeFetch([
      { method: "POST", match: `${API}/v1/products`, json: () => ({ id: `prod_${++n}` }) },
      { method: "POST", match: `${API}/v1/prices`, json: () => ({ id: `price_${++n}` }) },
      { method: "POST", match: `${API}/v1/payment_links`, json: () => ({ id: `plink_${++n}`, url: `https://buy.stripe.com/test_${n}` }) },
    ]);
    const stripe = new StripeCheckoutWrite({ env: { STRIPE_SECRET_KEY: "sk_test_x" }, dryRun: false, fetch: f.fetch });
    const { links } = await stripe.createPaymentLinks({ ventureId: "ven_1", bindings: bindings(), products: [weekly, yearly], successUrl: SUCCESS, currency: "USD" });

    expect(links).toEqual([
      { productId: "astra_weekly", ladderId: "weekly", stripeProductId: "prod_1", priceId: "price_2", linkId: "plink_3", url: "https://buy.stripe.com/test_3" },
      { productId: "astra_yearly", ladderId: "yearly", stripeProductId: "prod_4", priceId: "price_5", linkId: "plink_6", url: "https://buy.stripe.com/test_6" },
    ]);
    expect(f.calls).toHaveLength(6);
    for (const c of f.calls) {
      expect(c.headers.authorization).toBe("Bearer sk_test_x");
      expect(c.headers["content-type"]).toBe("application/x-www-form-urlencoded");
      expect(c.headers["idempotency-key"]).toMatch(/^ven_1-astra_/);
    }
    expect(form(f.calls[1]?.body)).toMatchObject({ product: "prod_1", currency: "usd", unit_amount: "499", "recurring[interval]": "week", lookup_key: "astra_weekly" });
    expect(form(f.calls[2]?.body)).toMatchObject({ "line_items[0][price]": "price_2", "after_completion[type]": "redirect", "after_completion[redirect][url]": SUCCESS, "subscription_data[trial_period_days]": "3" });
    expect(form(f.calls[5]?.body)).not.toHaveProperty("subscription_data[trial_period_days]");
  });

  it("reuses links already bound to the venture", async () => {
    const stripe = new StripeCheckoutWrite({ env: { STRIPE_SECRET_KEY: "sk_test_x" }, dryRun: false, fetch: forbiddenFetch });
    const existing = { url: "https://buy.stripe.com/old", linkId: "plink_old", priceId: "price_old", stripeProductId: "prod_old" };
    const { links } = await stripe.createPaymentLinks({ ventureId: "ven_1", bindings: bindings({ checkoutLinks: { weekly: existing } }), products: [weekly], successUrl: SUCCESS, currency: "usd" });
    expect(links).toEqual([{ productId: "astra_weekly", ladderId: "weekly", ...existing }]);
  });

  it("deactivates links so no new purchases start", async () => {
    const f = fakeFetch([{ method: "POST", match: `${API}/v1/payment_links/`, json: { id: "plink_1", active: false } }]);
    await new StripeCheckoutWrite({ env: { STRIPE_SECRET_KEY: "sk_test_x" }, dryRun: false, fetch: f.fetch }).deactivate({ linkIds: ["plink_1", "plink_2"] });
    expect(f.calls.map((c) => [c.url, form(c.body)])).toEqual([
      [`${API}/v1/payment_links/plink_1`, { active: "false" }],
      [`${API}/v1/payment_links/plink_2`, { active: "false" }],
    ]);
  });

  it("records instead of sending in dry-run, and needs no key there", async () => {
    const recorder = new DryRunRecorder();
    const stripe = new StripeCheckoutWrite({ env: {}, dryRun: true, recorder, fetch: forbiddenFetch });
    const { links } = await stripe.createPaymentLinks({ ventureId: "ven_1", bindings: bindings(), products: [weekly], successUrl: SUCCESS, currency: "usd" });
    expect(links[0]?.url).toMatch(/^https:\/\/buy\.stripe\.com\/dry_/);
    expect(links[0]?.stripeProductId).toMatch(/^prod_dry_/);
    expect(recorder.list().map((r) => new URL(r.url).pathname)).toEqual(["/v1/products", "/v1/prices", "/v1/payment_links"]);
  });

  it("refuses live writes without a secret key", async () => {
    const stripe = new StripeCheckoutWrite({ env: {}, dryRun: false, fetch: forbiddenFetch });
    await expect(stripe.createPaymentLinks({ ventureId: "ven_1", bindings: bindings(), products: [weekly], successUrl: SUCCESS, currency: "usd" })).rejects.toThrow(/STRIPE_SECRET_KEY/);
  });
});
