/**
 * Spec → deployable web app (the web lane: no store, no binary, no App Review):
 *
 *   <outRoot>/<slug>/web/            everything the web host deploys
 *     index.html, app.js, styles     the single-page app (templates/web-app)
 *     config.json                    the spec subset the app runs on, prices and checkout links
 *     api/geo.js, vercel.json        edge geofence and clean URLs
 *     privacy.html, terms.html, support.html
 *   <outRoot>/<slug>/web-server/tenants/<slug>.json   the verdict backend's tenant file
 *
 * geo.json (the allowed territories) is not rendered: the deploy writes it, so moving an app
 * to new territories is a redeploy. Deterministic like renderApp: same inputs, same bytes.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { PriceLadderEntry, StudioConfig } from "../config/schema.ts";
import { AppSpec as AppSpecSchema, type AppSpec, type BuildRecord, type Venture } from "../core/types.ts";
import { productIdFor, termsTemplate } from "../playbook/product.ts";
import { lintSpec } from "../principles/product.ts";
import { escapeHtml, legalHtmlBody, privacyPolicy, termsOfUse, type LegalDoc } from "./legal.ts";
import { paywallProducts, type RenderInput } from "./render.ts";
import { page } from "./site.ts";
import { buildTenantJson, ventureUrls, versionFor } from "./studio.ts";

export type WebRenderInput = Omit<RenderInput, "appleTeamId"> & {
  /** Defaults to templates/web-app next to the Expo template. */
  webTemplateDir?: string;
};

type Check = BuildRecord["checks"][number];

const REQUIRED = ["index.html", "app.js", "config.json", "api/geo.js", "vercel.json", "privacy.html", "terms.html", "support.html"];

const PERIOD_LABEL: Record<PriceLadderEntry["period"], string> = { week: "week", month: "month", year: "year" };

export interface WebProduct {
  ladderId: string;
  productId: string;
  label: string;
  terms: string;
  trialDays: number;
  checkoutUrl: string | null;
}

/** "$6.99" from cents (the web lane sells in config.web.currency; prices come from the ladder, never the LLM). */
export function formatPrice(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
}

/** Store wording ("cancel in Settings") reworded for web billing, where there is no store Settings screen. */
export function webCancelWording(text: string): string {
  return text
    .replace("Cancel anytime in Settings at least 24 hours before renewal.", "Cancel anytime from your receipt email or the billing portal at least 24 hours before renewal.")
    .replace(/^Cancel anytime in Settings$/, "Cancel anytime");
}

/** The ladder's terms line, worded for web billing. */
export function webTermsLine(entry: PriceLadderEntry, currency: string): string {
  return webCancelWording(termsTemplate(entry).replace("{price}", formatPrice(entry.usdCents, currency)));
}

export function webProducts(venture: Venture, spec: AppSpec, config: StudioConfig): WebProduct[] {
  return paywallProducts(spec, config).map((entry) => ({
    ladderId: entry.id,
    productId: productIdFor(venture.bindings.bundleId, entry.id),
    label: `${formatPrice(entry.usdCents, config.web.currency)} / ${PERIOD_LABEL[entry.period]}`,
    terms: webTermsLine(entry, config.web.currency),
    trialDays: entry.trialDays,
    checkoutUrl: venture.bindings.checkoutLinks?.[entry.id]?.url ?? null,
  }));
}

/** A choice step's options for the web, where "App Store search" means nothing: store search becomes web search. */
export function webOptions(step: AppSpec["onboarding"][number]): string[] {
  if (step.kind !== "attribution_survey") return [...step.options];
  const mapped = step.options.map((o) => (/app store|google play|play store/i.test(o) ? "Web search" : o));
  return [...new Set(mapped)];
}

