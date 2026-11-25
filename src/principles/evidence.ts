/**
 * Evidence of demand behind an idea, from the measured signals it cites. Three kinds count:
 *
 * - store demand: App Store search results and chart positions (people install apps for this),
 *   plus momentum (rating counts growing, ranks rising);
 * - attention: YouTube views per day and Instagram hashtag engagement (people watch this);
 * - money: long-running Meta ads, ads pointing at app stores, paid apps and the top-paid chart
 *   (someone earns from this).
 *
 * Attention without money is the classic false positive (a fad, a meme, bought views), so it
 * caps the score and is called out. LLM-written pattern signals (search_trend) are summaries,
 * not measurements, and never count as evidence on their own.
 */
import type { GateResult, Signal } from "../core/types.ts";

export interface EvidenceSummary {
  /** 0..1 composite. */
  score: number;
  storeDemand: number;
  attention: number;
  money: number;
  /** Distinct kinds of measured evidence (store, attention, money, owner), 0..1. */
  breadth: number;
  /** Measured signals among those cited. */
  measured: number;
  kinds: EvidenceKind[];
  notes: string[];
}

export type EvidenceKind = "store" | "attention" | "money" | "owner";

export const EVIDENCE_WEIGHTS = { storeDemand: 0.35, attention: 0.2, money: 0.3, breadth: 0.15 } as const;
/** Below this the evidence gate warns: the idea leans on thin demand. */
export const EVIDENCE_WARN_BELOW = 0.3;
/** Share of the deterministic gate score the evidence gate takes when evidence is screened. */
export const EVIDENCE_GATE_WEIGHT = 0.2;
/** Attention this strong with no money evidence reads as hype. */
const HYPE_ATTENTION = 0.6;
const HYPE_MONEY = 0.15;
const HYPE_CAP = 0.45;

const clamp01 = (x: number) => Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0));
const log10p = (x: number) => Math.log10(1 + Math.max(0, x));
const m = (s: Signal, key: string) => s.metrics[key] ?? 0;

/** Signals that carry measurements rather than an LLM's summary. */
export function isMeasured(s: Signal): boolean {
  return s.source === "app_store_chart" || s.source === "app_store_search" || s.source === "social_trend" || s.source === "manual";
}

function storeDemand(s: Signal): number {
  if (s.source === "app_store_search") {
    // 100k ratings on a top result is a proven market; momentum adds up to 0.2.
    const base = log10p(m(s, "ratings")) / 5;
    const momentum = Math.min(0.2, log10p(m(s, "ratingsPerDay")) / 10);
    return clamp01(base + momentum);
  }
  if (s.source === "app_store_chart") {
    const rank = m(s, "rank") || 200;
    const base = 1 - Math.log10(rank) / Math.log10(200);
    const rising = m(s, "rankDelta") > 0 ? Math.min(0.15, m(s, "rankDelta") / 100) : 0;
    const fresh = m(s, "newEntry") > 0 ? 0.1 : 0;
    return clamp01(base + rising + fresh);
  }
  return 0;
}

function attention(s: Signal): number {
  if (s.source !== "social_trend") return 0;
  if (s.trend === "youtube") return clamp01(log10p(m(s, "viewsPerDay")) / 5.5); // ~300k views/day across the top videos
  if (s.trend === "instagram") return clamp01(log10p(m(s, "recentMedianEngagement") || m(s, "medianEngagement")) / 4.5);
  return 0;
}

function money(s: Signal): number {
  if (s.source === "social_trend" && s.trend === "meta_ads") {
    return clamp01(
      0.5 * clamp01(m(s, "longRunningAdvertisers") / 5) + 0.3 * clamp01(m(s, "longRunningAds") / 15) + 0.2 * clamp01(m(s, "longRunningAppAds") / 5),
    );
  }
  if (s.source === "app_store_search" && m(s, "priceCents") > 0) return clamp01(0.3 + log10p(m(s, "ratings")) / 10);
  if (s.source === "app_store_chart" && s.tags.includes("top-paid")) return clamp01(0.4 + storeDemand(s) * 0.4);
  return 0;
}

/** Score the measured signals an idea cites. */
export function evidenceFor(cited: Signal[]): EvidenceSummary {
  const measured = cited.filter(isMeasured);
  const best = (f: (s: Signal) => number) => measured.reduce((x, s) => Math.max(x, f(s)), 0);
  const sd = best(storeDemand);
  const at = best(attention);
  const mo = best(money);
  const owner = measured.some((s) => s.source === "manual");
  const kinds: EvidenceKind[] = [];
  if (sd > 0) kinds.push("store");
  if (at > 0) kinds.push("attention");
  if (mo > 0) kinds.push("money");
  if (owner) kinds.push("owner");
  const breadth = clamp01(kinds.length / 3);
  let score = EVIDENCE_WEIGHTS.storeDemand * sd + EVIDENCE_WEIGHTS.attention * at + EVIDENCE_WEIGHTS.money * mo + EVIDENCE_WEIGHTS.breadth * breadth;
  const notes: string[] = [];
  if (at >= HYPE_ATTENTION && mo < HYPE_MONEY && sd < HYPE_ATTENTION) {
    score = Math.min(score, HYPE_CAP);
    notes.push("attention without paying advertisers or proven store demand (possible fad)");
  }
  if (owner) score = Math.max(score, 0.35); // the owner's own lead counts as a floor, never as proof
  const ignored = cited.length - measured.length;
  if (ignored > 0) notes.push(`${ignored} cited pattern summar${ignored === 1 ? "y" : "ies"} not counted as evidence`);
  return {
    score: round3(clamp01(score)),
    storeDemand: round3(sd),
    attention: round3(at),
    money: round3(mo),
    breadth: round3(breadth),
    measured: measured.length,
    kinds,
    notes,
  };
}

/** Fail without measured evidence or below `minScore`, warn when it is thin, pass otherwise. */
export function gateEvidence(e: EvidenceSummary, minScore = 0): GateResult {
  const parts = `store ${e.storeDemand.toFixed(2)}, attention ${e.attention.toFixed(2)}, money ${e.money.toFixed(2)}`;
  const notes = e.notes.length > 0 ? `; ${e.notes.join("; ")}` : "";
  if (e.measured === 0) return { gate: "evidence.demand", verdict: "fail", score: 0, reason: `cites no measured demand signal${notes}` };
  if (e.score < minScore) {
    return { gate: "evidence.demand", verdict: "fail", score: e.score, reason: `evidence ${e.score.toFixed(2)} below the ${minScore.toFixed(2)} minimum (${parts})${notes}` };
  }
  if (e.score < EVIDENCE_WARN_BELOW) {
    return { gate: "evidence.demand", verdict: "warn", score: e.score, reason: `thin evidence ${e.score.toFixed(2)} (${parts})${notes}` };
  }
  return { gate: "evidence.demand", verdict: "pass", score: e.score, reason: `evidence ${e.score.toFixed(2)} from ${e.kinds.join(", ")} (${parts})${notes}` };
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
