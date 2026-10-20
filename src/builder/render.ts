/**
 * Spec → shippable venture folder:
 *
 *   <outRoot>/<slug>/app/          Expo project (template copy + spec.json + studio.json + server tenant)
 *   <outRoot>/<slug>/store/        listing metadata, upload-ready screenshots, privacy answers
 *   <outRoot>/<slug>/store/screenshots-src/   SVG sources of the screenshots
 *   <outRoot>/<slug>/ios/          PrivacyInfo.xcprivacy (outside app/ so EAS keeps prebuilding)
 *   <outRoot>/<slug>/legal/        privacy.md, terms.md
 *   <outRoot>/<slug>/site/         everything the web host publishes
 *
 * Deterministic: the same venture, spec and config produce the same bytes. A re-render
 * replaces every generated file but keeps app/assets (the brand agent's icon).
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { PriceLadderEntry, StudioConfig } from "../config/schema.ts";
import { AppSpec as AppSpecSchema, type AppSpec, type BuildRecord, type Idea, type SensitiveDomain, type Venture } from "../core/types.ts";
import { ladderEntry } from "../playbook/product.ts";
import { LOCALE, lintSpec } from "../principles/product.ts";
import { legalMarkdown, privacyPolicy, termsOfUse } from "./legal.ts";
import { metadataProblems, storeMetadata } from "./metadata.ts";
import { applePrivacyAnswers, collectedData, dataSafetyCsv, privacyManifest, privacyManifestPlist } from "./privacy.ts";
import { pngInfo, rasterize, SCREENSHOT_SIZE, screenshotSvgs } from "./screenshots.ts";
import { siteFiles } from "./site.ts";
import { buildStudioJson, buildTenantJson, ventureUrls, versionFor } from "./studio.ts";

export interface RenderInput {
  venture: Venture;
  spec: AppSpec;
  idea: Idea;
  config: StudioConfig;
  domains: SensitiveDomain[];
  outRoot: string;
  templateDir: string;
  /** Apple team id for studio.json and the AASA appID; a placeholder when unknown. */
  appleTeamId?: string;
  builtAt?: string;
}

type Check = BuildRecord["checks"][number];

/** Template entries never copied into a venture. */
const TEMPLATE_EXCLUDE = new Set(["node_modules", ".expo", "dist", "web-build", ".git", "ios", "android"]);
/** Generated folders under the venture root, wiped on every render. */
const GENERATED_DIRS = ["store", "site", "legal", "ios"];
/** Kept across renders inside app/. */
const PRESERVED_APP_ENTRIES = new Set(["assets", "node_modules"]);

export const BUNDLE_ID = /^[a-z][a-z0-9]*(\.[a-z0-9_-]+)+$/i;
const SCREENSHOT_COUNT = [3, 10] as const;

const TEMPLATE_REQUIRED = [
  "package.json",
  "app.config.ts",
  "eas.json",
  "tsconfig.json",
  "app/_layout.tsx",
  "app/index.tsx",
  "app/onboarding.tsx",
  "app/paywall.tsx",
  "app/home.tsx",
  "app/result.tsx",
  "app/settings.tsx",
  "src/spec.ts",
  "src/events.ts",
  "server/package.json",
  "server/src/index.ts",
];

/** Write a generated file; a path that resolves outside the venture root is a bug or an attack and throws. */
/** Rasterized screenshots by SVG hash: re-renders for a changed binding redraw the same images. */
const PNG_CACHE = new Map<string, Buffer>();
const PNG_CACHE_MAX = 256;

function rasterizeCached(svg: string): Buffer {
  const key = createHash("sha256").update(svg).digest("hex");
  const hit = PNG_CACHE.get(key);
  if (hit) return hit;
  const png = rasterize(svg);
  if (PNG_CACHE.size >= PNG_CACHE_MAX) PNG_CACHE.delete(PNG_CACHE.keys().next().value as string);
  PNG_CACHE.set(key, png);
  return png;
}

