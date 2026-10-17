import type { TickContext } from "../../src/core/context.ts";
import type { ReadPorts } from "../../src/core/ports.ts";
import { Rng } from "../../src/core/rng.ts";
import type { Action, ActionKind, CohortMetrics } from "../../src/core/types.ts";
import { makeWorld, type World } from "../governance/fixtures.ts";
import { astraSpec } from "../principles/fixtures.ts";

export { makeWorld, type World };

/** Read ports that fail loudly when a test reaches a port it did not stub. */
export function readPorts(w: World, stubs: Partial<ReadPorts> = {}): ReadPorts {
  const missing = (name: string) =>
    new Proxy({}, { get: (_t, prop) => (prop === "kind" ? "sim" : () => Promise.reject(new Error(`unstubbed port ${name}.${String(prop)}`))) });
  return {
    clock: w.clock,
    llm: missing("llm"),
    media: missing("media"),
    trends: missing("trends"),
    store: missing("store"),
    metrics: missing("metrics"),
    creators: missing("creators"),
    social: missing("social"),
    ads: missing("ads"),
    ...stubs,
  } as ReadPorts;
}

export function tickContext(w: World, opts: { tick?: number; ports?: Partial<ReadPorts> } = {}): TickContext {
  return {
    config: w.config,
    ports: readPorts(w, opts.ports),
    store: w.store,
    rng: new Rng(7),
    today: w.clock.today(),
    tick: opts.tick ?? 1,
    outbox: w.gov,
    log: (type, data, ventureId) => {
      w.store.emit(type, data, ventureId);
    },
  };
}

/** Mark an action executed, as the executor would after a successful handler run. */
export function markExecuted(w: World, a: Action): Action {
  return w.store.governanceActions().put({ ...a, status: "executed", executedAt: w.clock.iso() });
}

export function openActions(w: World, kind: ActionKind): Action[] {
  return w.store.actions.list((a) => a.kind === kind && !["executed", "rejected", "cancelled", "failed", "dry_run"].includes(a.status));
}

export function withSpec(w: World): void {
  w.store.ventures.put({ ...w.venture, spec: astraSpec() });
}

export function cohort(patch: Partial<CohortMetrics>): CohortMetrics {
  return {
    ventureId: "ven_000001",
    cohortDate: "2026-02-20",
    ageDays: 10,
    platform: "ios",
    geo: "US",
    channel: "creator_ugc",
    lane: "ven_000001|creator_ugc|US|ccmp_000001",
    installs: 1000,
    spendCents: 50_000,
    trialStarts: 200,
    trialCancels: 120,
    conversions: 80,
    renewals: 0,
    activeSubscribers: 80,
    grossRevenueCents: 55_920,
    proceedsCents: 47_532,
    refundsCents: 0,
    ...patch,
  };
}
