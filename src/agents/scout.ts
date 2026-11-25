/**
 * Scout: reads public App Store charts and searches, social trends (YouTube, Instagram hashtags)
 * and the Meta Ad Library into Signals, adds momentum against the previous scans, then asks
 * Claude for the demand patterns behind them. Port failures on one chart, term or source are
 * skipped so a single flaky request cannot empty a discovery cycle.
 */
import type { AgentContext } from "../core/context.ts";
import type { AppLookup, ChartApp, TrendObservation } from "../core/ports.ts";
import type { IdeaRecord, Signal, SignalSource, TrendSource } from "../core/types.ts";
import { SCHEMA, type SchemaInputs } from "./schemas.ts";
import { normKey, rolePrompt } from "./shared.ts";

/** Search terms covering Vert's categories and adjacent core-need utilities. */
export const DEFAULT_SEARCH_TERMS: readonly string[] = [
  "astrology",
  "compatibility",
  "rizz",
  "dating reply",
  "chords",
  "golf swing",
  "card scanner",
  "plant identifier",
  "outfit",
  "budget",
  "side hustle",
  "dream meaning",
  "tarot",
  "calorie",
  "habit quit",
  "language",
];

const CHARTS = ["top-free", "top-paid"] as const;
const CHART_LIMIT = 50;
const SEARCH_LIMIT = 10;
const DIGEST_TOP_PER_TERM = 5;
/** Window social and ad-library scans look back over. */
export const TREND_WINDOW_DAYS = 14;
/** A previous scan must be at least this old to measure momentum against. */
const MIN_MOMENTUM_DAYS = 1;
const DAY_MS = 86_400_000;
const TREND_LABEL: Record<TrendSource, string> = { youtube: "YouTube", instagram: "Instagram", meta_ads: "Meta ads", google_trends: "Google Trends" };

const SYSTEM = rolePrompt(
  "You are the market scout of an app studio that builds single-player AI verdict apps for love, money and play.",
  [
    "You receive App Store chart positions and search results. Find the demand patterns behind them: recurring jobs-to-be-done, formats and audiences, not individual apps.",
    "A good pattern names a narrow audience and the verdict they want, e.g. 'screenshot-to-reply help for people texting a new match'.",
    "Prefer patterns with several example apps, high rating counts or paid-chart presence, and a verdict that films well in a short video.",
    "social lists per-term numbers from YouTube (viewsPerDay), Instagram hashtags (medianEngagement) and the Meta Ad Library (longRunningAdvertisers: advertisers with an ad running 30+ days). Paying advertisers are stronger evidence than views; views without advertisers or apps may be a fad.",
    "Apps appear in the input only as refs like app_1; their names, written by third-party developers, are in the app_store untrusted block. exampleApps must be refs that appear in the input. Never invent apps, numbers or rankings.",
    "Return between 3 and 8 patterns, each mapped to one core need.",
  ],
  { playbook: true, untrusted: true },
);

type Draft = Omit<Signal, "id" | "observedAt">;

/** Scan charts and searches into deduped Signals, plus pattern signals from one digest call. */
export async function scanMarket(ctx: AgentContext, opts: { countries?: string[]; terms?: string[] } = {}): Promise<Signal[]> {
  const countries = unique(opts.countries ?? ["US", ctx.config.lab.testGeos[0] ?? "US"]);
  const terms = opts.terms ?? [...DEFAULT_SEARCH_TERMS];
  const searchCountry = countries[0] ?? "US";
  const trends = ctx.ports.trends;

  const chartJobs = countries.flatMap((country) => CHARTS.map((chart) => ({ country, chart })));
  const [charts, searches, social] = await Promise.all([
    Promise.all(chartJobs.map((j) => settle(trends.topApps({ country: j.country, chart: j.chart, limit: CHART_LIMIT })))),
    Promise.all(terms.map((term) => settle(trends.searchApps({ term, country: searchCountry, limit: SEARCH_LIMIT })))),
    settle(Promise.resolve().then(() => ctx.ports.socialTrends.scan({ terms, country: searchCountry, sinceDays: TREND_WINDOW_DAYS }))),
  ]);

  const drafts: Draft[] = [];
  const digestInput: SchemaInputs["SignalDigest"] = { charts: [], searches: [], social: [] };
  // Third-party app names reach the model only inside an untrusted block, keyed by ref.
  const refs = new Map<string, string>();
  const names = new Map<string, string>();
  const ref = (name: string): string => {
    const known = refs.get(name);
    if (known) return known;
    const id = `app_${refs.size + 1}`;
    refs.set(name, id);
    names.set(id, name);
    return id;
  };
  chartJobs.forEach((job, i) => {
    for (const app of charts[i] ?? []) {
      drafts.push(chartDraft(app, job.chart, job.country));
      digestInput.charts.push({ name: ref(app.name), genre: app.genre, rank: app.rank, chart: job.chart, country: job.country });
    }
  });
  terms.forEach((term, i) => {
    const results = searches[i] ?? [];
    for (const app of results) drafts.push(searchDraft(app, term, searchCountry));
    if (results.length > 0) {
      digestInput.searches.push({
        term,
        top: results.slice(0, DIGEST_TOP_PER_TERM).map((a) => ({ name: ref(a.name), ratingCount: a.ratingCount, priceCents: a.priceCents })),
      });
    }
  });

  for (const obs of social) {
    drafts.push(trendDraft(obs));
    digestInput.social?.push({ term: obs.term, source: obs.source, metrics: obs.metrics });
  }

  if (digestInput.charts.length > 0 || digestInput.searches.length > 0 || social.length > 0) {
    const digest = await ctx.ports.llm.object({
      role: "scout",
      schemaName: SCHEMA.signalDigest,
      system: SYSTEM,
      instructions: "Summarize the demand patterns in these App Store charts and searches and the social and ad-library numbers.",
      input: digestInput,
      untrusted: [{ label: "app_store", text: JSON.stringify(Object.fromEntries(names)) }],
      purpose: "signal_digest",
    });
    for (const p of digest.patterns) {
      const examples = unique(p.exampleApps.flatMap((r) => names.get(r.trim()) ?? []));
      drafts.push({
        source: "search_trend",
        title: p.title.trim(),
        detail: examples.length > 0 ? `${p.detail.trim()} Examples: ${examples.join(", ")}.` : p.detail.trim(),
        metrics: { exampleApps: examples.length },
        tags: ["pattern", p.coreNeed],
      });
    }
  }

  const observedAt = ctx.ports.clock.iso();
  const withMomentum = addMomentum(dedupe(drafts), ctx.store.signals.list(), ctx.ports.clock.now());
  return withMomentum.map((d) => ({ ...d, id: ctx.store.nextId("signal"), observedAt }));
}

