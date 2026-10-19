import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { joinKeywords, METADATA_LIMITS, pngInfo, renderApp, SCREENSHOT_SIZE, type StudioJson, type TenantJson } from "../../src/builder/index.ts";
import type { AppSpec, BuildRecord } from "../../src/core/types.ts";
import { productIdFor } from "../../src/playbook/product.ts";
import { SAFETY_PREAMBLE } from "../../src/playbook/safety.ts";
import { astra, astraSpec, config, tempDir, TEMPLATE_DIR, venture } from "./fixtures.ts";

type Rendered = BuildRecord & { files: string[] };

function render(spec: AppSpec = astraSpec(), opts: { outRoot?: string; templateDir?: string; v?: Parameters<typeof venture>[1] } = {}): Rendered & { root: string } {
  const outRoot = opts.outRoot ?? tempDir();
  const v = venture(spec, opts.v);
  const record = renderApp({ venture: v, spec, idea: astra(), config, domains: ["astrology_fortune"], outRoot, templateDir: opts.templateDir ?? TEMPLATE_DIR });
  return { ...record, root: join(outRoot, v.slug) };
}

const read = (path: string) => readFileSync(path, "utf8");
const failed = (r: Rendered) => r.checks.filter((c) => !c.passed).map((c) => c.name);

