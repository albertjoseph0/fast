/**
 * Audience registry (Bier P4): tests must not exhaust an audience's attention, and cells
 * of one experiment must never share a unit. Units are creators, owned accounts, ad sets
 * or storefront territories; keys include the wedge so unrelated ventures don't collide.
 */
import type { StudioConfig } from "../config/schema.ts";
import type { AudienceExposure } from "../core/store.ts";
import type { ChannelKind, ExperimentPlan, Iso, Platform, TestCell } from "../core/types.ts";

/** GB plus the EU-27 and EEA storefronts gated behind privacy.euUkEnabled. */
export const EU_UK_GEOS = new Set([
  "GB", "IE", "FR", "DE", "ES", "IT", "NL", "BE", "LU", "AT", "PT", "SE", "DK", "FI", "PL", "CZ", "SK", "HU",
  "SI", "HR", "RO", "BG", "GR", "CY", "MT", "EE", "LV", "LT", "NO", "IS", "LI",
]);

export function exposureKey(wedge: string, channel: ChannelKind, platform: Platform | "app", unit: string): string {
  return `${wedge}|${channel}|${platform}|${unit}`;
}

const DAY_MS = 86_400_000;

/** True when the unit is in cooldown for this venture (other ventures: long cooldown; same venture: short). */
export function isBurned(opts: {
  key: string;
  ventureId: string;
  exposures: AudienceExposure[];
  now: Iso;
  config: StudioConfig;
}): boolean {
  const now = new Date(opts.now).getTime();
  return opts.exposures.some((e) => {
    if (e.key !== opts.key) return false;
    const ageDays = (now - new Date(e.at).getTime()) / DAY_MS;
    const cooldown = e.ventureId === opts.ventureId ? opts.config.lab.sameVentureCooldownDays : opts.config.lab.audienceCooldownDays;
    return ageDays < cooldown;
  });
}

/** Storefront geos available for tests in this locale, honouring EU/UK gating. */
export function testGeosFor(locale: string, config: StudioConfig): string[] {
  const lang = locale.split("-")[0]?.toLowerCase() ?? "en";
  const geos = lang === "en" ? config.lab.testGeos : (config.lab.localizedTestGeos[locale] ?? config.lab.localizedTestGeos[lang] ?? []);
  return geos.filter((g) => config.privacy.euUkEnabled || !EU_UK_GEOS.has(g)).filter((g) => !config.lab.scaleGeos.includes(g));
}

/**
 * Pick `count` fresh storefront geos for geo-assigned cells, least recently used first.
 * Returns fewer than `count` when not enough geos are out of cooldown.
 */
export function pickTestGeos(opts: {
  wedge: string;
  locale: string;
  channel: ChannelKind;
  count: number;
  ventureId: string;
  config: StudioConfig;
  exposures: AudienceExposure[];
  now: Iso;
}): string[] {
  const candidates = testGeosFor(opts.locale, opts.config).filter(
    (geo) =>
      !isBurned({
        key: exposureKey(opts.wedge, opts.channel, "app", geo),
        ventureId: opts.ventureId,
        exposures: opts.exposures,
        now: opts.now,
        config: opts.config,
      }),
  );
  const lastUsed = (geo: string) =>
    opts.exposures
      .filter((e) => e.key.endsWith(`|${geo}`) && e.wedge === opts.wedge)
      .reduce((latest, e) => (e.at > latest ? e.at : latest), "");
  return [...candidates].sort((a, b) => (lastUsed(a) < lastUsed(b) ? -1 : lastUsed(a) > lastUsed(b) ? 1 : a < b ? -1 : 1)).slice(0, opts.count);
}

/** Cells of one experiment must not share a storefront (geo cells) or an audience unit. */
export function assertDisjoint(cells: TestCell[]): string[] {
  const problems: string[] = [];
  const geoCells = cells.filter((c) => c.assignment === "geo");
  const geos = new Set<string>();
  for (const c of geoCells) {
    if (geos.has(c.geo)) problems.push(`geo ${c.geo} used by more than one cell`);
    geos.add(c.geo);
  }
  const units = new Map<string, string>();
  for (const c of cells) {
    for (const u of c.audienceUnits) {
      const owner = units.get(u);
      if (owner && owner !== c.id) problems.push(`unit ${u} shared by ${owner} and ${c.id}`);
      units.set(u, c.id);
    }
  }
  return problems;
}

/** Exposure records to append when an experiment starts (one per storefront and unit). */
export function exposuresForPlan(plan: ExperimentPlan, wedge: string, at: Iso): AudienceExposure[] {
  const out: AudienceExposure[] = [];
  for (const cell of plan.cells) {
    if (cell.assignment === "geo") {
      out.push({ key: exposureKey(wedge, cell.channel, "app", cell.geo), wedge, ventureId: plan.ventureId, experimentId: plan.id, at });
    }
    for (const unit of cell.audienceUnits) {
      out.push({ key: exposureKey(wedge, cell.channel, cell.platform, unit), wedge, ventureId: plan.ventureId, experimentId: plan.id, at });
    }
  }
  return out;
}
