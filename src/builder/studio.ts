/**
 * studio.json: everything the app template needs besides the spec (identity, URLs,
 * store products, env var names for keys, privacy manifest) and the verdict backend's
 * tenant file. Secrets never appear here, only the names of the variables holding them.
 */
import type { StudioConfig } from "../config/schema.ts";
import type { AppSpec, SensitiveDomain, Venture } from "../core/types.ts";
import { composeSystemPrompt } from "../playbook/safety.ts";
import { productIdFor, termsTemplate } from "../playbook/product.ts";
import { aiRecipients, privacyManifest, RECIPIENTS, type PrivacyManifest } from "./privacy.ts";

/** Public client keys, resolved from the EAS build environment by app.config.ts. */
export const APP_ENV = {
  posthogApiKey: "EXPO_PUBLIC_POSTHOG_API_KEY",
  posthogHost: "EXPO_PUBLIC_POSTHOG_HOST",
  revenueCatIosKey: "EXPO_PUBLIC_REVENUECAT_IOS_KEY",
  revenueCatAndroidKey: "EXPO_PUBLIC_REVENUECAT_ANDROID_KEY",
} as const;

/** Apple team id placeholder; the web host or a human substitutes the real one. */
export const TEAM_ID_PLACEHOLDER = "<TEAM_ID>";
export const CERT_FINGERPRINT_PLACEHOLDER = "<SHA256_CERT_FINGERPRINT>";

export interface VentureUrls {
  site: string;
  privacy: string;
  terms: string;
  support: string;
  deepLinkDomain: string;
}

/**
 * Bound URLs win; before the site is published they fall back to the company legal base
 * under the venture slug (the executor infers the same `/privacy`-style paths).
 */
export function ventureUrls(venture: Venture, config: StudioConfig): VentureUrls {
  const b = venture.bindings;
  const site = (b.webBaseUrl ?? `${config.company.legalBaseUrl.replace(/\/+$/, "")}/${venture.slug}`).replace(/\/+$/, "");
  return {
    site,
    privacy: b.privacyUrl ?? `${site}/privacy`,
    terms: b.termsUrl ?? `${site}/terms`,
    support: b.supportUrl ?? `${site}/support`,
    deepLinkDomain: b.deepLinkDomain ?? new URL(site).host,
  };
}

/** `1.0.0` for spec v1, `1.1.0` for v2: every spec version is a new store version. */
export function versionFor(specVersion: number): string {
  return `1.${Math.max(0, specVersion - 1)}.0`;
}

export interface StudioProduct {
  ladderId: string;
  productId: string;
  period: "week" | "month" | "year";
  trialDays: number;
  /** termsTemplate wording with a literal `{price}`; the app renders its own line from store data. */
  terms: string;
}

export interface StudioJson {
  appName: string;
  slug: string;
  version: string;
  buildNumber: number;
  company: { legalName: string; supportEmail: string };
  bundleId: string;
  androidPackage: string;
  appleTeamId: string;
  deepLinkDomain: string;
  backendUrl: string;
  urls: { site: string; privacy: string; terms: string; support: string; appStore: string | null; play: string | null };
  easProjectId: string | null;
  env: typeof APP_ENV;
  entitlementId: string;
  products: StudioProduct[];
  /** Named on the AI consent step (Apple 5.1.2(i)). */
  aiProviders: { id: string; name: string; role: string }[];
  privacyManifest: PrivacyManifest;
  testGeos: string[];
}

export function buildStudioJson(input: { venture: Venture; spec: AppSpec; config: StudioConfig; appleTeamId?: string }): StudioJson {
  const { venture, spec, config } = input;
  const b = venture.bindings;
  const urls = ventureUrls(venture, config);
  return {
    appName: spec.appName,
    slug: venture.slug,
    version: versionFor(venture.specVersion),
    buildNumber: venture.specVersion,
    company: { legalName: config.company.legalName, supportEmail: config.company.supportEmail },
    bundleId: b.bundleId,
    androidPackage: b.androidPackage,
    appleTeamId: input.appleTeamId ?? TEAM_ID_PLACEHOLDER,
    deepLinkDomain: urls.deepLinkDomain,
    backendUrl: (b.backendUrl ?? "").replace(/\/+$/, ""),
    urls: { site: urls.site, privacy: urls.privacy, terms: urls.terms, support: urls.support, appStore: b.appStoreUrl ?? null, play: b.playUrl ?? null },
    easProjectId: b.easProjectId ?? null,
    env: APP_ENV,
    entitlementId: config.monetization.entitlementId,
    // The whole ladder: remote-config paywall variants may pick any ladder id.
    products: config.monetization.ladder.map((e) => ({
      ladderId: e.id,
      productId: productIdFor(b.bundleId, e.id),
      period: e.period,
      trialDays: e.trialDays,
      terms: termsTemplate(e),
    })),
    aiProviders: aiRecipients(spec).map((id) => ({ id, name: RECIPIENTS[id].name, role: RECIPIENTS[id].role })),
    privacyManifest: privacyManifest(spec),
    testGeos: [...config.lab.testGeos],
  };
}

export interface TenantJson {
  slug: string;
  appName: string;
  /** Safety preamble, domain additions, fenced product prompt, closing rule. */
  systemPrompt: string;
  model: string;
  effort: "low";
  maxTokens: number;
  inputKind: AppSpec["core"]["inputKind"];
  outputSections: string[];
  freeUses: number;
  entitlementId: string;
  /** Env var holding this app's RevenueCat secret key (REST v1). */
  revenueCatSecretEnv: string;
  rateLimit: { perMinute: number; perDay: number };
  maxInputChars: number;
  supportEmail: string;
  /** GET /v1/config payloads by variant id; `default` applies when no variant matches. */
  remoteConfig: Record<string, Partial<Pick<AppSpec, "paywall" | "onboarding" | "share" | "core">>>;
}

export function buildTenantJson(input: { venture: Venture; spec: AppSpec; config: StudioConfig; domains: SensitiveDomain[] }): TenantJson {
  const { venture, spec, config, domains } = input;
  return {
    slug: venture.slug,
    appName: spec.appName,
    systemPrompt: composeSystemPrompt(spec.core.aiSystemPrompt, domains),
    model: config.llm.model,
    effort: "low",
    maxTokens: 1_500,
    inputKind: spec.core.inputKind,
    outputSections: [...spec.core.outputSections],
    freeUses: Math.max(0, spec.core.freeUsesBeforePaywall),
    entitlementId: config.monetization.entitlementId,
    revenueCatSecretEnv: `REVENUECAT_SECRET_KEY_${venture.slug.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`,
    rateLimit: { perMinute: 6, perDay: 60 },
    maxInputChars: 4_000,
    supportEmail: config.company.supportEmail,
    remoteConfig: { default: {} },
  };
}
