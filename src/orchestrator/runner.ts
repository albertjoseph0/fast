/**
 * Day loop for simulations: the studio ticks, the simulated board works its queue, then
 * the market simulates the day. Returns a scorecard of what the factory did.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LedgerCategory, VentureStage } from "../core/types.ts";
import type { TickSummary } from "./report.ts";
import { createSimStudio, type SimStudio } from "./wiring.ts";

export interface SimulationResult {
  seed: number;
  days: number;
  startDate: string;
  endDate: string;
  cashStartCents: number;
  cashEndCents: number;
  revenueCents: number;
  spendCents: { creators: number; ads: number; ai: number; media: number; inference: number };
  ideas: number;
  screenedIn: number;
  ventures: number;
  byStage: Partial<Record<VentureStage, number>>;
  everLive: number;
  validated: number;
  experiments: { registered: number; decided: Record<string, number> };
  actions: { total: number; executed: number; byStatus: Record<string, number> };
  humanTasks: { opened: number; done: number; byKind: Record<string, number> };
  llm: { calls: number; inputTokens: number; outputTokens: number; costCents: number } | null;
  errors: string[];
  ventureLines: TickSummary["ventures"];
  elapsedMs: number;
}

export interface SimulationOptions {
  days: number;
  seed?: number;
  dataDir?: string | null;
  config?: Parameters<typeof createSimStudio>[0]["config"];
  boardPolicy?: Parameters<typeof createSimStudio>[0]["boardPolicy"];
  startDate?: string;
  onTick?: (summary: TickSummary, sim: SimStudio) => void;
  /** Reuse an existing simulation (e.g. to continue a run). */
  sim?: SimStudio;
}

const count = <T extends string>(items: T[]): Record<string, number> => items.reduce<Record<string, number>>((acc, k) => ({ ...acc, [k]: (acc[k] ?? 0) + 1 }), {});

export async function runSimulation(o: SimulationOptions): Promise<SimulationResult> {
  const started = Date.now();
  const sim =
    o.sim ??
    createSimStudio({
      dataDir: o.dataDir ?? null,
      config: { ...o.config, ...(o.seed !== undefined ? { seed: o.seed } : {}) },
      ...(o.boardPolicy ? { boardPolicy: o.boardPolicy } : {}),
      ...(o.startDate ? { startDate: o.startDate } : {}),
    });
  const { studio, world, board, clock, store, config } = sim;
  const startDate = clock.today();
  const cashStartCents = studio.ledger.cash();
  const errors: string[] = [];
  let last: TickSummary | undefined;
  for (let day = 0; day < o.days; day++) {
    last = await studio.tick();
    for (const e of last.errors) errors.push(`${last.date} ${e}`);
    board.act();
    world.advanceDay();
    if (day % 7 === 6 || day === o.days - 1) store.checkpoint();
    o.onTick?.(last, sim);
    clock.advanceDays(1);
  }
  const ventures = store.ventures.list();
  const actions = store.actions.list();
  const tasks = store.tasks.list();
  const usage = sim.llm.kind === "claude" ? sim.llm.usage() : null;
  const net = (categories: LedgerCategory[]) => -store.net({ categories });
  const result: SimulationResult = {
    seed: config.seed,
    days: o.days,
    startDate,
    endDate: clock.today(),
    cashStartCents,
    cashEndCents: studio.ledger.cash(),
    revenueCents: store.net({ categories: ["revenue", "refunds"] }),
    spendCents: { creators: net(["creators"]), ads: net(["ads"]), ai: net(["ai"]), media: net(["media"]), inference: net(["inference"]) },
    ideas: store.ideas.count(),
    screenedIn: store.screenings.count((s) => s.verdict !== "reject"),
    ventures: ventures.length,
    byStage: count(ventures.map((v) => v.stage)) as Partial<Record<VentureStage, number>>,
    everLive: ventures.filter((v) => v.history.some((h) => h.to === "live_test")).length,
    validated: ventures.filter((v) => v.history.some((h) => h.to === "scaling")).length,
    experiments: {
      registered: store.experiments.count(),
      decided: count(store.experiments.list().flatMap((e) => (store.outcomes(e.id).at(-1)?.decision ? [store.outcomes(e.id).at(-1)?.decision as string] : []))),
    },
    actions: { total: actions.length, executed: actions.filter((a) => a.status === "executed").length, byStatus: count(actions.map((a) => a.status)) },
    humanTasks: { opened: tasks.length, done: tasks.filter((t) => t.status === "done").length, byKind: count(tasks.map((t) => t.kind)) },
    llm: usage ? { calls: usage.calls, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costCents: usage.costCents } : null,
    errors: errors.slice(0, 200),
    ventureLines: last?.ventures ?? [],
    elapsedMs: Date.now() - started,
  };
  if (o.dataDir) writeFileSync(join(o.dataDir, "simulation.json"), `${JSON.stringify(result, null, 2)}\n`);
  store.close();
  return result;
}
