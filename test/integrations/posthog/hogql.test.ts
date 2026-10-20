import { describe, expect, it } from "vitest";
import {
  HogQLBuilder,
  HogQLError,
  cellMetricQuery,
  cohortQuery,
  dailyQuery,
  denominatorSpec,
  ident,
  internalShareQuery,
  isoTimestamp,
  numeratorSpec,
  paged,
  prop,
  subscriptionsQuery,
} from "../../../src/integrations/posthog/hogql.ts";

const base = { appSlug: "astro", since: "2026-10-01T00:00:00Z", asOf: "2026-10-10T12:00:00.000Z" } as const;

describe("HogQL literals", () => {
  it("accepts plain and dotted/dashed identifiers, quoting the latter", () => {
    expect(ident("source_id")).toBe("source_id");
    expect(ident("$initial_geoip_country_code")).toBe("$initial_geoip_country_code");
    expect(ident("utm-source.v2")).toBe("`utm-source.v2`");
    expect(prop("person", "storefront")).toBe("ifNull(toString(person.properties.storefront), '')");
  });

  it("rejects malicious identifiers", () => {
    for (const bad of ["a b", "x') OR 1=1 --", "a`b", "", "x;DROP", "a\nb", "é"]) expect(() => ident(bad)).toThrow(HogQLError);
  });

  it("validates ISO timestamps", () => {
    expect(isoTimestamp("2026-10-01")).toBe("2026-10-01 00:00:00");
    expect(isoTimestamp("2026-10-01T05:06:07.123+02:00")).toBe("2026-10-01 03:06:07");
    for (const bad of ["2026-10-01' OR 1=1", "yesterday", "2026-13-45", "1 day"]) expect(() => isoTimestamp(bad)).toThrow(HogQLError);
  });

  it("keeps values out of the query text", () => {
    const q = new HogQLBuilder();
    const evil = "astro' OR 1=1 --";
    const sql = q.build(`SELECT 1 WHERE x = ${q.value(evil)} AND y IN ${q.list(["a", "b"])} AND t > ${q.time("2026-10-01")}`);
    expect(sql.query).toBe("SELECT 1 WHERE x = {v0} AND y IN ({v1}, {v2}) AND t > toDateTime({v3}, 'UTC')");
    expect(sql.values).toEqual({ v0: evil, v1: "a", v2: "b", v3: "2026-10-01 00:00:00" });
    expect(() => q.value(Number.NaN)).toThrow(HogQLError);
    expect(() => q.value("a\u0000b")).toThrow(HogQLError);
    expect(() => q.list([])).toThrow(HogQLError);
    expect(() => q.hours(1.5)).toThrow(HogQLError);
  });
});

describe("derived event specs", () => {
  it("maps derived events onto app and server events", () => {
    expect(denominatorSpec("trial_matured_24h", 0)).toEqual({ event: "trial_start", minAgeHours: 24, trialPeriod: false });
    expect(denominatorSpec("trial_matured", 0)).toEqual({ event: "trial_start", minAgeHours: 0, trialPeriod: true });
    expect(denominatorSpec("d1_eligible", 0)).toEqual({ event: "install", minAgeHours: 48, trialPeriod: false });
    expect(numeratorSpec("trial_kept_24h")).toEqual({ event: "trial_cancel", mode: "absent", fromHours: 0, toHours: 24, byInviter: false });
    expect(numeratorSpec("d1_retained")).toEqual({ event: "session", mode: "exists", fromHours: 24, toHours: 48, byInviter: false });
    expect(numeratorSpec("invite_install", 168)).toEqual({ event: "install", mode: "count", fromHours: 0, toHours: 168, byInviter: true });
    expect(numeratorSpec("activated", 24)).toEqual({ event: "activated", mode: "exists", fromHours: 0, toHours: 24, byInviter: false });
  });
});

