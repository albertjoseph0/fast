/**
 * Keyword heuristics the stub LLM uses where Claude would use judgment: sensitive-domain
 * classification, age floors, the core input kind and copy-safe text shaping.
 */
import type { AppSpec, Idea, SensitiveDomain } from "../core/types.ts";

const DOMAIN_KEYWORDS: readonly (readonly [SensitiveDomain, RegExp])[] = [
  ["astrology_fortune", /\b(astrolog\w*|tarot|horoscopes?|zodiac|birth charts?|fortunes?|synastry)\b/i],
  ["dating_safety", /\b(dating|rizz|flirt\w*|crush(es)?|hinge|tinder|situationship)\b/i],
  ["health", /\b(calorie\w*|diet\w*|symptoms?|workouts?|macros?|nutrition|diagnos\w*|vaping|nicotine|posture)\b/i],
  ["appearance_rating", /\b(outfits?|looks|attractive\w*|rate my|hot or not)\b/i],
  ["ai_companion", /\b(companions?|girlfriend|boyfriend)\b/i],
  ["finance", /\b(budget\w*|invest\w*|stocks?|crypto|income|mortgages?|bank)\b/i],
  ["minors", /\b(school|teens?|teenagers?|class(es)?|homework)\b/i],
  ["religion", /\b(bible|prayers?|scripture|church)\b/i],
  ["gambling", /\b(bet|betting|casinos?|gambl\w*|sportsbooks?)\b/i],
  ["mental_health", /\b(anxiety|depress\w*|therapy|therapist|mental health)\b/i],
];

/** Domains whose apps are 18+ regardless of the wedge. */
export const ADULT_DOMAINS: readonly SensitiveDomain[] = ["dating_safety", "appearance_rating", "ai_companion", "gambling", "finance"];

export interface DomainMatch {
  domain: SensitiveDomain;
  keyword: string;
}

export function classifyDomains(text: string): DomainMatch[] {
  const out: DomainMatch[] = [];
  for (const [domain, pattern] of DOMAIN_KEYWORDS) {
    const m = pattern.exec(text);
    if (m) out.push({ domain, keyword: m[0].toLowerCase() });
  }
  return out;
}

export type MinimumAge = AppSpec["compliance"]["minimumAge"];

const AGE_ORDER: readonly MinimumAge[] = ["13", "16", "18"];

export function maxAge(a: MinimumAge, b: MinimumAge): MinimumAge {
  return AGE_ORDER.indexOf(a) >= AGE_ORDER.indexOf(b) ? a : b;
}

/** Independent classifier rule: adult domains are 18+, minors-ish ideas 16+, everything else 13+. */
export function reviewMinimumAge(domains: readonly SensitiveDomain[], wedgeMinAge: number): MinimumAge {
  if (domains.some((d) => ADULT_DOMAINS.includes(d))) return "18";
  if (domains.includes("minors") || wedgeMinAge < 18) return "16";
  return "13";
}

/** Store rating floor: the stricter of the wedge's youngest user and the domain rules. */
export function specMinimumAge(domains: readonly SensitiveDomain[], wedgeMinAge: number): MinimumAge {
  const wedge: MinimumAge = wedgeMinAge >= 18 ? "18" : wedgeMinAge >= 16 ? "16" : "13";
  const domain: MinimumAge = domains.some((d) => ADULT_DOMAINS.includes(d)) ? "18" : "13";
  return maxAge(wedge, domain);
}

export function ideaText(idea: Pick<Idea, "title" | "oneLiner" | "aiCapability" | "verdictMoment" | "shareArtifact"> & {
  monetization: { payFor: string };
  wedge: { name: string; description: string };
}): string {
  return [idea.title, idea.oneLiner, idea.aiCapability, idea.verdictMoment, idea.monetization.payFor, idea.shareArtifact, idea.wedge.name, idea.wedge.description].join(" \n ");
}

export function inferInputKind(idea: Pick<Idea, "verdictMoment" | "aiCapability" | "oneLiner">): AppSpec["core"]["inputKind"] {
  const t = `${idea.verdictMoment} ${idea.oneLiner} ${idea.aiCapability}`.toLowerCase();
  if (/screenshot/.test(t)) return "screenshot";
  if (/\b(birth (dates?|times?|charts?)|zodiac)\b/.test(t)) return "date_time_place";
  if (/\b(audio|songs?|record\w*|singing|voice)\b/.test(t)) return "audio_file";
  if (/\b(photo\w*|pictures?|selfie|snap|scan|camera|film)\b/.test(t)) return "photo";
  if (/\b(questions?|quiz|answers?|tap|deck)\b/.test(t)) return "choices";
  return "text";
}

/** Copy must never carry numbers (claims, prices and counts are rendered from data). */
export function stripDigits(text: string): string {
  return text
    .replace(/[$€£¥#]?\d[\d,.:%]*/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.!?])/g, "$1")
    .trim();
}

const DANGLING = new Set(["a", "an", "the", "and", "or", "to", "of", "for", "with", "your", "my", "in", "on", "at", "by", "from", "that", "if", "is"]);

/** Cut at a word boundary so the result fits `max` characters, without a dangling article or preposition. */
export function truncateWords(text: string, max: number): string {
  const clean = text.trim();
  if (clean.length <= max) return clean;
  const words: string[] = [];
  for (const w of clean.split(/\s+/)) {
    if ([...words, w].join(" ").length > max) break;
    words.push(w);
  }
  while (words.length > 1 && DANGLING.has((words.at(-1) ?? "").toLowerCase())) words.pop();
  return (words.join(" ") || clean.slice(0, max)).replace(/[\s,;:–—-]+$/, "");
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "app"
  );
}

/** "zodiac TikTok" → "zodiac": the topic of a creator niche without the platform. */
export function nicheTopic(niche: string): string {
  const topic = niche
    .replace(/\b(tiktok|youtube|reels|instagram|tok)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return topic || niche;
}

/** Sorted-key JSON so equal inputs hash equally regardless of key order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? "null";
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort()
        .map((k) => [k, sortKeys(obj[k])]),
    );
  }
  return value;
}
