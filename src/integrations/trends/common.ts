/**
 * Shared pieces of the social and ad-library trend sources. Each source turns one search term
 * into one TrendObservation of raw counts; principles/evidence.ts scores them.
 */
import type { Clock, TrendObservation } from "../../core/ports.ts";
import type { TrendSource } from "../../core/types.ts";

export type Env = Record<string, string | undefined>;

export interface TrendSourceOptions {
  env: Env;
  clock: Clock;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface TrendSourceClient {
  readonly source: TrendSource;
  /** Most terms one scan may query, so a scan stays inside the platform's quota. */
  readonly maxTermsPerScan: number;
  /** Null when the source returned nothing usable for the term. */
  scanTerm(req: { term: string; country: string; sinceDays: number }): Promise<TrendObservation | null>;
}

export const MAX_SAMPLES = 5;
const SAMPLE_CHARS = 140;
const DAY_MS = 86_400_000;

export type Json = Record<string, unknown>;

export function obj(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function str(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

export function num(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : 0;
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** Whole days between an ISO timestamp and now, at least 1 (a post from this morning counts as a day). */
export function ageDays(iso: string, now: Date): number {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return Infinity;
  return Math.max(1, (now.getTime() - t) / DAY_MS);
}

/** Short single-line excerpts of third-party text; quoted to the LLM only inside an untrusted block. */
export function samples(texts: string[]): string[] {
  const out: string[] = [];
  for (const t of texts) {
    const line = t.replace(/\s+/g, " ").trim().slice(0, SAMPLE_CHARS);
    if (line && !out.includes(line)) out.push(line);
    if (out.length >= MAX_SAMPLES) break;
  }
  return out;
}

export function round(x: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

/** Instagram hashtags are one word of letters and digits. */
export function hashtagFor(term: string): string {
  return term.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type { TrendObservation, TrendSource };
