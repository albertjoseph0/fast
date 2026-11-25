/**
 * Hidden topic demand for the simulator, and the social/ad-library observations it produces.
 *
 * Each topic has a true demand D (mean about 1) that moves a venture's appeal in truth.ts, and a
 * hype factor H that inflates only social attention. Most topics have H = 1; a few are fads whose
 * views run far ahead of what people pay for. Ad-library numbers follow D alone (advertisers keep
 * paying only where it earns), social numbers follow D x H, both with noise. So evidence carries
 * real signal, views alone can mislead, and long-running ads are the more honest signal: the
 * pattern operators report from live markets.
 */
import type { TrendObservation } from "../core/ports.ts";
import { hashString, Rng } from "../core/rng.ts";
import type { Idea, TrendSource } from "../core/types.ts";

/** Topic keywords the simulated market has demand for (matched as whole words or word stems). */
export const SIM_TOPICS: readonly string[] = [
  "astrology",
  "horoscope",
  "zodiac",
  "compatibility",
  "tarot",
  "rizz",
  "dating",
  "flirt",
  "chords",
  "guitar",
  "golf",
  "card",
  "plant",
  "outfit",
  "style",
  "budget",
  "hustle",
  "dream",
  "calorie",
  "macros",
  "habit",
  "language",
  "face",
  "glow",
  "bible",
  "prayer",
  "thrift",
  "resale",
  "coin",
  "homework",
  "pet",
  "dog",
  "room",
  "skin",
  "sleep",
  "mood",
  "trivia",
  "name",
  "voice",
  "headshot",
];

const HYPE_SHARE = 0.15;
const DEMAND_SIGMA = 0.7;

export interface TopicTruth {
  demand: number;
  hype: number;
}

export function topicTruth(topic: string, seed: number): TopicTruth {
  const r = new Rng(hashString(`${seed}:topic:${topic}`));
  const demand = Math.exp(DEMAND_SIGMA * r.normal() - (DEMAND_SIGMA * DEMAND_SIGMA) / 2);
  const hype = r.next() < HYPE_SHARE ? r.uniform(2.5, 5) : 1;
  return { demand, hype };
}

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
}

/** Topics a text is about: a word equal to the topic or starting with it (stems: "dreams", "dogs"). */
export function topicsIn(text: string): string[] {
  const ws = words(text);
  return SIM_TOPICS.filter((t) => ws.some((w) => w === t || (w.startsWith(t) && w.length - t.length <= 3)));
}

/** Demand behind a piece of text: the strongest topic it names, 1 when it names none. */
export function textDemand(text: string, seed: number): number {
  const topics = topicsIn(text);
  return topics.length === 0 ? 1 : Math.max(...topics.map((t) => topicTruth(t, seed).demand));
}

/** True demand multiplier for an idea: the strongest topic it serves, 1 when it matches none. */
export function ideaDemand(idea: Idea, seed: number): number {
  const text = [idea.title, idea.oneLiner, idea.aiCapability, idea.verdictMoment, idea.wedge.name, idea.wedge.description].join(" ");
  const topics = topicsIn(text);
  if (topics.length === 0) return 1;
  return Math.max(...topics.map((t) => topicTruth(t, seed).demand));
}

/** One simulated observation per source for a term, or none when the term matches no topic. */
export function simTrendObservations(term: string, sources: readonly TrendSource[], seed: number, week: string, sinceDays: number): TrendObservation[] {
  const topics = topicsIn(term);
  if (topics.length === 0) return [];
  const truths = topics.map((t) => topicTruth(t, seed));
  const demand = Math.max(...truths.map((t) => t.demand));
  const hype = Math.max(...truths.map((t) => t.hype));
  const r = new Rng(hashString(`${seed}:trend:${term}:${week}`));
  const out: TrendObservation[] = [];
  for (const source of sources) {
    if (source === "youtube") {
      const views = Math.round(400_000 * demand * hype * r.lognormal(1, 0.6));
      out.push({
        source,
        term,
        metrics: {
          videos: 25,
          channels: r.int(12, 24),
          views,
          medianViews: Math.round(views / 40),
          viewsPerDay: Math.round(views / Math.max(1, sinceDays)),
          engagementRate: Math.round(r.uniform(0.02, 0.06) * 1e4) / 1e4,
        },
        samples: [],
      });
    } else if (source === "instagram") {
      const median = Math.round(900 * demand * hype * r.lognormal(1, 0.6));
      out.push({
        source,
        term,
        metrics: {
          posts: 50,
          recentPosts: Math.min(50, Math.round(18 * Math.sqrt(demand * hype) * r.lognormal(1, 0.3))),
          engagement: median * 50,
          medianEngagement: median,
          recentMedianEngagement: Math.round(median * r.uniform(0.7, 1.3)),
        },
        samples: [],
      });
    } else if (source === "meta_ads") {
      const activeAds = Math.min(100, r.poisson(22 * demand));
      const longShare = Math.min(0.85, 0.28 * Math.sqrt(demand));
      const longRunningAds = r.binomial(activeAds, longShare);
      const appAds = r.binomial(activeAds, 0.35);
      out.push({
        source,
        term,
        metrics: {
          activeAds,
          advertisers: Math.max(activeAds > 0 ? 1 : 0, Math.round(activeAds / r.uniform(2, 4))),
          longRunningAds,
          longRunningAdvertisers: Math.round(longRunningAds / r.uniform(2, 4)),
          medianDaysRunning: Math.round(14 * Math.sqrt(demand) * r.lognormal(1, 0.3)),
          maxDaysRunning: Math.round(90 * Math.sqrt(demand) * r.lognormal(1, 0.3)),
          appAds,
          longRunningAppAds: r.binomial(appAds, longShare),
          euReach: Math.round(150_000 * demand * r.lognormal(1, 0.5)),
        },
        samples: [],
      });
    }
  }
  return out;
}
