/**
 * Execution contexts and the outbox contract.
 *
 * Agents receive an AgentContext (read ports only) and return data. The orchestrator
 * receives a TickContext and turns decisions into Actions through the Outbox; it never
 * holds WritePorts. Governance implements Outbox and is the only holder of WritePorts.
 */
import type { StudioConfig } from "../config/schema.ts";
import type { ReadPorts } from "./ports.ts";
import type { Rng } from "./rng.ts";
import type { StudioStore } from "./store.ts";
import type {
  Action,
  ActionKind,
  ActionPayloads,
  Cents,
  Commitment,
  HumanTask,
  HumanTaskDraft,
  ProposedBy,
  StudioEventType,
} from "./types.ts";

export interface ProposeInput<K extends ActionKind> {
  kind: K;
  ventureId?: string;
  payload: ActionPayloads[K];
  summary: string;
  rationale: string;
  proposedBy: ProposedBy;
  /** Stable natural key, e.g. `ios` for store.create_app or a submission id for a payout. */
  naturalKey: string;
  commitment?: Commitment;
  /** Defaults to commitment.maxTotalCents, else 0. */
  costCents?: Cents;
  experimentId?: string;
  cellId?: string;
}

export interface Outbox {
  /**
   * Create an action, run policy and set its status. If an open action with the same
   * dedupe key exists, returns it instead of creating a duplicate.
   */
  propose<K extends ActionKind>(input: ProposeInput<K>): Action<K>;
  /** Open (or return the existing open) human task, blocking the given actions until done. */
  openTask(draft: HumanTaskDraft, blocksActionIds?: string[]): HumanTask;
  /** Cancel an open action (e.g. spend for a venture that is winding down). */
  cancel(id: string, reason: string): Action;
  /** Actions in a given status, optionally for one venture. */
  list(filter?: { status?: Action["status"][]; ventureId?: string; kind?: ActionKind[] }): Action[];
}

export interface AgentContext {
  config: StudioConfig;
  ports: ReadPorts;
  /** Read domain state freely; agents do not create actions. */
  store: StudioStore;
  rng: Rng;
  today: string;
}

export interface TickContext extends AgentContext {
  tick: number;
  outbox: Outbox;
  log(type: StudioEventType, data: Record<string, unknown>, ventureId?: string): void;
}
