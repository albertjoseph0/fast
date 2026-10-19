/**
 * Store listing metadata in fastlane `deliver` layout (store/metadata/<locale>/*.txt) and
 * the App Store Connect field limits the build checks enforce.
 */
import type { AppSpec } from "../core/types.ts";
import type { VentureUrls } from "./studio.ts";

export const METADATA_LIMITS = {
  name: 30,
  subtitle: 30,
  keywords: 100,
  promotional_text: 170,
  description: 4_000,
} as const;

/**
 * Comma-joined keywords within the limit: trimmed, case-insensitively deduplicated, and
 * any keyword that would overflow is dropped rather than cut mid-word.
 */
export function joinKeywords(keywords: string[], max: number = METADATA_LIMITS.keywords): string {
  const seen = new Set<string>();
  const kept: string[] = [];
  let length = 0;
  for (const raw of keywords) {
    const k = raw.trim().replace(/\s*,\s*/g, " ");
    const key = k.toLowerCase();
    if (!k || seen.has(key)) continue;
    const next = length + (kept.length ? 1 : 0) + k.length;
    if (next > max) continue;
    seen.add(key);
    kept.push(k);
    length = next;
  }
  return kept.join(",");
}

/** File name (without .txt) → content. */
export function storeMetadata(spec: AppSpec, urls: VentureUrls): Record<string, string> {
  return {
    name: spec.appName.trim(),
    subtitle: spec.subtitle.trim(),
    description: spec.aso.description.trim(),
    keywords: joinKeywords(spec.aso.keywords),
    promotional_text: spec.aso.promotionalText.trim(),
    privacy_url: urls.privacy,
    support_url: urls.support,
    marketing_url: urls.site,
  };
}

/** Limit violations, empty when the metadata fits App Store Connect. */
export function metadataProblems(meta: Record<string, string>): string[] {
  const problems: string[] = [];
  for (const [field, max] of Object.entries(METADATA_LIMITS)) {
    const value = meta[field] ?? "";
    if (value.length > max) problems.push(`${field} is ${value.length} chars (max ${max})`);
  }
  for (const field of ["name", "description", "keywords", "privacy_url", "support_url"]) {
    if (!(meta[field] ?? "").trim()) problems.push(`${field} is empty`);
  }
  return problems;
}