describe("cellMetricQuery", () => {
  it("geo cell: unique persons, maturity cutoff, window after the person's denominator, by source", () => {
    const q = cellMetricQuery({ ...base, numerator: "activated", denominator: "install", maturityHours: 24, windowHours: 24, cell: { kind: "geo", geoCodes: ["CA", "CAN"] } });
    expect(q.query).toContain("SELECT source, count() AS trials, sum(hit) AS successes");
    expect(q.query).toContain("SELECT person_id AS pid, min(timestamp) AS t0");
    expect(q.query).toContain("timestamp <= toDateTime({v1}, 'UTC') - toIntervalHour(24)");
    expect(q.query).toContain("max(if(num.ts >= den.t0 + toIntervalHour(0) AND num.ts < den.t0 + toIntervalHour(24), 1, 0)) AS hit");
    expect(q.query).toContain(
      "if(ifNull(toString(person.properties.source_id), '') != '', ifNull(toString(person.properties.source_id), ''), concat('unattributed:', toString(cityHash64(toString(person_id)) % 20)))",
    );
    expect(q.query).not.toContain("'unknown'");
    expect(q.query).toContain("ifNull(toString(person.properties.$initial_geoip_country_code), '')");
    expect(q.query).toContain("ifNull(toString(properties.is_internal), '') != 'true'");
    expect(q.query).toMatch(/IN \(\{v\d+\}, \{v\d+\}\)/);
    expect(Object.values(q.values)).toEqual(expect.arrayContaining(["install", "activated", "astro", "CA", "CAN", "2026-10-01 00:00:00", "2026-10-10 12:00:00"]));
  });

  it("user_random cell matches the sticky variant (cell_id)", () => {
    const q = cellMetricQuery({ ...base, numerator: "trial_start", denominator: "install", maturityHours: 24, windowHours: 72, cell: { kind: "user_random", cellId: "pw_b" } });
    expect(q.query).toContain("if(ifNull(toString(properties.cell_id), '') != '', ifNull(toString(properties.cell_id), ''), ifNull(toString(person.properties.cell_id), '')) = {v");
    expect(Object.values(q.values)).toContain("pw_b");
    expect(q.query).not.toContain("storefront");
  });

  it("server-side numerators are not filtered by app_slug", () => {
    const q = cellMetricQuery({ ...base, numerator: "conversion", denominator: "trial_matured", maturityHours: 0, cell: { kind: "geo", geoCodes: ["AU"] } });
    const numSide = q.query.slice(q.query.indexOf("LEFT JOIN"));
    expect(numSide).not.toContain("app_slug");
    expect(q.query).toContain("argMin(toFloat(properties.trial_days), timestamp) AS trial_days");
    expect(q.query).toContain("HAVING t0 + toIntervalDay(toInt(ifNull(trial_days, {v");
  });

  it("trial keep is the absence of a cancel within 24h; kFactor counts invitee installs", () => {
    const keep = cellMetricQuery({ ...base, numerator: "trial_kept_24h", denominator: "trial_matured_24h", maturityHours: 0, cell: { kind: "geo", geoCodes: ["NZ"] } });
    expect(keep.query).toContain("1 - max(if(");
    expect(Object.values(keep.values)).toContain("trial_cancel");
    const k = cellMetricQuery({ ...base, numerator: "invite_install", denominator: "activated", maturityHours: 168, windowHours: 168, cell: { kind: "geo", geoCodes: ["NZ"] } });
    expect(k.query).toContain("countIf(");
    expect(k.query).toContain("ON num.inviter = den.did");
  });

  it("never splices caller strings into the text", () => {
    const evil = "x' UNION SELECT * FROM persons --";
    const q = cellMetricQuery({ ...base, appSlug: evil, numerator: "activated", denominator: "install", maturityHours: 24, cell: { kind: "user_random", cellId: evil } });
    expect(q.query).not.toContain("UNION");
    expect(Object.values(q.values).filter((v) => v === evil)).toHaveLength(3);
    expect(() => cellMetricQuery({ ...base, asOf: "now() --", numerator: "activated", denominator: "install", maturityHours: 24, cell: { kind: "geo", geoCodes: ["CA"] } })).toThrow(HogQLError);
  });
});

describe("other queries", () => {
  it("internal share counts internal_session over all sessions in the cell", () => {
    const q = internalShareQuery({ appSlug: "astro", cellId: "c1", geoCodes: ["CA", "CAN"], since: base.since, asOf: base.asOf });
    expect(q.query).toContain("SELECT countIf(event = {v0}) AS internal, count() AS total");
    expect(q.values.v0).toBe("internal_session");
  });

  it("daily groups by day, geo, platform and event with revenue", () => {
    const q = dailyQuery({ appSlug: "astro", since: "2026-10-01", until: "2026-10-03" });
    expect(q.query).toContain("GROUP BY day, geo, platform, event");
    expect(q.query).toContain("sum(ifNull(toFloat(properties.revenue), 0)) AS revenue");
    expect(q.query).toContain("toDateTime({v1}, 'UTC') + toIntervalDay(1)");
  });

  it("cohort query joins installs to later subscription events", () => {
    const q = cohortQuery({ appSlug: "astro", cohortSince: "2026-09-01", cohortUntil: "2026-10-01", asOf: base.asOf });
    expect(q.query).toContain(") AS i LEFT JOIN (");
    expect(q.query).toContain("ORDER BY i.pid, e.ts, e.event, e.revenue, e.expires");
    expect(q.query).toMatch(/timestamp < toDateTime\(\{v\d+\}, 'UTC'\) \+ toIntervalDay\(1\) AND timestamp <= toDateTime\(\{v\d+\}, 'UTC'\) GROUP BY person_id/);
    expect(Object.values(q.values)).toEqual(expect.arrayContaining(["install", "trial_start", "conversion", "renewal", "refund"]));
  });
});

describe("paging", () => {
  it("orders every row-level query totally and reads it in LIMIT/OFFSET pages", () => {
    const subs = subscriptionsQuery({ since: "2025-10-01", until: "2026-10-10" });
    expect(subs.query).toContain("ORDER BY timestamp, pid, geo, expires");
    expect(subs.query).not.toContain("LIMIT");
    expect(paged(subs, 50_000)).toEqual({ query: `${subs.query} LIMIT 50000 OFFSET 50000`, values: subs.values });
    expect(() => paged(subs, -1)).toThrow(HogQLError);
    expect(() => paged(subs, 1.5)).toThrow(HogQLError);
  });
});
