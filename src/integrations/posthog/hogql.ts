/**
 * A small, safe HogQL builder and the studio's analytics queries.
 *
 * Nothing caller-supplied is ever spliced into query text. Values travel in the query's
 * `values` object and are referenced as {placeholders} (PostHog's HogQLQuery.values);
 * identifiers (property names) cannot be placeholders, so they must match
 * /^[A-Za-z0-9_$.-]+$/ and are backtick-quoted when not plain. Timestamps must be ISO-8601.
 *
 * Event semantics follow core/events.ts. Derived events are computed here:
 *   trial_matured_24h  trial_start at least 24h old       trial_kept_24h  no trial_cancel within 24h
 *   trial_matured      trial_start older than trial_days  d1_eligible     install at least 48h old
 *   d1_retained        session in [24h, 48h) after install
 *   invite_install     installs whose `inviter_distinct_id` property names the person
 * Proportions count unique persons: each person counts once in the denominator (their first
 * qualifying event) and at most once in the numerator. Rates count numerator events.
 */
import { APP_EVENTS, EV } from "../../core/events.ts";
import type { EventName } from "../../core/events.ts";

export class HogQLError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HogQLError";
  }
}

export interface HogQLQuery {
  query: string;
  values: Record<string, string | number>;
}

const IDENT = /^[A-Za-z0-9_$.-]+$/;
const PLAIN_IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const ISO = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const MAX_STRING = 1_000;
const ROW_LIMIT = 50_000;

/** Validate an identifier and quote it for HogQL when it is not a plain name. */
export function ident(name: string): string {
  if (!IDENT.test(name) || name.length > 200) throw new HogQLError(`invalid HogQL identifier: ${JSON.stringify(name)}`);
  return PLAIN_IDENT.test(name) ? name : `\`${name}\``;
}