function trendDraft(obs: TrendObservation): Draft {
  const label = TREND_LABEL[obs.source];
  const quoted = obs.samples.length > 0 ? ` Top posts: ${obs.samples.map((t) => `"${t}"`).join("; ")}.` : "";
  return {
    source: "social_trend",
    trend: obs.source,
    title: `${obs.term} on ${label}`,
    detail: `${label}, last ${TREND_WINDOW_DAYS} days: ${describeMetrics(obs)}.${quoted}`,
    ...(obs.url ? { url: obs.url } : {}),
    metrics: obs.metrics,
    tags: unique([obs.term.toLowerCase(), obs.source, "social"]),
  };
}

function describeMetrics(obs: TrendObservation): string {
  const m = obs.metrics;
  const n = (k: string) => Math.round(m[k] ?? 0).toLocaleString("en-US");
  if (obs.source === "youtube") return `${n("videos")} top videos from ${n("channels")} channels, ${n("views")} views (${n("viewsPerDay")} a day)`;
  if (obs.source === "instagram") return `${n("posts")} top posts, ${n("recentPosts")} of them recent, median engagement ${n("medianEngagement")}`;
  if (obs.source === "meta_ads") {
    return `${n("activeAds")} active ads from ${n("advertisers")} advertisers; ${n("longRunningAds")} running 30+ days from ${n("longRunningAdvertisers")} advertisers; ${n("appAds")} link to an app store`;
  }
  return Object.entries(m)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
}

/** Metrics whose daily change is worth knowing, and the name the change is stored under. */
const RATE_METRICS: readonly [string, string][] = [
  ["ratings", "ratingsPerDay"],
  ["views", "viewsGrowthPerDay"],
  ["activeAds", "activeAdsPerDay"],
  ["longRunningAdvertisers", "longRunningAdvertisersPerDay"],
];

/**
 * Momentum against the most recent earlier scan of the same thing (same source, platform and
 * title, at least a day old): daily change in ratings, views and ads, rank movement on charts
 * (positive rankDelta = climbing), and newEntry for an app on a chart for the first time.
 */
export function addMomentum(drafts: Draft[], prior: Signal[], now: Date): Draft[] {
  const latest = new Map<string, Signal>();
  const chartsSeen = prior.some((s) => s.source === "app_store_chart");
  const cutoff = now.getTime() - MIN_MOMENTUM_DAYS * DAY_MS;
  for (const s of prior) {
    if (Date.parse(s.observedAt) > cutoff) continue;
    const key = momentumKey(s);
    const seen = latest.get(key);
    if (!seen || seen.observedAt < s.observedAt) latest.set(key, s);
  }
  return drafts.map((d) => {
    const prev = latest.get(momentumKey(d));
    const metrics = { ...d.metrics };
    if (prev) {
      const days = Math.max(MIN_MOMENTUM_DAYS, (now.getTime() - Date.parse(prev.observedAt)) / DAY_MS);
      for (const [key, rate] of RATE_METRICS) {
        const cur = d.metrics[key];
        const before = prev.metrics[key];
        if (cur !== undefined && before !== undefined) metrics[rate] = Math.round(((cur - before) / days) * 100) / 100;
      }
      if (d.metrics.rank !== undefined && prev.metrics.rank !== undefined) metrics.rankDelta = prev.metrics.rank - d.metrics.rank;
    } else if (d.source === "app_store_chart" && chartsSeen) {
      metrics.newEntry = 1;
    }
    return { ...d, metrics };
  });
}

