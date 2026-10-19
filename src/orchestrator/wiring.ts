/**
 * Composition roots. createSimStudio wires the studio to the simulated market (with the stub
 * LLM by default, or real Claude to exercise the agents); createLiveStudio wires it to the
 * real platform APIs, dry-run until a human turns that off.
 */
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgents, type Agents } from "../agents/index.ts";
import { renderApp } from "../builder/index.ts";
import { defaultConfig, type StudioConfig } from "../config/schema.ts";
import { SimClock, SystemClock } from "../core/clock.ts";
import type { Clock, LlmPort, MediaPort, PortSet } from "../core/ports.ts";
import { Rng } from "../core/rng.ts";
import { StudioStore } from "../core/store.ts";
import { LedgerSync } from "../governance/ledger.ts";
import { createClaudeLlm, resolveLlmProvider } from "../llm/claude.ts";
import { createMedia } from "../llm/media.ts";
import { StubLlm } from "../llm/stub.ts";
import { CONTENT_FORMATS } from "../playbook/formats.ts";
import { createSimPorts, SimWorld } from "../sim/index.ts";
import type { StudioDeps } from "./deps.ts";
import { differentiationReport } from "./differentiation.ts";
import { SimBoard, type SimBoardPolicy } from "./simBoard.ts";
import { Studio } from "./studio.ts";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const TEMPLATE_DIR = join(REPO_ROOT, "templates", "expo-app");

type Env = Record<string, string | undefined>;
type ConfigInput = Parameters<typeof defaultConfig>[0];

/** The studio's one legal entity and its store developer accounts (registered by humans). */
export function seedStudioAccounts(store: StudioStore, config: StudioConfig, opts: { appleTeamId?: string; secretRefs?: Record<string, string> } = {}): void {
  if (store.entities.count() > 0) return;
  const entity = store.entities.put({ id: store.nextId("entity"), legalName: config.company.legalName, jurisdiction: "US-DE", purpose: "studio" });
  store.publishers.put({
    id: store.nextId("publisher"),
    entityId: entity.id,
    platform: "ios",
    externalTeamId: opts.appleTeamId ?? "SIMTEAM01",
    kind: "organization",
    status: "active",
    secretRefs: opts.secretRefs ?? { keyId: "ASC_KEY_ID", issuerId: "ASC_ISSUER_ID", privateKeyPath: "ASC_PRIVATE_KEY_PATH" },
  });
}

function makeLlm(config: StudioConfig, ledger: LedgerSync, clock: Clock, env: Env): LlmPort {
  const provider = resolveLlmProvider(config, env);
  if (provider === "stub") return new StubLlm({ seed: config.seed });
  return createClaudeLlm({ config, meter: ledger, clock, provider, env });
}

function makeDeps(config: StudioConfig, dataRoot: string, agents?: Agents): StudioDeps {
  return {
    agents: agents ?? createAgents(),
    renderApp,
    outRoot: join(dataRoot, "ventures"),
    templateDir: TEMPLATE_DIR,
    mediaRoot: join(dataRoot, "media"),
    defaultFormatId: CONTENT_FORMATS[0]?.id ?? "slideshow_story",
    differentiationReport,
  };
}

export interface SimStudio {
  studio: Studio;
  world: SimWorld;
  board: SimBoard;
  clock: SimClock;
  store: StudioStore;
  config: StudioConfig;
  llm: LlmPort;
}

export function createSimStudio(opts: {
  config?: ConfigInput;
  /** Directory for state, reports and generated files; null keeps state in memory (files go to a scratch dir). */
  dataDir: string | null;
  scratchDir?: string;
  startDate?: string;
  boardPolicy?: Partial<SimBoardPolicy>;
  agents?: Agents;
  env?: Env;
  media?: MediaPort;
}): SimStudio {
  const config = defaultConfig({ ...opts.config, mode: "sim" });
  const clock = new SimClock(opts.startDate ?? "2026-01-05T09:00:00.000Z");
  const root = opts.dataDir ?? opts.scratchDir ?? join(REPO_ROOT, ".scratch", `sim-${config.seed}`);
  mkdirSync(root, { recursive: true });
  const store = new StudioStore(opts.dataDir ? join(opts.dataDir, "state") : null, clock, config.seed, { durability: "checkpoint" });
  seedStudioAccounts(store, config);
  const rng = new Rng(config.seed);
  const ledger = new LedgerSync({ store, config, clock });
  const env = opts.env ?? process.env;
  const llm = makeLlm(config, ledger, clock, env);
  const media = opts.media ?? createMedia({ config, meter: ledger, provider: config.media.provider, env });
  const world = new SimWorld({ seed: config.seed, clock, store, config });
  const ports: PortSet = createSimPorts({ world, clock, store, config, llm, media });
  const studio = new Studio({ config, store, clock, rng, ports, deps: makeDeps(config, root, opts.agents), dataDir: root, ledger });
  const board = new SimBoard({ store, governance: studio.governance, clock, rng: rng.fork("board"), config, ...(opts.boardPolicy ? { policy: opts.boardPolicy } : {}) });
  return { studio, world, board, clock, store, config, llm };
}

export interface LiveStudio {
  studio: Studio;
  store: StudioStore;
  config: StudioConfig;
  llm: LlmPort;
}

/**
 * Live wiring: real APIs behind governance. Writes are dry-run (recorded, never sent) while
 * config.dryRun is true. Port factories live in src/integrations and are loaded lazily so a
 * simulation never imports live clients.
 */
export async function createLiveStudio(opts: { config: StudioConfig; dataDir: string; env?: Env; agents?: Agents }): Promise<LiveStudio> {
  const config = opts.config;
  const env = opts.env ?? process.env;
  const clock = new SystemClock();
  const store = new StudioStore(join(opts.dataDir, "state"), clock, config.seed);
  const ledger = new LedgerSync({ store, config, clock });
  const llm = makeLlm(config, ledger, clock, env);
  const media = createMedia({ config, meter: ledger, provider: config.media.provider, env });
  const { createLivePorts } = await import("../integrations/live.ts");
  const ports = await createLivePorts({ config, store, env, clock, llm, media, dataDir: opts.dataDir });
  const studio = new Studio({ config, store, clock, rng: new Rng(config.seed), ports, deps: makeDeps(config, opts.dataDir, opts.agents), dataDir: opts.dataDir, ledger });
  return { studio, store, config, llm };
}