function write(root: string, path: string, content: string | Buffer, files: string[]): void {
  const base = resolve(root);
  if (!resolve(path).startsWith(base + sep)) throw new Error(`refusing to write outside ${base}: ${path}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  files.push(path);
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => (e.isDirectory() ? listFiles(join(dir, e.name)) : [join(dir, e.name)]));
}

function copyTemplate(templateDir: string, projectDir: string): void {
  if (existsSync(projectDir)) {
    for (const entry of readdirSync(projectDir)) {
      if (!PRESERVED_APP_ENTRIES.has(entry)) rmSync(join(projectDir, entry), { recursive: true, force: true });
    }
  }
  mkdirSync(projectDir, { recursive: true });
  cpSync(templateDir, projectDir, { recursive: true, filter: (src) => !TEMPLATE_EXCLUDE.has(basename(src)) });
}

function check(name: string, passed: boolean, detail: string): Check {
  return { name, passed, detail };
}

function paywallProducts(spec: AppSpec, config: StudioConfig): PriceLadderEntry[] {
  return spec.paywall.productIds.flatMap((id) => {
    try {
      return [ladderEntry(config, id)];
    } catch {
      return []; // the spec lint reports unknown ladder ids
    }
  });
}

function withAscAppId(easJson: string, ascAppId: string | undefined): string {
  if (!ascAppId) return easJson;
  const eas = JSON.parse(easJson) as { submit?: { production?: { ios?: Record<string, unknown> } } };
  const production = eas.submit?.production ?? {};
  eas.submit = { ...eas.submit, production: { ...production, ios: { ...production.ios, ascAppId } } };
  return json(eas);
}

/** Render the venture's app, store assets, legal pages and site; checks report every problem instead of throwing. */
export function renderApp(input: RenderInput): BuildRecord & { files: string[] } {
  const { venture, spec, idea, config, domains } = input;
  const root = join(input.outRoot, venture.slug);
  const projectDir = join(root, "app");
  const files: string[] = [];

  for (const dir of GENERATED_DIRS) rmSync(join(root, dir), { recursive: true, force: true });
  copyTemplate(input.templateDir, projectDir);

  const urls = ventureUrls(venture, config);
  const studio = buildStudioJson({ venture, spec, config, ...(input.appleTeamId ? { appleTeamId: input.appleTeamId } : {}) });
  write(root, join(projectDir, "spec.json"), json(spec), files);
  write(root, join(projectDir, "studio.json"), json(studio), files);
  const easPath = join(projectDir, "eas.json");
  if (existsSync(easPath)) writeFileSync(easPath, withAscAppId(readFileSync(easPath, "utf8"), venture.bindings.ascAppId));
  write(root, join(projectDir, "server", "tenants", `${venture.slug}.json`), json(buildTenantJson({ venture, spec, config, domains })), files);

  // An invalid locale is reported by the spec_lint check; it never becomes a path.
  const metaDir = join(root, "store", "metadata", LOCALE.test(spec.locale) ? spec.locale : config.company.defaultLocale);
  const meta = storeMetadata(spec, urls);
  for (const [name, value] of Object.entries(meta)) write(root, join(metaDir, `${name}.txt`), `${value}\n`, files);

  const shots = screenshotSvgs(spec);
  const shotProblems: string[] = [];
  for (const shot of shots) {
    write(root, join(root, "store", "screenshots-src", `${shot.name}.svg`), shot.svg, files);
    const png = rasterizeCached(shot.svg);
    const info = pngInfo(png);
    if (!info || info.width !== SCREENSHOT_SIZE.width || info.height !== SCREENSHOT_SIZE.height || info.colorType !== 2) {
      shotProblems.push(`${shot.name}.png is not a ${SCREENSHOT_SIZE.width}x${SCREENSHOT_SIZE.height} RGB PNG`);
    }
    write(root, join(root, "store", "screenshots", `${shot.name}.png`), png, files);
  }
  if (shots.length < SCREENSHOT_COUNT[0] || shots.length > SCREENSHOT_COUNT[1]) {
    shotProblems.push(`${shots.length} screenshots (App Store Connect takes ${SCREENSHOT_COUNT[0]}..${SCREENSHOT_COUNT[1]})`);
  }

  const privacyAnswers = applePrivacyAnswers(spec);
  write(root, join(root, "store", "app-privacy.json"), json(privacyAnswers), files);
  write(root, join(root, "store", "data-safety.csv"), dataSafetyCsv(spec), files);
  write(root, join(root, "ios", "PrivacyInfo.xcprivacy"), privacyManifestPlist(privacyManifest(spec)), files);

  const legalInput = { spec, config, urls, updated: venture.updatedAt.slice(0, 10), products: paywallProducts(spec, config) };
  const privacy = privacyPolicy(legalInput);
  const terms = termsOfUse(legalInput);
  write(root, join(root, "legal", "privacy.md"), legalMarkdown(privacy), files);
  write(root, join(root, "legal", "terms.md"), legalMarkdown(terms), files);
  for (const f of siteFiles({ spec, studio, privacy, terms })) write(root, join(root, "site", f.path), f.content, files);

  const checks: Check[] = [];
  const parsed = AppSpecSchema.safeParse(spec);
  checks.push(check("spec_schema", parsed.success, parsed.success ? "AppSpec parses" : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")));
  let blocks: string[];
  try {
    blocks = lintSpec(spec, idea, config, domains).filter((f) => f.severity === "block").map((f) => `${f.ruleId}: ${f.message}`);
  } catch (err) {
    blocks = [`lint crashed: ${(err as Error).message}`];
  }
  checks.push(check("spec_lint", blocks.length === 0, blocks.length ? blocks.join("; ") : "no blocking findings"));
  const metaProblems = metadataProblems(meta);
  checks.push(check("metadata_limits", metaProblems.length === 0, metaProblems.length ? metaProblems.join("; ") : "listing fits App Store Connect limits"));
  const badIds = [venture.bindings.bundleId, venture.bindings.androidPackage].filter((id) => !BUNDLE_ID.test(id));
  checks.push(check("bundle_id_format", badIds.length === 0, badIds.length ? `invalid: ${badIds.join(", ")}` : `${venture.bindings.bundleId} / ${venture.bindings.androidPackage}`));
  checks.push(check("backend_url", /^https:\/\/[^\s/]+/.test(studio.backendUrl), studio.backendUrl || "no backend URL bound"));
  const trackers = collectedData(spec).filter((d) => d.usedForTracking);
  checks.push(
    check(
      "no_tracking",
      trackers.length === 0 && !privacyAnswers.tracking,
      trackers.length ? `tracking declared for ${trackers.map((d) => d.dataType).join(", ")}; the template never requests ATT` : "no tracking, no ATT prompt, no IDFA",
    ),
  );
  const shotDir = join(root, "store", "screenshots");
  const strays = readdirSync(shotDir).filter((f) => !/^\d+\.png$/.test(f));
  if (strays.length) shotProblems.push(`non-upload files in store/screenshots: ${strays.join(", ")}`);
  checks.push(check("screenshots", shotProblems.length === 0, shotProblems.length ? shotProblems.join("; ") : `${shots.length} PNGs at ${SCREENSHOT_SIZE.width}x${SCREENSHOT_SIZE.height}`));

  const required = [
    ...TEMPLATE_REQUIRED.map((f) => join(projectDir, f)),
    join(projectDir, "spec.json"),
    join(projectDir, "studio.json"),
    join(projectDir, "server", "tenants", `${venture.slug}.json`),
    ...["name", "subtitle", "description", "keywords", "promotional_text", "privacy_url", "support_url", "marketing_url"].map((n) => join(metaDir, `${n}.txt`)),
    join(root, "store", "app-privacy.json"),
    join(root, "store", "data-safety.csv"),
    join(root, "ios", "PrivacyInfo.xcprivacy"),
    join(root, "legal", "privacy.md"),
    join(root, "legal", "terms.md"),
    ...["index.html", "privacy.html", "terms.html", "support.html", ".well-known/apple-app-site-association", ".well-known/assetlinks.json"].map((f) => join(root, "site", f)),
  ];
  const missing = required.filter((f) => !existsSync(f));
  checks.push(check("required_files", missing.length === 0, missing.length ? `missing: ${missing.map((f) => f.slice(root.length + 1)).join(", ")}` : `${required.length} required files present`));

  const generated = new Set(files);
  return {
    projectDir,
    version: versionFor(venture.specVersion),
    buildNumber: venture.specVersion,
    specVersion: venture.specVersion,
    checks,
    builtAt: input.builtAt ?? venture.updatedAt,
    files: [...listFiles(projectDir).filter((f) => !f.includes(`${join(projectDir, "node_modules")}`) && !generated.has(f)), ...files],
  };
}