describe("renderApp", () => {
  let r: Rendered & { root: string };
  beforeAll(() => {
    r = render();
  });

  it("renders into <outRoot>/<slug>/app with a passing build record", () => {
    expect(r.projectDir).toBe(join(r.root, "app"));
    expect(failed(r)).toEqual([]);
    expect(r.checks.map((c) => c.name)).toEqual(
      expect.arrayContaining(["spec_schema", "spec_lint", "metadata_limits", "bundle_id_format", "required_files", "screenshots", "no_tracking"]),
    );
    expect(r).toMatchObject({ version: "1.0.0", buildNumber: 1, specVersion: 1, builtAt: "2026-10-18T09:30:00.000Z" });
    expect(r.files.every((f) => f.startsWith(r.root) && existsSync(f))).toBe(true);
  });

  it("derives version and build number from the spec version", () => {
    const again = render(astraSpec(), { v: { specVersion: 3 } });
    expect(again).toMatchObject({ version: "1.2.0", buildNumber: 3, specVersion: 3 });
    expect((JSON.parse(read(join(again.projectDir, "studio.json"))) as StudioJson).buildNumber).toBe(3);
  });

  it("writes spec.json and studio.json with identity, URLs, products and env var names only", () => {
    expect(JSON.parse(read(join(r.projectDir, "spec.json")))).toEqual(astraSpec());
    const studio = JSON.parse(read(join(r.projectDir, "studio.json"))) as StudioJson;
    expect(studio).toMatchObject({
      slug: "astra",
      bundleId: "com.faststudio.astra",
      androidPackage: "com.faststudio.astra",
      deepLinkDomain: "astra.faststudio.example",
      backendUrl: "https://verdict.faststudio.example",
      appleTeamId: "<TEAM_ID>",
      urls: { privacy: "https://faststudio.example/astra/privacy", terms: "https://faststudio.example/astra/terms", support: "https://faststudio.example/astra/support" },
      entitlementId: "pro",
    });
    expect(studio.env.posthogApiKey).toMatch(/^EXPO_PUBLIC_[A-Z_]+$/);
    expect(studio.products).toHaveLength(config.monetization.ladder.length);
    expect(studio.products.find((p) => p.ladderId === "week_699_t3")?.productId).toBe(productIdFor("com.faststudio.astra", "week_699_t3"));
    expect(studio.aiProviders.map((p) => p.id)).toEqual(["anthropic", "studio_backend"]);
    expect(studio.privacyManifest.NSPrivacyTracking).toBe(false);
  });

  it("writes a tenant with the safety preamble before the product prompt", () => {
    const tenant = JSON.parse(read(join(r.projectDir, "server", "tenants", "astra.json"))) as TenantJson;
    const prompt = tenant.systemPrompt;
    expect(prompt.startsWith(SAFETY_PREAMBLE.default)).toBe(true);
    const product = prompt.indexOf(astraSpec().core.aiSystemPrompt);
    expect(product).toBeGreaterThan(prompt.indexOf(SAFETY_PREAMBLE.astrology_fortune));
    expect(prompt.indexOf(SAFETY_PREAMBLE.astrology_fortune)).toBeGreaterThan(0);
    expect(tenant).toMatchObject({ slug: "astra", model: "claude-opus-5-5", effort: "low", freeUses: 0, outputSections: ["Sun", "Moon", "Rising"], entitlementId: "pro" });
    expect(tenant.revenueCatSecretEnv).toBe("REVENUECAT_SECRET_KEY_ASTRA");
  });

  it("writes store metadata within App Store Connect limits", () => {
    const dir = join(r.root, "store", "metadata", "en-US");
    expect(readdirSync(dir).sort()).toEqual(
      ["description", "keywords", "marketing_url", "name", "privacy_url", "promotional_text", "subtitle", "support_url"].map((n) => `${n}.txt`),
    );
    for (const [field, max] of Object.entries(METADATA_LIMITS)) expect(read(join(dir, `${field}.txt`)).trim().length).toBeLessThanOrEqual(max);
    expect(read(join(dir, "keywords.txt")).trim()).toBe(astraSpec().aso.keywords.join(","));
    expect(read(join(dir, "privacy_url.txt")).trim()).toBe("https://faststudio.example/astra/privacy");
  });

  it("joins keywords within 100 chars without cutting words or repeating them", () => {
    const joined = joinKeywords(["astrology", "Astrology", " zodiac ", "x".repeat(95), "birth chart", "a,b"]);
    expect(joined).toBe("astrology,zodiac,birth chart,a b");
    expect(joinKeywords(Array.from({ length: 30 }, (_, i) => `keyword${i}`)).length).toBeLessThanOrEqual(100);
  });

  it("writes upload-ready PNG screenshots and keeps the SVG sources apart", () => {
    const spec = astraSpec();
    const shots = readdirSync(join(r.root, "store", "screenshots")).sort();
    expect(shots).toEqual(spec.aso.screenshotCaptions.map((_, i) => `${i + 1}.png`));
    for (const shot of shots) {
      const info = pngInfo(readFileSync(join(r.root, "store", "screenshots", shot)));
      expect(info).toEqual({ ...SCREENSHOT_SIZE, colorType: 2 });
    }
    spec.aso.screenshotCaptions.forEach((caption, i) => {
      const svg = read(join(r.root, "store", "screenshots-src", `${i + 1}.svg`));
      expect(svg).toContain(`width="${SCREENSHOT_SIZE.width}" height="${SCREENSHOT_SIZE.height}"`);
      for (const word of caption.split(/\s+/)) expect(svg).toContain(word.replace(/&/g, "&amp;"));
      expect(svg).toContain(spec.brand.backgroundColor.toLowerCase());
    });
  });

  it("writes legal pages with auto-renewal terms, cancellation and an AI disclosure naming the providers", () => {
    const terms = read(join(r.root, "legal", "terms.md"));
    expect(terms).toContain("3-day free trial, then the price per week shown in the app before you confirm the purchase. Renews automatically until cancelled.");
    expect(terms).toContain("renews automatically");
    expect(terms).toContain("https://apps.apple.com/account/subscriptions");
    expect(terms).toContain("generated by artificial intelligence");
    expect(terms).toContain("Anthropic, PBC");
    expect(terms).toContain("Fast Studio LLC");
    expect(terms).toContain("State of Delaware");
    expect(terms).not.toMatch(/\$\d/);

    const privacy = read(join(r.root, "legal", "privacy.md"));
    for (const name of ["Anthropic, PBC", "PostHog, Inc.", "RevenueCat, Inc.", "our own servers"]) expect(privacy).toContain(name);
    expect(privacy).toContain("kept for up to 30 days");
    expect(privacy).toContain("does not track you");
    expect(privacy).toContain("help@faststudio.example");
    expect(privacy).toContain("not directed to anyone under 18");
    expect(privacy).toContain("not offered in the European Economic Area");
  });

  it("publishes a site with landing, legal, support and deep-link association files", () => {
    const site = join(r.root, "site");
    for (const page of ["index.html", "privacy.html", "terms.html", "support.html", "chart/index.html"]) expect(existsSync(join(site, page))).toBe(true);
    expect(read(join(site, "terms.html"))).toContain("Renews automatically until cancelled");
    expect(read(join(site, "privacy.html"))).toContain('<a href="mailto:help@faststudio.example">');
    expect(read(join(site, "index.html"))).toContain('href="#app-store"');

    const aasa = JSON.parse(read(join(site, ".well-known", "apple-app-site-association"))) as {
      applinks: { details: { appIDs: string[]; components: { "/": string }[] }[] };
    };
    expect(aasa.applinks.details[0]?.appIDs).toEqual(["<TEAM_ID>.com.faststudio.astra"]);
    expect(aasa.applinks.details[0]?.components[0]?.["/"]).toBe("/chart*");
    const links = JSON.parse(read(join(site, ".well-known", "assetlinks.json"))) as { target: { package_name: string } }[];
    expect(links[0]?.target.package_name).toBe("com.faststudio.astra");
  });

  it("marks tracking false in every privacy disclosure", () => {
    const apple = JSON.parse(read(join(r.root, "store", "app-privacy.json"))) as { tracking: boolean; dataTypes: { type: string; usedForTracking: boolean }[] };
    expect(apple.tracking).toBe(false);
    expect(apple.dataTypes.every((d) => !d.usedForTracking)).toBe(true);
    expect(apple.dataTypes.map((d) => d.type)).toEqual(expect.arrayContaining(["Other User Content", "Device ID", "Product Interaction", "Purchase History"]));
    const plist = read(join(r.root, "ios", "PrivacyInfo.xcprivacy"));
    expect(plist).toMatch(/<key>NSPrivacyTracking<\/key>\n\t<false\/>/);
    expect(plist).toContain("NSPrivacyAccessedAPICategoryUserDefaults");
    const csv = read(join(r.root, "store", "data-safety.csv")).trim().split("\n");
    expect(csv[0]).toContain("data_category,data_type,collected,shared");
    expect(csv.slice(1).every((line) => line.split(",")[3] === "no")).toBe(true);
  });

  it("is deterministic", () => {
    const again = render();
    for (const rel of ["legal/terms.md", "legal/privacy.md", "store/screenshots-src/1.svg", "site/index.html", "app/studio.json"]) {
      expect(read(join(again.root, rel))).toBe(read(join(r.root, rel)));
    }
  });
});

