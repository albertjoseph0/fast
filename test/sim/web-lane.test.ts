import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("../../src/builder/index.ts", () => import("./fakeBuilder.ts"));
vi.mock("../builder/index.ts", () => import("./fakeBuilder.ts"));

const { createSimStudio } = await import("../../src/orchestrator/wiring.ts");
const { runSimulation } = await import("../../src/orchestrator/runner.ts");

const scratch = mkdtempSync(join(tmpdir(), "fast-sim-web-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("web lane on the simulated market", () => {
  it("ships web apps without stores or App Review and runs tests on them", async () => {
    const sim = createSimStudio({ dataDir: null, scratchDir: scratch, config: { seed: 42, web: { defaultLane: "web", appsDomain: "apps.sim.example" } }, env: {} });
    const result = await runSimulation({ days: 60, sim });
    const { store } = sim;

    expect(result.errors).toEqual([]);
    expect(result.everLive).toBeGreaterThanOrEqual(1);
    expect(result.experiments.registered).toBeGreaterThanOrEqual(1);
    // No store work at all: no Apple tasks, no binaries, no review submissions.
    expect(store.tasks.list((t) => t.kind.startsWith("apple.")).map((t) => `${t.kind}:${t.ventureId ?? "studio"}`)).toEqual([]);
    expect(store.actions.count((a) => a.kind === "store.submit_review" || a.kind === "store.start_build")).toBe(0);
    // Every live web app is geofenced to test geos and sells through payment links.
    const live = store.ventures.list((v) => v.stores.some((s) => s.platform === "web" && s.status === "live"));
    expect(live.length).toBeGreaterThanOrEqual(1);
    for (const v of live) {
      const rec = v.stores.find((s) => s.platform === "web");
      expect(rec?.territories.length).toBeGreaterThan(0);
      expect(v.bindings.webAppUrl).toBe(`https://${v.slug}.apps.sim.example`);
      expect(Object.keys(v.bindings.checkoutLinks ?? {}).length).toBe(sim.config.monetization.ladder.length);
    }
    // The first public deploy of each app went to the board.
    const firstDeploys = store.actions.list((a) => a.kind === "web.deploy_app" && a.findings.some((f) => f.ruleId === "web.first_launch"));
    expect(firstDeploys.length).toBeGreaterThanOrEqual(1);
  }, 120_000);
});
