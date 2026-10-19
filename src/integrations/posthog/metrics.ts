/**
 * Pure assembly of HogQL result rows (and studio-store exposure facts) into the
 * MetricsPort shapes. Money arrives from RevenueCat's PostHog integration as USD floats in
 * the `revenue` property (configure the integration to report gross revenue); proceeds are
 * derived here with the same VAT and store-fee arithmetic the lab uses.
 */
import type { StudioConfig } from "../../config/schema.ts";
import type { CellMetricRequest } from "../../core/ports.ts";
import type { StudioStore } from "../../core/store.ts";
import { ChannelKind } from "../../core/types.ts";
import type { CohortMetrics, DailyMetrics, StorePlatform } from "../../core/types.ts";
import { EV } from "../../core/events.ts";
import type { EventName } from "../../core/events.ts";
import { netPriceCents } from "../../lab/ltv.ts";
import { fromAscTerritory, toAscTerritory } from "../apple/territories.ts";

export interface MetricCounts {
  successes: number;
  trials: number;
  bySource: Record<string, { successes: number; trials: number }>;
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** Cohort ages emitted, matching the simulator. */
export const COHORT_AGES = [0, 1, 2, 3, 4, 5, 6, 7, 10, 14, 21, 30, 45, 60, 90, 120, 180, 270, 365];

/** Storefront codes a geo cell matches: the alpha-2 code and StoreKit's alpha-3 code. */
export function geoCodes(geo: string): string[] {
  const upper = geo.toUpperCase();
  try {
    return [upper, toAscTerritory(upper)];
  } catch {
    return [upper];
  }
}

/** Normalize a storefront or GeoIP code to alpha-2 ('' stays ''). */
export function normalizeGeo(code: string): string {
  return code ? fromAscTerritory(code) : "";
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function str(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

function usdCents(v: unknown): number {
  return Math.round(num(v) * 100);
}

function platformOf(v: string): StorePlatform {
  return v.toLowerCase() === "android" ? "android" : "ios";
}

/** PostHog renders DateTimes as "YYYY-MM-DD HH:MM:SS(.fff)" in UTC (or ISO with an offset). */
export function parseTs(v: unknown): number {
  const s = str(v);
  if (!s) return Number.NaN;
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  return new Date(/(Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`).getTime();
}

/** cellMetricQuery rows → counts. */
export function cellCounts(rows: unknown[][]): MetricCounts {
  const out: MetricCounts = { successes: 0, trials: 0, bySource: {} };
  for (const [source, trials, successes] of rows) {
    const t = num(trials);
    const s = num(successes);
    out.trials += t;
    out.successes += s;
    const key = str(source) || "unknown";
    const slot = (out.bySource[key] ??= { successes: 0, trials: 0 });
    slot.trials += t;
    slot.successes += s;
  }
  return out;
}

/** In-geo views of the cell's mature posts (creator submissions and owned content), by source. */
export function viewExposure(store: StudioStore, req: CellMetricRequest): { trials: number; firstPostedAt: number | null; bySource: Record<string, number> } {
  const asOf = new Date(req.asOf).getTime();
  const geo = req.geo.toUpperCase();
  const mature = (postedAt: string | undefined) => Boolean(postedAt) && new Date(postedAt as string).getTime() + req.maturityHours * HOUR_MS <= asOf;
  const bySource: Record<string, number> = {};
  let trials = 0;
  let first = Number.POSITIVE_INFINITY;
  const add = (source: string, views: number, postedAt: string) => {
    if (views <= 0) return;
    trials += views;
    bySource[source] = (bySource[source] ?? 0) + views;
    first = Math.min(first, new Date(postedAt).getTime());
  };
  const campaigns = new Set(store.campaigns.list((c) => c.experimentId === req.experimentId && c.cellId === req.cellId).map((c) => c.id));
  for (const s of store.submissions.list((x) => campaigns.has(x.campaignId) && ["posted", "post_approved", "paid"].includes(x.stage))) {
    if (!s.verification || !mature(s.postedAt)) continue;
    const share = s.verification.audienceGeo?.[geo] ?? store.creators.get(s.creatorId)?.audienceGeo[geo] ?? 0;
    add(s.creatorId, Math.round((s.viewsAtLock ?? s.verification.viewsFromPlatform) * share), s.postedAt as string);
  }
  for (const c of store.content.list((x) => x.ventureId === req.ventureId && x.experimentId === req.experimentId && x.cellId === req.cellId && x.status === "posted")) {
    if (!mature(c.postedAt) || !c.stats?.views) continue;
    add(`owned:${c.accountId ?? c.id}`, Math.round(c.stats.views * (c.stats.audienceGeo?.[geo] ?? 0)), c.postedAt as string);
  }
  return { trials, firstPostedAt: Number.isFinite(first) ? first : null, bySource };
}

/** Owned posts of the experiment reaching the attention threshold (S0). */
export function postExposure(store: StudioStore, req: CellMetricRequest, hitViews: number): MetricCounts {
  const asOf = new Date(req.asOf).getTime();
  const out: MetricCounts = { successes: 0, trials: 0, bySource: {} };
  for (const c of store.content.list((x) => x.ventureId === req.ventureId && x.experimentId === req.experimentId && (x.cellId === undefined || x.cellId === req.cellId))) {
    if (c.status !== "posted" || !c.postedAt || new Date(c.postedAt).getTime() + req.maturityHours * HOUR_MS > asOf) continue;
    const hit = (c.stats?.views ?? 0) >= hitViews ? 1 : 0;
    out.trials += 1;
    out.successes += hit;
    out.bySource[c.id] = { successes: hit, trials: 1 };
  }
  return out;
}

/** UTC day start (ms) of an ISO timestamp. */
export function dayStartMs(iso: string): number {
  return Math.floor(new Date(iso).getTime() / DAY_MS) * DAY_MS;
}

export interface Purchase {
  person: string;
  geo: string;
  ts: number;
  expires: number;
}

/** subscriptionsQuery rows → purchases (oldest first). */
export function purchases(rows: unknown[][]): Purchase[] {
  return rows
    .map(([pid, geo, ts, expires]) => ({ person: str(pid), geo: normalizeGeo(str(geo)), ts: parseTs(ts), expires: parseTs(expires) }))
    .filter((p) => Number.isFinite(p.ts))
    .sort((a, b) => a.ts - b.ts);
}

/** Persons whose latest purchase at `at` still grants access, total and by geo. */
export function activeAt(list: Purchase[], at: number): { total: number; byGeo: Record<string, number> } {
  const latest = new Map<string, Purchase>();
  for (const p of list) if (p.ts <= at) latest.set(p.person, p);
  const out = { total: 0, byGeo: {} as Record<string, number> };
  for (const p of latest.values()) {
    if (!(p.expires > at)) continue;
    out.total += 1;
    if (p.geo) out.byGeo[p.geo] = (out.byGeo[p.geo] ?? 0) + 1;
  }
  return out;
}

function emptyDaily(ventureId: string, date: string, geo: string | null, complete: boolean): DailyMetrics {
  return { ventureId, date, cellId: null, geo, counts: {}, grossRevenueCents: 0, proceedsCents: 0, refundsCents: 0, activeSubscribers: 0, reportedSpendCents: 0, complete };
}

const REVENUE_EVENTS = new Set<string>([EV.conversion, EV.renewal]);

/** dailyQuery + subscriptionsQuery rows → one venture row per day plus one row per (day, geo). */
export function buildDaily(input: {
  ventureId: string;
  since: string;
  until: string;
  completeThrough: string;
  config: StudioConfig;
  rows: unknown[][];
  purchases: Purchase[];
}): DailyMetrics[] {
  const days: string[] = [];
  for (let t = new Date(`${input.since}T00:00:00Z`).getTime(); t <= new Date(`${input.until}T00:00:00Z`).getTime(); t += DAY_MS) days.push(new Date(t).toISOString().slice(0, 10));
  const totals = new Map<string, DailyMetrics>();
  const byGeo = new Map<string, DailyMetrics>();
  for (const d of days) totals.set(d, emptyDaily(input.ventureId, d, null, d <= input.completeThrough));
  const geoRow = (d: string, geo: string) => {
    const key = `${d}|${geo}`;
    let row = byGeo.get(key);
    if (!row) byGeo.set(key, (row = emptyDaily(input.ventureId, d, geo, d <= input.completeThrough)));
    return row;
  };
  for (const [day, rawGeo, platform, event, n, revenue] of input.rows) {
    const d = str(day).slice(0, 10);
    const total = totals.get(d);
    if (!total) continue;
    const geo = normalizeGeo(str(rawGeo));
    const targets = geo ? [total, geoRow(d, geo)] : [total];
    const name = str(event) as EventName;
    const cents = usdCents(revenue);
    for (const row of targets) {
      row.counts[name] = (row.counts[name] ?? 0) + num(n);
      if (REVENUE_EVENTS.has(name)) {
        row.grossRevenueCents += cents;
        row.proceedsCents += Math.round(netPriceCents(cents, geo, platformOf(str(platform)), input.config));
      } else if (name === EV.refund) {
        row.refundsCents += Math.abs(cents);
      }
    }
  }
  for (const d of days) {
    const active = activeAt(input.purchases, new Date(`${d}T00:00:00Z`).getTime() + DAY_MS - 1);
    (totals.get(d) as DailyMetrics).activeSubscribers = active.total;
    for (const [geo, count] of Object.entries(active.byGeo)) geoRow(d, geo).activeSubscribers = count;
  }
  const geoRows = [...byGeo.values()].sort((a, b) => (a.date === b.date ? (a.geo as string).localeCompare(b.geo as string) : a.date.localeCompare(b.date)));
  return [...totals.values(), ...geoRows];
}

export interface CohortPerson {
  installedAt: number;
  cohortDate: string;
  geo: string;
  platform: StorePlatform;
  source: string;
  channel: ChannelKind;
  experiment: string;
  cell: string;
  events: { event: string; ts: number; cents: number; expires: number }[];
}

const CHANNELS = new Set<string>(ChannelKind.options);

/** Person property `channel` when valid; otherwise creators when a source is known, else store search. */
function channelOf(raw: string, source: string): ChannelKind {
  if (CHANNELS.has(raw)) return raw as ChannelKind;
  return source !== "unknown" ? "creator_ugc" : "app_store_search";
}

/** cohortQuery rows → persons with their post-install events. */
export function cohortPersons(rows: unknown[][]): CohortPerson[] {
  const persons = new Map<string, CohortPerson>();
  for (const [pid, t0, geo, platform, source, channel, experiment, cell, event, ts, revenue, expires] of rows) {
    const id = str(pid);
    let p = persons.get(id);
    if (!p) {
      const installedAt = parseTs(t0);
      if (!Number.isFinite(installedAt)) continue;
      const src = str(source) || "unknown";
      p = {
        installedAt,
        cohortDate: new Date(installedAt).toISOString().slice(0, 10),
        geo: normalizeGeo(str(geo)) || "unknown",
        platform: platformOf(str(platform)),
        source: src,
        channel: channelOf(str(channel), src),
        experiment: str(experiment),
        cell: str(cell),
        events: [],
      };
      persons.set(id, p);
    }
    const name = str(event);
    const at = parseTs(ts);
    if (name && Number.isFinite(at)) p.events.push({ event: name, ts: at, cents: usdCents(revenue), expires: parseTs(expires) });
  }
  return [...persons.values()];
}

/** Cumulative cohort rows per (install date, lane) at each age up to maxAgeDays and the last full day. */
export function buildCohorts(input: { ventureId: string; persons: CohortPerson[]; asOf: string; maxAgeDays: number; config: StudioConfig }): CohortMetrics[] {
  const groups = new Map<string, CohortPerson[]>();
  for (const p of input.persons) {
    const lane = `${input.ventureId}|${p.channel}|${p.geo}|${p.source}`;
    const key = `${p.cohortDate}|${lane}`;
    const list = groups.get(key);
    if (list) list.push(p);
    else groups.set(key, [p]);
  }
  const today = dayStartMs(input.asOf);
  const out: CohortMetrics[] = [];
  for (const [key, list] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const first = list[0] as CohortPerson;
    const lane = key.slice(first.cohortDate.length + 1);
    const cohortStart = new Date(`${first.cohortDate}T00:00:00Z`).getTime();
    const maxAge = Math.min(input.maxAgeDays, Math.round((today - cohortStart) / DAY_MS) - 1);
    const sameExperiment = list.every((p) => p.experiment === first.experiment) && first.experiment !== "";
    const sameCell = list.every((p) => p.cell === first.cell) && first.cell !== "";
    for (const age of COHORT_AGES) {
      if (age > maxAge) break;
      const cutoff = cohortStart + (age + 1) * DAY_MS;
      const row: CohortMetrics = {
        ventureId: input.ventureId,
        cohortDate: first.cohortDate,
        ageDays: age,
        platform: first.platform,
        geo: first.geo,
        channel: first.channel,
        lane,
        installs: list.length,
        spendCents: 0,
        trialStarts: 0,
        trialCancels: 0,
        conversions: 0,
        renewals: 0,
        activeSubscribers: 0,
        grossRevenueCents: 0,
        proceedsCents: 0,
        refundsCents: 0,
        ...(sameExperiment ? { experimentId: first.experiment } : {}),
        ...(sameCell ? { cellId: first.cell } : {}),
      };
      for (const p of list) {
        const seen = p.events.filter((e) => e.ts < cutoff);
        const has = (event: string) => seen.some((e) => e.event === event);
        if (has(EV.trialStart)) row.trialStarts += 1;
        if (has(EV.trialCancel)) row.trialCancels += 1;
        if (has(EV.conversion)) row.conversions += 1;
        let latest: (typeof seen)[number] | undefined;
        for (const e of seen) {
          if (e.event === EV.renewal) row.renewals += 1;
          if (REVENUE_EVENTS.has(e.event)) {
            row.grossRevenueCents += e.cents;
            row.proceedsCents += Math.round(netPriceCents(e.cents, p.geo, p.platform, input.config));
            if (!latest || e.ts >= latest.ts) latest = e;
          } else if (e.event === EV.refund) {
            row.refundsCents += Math.abs(e.cents);
          }
        }
        if (latest && latest.expires >= cutoff) row.activeSubscribers += 1;
      }
      out.push(row);
    }
  }
  return out;
}
