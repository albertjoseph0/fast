/**
 * Evidence for App Review 4.3 (spam/duplicates): how the app differs from the nearest store
 * competitors and from the studio's own portfolio. Deterministic text overlap, no LLM.
 */
import type { TickContext } from "../core/context.ts";
import type { Venture } from "../core/types.ts";
import { isActive } from "./lifecycle.ts";
import { ideaFor } from "./pipeline.ts";

const STOP = new Set(["the", "a", "an", "and", "or", "for", "to", "of", "in", "on", "your", "you", "with", "app", "ai", "by", "is", "it", "that", "this", "from", "get", "my"]);

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2 && !STOP.has(t)),
  );
}

export function overlap(a: string, b: string): number {
  const x = tokens(a);
  const y = tokens(b);
  if (!x.size || !y.size) return 0;
  let inter = 0;
  for (const t of x) if (y.has(t)) inter++;
  return inter / (x.size + y.size - inter);
}

export async function differentiationReport(ctx: TickContext, v: Venture): Promise<string> {
  const idea = ideaFor(ctx, v);
  const self = `${idea.title} ${idea.oneLiner} ${idea.verdictMoment} ${idea.aiCapability}`;
  const terms = [...new Set([idea.wedge.creatorNiche, v.spec?.aso.keywords[0] ?? idea.title].filter(Boolean))].slice(0, 2);
  const seen = new Map<string, { name: string; ratingCount: number; score: number }>();
  for (const term of terms) {
    try {
      for (const app of await ctx.ports.trends.searchApps({ term, country: "US", limit: 5 })) {
        if (!seen.has(app.id)) seen.set(app.id, { name: app.name, ratingCount: app.ratingCount, score: overlap(self, `${app.name} ${app.description}`) });
      }
    } catch {
      // Search is evidence, not a gate: a failed lookup leaves the competitor list shorter.
    }
  }
  const competitors = [...seen.values()].sort((a, b) => b.score - a.score).slice(0, 5);
  const siblings = ctx.store.ventures
    .list((x) => x.id !== v.id && isActive(x) && x.stage !== "screened")
    .map((x) => {
      const other = ideaFor(ctx, x);
      return { name: x.name, score: overlap(self, `${other.title} ${other.oneLiner} ${other.verdictMoment} ${other.aiCapability}`) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  return [
    `Differentiation: ${idea.differentiation}`,
    `Core experience: ${idea.verdictMoment} (${idea.aiCapability}).`,
    competitors.length ? `Nearest store apps by text overlap: ${competitors.map((c) => `${c.name} (${c.ratingCount} ratings, ${pct(c.score)})`).join("; ")}.` : "No close store competitors found.",
    siblings.length ? `Same-publisher apps by overlap: ${siblings.map((s) => `${s.name} ${pct(s.score)}`).join("; ")}.` : "No other apps from this publisher.",
    "Built in-house by the publisher, which also provides the app's content; the core feature, prompts, onboarding and audience are specific to this app.",
  ].join("\n");
}