/** Validate an ISO-8601 date or timestamp and normalize it to UTC "YYYY-MM-DD HH:MM:SS". */
export function isoTimestamp(value: string): string {
  if (!ISO.test(value)) throw new HogQLError(`invalid ISO timestamp: ${JSON.stringify(value)}`);
  const ms = new Date(value.length === 10 ? `${value}T00:00:00Z` : value).getTime();
  if (!Number.isFinite(ms)) throw new HogQLError(`invalid ISO timestamp: ${JSON.stringify(value)}`);
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

/** Collects placeholder values while a query is assembled. */
export class HogQLBuilder {
  private readonly values: Record<string, string | number> = {};
  private n = 0;

  /** A string or number value as a {placeholder}. */
  value(v: string | number): string {
    if (typeof v === "number") {
      if (!Number.isFinite(v)) throw new HogQLError(`invalid HogQL number: ${v}`);
    } else if (v.length > MAX_STRING || v.includes("\u0000")) {
      throw new HogQLError("invalid HogQL string value");
    }
    const key = `v${this.n++}`;
    this.values[key] = v;
    return `{${key}}`;
  }

  /** An ISO timestamp value as a UTC DateTime expression. */
  time(iso: string): string {
    return `toDateTime(${this.value(isoTimestamp(iso))}, 'UTC')`;
  }

  /** A non-empty list of values for IN (...). */
  list(vs: readonly (string | number)[]): string {
    if (!vs.length) throw new HogQLError("empty HogQL list");
    return `(${vs.map((v) => this.value(v)).join(", ")})`;
  }

  /** A whole number of hours as an interval (inlined: validated as a safe integer). */
  hours(h: number): string {
    if (!Number.isSafeInteger(h) || h < 0) throw new HogQLError(`invalid hour count: ${h}`);
    return `toIntervalHour(${h})`;
  }

  build(query: string): HogQLQuery {
    return { query: query.replace(/\s+/g, " ").trim(), values: { ...this.values } };
  }
}

/** `properties.<name>` / `person.properties.<name>` as a string ('' when missing). */
export function prop(scope: "event" | "person", name: string): string {
  const base = scope === "event" ? "properties" : "person.properties";
  return `ifNull(toString(${base}.${ident(name)}), '')`;
}

const APP_EVENT_NAMES = new Set<string>(Object.values(APP_EVENTS));
const NOT_INTERNAL = `${prop("event", "is_internal")} != 'true'`;
/** Storefront person property (StoreKit alpha-3 or alpha-2), else the install-time GeoIP country. */
export const GEO_EXPR = `upper(if(${prop("person", "storefront")} != '', ${prop("person", "storefront")}, ${prop("person", "$initial_geoip_country_code")}))`;
const CELL_EXPR = `if(${prop("event", "cell_id")} != '', ${prop("event", "cell_id")}, ${prop("person", "cell_id")})`;
const SOURCE_EXPR = `if(${prop("person", "source_id")} != '', ${prop("person", "source_id")}, 'unknown')`;
const REVENUE_EXPR = `ifNull(toFloat(properties.revenue), 0)`;
/** RevenueCat sends `platform` (iOS/Android); app events carry `$os`. */
const PLATFORM_EXPR = `lower(if(${prop("event", "platform")} != '', ${prop("event", "platform")}, ${prop("event", "$os")}))`;

/** App events carry app_slug; RevenueCat's server events do not (one project per venture anyway). */
function eventFilter(q: HogQLBuilder, event: string, appSlug: string): string {
  const base = `event = ${q.value(event)}`;
  return APP_EVENT_NAMES.has(event) ? `${base} AND ${prop("event", "app_slug")} = ${q.value(appSlug)} AND ${NOT_INTERNAL}` : base;
}

export type CellSelector = { kind: "geo"; geoCodes: string[] } | { kind: "user_random"; cellId: string };

function cellFilter(q: HogQLBuilder, cell: CellSelector): string {
  return cell.kind === "geo" ? `${GEO_EXPR} IN ${q.list(cell.geoCodes.map((g) => g.toUpperCase()))}` : `${CELL_EXPR} = ${q.value(cell.cellId)}`;
}

interface DenominatorSpec {
  event: string;
  minAgeHours: number;
  /** Mature only once the trial period (trial_days, default 3) has passed. */
  trialPeriod: boolean;
}

interface NumeratorSpec {
  event: string;
  mode: "exists" | "absent" | "count";
  fromHours: number;
  toHours: number | null;
  /** Join on the inviter named by the event instead of the event's own person. */
  byInviter: boolean;
}

const DEFAULT_TRIAL_DAYS = 3;
const RATE_NUMERATORS = new Set<EventName>([EV.inviteInstall]);

export function denominatorSpec(event: EventName, maturityHours: number): DenominatorSpec {
  const h = Math.ceil(maturityHours);
  switch (event) {
    case EV.trialMatured24h:
      return { event: EV.trialStart, minAgeHours: Math.max(h, 24), trialPeriod: false };
    case EV.trialMatured:
      return { event: EV.trialStart, minAgeHours: h, trialPeriod: true };
    case EV.d1Eligible:
      return { event: EV.install, minAgeHours: Math.max(h, 48), trialPeriod: false };
    default:
      return { event, minAgeHours: h, trialPeriod: false };
  }
}

export function numeratorSpec(event: EventName, windowHours?: number): NumeratorSpec {
  const to = windowHours === undefined ? null : Math.ceil(windowHours);
  switch (event) {
    case EV.trialKept24h:
      return { event: EV.trialCancel, mode: "absent", fromHours: 0, toHours: 24, byInviter: false };
    case EV.d1Retained:
      return { event: EV.session, mode: "exists", fromHours: 24, toHours: 48, byInviter: false };
    case EV.inviteInstall:
      return { event: EV.install, mode: "count", fromHours: 0, toHours: to, byInviter: true };
    default:
      return { event, mode: RATE_NUMERATORS.has(event) ? "count" : "exists", fromHours: 0, toHours: to, byInviter: false };
  }
}

export interface CellMetricQueryInput {
  appSlug: string;
  numerator: EventName;
  denominator: EventName;
  maturityHours: number;
  windowHours?: number;
  since: string;
  asOf: string;
  cell: CellSelector;
}

/** Rows: [source, trials, successes] per traffic source (person property source_id). */
export function cellMetricQuery(input: CellMetricQueryInput): HogQLQuery {
  const q = new HogQLBuilder();
  const den = denominatorSpec(input.denominator, input.maturityHours);
  const num = numeratorSpec(input.numerator, input.windowHours);
  const since = q.time(input.since);
  const asOf = q.time(input.asOf);
  const trialAge = den.trialPeriod
    ? `HAVING t0 + toIntervalDay(toInt(ifNull(trial_days, ${q.value(DEFAULT_TRIAL_DAYS)}))) <= ${asOf}`
    : "";
  const denSelect = `
    SELECT person_id AS pid, min(timestamp) AS t0, any(${SOURCE_EXPR}) AS source, any(distinct_id) AS did
      ${den.trialPeriod ? ", argMin(toFloat(properties.trial_days), timestamp) AS trial_days" : ""}
    FROM events
    WHERE ${eventFilter(q, den.event, input.appSlug)}
      AND timestamp >= ${since} AND timestamp <= ${asOf} - ${q.hours(den.minAgeHours)}
      AND ${cellFilter(q, input.cell)}
    GROUP BY person_id ${trialAge}`;
  const numSelect = num.byInviter
    ? `SELECT ${prop("event", "inviter_distinct_id")} AS inviter, timestamp AS ts
       FROM events
       WHERE ${eventFilter(q, num.event, input.appSlug)} AND timestamp >= ${since} AND timestamp <= ${asOf} AND ${prop("event", "inviter_distinct_id")} != ''`
    : `SELECT person_id AS pid, timestamp AS ts
       FROM events
       WHERE ${eventFilter(q, num.event, input.appSlug)} AND timestamp >= ${since} AND timestamp <= ${asOf}`;
  const join = num.byInviter ? "num.inviter = den.did" : "num.pid = den.pid";
  const inWindow = [
    `num.ts >= den.t0 + ${q.hours(num.fromHours)}`,
    num.toHours === null ? `num.ts <= ${asOf}` : `num.ts < den.t0 + ${q.hours(num.toHours)}`,
  ].join(" AND ");
  const hit = num.mode === "count" ? `countIf(${inWindow})` : num.mode === "exists" ? `max(if(${inWindow}, 1, 0))` : `1 - max(if(${inWindow}, 1, 0))`;
  return q.build(`
    SELECT source, count() AS trials, sum(hit) AS successes
    FROM (
      SELECT den.pid AS pid, any(den.source) AS source, ${hit} AS hit
      FROM (${denSelect}) AS den
      LEFT JOIN (${numSelect}) AS num ON ${join}
      GROUP BY den.pid
    )
    GROUP BY source
    ORDER BY source
    LIMIT ${ROW_LIMIT}`);
}

/** Rows: [internal, total]: internal_session vs all sessions in the cell (its cell_id, or untagged in its geo). */
export function internalShareQuery(input: { appSlug: string; cellId: string; geoCodes: string[]; since: string; asOf: string }): HogQLQuery {
  const q = new HogQLBuilder();
  return q.build(`
    SELECT countIf(event = ${q.value(EV.internalSession)}) AS internal, count() AS total
    FROM events
    WHERE event IN ${q.list([EV.session, EV.internalSession])}
      AND ${prop("event", "app_slug")} = ${q.value(input.appSlug)}
      AND timestamp >= ${q.time(input.since)} AND timestamp <= ${q.time(input.asOf)}
      AND (${CELL_EXPR} = ${q.value(input.cellId)} OR (${CELL_EXPR} = '' AND ${GEO_EXPR} IN ${q.list(input.geoCodes.map((g) => g.toUpperCase()))}))`);
}

/** Events counted in daily rows. */
export const DAILY_EVENTS: readonly EventName[] = [
  EV.install,
  EV.session,
  EV.onboardingStart,
  EV.onboardingComplete,
  EV.activated,
  EV.paywallView,
  EV.trialStart,
  EV.shareFirst,
  EV.share,
  EV.inviteSent,
  EV.conversion,
  EV.renewal,
  EV.trialCancel,
  EV.billingIssue,
  EV.refund,
];

/** Rows: [day, geo, platform, event, events, revenueUsd] for [since, until] (dates inclusive). */
export function dailyQuery(input: { appSlug: string; since: string; until: string }): HogQLQuery {
  const q = new HogQLBuilder();
  const from = q.time(input.since);
  const to = `${q.time(input.until)} + toIntervalDay(1)`;
  const app = DAILY_EVENTS.filter((e) => APP_EVENT_NAMES.has(e));
  const server = DAILY_EVENTS.filter((e) => !APP_EVENT_NAMES.has(e));
  return q.build(`
    SELECT toString(toDate(timestamp)) AS day, ${GEO_EXPR} AS geo, ${PLATFORM_EXPR} AS platform, event, count() AS n, sum(${REVENUE_EXPR}) AS revenue
    FROM events
    WHERE timestamp >= ${from} AND timestamp < ${to}
      AND ((event IN ${q.list(app)} AND ${prop("event", "app_slug")} = ${q.value(input.appSlug)} AND ${NOT_INTERNAL}) OR event IN ${q.list(server)})
    GROUP BY day, geo, platform, event
    ORDER BY day, geo, platform, event
    LIMIT ${ROW_LIMIT}`);
}

/** Rows: [person, geo, ts, expiration_at] for purchases that grant access, oldest first. */
export function subscriptionsQuery(input: { since: string; until: string }): HogQLQuery {
  const q = new HogQLBuilder();
  return q.build(`
    SELECT toString(person_id) AS pid, ${GEO_EXPR} AS geo, toString(timestamp) AS ts, ${prop("event", "expiration_at")} AS expires
    FROM events
    WHERE event IN ${q.list([EV.conversion, EV.renewal])}
      AND timestamp >= ${q.time(input.since)} AND timestamp < ${q.time(input.until)} + toIntervalDay(1)
    ORDER BY timestamp
    LIMIT ${ROW_LIMIT}`);
}

/** Events folded into cohort rows. */
export const COHORT_EVENTS: readonly EventName[] = [EV.trialStart, EV.trialCancel, EV.conversion, EV.renewal, EV.refund];

/**
 * Rows: [person, install_ts, geo, platform, source, channel, experiment, cell, event, ts, revenueUsd, expires]
 * for persons who installed in [cohortSince, cohortUntil]; event is '' for persons with no later event.
 */
export function cohortQuery(input: { appSlug: string; cohortSince: string; cohortUntil: string; asOf: string }): HogQLQuery {
  const q = new HogQLBuilder();
  const from = q.time(input.cohortSince);
  const asOf = q.time(input.asOf);
  return q.build(`
    SELECT toString(i.pid), toString(i.t0), i.geo, i.platform, i.source, i.channel, i.experiment, i.cell,
      ifNull(e.event, ''), toString(e.ts), ifNull(e.revenue, 0), ifNull(e.expires, '')
    FROM (
      SELECT person_id AS pid, min(timestamp) AS t0, any(${GEO_EXPR}) AS geo, any(${PLATFORM_EXPR}) AS platform,
        any(${SOURCE_EXPR}) AS source, any(${prop("person", "channel")}) AS channel,
        any(${prop("person", "experiment_id")}) AS experiment, any(${CELL_EXPR}) AS cell
      FROM events
      WHERE ${eventFilter(q, EV.install, input.appSlug)}
        AND timestamp >= ${from} AND timestamp < ${q.time(input.cohortUntil)} + toIntervalDay(1)
      GROUP BY person_id
    ) AS i
    LEFT JOIN (
      SELECT person_id AS pid, event, timestamp AS ts, ${REVENUE_EXPR} AS revenue, ${prop("event", "expiration_at")} AS expires
      FROM events
      WHERE event IN ${q.list(COHORT_EVENTS)} AND timestamp >= ${from} AND timestamp <= ${asOf}
    ) AS e ON e.pid = i.pid
    ORDER BY i.pid, e.ts
    LIMIT ${ROW_LIMIT}`);
}
