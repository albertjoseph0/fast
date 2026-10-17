/**
 * Studio state: an in-memory document store with a JSON snapshot and an append-only
 * event log. Small enough to read, diff and audit by hand; no native dependencies.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  Action,
  CellObservation,
  ContentPiece,
  CreatorCampaign,
  CreatorSubmission,
  DailyMetrics,
  ExperimentOutcome,
  ExperimentPlan,
  IdeaRecord,
  LedgerCategory,
  LedgerEntry,
  Screening,
  Signal,
  StudioEvent,
  Venture,
} from "./types.ts";
import type { Clock } from "./ports.ts";

export interface AudienceExposure {
  /** `${wedge}|${geo}|${channel}` */
  key: string;
  ventureId: string;
  experimentId: string;
  at: string;
}

export interface StudioState {
  version: 1;
  meta: { createdAt: string; tick: number; lastTickAt: string | null; seed: number };
  counters: Record<string, number>;
  signals: Record<string, Signal>;
  ideas: Record<string, IdeaRecord>;
  screenings: Record<string, Screening>;
  ventures: Record<string, Venture>;
  experiments: Record<string, ExperimentPlan>;
  observations: Record<string, CellObservation[]>;
  outcomes: Record<string, ExperimentOutcome[]>;
  content: Record<string, ContentPiece>;
  campaigns: Record<string, CreatorCampaign>;
  submissions: Record<string, CreatorSubmission>;
  actions: Record<string, Action>;
  ledger: LedgerEntry[];
  metrics: Record<string, DailyMetrics[]>;
  exposures: AudienceExposure[];
}

type KeyedCollection =
  | "signals"
  | "ideas"
  | "screenings"
  | "ventures"
  | "experiments"
  | "content"
  | "campaigns"
  | "submissions"
  | "actions";

export class Collection<T> {
  constructor(
    private readonly records: () => Record<string, T>,
    private readonly keyOf: (t: T) => string,
  ) {}

  get(id: string): T | undefined {
    return this.records()[id];
  }

  require(id: string): T {
    const v = this.records()[id];
    if (!v) throw new Error(`not found: ${id}`);
    return v;
  }

  put(value: T): T {
    this.records()[this.keyOf(value)] = value;
    return value;
  }

  update(id: string, fn: (current: T) => T): T {
    return this.put(fn(this.require(id)));
  }

  list(filter?: (t: T) => boolean): T[] {
    const all = Object.values(this.records());
    return filter ? all.filter(filter) : all;
  }

  count(filter?: (t: T) => boolean): number {
    return this.list(filter).length;
  }
}

function emptyState(createdAt: string, seed: number): StudioState {
  return {
    version: 1,
    meta: { createdAt, tick: 0, lastTickAt: null, seed },
    counters: {},
    signals: {},
    ideas: {},
    screenings: {},
    ventures: {},
    experiments: {},
    observations: {},
    outcomes: {},
    content: {},
    campaigns: {},
    submissions: {},
    actions: {},
    ledger: [],
    metrics: {},
    exposures: [],
  };
}

export class StudioStore {
  private state: StudioState;
  private readonly events: StudioEvent[] = [];
  private eventSeq = 0;

  readonly signals: Collection<Signal>;
  readonly ideas: Collection<IdeaRecord>;
  readonly screenings: Collection<Screening>;
  readonly ventures: Collection<Venture>;
  readonly experiments: Collection<ExperimentPlan>;
  readonly content: Collection<ContentPiece>;
  readonly campaigns: Collection<CreatorCampaign>;
  readonly submissions: Collection<CreatorSubmission>;
  readonly actions: Collection<Action>;

  /**
   * @param dir directory for state.json + events.jsonl, or null for an in-memory store
   */
  constructor(
    readonly dir: string | null,
    private readonly clock: Clock,
    seed = 1,
  ) {
    this.state = emptyState(clock.iso(), seed);
    if (dir) {
      mkdirSync(dir, { recursive: true });
      const snapshot = join(dir, "state.json");
      if (existsSync(snapshot)) this.state = JSON.parse(readFileSync(snapshot, "utf8")) as StudioState;
      const log = join(dir, "events.jsonl");
      if (existsSync(log)) {
        const lines = readFileSync(log, "utf8").split("\n").filter(Boolean);
        this.eventSeq = lines.length;
      }
    }
    const keyed = <T,>(name: KeyedCollection, keyOf: (t: T) => string) =>
      new Collection<T>(() => this.state[name] as unknown as Record<string, T>, keyOf);
    this.signals = keyed<Signal>("signals", (s) => s.id);
    this.ideas = keyed<IdeaRecord>("ideas", (i) => i.id);
    this.screenings = keyed<Screening>("screenings", (s) => s.ideaId);
    this.ventures = keyed<Venture>("ventures", (v) => v.id);
    this.experiments = keyed<ExperimentPlan>("experiments", (e) => e.id);
    this.content = keyed<ContentPiece>("content", (c) => c.id);
    this.campaigns = keyed<CreatorCampaign>("campaigns", (c) => c.id);
    this.submissions = keyed<CreatorSubmission>("submissions", (s) => s.id);
    this.actions = keyed<Action>("actions", (a) => a.id);
  }