/** The runtime config the app reads; only what the browser needs (no system prompt, no keys but PostHog's public one). */
export function webConfig(venture: Venture, spec: AppSpec, config: StudioConfig) {
  return {
    slug: venture.slug,
    appName: spec.appName,
    subtitle: spec.subtitle,
    backendUrl: (venture.bindings.backendUrl ?? "").replace(/\/+$/, ""),
    posthog: { key: venture.bindings.posthogPublicKey ?? null, host: config.web.posthogHost.replace(/\/+$/, "") },
    minimumAge: Number(spec.compliance.minimumAge),
    aiDisclosure: spec.compliance.aiDisclosure,
    onboarding: spec.onboarding.map((s) => ({ id: s.id, kind: s.kind, title: s.title, subtitle: s.subtitle, options: webOptions(s), storeAs: s.storeAs })),
    inputKind: spec.core.inputKind,
    outputSections: [...spec.core.outputSections],
    inputLabel: spec.core.inputLabel,
    loadingMessages: [...spec.core.loadingMessages],
    share: { caption: spec.share.caption, cardHeadline: spec.share.cardHeadline },
    paywall: { headline: spec.paywall.headline, bullets: spec.paywall.bullets.map(webCancelWording), highlighted: spec.paywall.highlightedProductId },
    products: webProducts(venture, spec, config),
    customerPortalUrl: config.web.customerPortalUrl,
  };
}

/** Terms of use with web billing: Stripe charges the card, cancellation is from the receipt or portal. */
export function webTerms(doc: LegalDoc, portalUrl: string | null, supportEmail: string): LegalDoc {
  const cancel = portalUrl
    ? `How to cancel online: open the billing portal at ${portalUrl}, or use the manage-subscription link in your receipt email.`
    : `How to cancel online: use the manage-subscription link in your receipt email, or email ${supportEmail} and we will cancel it for you.`;
  return {
    ...doc,
    sections: doc.sections.map((s) => {
      if (s.heading === "Agreement") return { ...s, paragraphs: s.paragraphs.filter((p) => !/Apple App Store/.test(p)) };
      if (s.bullets) return { ...s, bullets: s.bullets.map(webCancelWording) };
      if (s.heading !== "Billing, renewal and cancellation") return s;
      return {
        ...s,
        paragraphs: [
          "Payment is charged to the card you enter at checkout, processed by Stripe, when you confirm the purchase or, if your plan starts with a free trial, when the trial ends. Your subscription renews automatically at the same price and for the same period until you cancel it.",
          "To avoid being charged, cancel before the end of the free trial or the current period. Cancelling stops future renewals; you keep access until the end of the period you already paid for.",
          cancel,
          `For refunds, email ${supportEmail}. If a price changes, you will be told in advance and can cancel before the new price applies.`,
        ],
      };
    }),
  };
}

/** Privacy policy plus the payment processor the web lane adds. */
export function webPrivacy(doc: LegalDoc): LegalDoc {
  return {
    ...doc,
    sections: [
      ...doc.sections,
      {
        heading: "Payments on the web",
        paragraphs: [
          "If you subscribe on our website, Stripe, Inc. processes your payment and receives your card details and email address directly; we never see your full card number. We receive a record of the purchase so we can unlock your subscription. See https://stripe.com/privacy.",
        ],
      },
    ],
  };
}

function supportPage(spec: AppSpec, config: StudioConfig): string {
  const email = escapeHtml(config.company.supportEmail);
  const portal = config.web.customerPortalUrl;
  return page(
    spec,
    `${spec.appName} Support`,
    `<h1>${escapeHtml(spec.appName)} Support</h1>
<p>Email us at <a href="mailto:${email}">${email}</a>.</p>
<h2>How do I cancel my subscription?</h2>
<p>${portal ? `Open the <a href="${escapeHtml(portal)}">billing portal</a>, or use` : "Use"} the manage-subscription link in your receipt email. Cancel at least 24 hours before renewal to avoid the next charge.</p>
<h2>How do I get a refund?</h2>
<p>Email us from the address you paid with and we will sort it out.</p>
<h2>How do I delete my data?</h2>
<p>Email us. Results are kept for a day so they can be shared, and a result you share stays readable by anyone with its link for 30 days unless you ask us to delete it; see the <a href="/privacy">Privacy Policy</a>.</p>
<h2>How are results made?</h2>
<p>Results are generated by AI and may be wrong. If a result seems harmful or wrong, use Report this result or email us.</p>`,
  );
}