describe("renderApp re-render and template copy", () => {
  it("skips node_modules and .expo, keeps the brand icon, and drops stale screenshots", () => {
    const template = join(tempDir(), "template");
    cpSync(TEMPLATE_DIR, template, { recursive: true });
    mkdirSync(join(template, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(template, "node_modules", "left-pad", "index.js"), "");
    mkdirSync(join(template, ".expo"), { recursive: true });
    writeFileSync(join(template, ".expo", "settings.json"), "{}");

    const outRoot = tempDir();
    const five = { ...astraSpec(), aso: { ...astraSpec().aso, screenshotCaptions: ["One", "Two", "Three", "Four", "Five"] } };
    const first = render(five, { outRoot, templateDir: template });
    expect(existsSync(join(first.projectDir, "node_modules"))).toBe(false);
    expect(existsSync(join(first.projectDir, ".expo"))).toBe(false);
    expect(readdirSync(join(first.root, "store", "screenshots"))).toHaveLength(5);

    mkdirSync(join(first.projectDir, "assets"), { recursive: true });
    writeFileSync(join(first.projectDir, "assets", "icon.png"), "icon");
    const second = render(astraSpec(), { outRoot, templateDir: template, v: { specVersion: 2 } });
    expect(read(join(second.projectDir, "assets", "icon.png"))).toBe("icon");
    expect(readdirSync(join(second.root, "store", "screenshots")).sort()).toEqual(["1.png", "2.png", "3.png"]);
    expect(failed(second)).toEqual([]);
  });

  it("fills the App Store Connect app id into eas.json once bound", () => {
    const r = render(astraSpec(), { v: { bindings: { ...venture().bindings, ascAppId: "6400000000" } } });
    const eas = JSON.parse(read(join(r.projectDir, "eas.json"))) as { submit: { production: { ios: { ascAppId?: string } } }; build: Record<string, { autoIncrement?: boolean }> };
    expect(eas.submit.production.ios.ascAppId).toBe("6400000000");
    expect(eas.build.production?.autoIncrement).toBe(true);
  });
});

describe("renderApp checks", () => {
  it("fails bundle_id_format for an invalid bundle id", () => {
    const r = render(astraSpec(), { v: { bindings: { ...venture().bindings, bundleId: "1bad id" } } });
    expect(failed(r)).toEqual(["bundle_id_format"]);
  });

  it("fails spec_lint and metadata_limits for an over-long subtitle", () => {
    const r = render({ ...astraSpec(), subtitle: "A subtitle that is far too long for the store" });
    expect(failed(r)).toEqual(expect.arrayContaining(["spec_lint", "metadata_limits"]));
    expect(r.checks.find((c) => c.name === "spec_lint")?.detail).toContain("spec.subtitle_length");
  });

  it("fails no_tracking when the inventory declares tracking", () => {
    const spec = astraSpec();
    const inventory = spec.compliance.dataInventory.map((d, i) => (i === 0 ? { ...d, usedForTracking: true } : d));
    const r = render({ ...spec, compliance: { ...spec.compliance, dataInventory: inventory } });
    expect(failed(r)).toContain("no_tracking");
  });

  it("fails spec_lint for a paywall product outside the price ladder without throwing", () => {
    const r = render({ ...astraSpec(), paywall: { ...astraSpec().paywall, productIds: ["no_such_product", "week_699_t3"] } });
    expect(failed(r)).toEqual(["spec_lint"]);
    expect(read(join(r.root, "legal", "terms.md"))).toContain("Weekly plan with a 3-day free trial");
  });

  it("fails spec_schema for a malformed spec", () => {
    const r = render({ ...astraSpec(), category: 7 } as unknown as AppSpec);
    expect(failed(r)).toContain("spec_schema");
  });

  it("fails backend_url when no backend is bound", () => {
    const { backendUrl: _drop, ...bindings } = venture().bindings;
    const r = render(astraSpec(), { v: { bindings } });
    expect(failed(r)).toEqual(["backend_url"]);
  });
});
