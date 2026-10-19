/**
 * The venture's static site: landing page, legal and support pages, the share deep-link
 * fallback, and the association files that make share links open the app (Apple
 * Universal Links, Android App Links).
 */
import type { AppSpec } from "../core/types.ts";
import { escapeHtml, legalHtmlBody, type LegalDoc } from "./legal.ts";
import { CERT_FINGERPRINT_PLACEHOLDER, type StudioJson } from "./studio.ts";

export interface SiteFile {
  path: string;
  content: string;
}

/** Store button targets before the listings exist; the web host or a human swaps them in. */
export const STORE_LINK_PLACEHOLDER = { ios: "#app-store", android: "#google-play" } as const;

function safeColor(value: string, fallback: string): string {
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value) ? value : fallback;
}

function page(spec: AppSpec, title: string, body: string): string {
  const bg = safeColor(spec.brand.backgroundColor, "#ffffff");
  const fg = safeColor(spec.brand.textColor, "#111111");
  const accent = safeColor(spec.brand.accentColor, "#3355ff");
  return `<!doctype html>
<html lang="${escapeHtml(spec.locale.split("-")[0] ?? "en")}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{--bg:${bg};--fg:${fg};--accent:${accent}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:720px;margin:0 auto;padding:32px 16px 64px}
a{color:var(--accent)}
h1{line-height:1.2}
.muted{opacity:.7}
.stores{display:flex;flex-wrap:wrap;gap:12px;margin:24px 0}
.store{display:inline-block;padding:12px 20px;border-radius:12px;background:var(--accent);color:var(--bg);text-decoration:none;font-weight:600}
footer{margin-top:48px;font-size:14px;opacity:.8}
footer a{margin-right:16px}
</style>
</head>
<body>
<main>
${body}
<footer><a href="/">Home</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/support">Support</a></footer>
</main>
</body>
</html>
`;
}

function storeButtons(studio: StudioJson): string {
  const ios = studio.urls.appStore ?? STORE_LINK_PLACEHOLDER.ios;
  const android = studio.urls.play ?? STORE_LINK_PLACEHOLDER.android;
  return `<div class="stores"><a class="store" data-store="ios" href="${escapeHtml(ios)}">Download on the App Store</a><a class="store" data-store="android" href="${escapeHtml(android)}">Get it on Google Play</a></div>`;
}

function paragraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

/** Deep-link path without wildcards or parameters, e.g. "/chart" for "/chart/:id". */
export function deepLinkBase(deepLinkPath: string): string {
  const segments = deepLinkPath.split("/").filter((s) => s && !s.startsWith(":") && !s.includes("*"));
  const clean = segments.filter((s) => /^[A-Za-z0-9._-]+$/.test(s));
  return clean.length ? `/${clean.join("/")}` : "/";
}

export function appleAppSiteAssociation(studio: StudioJson, deepLinkPath: string): string {
  const appId = `${studio.appleTeamId}.${studio.bundleId}`;
  const base = deepLinkBase(deepLinkPath);
  const pattern = base === "/" ? "/*" : `${base}*`;
  return `${JSON.stringify(
    {
      applinks: {
        apps: [],
        details: [{ appIDs: [appId], appID: appId, paths: [pattern], components: [{ "/": pattern, comment: "Shared result cards" }] }],
      },
    },
    null,
    2,
  )}\n`;
}

export function assetLinks(studio: StudioJson): string {
  return `${JSON.stringify(
    [
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: { namespace: "android_app", package_name: studio.androidPackage, sha256_cert_fingerprints: [CERT_FINGERPRINT_PLACEHOLDER] },
      },
    ],
    null,
    2,
  )}\n`;
}

export function siteFiles(input: { spec: AppSpec; studio: StudioJson; privacy: LegalDoc; terms: LegalDoc }): SiteFile[] {
  const { spec, studio } = input;
  const name = escapeHtml(spec.appName);
  const index = page(
    spec,
    `${spec.appName}: ${spec.subtitle}`,
    `<h1>${name}</h1>
<p><strong>${escapeHtml(spec.subtitle)}</strong></p>
${storeButtons(studio)}
${paragraphs(spec.aso.description)}
<p class="muted">${name} uses AI to generate results. Results may be inaccurate and are for entertainment and general information.</p>`,
  );
  const support = page(
    spec,
    `${spec.appName} Support`,
    `<h1>${name} Support</h1>
<p>Email us at <a href="mailto:${escapeHtml(studio.company.supportEmail)}">${escapeHtml(studio.company.supportEmail)}</a>.</p>
<h2>How do I cancel my subscription?</h2>
<p>On iPhone or iPad: Settings &gt; your name &gt; Subscriptions, or <a href="https://apps.apple.com/account/subscriptions">apps.apple.com/account/subscriptions</a>. On Android: Google Play Store &gt; Payments &amp; subscriptions &gt; Subscriptions, or <a href="https://play.google.com/store/account/subscriptions">play.google.com/store/account/subscriptions</a>. Cancel at least 24 hours before renewal to avoid the next charge. In the app, Settings &gt; Manage subscription opens the same page.</p>
<h2>How do I restore a purchase?</h2>
<p>Open the app, go to Settings and tap Restore purchases while signed in to the store account you bought with.</p>
<h2>How do I get a refund?</h2>
<p>Purchases are processed by Apple or Google. Request a refund at <a href="https://reportaproblem.apple.com">reportaproblem.apple.com</a> or through Google Play's order history.</p>
<h2>How do I delete my data?</h2>
<p>In the app, open Settings and tap Delete my data, or email us. See the <a href="/privacy">Privacy Policy</a>.</p>
<h2>How are results made?</h2>
<p>Results are generated by AI and may be wrong. If a result seems harmful or wrong, tap Report this result or email us.</p>`,
  );
  const base = deepLinkBase(spec.share.deepLinkPath);
  const fallback = page(
    spec,
    spec.appName,
    `<h1>${name}</h1>
<p>This result was made with ${name}. Get the app to open it and make your own.</p>
${storeButtons(studio)}`,
  );
  const files: SiteFile[] = [
    { path: "index.html", content: index },
    { path: "privacy.html", content: page(spec, input.privacy.title, legalHtmlBody(input.privacy)) },
    { path: "terms.html", content: page(spec, input.terms.title, legalHtmlBody(input.terms)) },
    { path: "support.html", content: support },
    { path: ".well-known/apple-app-site-association", content: appleAppSiteAssociation(studio, spec.share.deepLinkPath) },
    { path: ".well-known/assetlinks.json", content: assetLinks(studio) },
  ];
  if (base !== "/" && !["/privacy", "/terms", "/support", "/index"].includes(base)) {
    files.push({ path: `${base.slice(1)}/index.html`, content: fallback });
  }
  return files;
}
