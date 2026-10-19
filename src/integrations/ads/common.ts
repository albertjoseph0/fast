/**
 * Shared pieces of the ad-network adapters: per-network contract, money conversion,
 * attribution maturity and composite campaign ids.
 */
import { createHash } from "node:crypto";
import type { AdsWrite, Clock } from "../../core/ports.ts";
import type { StudioStore } from "../../core/store.ts";
import type { AdDailyStats, Cents } from "../../core/types.ts";
import type { StudioConfig } from "../../config/schema.ts";
import { addDays } from "../../core/clock.ts";
import type { DryRunRecorder, HttpRequest } from "../http.ts";

export type CreateCampaignRequest = Parameters<AdsWrite["createCampaign"]>[0];

/** Uniform constructor options for the live ad clients (composed in integrations/live.ts). */
export interface AdsClientOptions {
  config: StudioConfig;
  store: StudioStore;
  env: Record<string, string | undefined>;
  dryRun: boolean;
  recorder?: DryRunRecorder;
  fetch?: typeof fetch;
  clock?: Clock;
  sleep?: (ms: number) => Promise<void>;
}

/** One network's campaign surface; LiveAdsRead/LiveAdsWrite dispatch to these. */
export interface NetworkAdapter {
  createCampaign(req: CreateCampaignRequest): Promise<{ campaignExternalId: string }>;
  setDailyBudget(campaignExternalId: string, dailyBudgetCents: Cents): Promise<void>;
  pause(campaignExternalId: string): Promise<void>;
  stats(campaignExternalId: string, since: string, until: string): Promise<AdDailyStats[]>;
}

/** Days before a network's install attribution for a date is treated as settled. */
export const ATTRIBUTION_LAG_DAYS = 2;

/** False for the most recent `lagDays` days (today included). */
export function attributionComplete(date: string, today: string, lagDays = ATTRIBUTION_LAG_DAYS): boolean {
  return date <= addDays(today, -lagDays);
}

/** "12.34" (major units) → 1234 cents. */
export function amountToCents(amount: string | number | undefined | null): Cents {
  const n = typeof amount === "number" ? amount : Number(amount ?? 0);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

/** 1234 cents → "12.34". */
export function centsToAmount(cents: Cents): string {
  if (!Number.isInteger(cents)) throw new Error(`money must be integer cents, got ${cents}`);
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function int(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/** `${account}:${campaign}` for networks whose later calls need the account. */
export function joinId(accountId: string, campaignId: string): string {
  return `${accountId}:${campaignId}`;
}

export function splitId(externalId: string, network: string): { accountId: string; campaignId: string } {
  const i = externalId.indexOf(":");
  if (i <= 0 || i === externalId.length - 1) throw new Error(`${network} campaign id "${externalId}" is not <account>:<campaign>`);
  return { accountId: externalId.slice(0, i), campaignId: externalId.slice(i + 1) };
}

export function dryId(kind: string, req: Pick<HttpRequest, "method" | "url" | "json" | "body">): string {
  const body = req.json !== undefined ? JSON.stringify(req.json) : typeof req.body === "string" ? req.body : "";
  const tag = createHash("sha256").update(`${req.method} ${req.url} ${body}`).digest("hex").slice(0, 12);
  return `dry_${kind}_${tag}`;
}

export function isDry(id: string): boolean {
  return id.startsWith("dry_") || id.includes(":dry_");
}

/** Inclusive date ranges of at most `maxDays` days covering since..until. */
export function dateChunks(since: string, until: string, maxDays: number): { start: string; end: string }[] {
  const out: { start: string; end: string }[] = [];
  for (let start = since; start <= until; start = addDays(start, maxDays)) {
    const end = addDays(start, maxDays - 1);
    out.push({ start, end: end < until ? end : until });
  }
  return out;
}

/** Shape checks every network shares; budgets are never open-ended. */
export function validateCampaign(req: CreateCampaignRequest): void {
  if (!Number.isInteger(req.dailyBudgetCents) || req.dailyBudgetCents <= 0) throw new Error(`daily budget must be positive integer cents, got ${req.dailyBudgetCents}`);
  if (!req.endAt || req.endAt <= req.startAt) throw new Error(`campaign ${req.name}: endAt (${req.endAt}) must be after startAt (${req.startAt})`);
  if (!req.geos.length) throw new Error(`campaign ${req.name}: at least one geo is required`);
}

/** Store URL ad networks deep-link to for the venture's app. */
export function storeUrl(req: CreateCampaignRequest): string {
  const b = req.bindings;
  if (req.os === "ios") {
    if (b.appStoreUrl) return b.appStoreUrl;
    if (b.ascAppId) return `https://apps.apple.com/app/id${b.ascAppId}`;
    throw new Error("iOS campaign needs bindings.appStoreUrl or ascAppId");
  }
  return b.playUrl ?? `https://play.google.com/store/apps/details?id=${b.androidPackage}`;
}
