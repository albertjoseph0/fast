/**
 * Ideator: turns market signals into Idea candidates. Claude proposes; normalizeIdea and
 * the Idea schema decide what survives, and the gates decide what advances.
 */
import type { AgentContext } from "../core/context.ts";
import { Idea, type CoreNeed, type IdeaRecord, type Signal } from "../core/types.ts";
import { playbookContext } from "../playbook/context.ts";
import { normalizeIdea } from "../principles/gates.ts";
import { SCHEMA } from "./schemas.ts";
import { ideaFreeText, normKey, rolePrompt } from "./shared.ts";

const CORE_NEEDS: CoreNeed[] = ["love", "money", "play", "self_improvement"];
const MAX_SIGNALS = 60;
const NOTE_SECTIONS = ["Product template", "Bier gates (an idea must pass all eleven)"];
const SOURCE_PRIORITY: Record<Signal["source"], number> = {
  search_trend: 0,
  social_trend: 1,
  portfolio: 2,
  manual: 3,
  app_store_search: 4,
  app_store_chart: 5,
};

const SYSTEM = rolePrompt(
  "You are the ideator of an app studio that ships single-player AI verdict apps in days and tests them with human creators.",
  [
    "Every idea is one AI capability that turns one input (photo, screenshot, text, birth data, audio, a few choices) into a personal verdict that films well in under 3 seconds.",
    "A lone user must get full value with zero friends on the app. Never propose meetup, marketplace or partnership-dependent apps.",
    "Pick a narrow wedge: a specific audience with a discoverable creator niche of at least 20 creators whose audiences are mostly in the wedge.",
    "The primary channel is organic (creator_ugc unless there is a strong reason). Give at least 3 short-form hooks and a share artifact that advertises the app.",
    "Wedge factors (coPresence, discoverable, inflectionPoint, obsessive, urgency, ownedReach) are 0..1. Ages: minAge is at least 13; anything under 18 needs a human, so prefer adults.",
    "Label every sensitive domain that applies honestly; an independent classifier checks you.",
    "State a real differentiation from existing apps (Apple 4.3): a different input, verdict or voice, not a reskin.",
    "Hooks and copy carry no user counts, ratings, rankings, prices, income or health promises, and no testimonials.",
    "Never reuse a title from avoidTitles. Use the signals as evidence of demand, not as apps to clone.",
    "Ground every idea in evidence: evidenceRefs lists the refs of the signals that show demand for it. Cite measured signals (app_store_search, app_store_chart, social_trend, manual), not only pattern summaries. Prefer ideas with paying evidence (long-running ads, paid apps, top-paid chart) over attention alone. An idea you cannot ground is not worth proposing.",
    "Read the numbers: for app_store_search, ratings and ratingsPerDay; for social_trend youtube, viewsPerDay; instagram, medianEngagement; meta_ads, longRunningAdvertisers and longRunningAppAds (ads running 30+ days usually pay for themselves).",
    "Signals with a ref quote App Store and social text written outside the studio; their title and detail are in the market_signals untrusted block.",
  ],
  { playbook: true, untrusted: true },
);

/** Sources the studio writes itself; every other signal quotes third-party text. */
const TRUSTED_SOURCES: readonly Signal["source"][] = ["manual", "portfolio"];

/** Bullet lines of the playbook's product template and Bier gate sections. */
function playbookNotes(): string[] {
  const notes: string[] = [];
  let take = false;
  for (const line of playbookContext().split("\n")) {
    if (line.startsWith("## ")) take = NOTE_SECTIONS.includes(line.slice(3).trim());
    else if (take && line.startsWith("- ")) notes.push(line.slice(2));
  }
  return notes;
}

/**
 * At most `max` signals, shared across sources round-robin in priority order, so pattern summaries
 * cannot crowd out the measured rows (store results, trend scans) the ideas must cite. A source
 * with few signals leaves its share to the others; order within a source is kept.
 */
export function selectSignals(signals: readonly Signal[], max = MAX_SIGNALS): Signal[] {
  const bySource = new Map<Signal["source"], Signal[]>();
  for (const s of signals) bySource.set(s.source, [...(bySource.get(s.source) ?? []), s]);
  const queues = [...bySource.entries()].sort((a, b) => SOURCE_PRIORITY[a[0]] - SOURCE_PRIORITY[b[0]]).map(([, q]) => q);
  const out: Signal[] = [];
  for (let i = 0; out.length < max && queues.some((q) => i < q.length); i++) {
    for (const q of queues) {
      if (out.length >= max) break;
      const s = q[i];
      if (s) out.push(s);
    }
  }
  // Keep the prompt grouped by source, as before.
  return out.sort((a, b) => SOURCE_PRIORITY[a.source] - SOURCE_PRIORITY[b.source]);
}

/** Generate up to `count` schema-valid, normalized ideas with fresh titles, each tied to the signals it cites. */
export async function generateIdeas(
  ctx: AgentContext,
  opts: { signals: Signal[]; count: number; avoidTitles: string[] },
): Promise<IdeaRecord[]> {
  const signals = selectSignals(opts.signals);
  const trusted = (s: Signal) => TRUSTED_SOURCES.includes(s.source);
  const ref = (i: number) => `signal_${i + 1}`;
  const byRef = new Map(signals.map((s, i) => [ref(i), s]));
  const external = signals.flatMap((s, i) => (trusted(s) ? [] : [{ ref: ref(i), title: s.title, detail: s.detail }]));
  const batch = await ctx.ports.llm.object({
    role: "ideator",
    schemaName: SCHEMA.ideaBatch,
    system: SYSTEM,
    instructions: `Propose ${opts.count} distinct app ideas grounded in these signals, each citing its evidence. Spread them across the core needs.`,
    input: {
      count: opts.count,
      signals: signals.map((s, i) => {
        const base = { ref: ref(i), source: signalKind(s), metrics: s.metrics, tags: s.tags };
        return trusted(s) ? { ...base, title: s.title, detail: s.detail } : base;
      }),
      coreNeeds: CORE_NEEDS,
      avoidTitles: opts.avoidTitles,
      playbookNotes: playbookNotes(),
    },
    ...(external.length > 0 ? { untrusted: [{ label: "market_signals", text: JSON.stringify(external) }] } : {}),
    purpose: "idea_batch",
  });

  const taken = new Set(opts.avoidTitles.map(normKey));
  const createdAt = ctx.ports.clock.iso();
  const out: IdeaRecord[] = [];
  for (const raw of batch.ideas) {
    if (out.length >= opts.count) break;
    const { evidenceRefs, ...rest } = raw;
    const parsed = Idea.safeParse(safeNormalize(rest));
    if (!parsed.success) continue;
    const key = normKey(parsed.data.title);
    if (!key || taken.has(key)) continue;
    taken.add(key);
    // Only refs that exist in this batch's input count; an idea that cites none fails the evidence gate.
    const cited = [...new Set(evidenceRefs.map((r) => r.trim()))].flatMap((r) => byRef.get(r)?.id ?? []);
    out.push({ id: ctx.store.nextId("idea"), idea: parsed.data, sourceSignalIds: cited, createdAt });
  }
  return out;
}

/** The source as the model sees it: social_trend signals name their platform. */
function signalKind(s: Signal): string {
  return s.source === "social_trend" && s.trend ? `social_trend:${s.trend}` : s.source;
}

function safeNormalize(raw: unknown): unknown {
  try {
    return normalizeIdea(raw as Idea);
  } catch {
    return raw;
  }
}