  get meta(): StudioState["meta"] {
    return this.state.meta;
  }

  /** Deterministic, human-readable ids: idea_0001, ven_0002, ... */
  nextId(prefix: string): string {
    const n = (this.state.counters[prefix] ?? 0) + 1;
    this.state.counters[prefix] = n;
    return `${prefix}_${String(n).padStart(4, "0")}`;
  }

  // -- observations / outcomes ------------------------------------------------

  addObservation(experimentId: string, obs: CellObservation): void {
    (this.state.observations[experimentId] ??= []).push(obs);
  }

  observations(experimentId: string): CellObservation[] {
    return this.state.observations[experimentId] ?? [];
  }

  /** Latest observation per cell (observations are cumulative snapshots). */
  latestObservations(experimentId: string): Map<string, CellObservation> {
    const out = new Map<string, CellObservation>();
    for (const o of this.observations(experimentId)) out.set(o.cellId, o);
    return out;
  }

  addOutcome(outcome: ExperimentOutcome): void {
    (this.state.outcomes[outcome.experimentId] ??= []).push(outcome);
  }

  outcomes(experimentId: string): ExperimentOutcome[] {
    return this.state.outcomes[experimentId] ?? [];
  }

  // -- metrics -----------------------------------------------------------------

  setMetrics(ventureId: string, rows: DailyMetrics[]): void {
    this.state.metrics[ventureId] = rows;
  }

  metrics(ventureId: string): DailyMetrics[] {
    return this.state.metrics[ventureId] ?? [];
  }

  // -- audiences (Bier P4: don't exhaust an audience) ----------------------------

  recordExposure(e: AudienceExposure): void {
    this.state.exposures.push(e);
  }

  exposures(key?: string): AudienceExposure[] {
    return key ? this.state.exposures.filter((e) => e.key === key) : this.state.exposures;
  }

  // -- money -------------------------------------------------------------------

  book(entry: Omit<LedgerEntry, "id" | "at"> & { at?: string }): LedgerEntry {
    const row: LedgerEntry = { id: this.nextId("led"), at: entry.at ?? this.clock.iso(), ...entry };
    this.state.ledger.push(row);
    return row;
  }

  ledger(filter?: (e: LedgerEntry) => boolean): LedgerEntry[] {
    return filter ? this.state.ledger.filter(filter) : this.state.ledger;
  }

  /** Net cash (revenue minus spend), optionally for one venture and/or category set. */
  net(opts: { ventureId?: string; categories?: LedgerCategory[]; since?: string } = {}): number {
    return this.state.ledger
      .filter((e) => (opts.ventureId ? e.ventureId === opts.ventureId : true))
      .filter((e) => (opts.categories ? opts.categories.includes(e.category) : true))
      .filter((e) => (opts.since ? e.at >= opts.since : true))
      .reduce((sum, e) => sum + e.amountCents, 0);
  }

  // -- events ------------------------------------------------------------------

  emit(type: string, data: Record<string, unknown> = {}, ventureId?: string): StudioEvent {
    const event: StudioEvent = { seq: ++this.eventSeq, at: this.clock.iso(), type, data };
    if (ventureId) event.ventureId = ventureId;
    this.events.push(event);
    if (this.dir) appendFileSync(join(this.dir, "events.jsonl"), JSON.stringify(event) + "\n");
    return event;
  }

  /** Events emitted by this process (the on-disk log holds the full history). */
  recentEvents(filter?: (e: StudioEvent) => boolean): StudioEvent[] {
    return filter ? this.events.filter(filter) : this.events;
  }

  // -- persistence -------------------------------------------------------------

  save(): void {
    if (!this.dir) return;
    const path = join(this.dir, "state.json");
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 1));
    renameSync(tmp, path);
  }

  snapshot(): StudioState {
    return structuredClone(this.state);
  }
}