/** App styles on top of the site's page(): touch-sized buttons, choice cards, the result card and plans. */
export const APP_CSS = `
#app{min-height:60vh}
#app h1{font-size:28px;margin:8px 0 12px}
#app h2{font-size:18px;margin:0 0 6px}
.eyebrow{font-size:13px;letter-spacing:.06em;text-transform:uppercase;opacity:.7;margin:0 0 8px}
.small{font-size:14px}.center{text-align:center}
.progress{height:4px;border-radius:2px;background:color-mix(in srgb,var(--fg) 15%,transparent);margin-bottom:24px}
.progress>div{height:4px;border-radius:2px;background:var(--accent)}
.actions{display:flex;flex-direction:column;gap:10px;margin:24px 0 8px}
button,.button{font:inherit;font-weight:600;display:block;width:100%;box-sizing:border-box;text-align:center;text-decoration:none;padding:15px 18px;border-radius:14px;border:0;cursor:pointer;-webkit-tap-highlight-color:transparent}
.primary{background:var(--accent);color:var(--bg)}
.secondary{background:color-mix(in srgb,var(--fg) 10%,transparent);color:var(--fg)}
button:disabled{opacity:.4;cursor:default}
button.link{background:none;color:var(--fg);opacity:.6;font-weight:400;font-size:14px;padding:10px}
.options{display:flex;flex-direction:column;gap:10px;margin-top:20px}
.option{background:color-mix(in srgb,var(--fg) 7%,transparent);color:var(--fg);text-align:left;font-weight:500;border:2px solid transparent}
.option.selected{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 18%,transparent)}
.field{font:inherit;width:100%;box-sizing:border-box;padding:14px;border-radius:12px;border:2px solid color-mix(in srgb,var(--fg) 20%,transparent);background:transparent;color:var(--fg);margin-top:16px}
.field:focus{outline:none;border-color:var(--accent)}
.card{background:color-mix(in srgb,var(--fg) 7%,transparent);border-radius:18px;padding:18px;margin:12px 0}
.card p{margin:0}
.card.hero{background:var(--accent);color:var(--bg)}
.card.hero h2{font-size:24px}
.section-name{font-weight:600;padding:6px 0;border-top:1px solid color-mix(in srgb,var(--bg) 30%,transparent)}
.notice{background:color-mix(in srgb,var(--accent) 20%,transparent);border-radius:12px;padding:12px 14px}
.drop{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;min-height:180px;border:2px dashed color-mix(in srgb,var(--fg) 30%,transparent);border-radius:18px;padding:16px;cursor:pointer;margin-top:16px;text-align:center}
.drop .preview{max-width:100%;max-height:320px;border-radius:12px}
.drop .preview:not([src]){display:none}
.visually-hidden{position:absolute;width:1px;height:1px;opacity:0;overflow:hidden}
.bullets{padding-left:20px}.bullets li{margin:6px 0}
.plan{border:2px solid color-mix(in srgb,var(--fg) 15%,transparent);border-radius:18px;padding:16px;margin:12px 0}
.plan.highlighted{border-color:var(--accent)}
.plan p{margin:0 0 8px}.plan-price{font-size:20px;font-weight:700}
.spinner{width:36px;height:36px;margin:48px auto 16px;border-radius:50%;border:4px solid color-mix(in srgb,var(--fg) 15%,transparent);border-top-color:var(--accent);animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
`;

function indexHtml(spec: AppSpec): string {
  return page(
    spec,
    `${spec.appName}: ${spec.subtitle}`,
    `<div id="app"><h1>${escapeHtml(spec.appName)}</h1><p>${escapeHtml(spec.subtitle)}</p><noscript>${escapeHtml(spec.appName)} needs JavaScript.</noscript></div>
<script type="module" src="/app.js"></script>`,
    APP_CSS,
  );
}

