import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

// The real path mocks src/builder once it exists; the raw specifier (wiring.ts's own import)
// is the id vitest falls back to while the module is still missing.
vi.mock("../../src/builder/index.ts", () => import("./fakeBuilder.ts"));
vi.mock("../builder/index.ts", () => import("./fakeBuilder.ts"));

const { createSimStudio } = await import("../../src/orchestrator/wiring.ts");
const { runSimulation } = await import("../../src/orchestrator/runner.ts");

const scratch = mkdtempSync(join(tmpdir(), "fast-sim-smoke-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("studio on the simulated market", () => {
  it("runs 60 days end to end through the sim ports without tick errors", async () => {
    const sim = createSimStudio({ dataDir: null, scratchDir: scratch, config: { seed: 42 }, env: {} });
    const result = await runSimulation({ days: 60, sim });
    const { store, world } = sim;

    expect(result.errors).toEqual([]);
    expect(result.everLive).toBeGreaterThanOrEqual(1);
    expect(result.experiments.registered).toBeGreaterThanOrEqual(1);
    expect(store.experiments.count((e) => e.stages.includes("S1_distribution"))).toBeGreaterThanOrEqual(1);
    expect(store.submissions.count()).toBeGreaterThan(0);
    expect(store.payouts.count()).toBeGreaterThan(0);
    expect(world.payoutCount()).toBeGreaterThan(0);
    expect(store.tasks.count((t) => t.kind === "apple.create_app")).toBeGreaterThanOrEqual(1);
    expect(result.spendCents.creators).toBeGreaterThan(0);
  }, 120_000);

  it("replays the same company history from the same seed, wherever its files are rendered", async () => {
    const history = async (dir: string) => {
      const sim = createSimStudio({ dataDir: null, scratchDir: mkdtempSync(join(scratch, dir)), config: { seed: 7 }, env: {} });
      const lines: string[] = [];
      await runSimulation({ days: 30, sim, onTick: (s) => lines.push(`${s.date} ${JSON.stringify(s.ventures)}`) });
      return { lines, ventures: sim.store.ventures.list().map((v) => v.history), ideas: sim.store.ideas.list().map((i) => i.idea.title) };
    };
    const a = await history("a-");
    expect(a.lines.some((l) => l.includes("building"))).toBe(true);
    expect(await history("b-")).toEqual(a);
  }, 120_000);
});
