import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderWebApp, webDeployFiles, webTermsLine } from "../../src/builder/index.ts";
import type { AppSpec, VentureBindings } from "../../src/core/types.ts";
import { astra, astraSpec, config, tempDir, TEMPLATE_DIR, venture } from "./fixtures.ts";
// @ts-expect-error plain JS module shipped to browsers
import { allowedGeo, attributionFrom, checkoutSessionFrom, checkoutUrl, newUserId } from "../../templates/web-app/app.js";
// @ts-expect-error plain JS module shipped to browsers
import geo from "../../templates/web-app/api/geo.js";

const links = Object.fromEntries(
  config.monetization.ladder.map((e) => [e.id, { url: `https://buy.stripe.com/test_${e.id}`, linkId: `plink_${e.id}`, priceId: `price_${e.id}`, stripeProductId: `prod_${e.id}` }]),
);

function render(bindings: Partial<VentureBindings> = {}, spec: AppSpec = astraSpec()) {
  const outRoot = tempDir();
  const base = venture(spec);
  const v = venture(spec, { bindings: { ...base.bindings, platforms: ["web"], webAppUrl: "https://astra.apps.example.com", posthogPublicKey: "phc_test", checkoutLinks: links, ...bindings } });
  const record = renderWebApp({ venture: v, spec, idea: astra(), config, domains: ["astrology_fortune"], outRoot, templateDir: TEMPLATE_DIR });
  return { record, root: join(outRoot, v.slug) };
}
const failed = (r: { checks: { name: string; passed: boolean }[] }) => r.checks.filter((c) => !c.passed).map((c) => c.name);
const read = (p: string) => readFileSync(p, "utf8");

describe("renderWebApp", () => {
  it("renders a deployable app with config, legal pages and a tenant, and passes its checks", () => {
    const { record, root } = render();
    expect(record.projectDir).toBe(join(root, "web"));
    expect(failed(record)).toEqual([]);
    const cfg = JSON.parse(read(join(record.projectDir, "config.json")));
    expect(cfg).toMatchObject({ slug: "astra", backendUrl: "https://verdict.faststudio.example", posthog: { key: "phc_test" } });
    expect(cfg.products.length).toBeGreaterThan(0);
    expect(cfg.paywall.bullets.join(" ")).not.toContain("in Settings");
    for (const p of cfg.products) expect(p.checkoutUrl).toBe(links[p.ladderId]?.url);
    expect(JSON.stringify(cfg)).not.toContain(astraSpec().core.aiSystemPrompt);
    const tenant = JSON.parse(read(join(root, "web-server", "tenants", "astra.json")));
    expect(tenant.revenueCatStripeKeyEnv).toBe("REVENUECAT_STRIPE_KEY_ASTRA");
    expect(existsSync(join(record.projectDir, "geo.json"))).toBe(false);
    expect(webDeployFiles(record.projectDir).map((f) => f.path)).toEqual(expect.arrayContaining(["index.html", "app.js", "api/geo.js", "vercel.json", "terms.html"]));
  });

  it("words billing for Stripe, not the App Store", () => {
    const { record } = render();
    const terms = read(join(record.projectDir, "terms.html"));
    expect(terms).not.toMatch(/Apple|Google Play|in Settings/);
    expect(terms).toContain("processed by Stripe");
    expect(read(join(record.projectDir, "privacy.html"))).toContain("Payments on the web");
    const entry = config.monetization.ladder[0]!;
    expect(webTermsLine(entry, "usd")).toContain("receipt email");
  });

  it("fails its checks without payment links or a backend", () => {
    expect(failed(render({ checkoutLinks: {} }).record)).toContain("checkout_links");
    expect(failed(render({ backendUrl: undefined as unknown as string }).record)).toContain("backend_url");
  });
});

describe("web app runtime helpers", () => {
  it("tags payment links with the user and reads the returned session", () => {
    expect(checkoutUrl("https://buy.stripe.com/test_1?prefilled_email=a", "web_ab")).toBe("https://buy.stripe.com/test_1?prefilled_email=a&client_reference_id=web_ab");
    expect(checkoutSessionFrom("?checkout=cs_test_a1B2")).toBe("cs_test_a1B2");
    expect(checkoutSessionFrom("?checkout={CHECKOUT_SESSION_ID}")).toBeNull();
    expect(checkoutSessionFrom("?checkout=pi_123")).toBeNull();
  });

  it("geofences by territory and keeps first-touch attribution short", () => {
    expect(allowedGeo("nz", ["NZ", "CA"])).toBe(true);
    expect(allowedGeo("US", ["NZ"])).toBe(false);
    expect(allowedGeo(null, ["NZ"])).toBe(false);
    expect(attributionFrom("?utm_source=tiktok&ref=maya&x=1", "https://www.tiktok.com/@maya")).toEqual({ utm_source: "tiktok", ref: "maya", referrer_host: "www.tiktok.com" });
    expect(newUserId(() => new Uint8Array(16).fill(171))).toBe(`web_${"ab".repeat(16)}`);
  });

  it("answers the visitor's country from the edge header without storing it", () => {
    const headers: Record<string, string> = {};
    let body: unknown;
    const res = { setHeader: (k: string, v: string) => void (headers[k] = v), status: () => ({ json: (b: unknown) => void (body = b) }) };
    geo({ headers: { "x-vercel-ip-country": "nz" } }, res);
    expect(body).toEqual({ country: "NZ" });
    expect(headers["cache-control"]).toBe("private, no-store");
  });
});