function write(root: string, path: string, content: string, files: string[]): void {
  if (!resolve(path).startsWith(resolve(root) + sep)) throw new Error(`refusing to write outside ${root}: ${path}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  files.push(path);
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function check(name: string, passed: boolean, detail: string): Check {
  return { name, passed, detail };
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => (e.isDirectory() ? listFiles(join(dir, e.name)) : [join(dir, e.name)]));
}

export function renderWebApp(input: WebRenderInput): BuildRecord & { files: string[] } {
  const { venture, spec, idea, config, domains } = input;
  const root = join(input.outRoot, venture.slug);
  const webDir = join(root, "web");
  const files: string[] = [];
  rmSync(webDir, { recursive: true, force: true });
  rmSync(join(root, "web-server"), { recursive: true, force: true });
  mkdirSync(webDir, { recursive: true });
  const template = input.webTemplateDir ?? join(dirname(input.templateDir), "web-app");
  cpSync(template, webDir, { recursive: true });

  const urls = ventureUrls({ ...venture, bindings: { ...venture.bindings, ...(venture.bindings.webAppUrl ? { webBaseUrl: venture.bindings.webAppUrl } : {}) } }, config);
  const legalInput = { spec, config, urls, updated: venture.updatedAt.slice(0, 10), products: paywallProducts(spec, config) };
  const privacy = webPrivacy(privacyPolicy(legalInput));
  const terms = webTerms(termsOfUse(legalInput), config.web.customerPortalUrl, config.company.supportEmail);
  const cfg = webConfig(venture, spec, config);

  write(root, join(webDir, "index.html"), indexHtml(spec), files);
  write(root, join(webDir, "config.json"), json(cfg), files);
  write(root, join(webDir, "privacy.html"), page(spec, privacy.title, legalHtmlBody(privacy)), files);
  write(root, join(webDir, "terms.html"), page(spec, terms.title, legalHtmlBody(terms)), files);
  write(root, join(webDir, "support.html"), supportPage(spec, config), files);

  const tenant = {
    ...buildTenantJson({ venture, spec, config, domains }),
    revenueCatStripeKeyEnv: `REVENUECAT_STRIPE_KEY_${venture.slug.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`,
  };
  write(root, join(root, "web-server", "tenants", `${venture.slug}.json`), json(tenant), files);

  const checks: Check[] = [];
  const parsed = AppSpecSchema.safeParse(spec);
  checks.push(check("spec_schema", parsed.success, parsed.success ? "AppSpec parses" : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")));
  const blocks = lintSpec(spec, idea, config, domains).filter((f) => f.severity === "block").map((f) => `${f.ruleId}: ${f.message}`);
  checks.push(check("spec_lint", blocks.length === 0, blocks.length ? blocks.join("; ") : "no blocking findings"));
  checks.push(check("backend_url", /^https:\/\/[^\s/]+/.test(cfg.backendUrl), cfg.backendUrl || "no backend URL bound"));
  const unlinked = cfg.products.filter((p) => !p.checkoutUrl).map((p) => p.ladderId);
  checks.push(check("checkout_links", cfg.products.length > 0 && unlinked.length === 0, unlinked.length ? `no payment link for ${unlinked.join(", ")}` : `${cfg.products.length} payment links`));
  const deployed = new Set(listFiles(webDir).map((f) => f.slice(webDir.length + 1).split(sep).join("/")));
  const missing = REQUIRED.filter((f) => !deployed.has(f));
  checks.push(check("required_files", missing.length === 0, missing.length ? `missing: ${missing.join(", ")}` : `${REQUIRED.length} required files present`));
  checks.push(check("geofence", !deployed.has("geo.json"), deployed.has("geo.json") ? "geo.json must come from the deploy, not the render" : "territories set at deploy"));

  return {
    projectDir: webDir,
    version: versionFor(venture.specVersion),
    buildNumber: venture.specVersion,
    specVersion: venture.specVersion,
    checks,
    builtAt: input.builtAt ?? venture.updatedAt,
    files: listFiles(webDir),
  };
}

/** Deploy entries for a rendered web app: every file under web/, by its path in the app. */
export function webDeployFiles(webDir: string): { path: string; localPath: string }[] {
  return listFiles(webDir).map((localPath) => ({ path: localPath.slice(webDir.length + 1).split(sep).join("/"), localPath }));
}