function momentumKey(s: Pick<Signal, "source" | "trend" | "title" | "tags">): string {
  // A chart signal is one app on one chart in one storefront.
  const where = s.source === "app_store_chart" ? s.tags.slice(1, 3).join("/") : "";
  return `${s.source}|${s.trend ?? ""}|${where}|${normKey(s.title)}`;
}

function chartDraft(app: ChartApp, chart: (typeof CHARTS)[number], country: string): Draft {
  return draft("app_store_chart", app.name, `#${app.rank} on the ${country} ${chart} chart (${app.genre}) by ${app.artist}`, app.url, { rank: app.rank }, [
    app.genre,
    chart,
    country,
  ]);
}

function searchDraft(app: AppLookup, term: string, country: string): Draft {
  return draft(
    "app_store_search",
    app.name,
    `Ranks for "${term}" in ${country}: ${app.genre} by ${app.seller}, ${app.ratingCount} ratings, released ${app.releaseDate.slice(0, 10)}`,
    app.url,
    { ratings: app.ratingCount, rating: app.rating, priceCents: app.priceCents },
    [term, app.genre, country],
  );
}

function draft(source: SignalSource, title: string, detail: string, url: string, metrics: Record<string, number>, tags: string[]): Draft {
  return { source, title: title.trim(), detail, ...(url ? { url } : {}), metrics, tags: unique(tags.map((t) => t.toLowerCase())) };
}

/** First occurrence wins; later duplicates contribute missing metrics and tags. */
function dedupe(drafts: Draft[]): Draft[] {
  const byTitle = new Map<string, Draft>();
  for (const d of drafts) {
    if (!d.title) continue;
    const key = normKey(d.title);
    const seen = byTitle.get(key);
    if (!seen) byTitle.set(key, { ...d, metrics: { ...d.metrics }, tags: [...d.tags] });
    else byTitle.set(key, { ...seen, metrics: { ...d.metrics, ...seen.metrics }, tags: unique([...seen.tags, ...d.tags]) });
  }
  return [...byTitle.values()];
}

async function settle<T>(p: Promise<T[]>): Promise<T[]> {
  // A port that is not wired (a test double) may answer with something other than an array.
  try {
    const out = await p;
    return Array.isArray(out) ? out : [];
  } catch {
    return [];
  }
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

/** At most this many distinct terms are measured per discovery cycle (YouTube search costs 100 quota units a call). */
export const MAX_VERIFY_TERMS = 20;
/** Search results kept per verified term: the leaders show whether the market is real. */
const VERIFY_SEARCH_LIMIT = 5;

export interface DemandCheck {
  /** New signals, ready to store. */
  signals: Signal[];
  /** Idea id -> the ids of the signals measured for that idea's own demand terms. */
  byIdea: Map<string, string[]>;
}

/**
 * Measure each idea's own demand. The ideator cites whatever signals it was shown, which often
 * describe the market at large rather than this idea; here the idea's demandTerms are searched in
 * the App Store and scanned on YouTube, Instagram and the Meta Ad Library, so its evidence is
 * about what it actually does. Terms are shared across ideas and capped per cycle.
 */
export async function verifyDemand(ctx: AgentContext, records: IdeaRecord[], opts: { country?: string } = {}): Promise<DemandCheck> {
  const country = opts.country ?? ctx.config.lab.testGeos[0] ?? "US";
  const terms = unique(records.flatMap((r) => r.demandTerms ?? [])).slice(0, MAX_VERIFY_TERMS);
  const byIdea = new Map<string, string[]>();
  if (terms.length === 0) return { signals: [], byIdea };

  const [searches, social] = await Promise.all([
    Promise.all(terms.map((term) => settle(ctx.ports.trends.searchApps({ term, country, limit: VERIFY_SEARCH_LIMIT })))),
    settle(Promise.resolve().then(() => ctx.ports.socialTrends.scan({ terms, country, sinceDays: TREND_WINDOW_DAYS }))),
  ]);
  const drafts: { term: string; draft: Draft }[] = [];
  terms.forEach((term, i) => {
    for (const app of searches[i] ?? []) drafts.push({ term, draft: searchDraft(app, term, country) });
  });
  for (const obs of social) if (terms.includes(obs.term)) drafts.push({ term: obs.term, draft: trendDraft(obs) });

  const observedAt = ctx.ports.clock.iso();
  const withMomentum = addMomentum(
    drafts.map((d) => d.draft),
    ctx.store.signals.list(),
    ctx.ports.clock.now(),
  );
  const signals = withMomentum.map((d) => ({ ...d, id: ctx.store.nextId("signal"), observedAt }));
  const idsByTerm = new Map<string, string[]>();
  signals.forEach((s, i) => {
    const term = drafts[i]!.term;
    idsByTerm.set(term, [...(idsByTerm.get(term) ?? []), s.id]);
  });
  for (const r of records) {
    const ids = unique((r.demandTerms ?? []).flatMap((t) => idsByTerm.get(t) ?? []));
    if (ids.length > 0) byIdea.set(r.id, ids);
  }
  return { signals, byIdea };
}
