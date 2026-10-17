/**
 * Studio state: an in-memory document store with a JSON snapshot and an append-only
 * event log. Small enough to read, diff and audit by hand; no native dependencies.
 *
 * Durability protocol: mutations stay in memory until commit(), which writes the
 * snapshot atomically (tmp + fsync + rename) and only then appends the buffered events.
 * The governance executor commits before and after every external call (write-ahead),
 * so a crash can never re-run a side effect blindly. One process may hold the lock.
 */
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import type {
  Action,
  AdCampaign,
  CellObservation,
  Claim,
  CohortMetrics,
  ContentPiece,
  CreativeBatch,
  Creator,
  CreatorCampaign,
  CreatorDeal,
  CreatorSubmission,
  DailyMetrics,
  ExperimentOutcome,
  ExperimentPlan,
  ExternalJob,
  HumanTask,
  Hook,
  IdKind,
  IdeaRecord,
  LedgerCategory,
  LedgerEntry,
  LegalEntity,
  OwnedAccount,
  Payout,
  PublisherAccount,
  Screening,
  Signal,
  StudioEvent,
  StudioEventType,
  Venture,
} from "./types.ts";
import { ID } from "./types.ts";
import type { Clock } from "./ports.ts";

export const STATE_VERSION = 2;

export interface AudienceExposure {
  /** `${wedge}|${channel}|${platform}|${unit}`: unit is a creatorId, accountId, ad set or storefront geo. */
  key: string;
  wedge: string;
  ventureId: string;
  experimentId: string;
  at: string;
}

export interface QuotaWindow {
  windowStart: string;
  used: number;
  limit: number;
}

export interface StudioState {
  version: number;
  meta: { createdAt: string; tick: number; lastTickDate: string | null; seed: number };
  counters: Record<string, number>;
  signals: Record<string, Signal>;
  ideas: Record<string, IdeaRecord>;
  screenings: Record<string, Screening>;
  ventures: Record<string, Venture>;
  experiments: Record<string, ExperimentPlan>;
  observations: Record<string, CellObservation[]>;
  outcomes: Record<string, ExperimentOutcome[]>;
  hooks: Record<string, Hook>;
  batches: Record<string, CreativeBatch>;
  content: Record<string, ContentPiece>;
  creators: Record<string, Creator>;
  deals: Record<string, CreatorDeal>;
  campaigns: Record<string, CreatorCampaign>;
  submissions: Record<string, CreatorSubmission>;
  payouts: Record<string, Payout>;
  adCampaigns: Record<string, AdCampaign>;
  actions: Record<string, Action>;
  tasks: Record<string, HumanTask>;
  jobs: Record<string, ExternalJob>;
  claims: Record<string, Claim>;
  entities: Record<string, LegalEntity>;
  publishers: Record<string, PublisherAccount>;
  accounts: Record<string, OwnedAccount>;
  ledger: LedgerEntry[];
  /** `${ventureId}` -> rows keyed by `${date}|${cellId ?? "*"}|${geo ?? "*"}`. */
  metrics: Record<string, Record<string, DailyMetrics>>;
  /** `${ventureId}` -> rows keyed by `${cohortDate}|${lane}|${ageDays}`. */
  cohorts: Record<string, Record<string, CohortMetrics>>;
  exposures: AudienceExposure[];
  quotas: Record<string, QuotaWindow>;
  /** Automation freezes by scope (`platform:tiktok`, `venture:ven_000003`, `network:meta`); cleared only by a human. */
  freezes: Record<string, Freeze>;
}

export interface Freeze {
  scope: string;
  reason: string;
  at: string;
  by: string;
}

type KeyedCollection = {
  [K in keyof StudioState]: StudioState[K] extends Record<string, { id: string }> ? K : never;
}[keyof StudioState];

export interface ReadonlyCollection<T> {
  get(id: string): T | undefined;
  require(id: string): T;
  list(filter?: (t: T) => boolean): T[];
  count(filter?: (t: T) => boolean): number;
}

export class Collection<T> implements ReadonlyCollection<T> {
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
    version: STATE_VERSION,
    meta: { createdAt, tick: 0, lastTickDate: null, seed },
    counters: {},
    signals: {},
    ideas: {},
    screenings: {},
    ventures: {},
    experiments: {},
    observations: {},
    outcomes: {},
    hooks: {},
    batches: {},
    content: {},
    creators: {},
    deals: {},
    campaigns: {},
    submissions: {},
    payouts: {},
    adCampaigns: {},
    actions: {},
    tasks: {},
    jobs: {},
    claims: {},
    entities: {},
    publishers: {},
    accounts: {},
    ledger: [],
    metrics: {},
    cohorts: {},
    exposures: [],
    quotas: {},
    freezes: {},
  };
}

/** Forward-migrate an older snapshot by filling any missing collections. */
function migrate(parsed: Partial<StudioState>, createdAt: string, seed: number): StudioState {
  const base = emptyState(createdAt, seed);
  const merged = { ...base, ...parsed, meta: { ...base.meta, ...parsed.meta } } as StudioState;
  merged.version = STATE_VERSION;
  return merged;
}

export class LockHeldError extends Error {}

export class StudioStore {
  private state: StudioState;
  private pendingEvents: StudioEvent[] = [];
  private readonly recent: StudioEvent[] = [];
  private eventSeq = 0;
  private lockPath: string | null = null;

  readonly signals: Collection<Signal>;
  readonly ideas: Collection<IdeaRecord>;
  readonly screenings: Collection<Screening>;
  readonly ventures: Collection<Venture>;
  readonly experiments: Collection<ExperimentPlan>;
  readonly hooks: Collection<Hook>;
  readonly batches: Collection<CreativeBatch>;
  readonly content: Collection<ContentPiece>;
  readonly creators: Collection<Creator>;
  readonly deals: Collection<CreatorDeal>;
  readonly campaigns: Collection<CreatorCampaign>;
  readonly submissions: Collection<CreatorSubmission>;
  readonly payouts: Collection<Payout>;
  readonly adCampaigns: Collection<AdCampaign>;
  readonly tasks: Collection<HumanTask>;
  readonly jobs: Collection<ExternalJob>;
  readonly claims: Collection<Claim>;
  readonly entities: Collection<LegalEntity>;
  readonly publishers: Collection<PublisherAccount>;
  readonly accounts: Collection<OwnedAccount>;
  /** Read-only for everyone; only src/governance writes actions (via governanceActions()). */
  readonly actions: ReadonlyCollection<Action>;
  private readonly actionsRw: Collection<Action>;

  /**
   * @param dir directory for state.json + events.jsonl, or null for an in-memory store
   * @param opts.lock take the single-writer lock (default true when dir is set)
   */
  constructor(
    readonly dir: string | null,
    private readonly clock: Clock,
    seed = 1,
    opts: { lock?: boolean } = {},
  ) {
    this.state = emptyState(clock.iso(), seed);
    if (dir) {
      mkdirSync(dir, { recursive: true });
      if (opts.lock ?? true) this.acquireLock(dir);
      const snapshot = join(dir, "state.json");
      if (existsSync(snapshot)) {
        this.state = migrate(JSON.parse(readFileSync(snapshot, "utf8")) as Partial<StudioState>, clock.iso(), seed);
      }
      const log = join(dir, "events.jsonl");
      if (existsSync(log)) this.eventSeq = readFileSync(log, "utf8").split("\n").filter(Boolean).length;
    }
    const keyed = <T extends { id: string }>(name: KeyedCollection) =>
      new Collection<T>(() => this.state[name] as unknown as Record<string, T>, (t) => t.id);
    this.signals = keyed<Signal>("signals");
    this.ideas = keyed<IdeaRecord>("ideas");
    this.screenings = keyed<Screening>("screenings");
    this.ventures = keyed<Venture>("ventures");
    this.experiments = keyed<ExperimentPlan>("experiments");
    this.hooks = keyed<Hook>("hooks");
    this.batches = keyed<CreativeBatch>("batches");
    this.content = keyed<ContentPiece>("content");
    this.creators = keyed<Creator>("creators");
    this.deals = keyed<CreatorDeal>("deals");
    this.campaigns = keyed<CreatorCampaign>("campaigns");
    this.submissions = keyed<CreatorSubmission>("submissions");
    this.payouts = keyed<Payout>("payouts");
    this.adCampaigns = keyed<AdCampaign>("adCampaigns");
    this.tasks = keyed<HumanTask>("tasks");
    this.jobs = keyed<ExternalJob>("jobs");
    this.claims = keyed<Claim>("claims");
    this.entities = keyed<LegalEntity>("entities");
    this.publishers = keyed<PublisherAccount>("publishers");
    this.accounts = keyed<OwnedAccount>("accounts");
    this.actionsRw = keyed<Action>("actions");
    this.actions = this.actionsRw;
  }

  /** Writable action collection. Only src/governance may call this (enforced by a contract test). */
  governanceActions(): Collection<Action> {
    return this.actionsRw;
  }

  get meta(): StudioState["meta"] {
    return this.state.meta;
  }

  /** Deterministic, human-readable ids: idea_000001, ven_000002, ... */
  nextId(kind: IdKind): string {
    const prefix = ID[kind];
    const n = (this.state.counters[prefix] ?? 0) + 1;
    this.state.counters[prefix] = n;
    return `${prefix}_${String(n).padStart(6, "0")}`;
  }

  latestScreening(ideaId: string): Screening | undefined {
    return this.screenings
      .list((s) => s.ideaId === ideaId)
      .sort((a, b) => (a.screenedAt < b.screenedAt ? -1 : a.screenedAt > b.screenedAt ? 1 : a.id < b.id ? -1 : 1))
      .at(-1);
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

  // -- metrics and cohorts (upserts, so overlapping sync windows never duplicate) ----

  upsertMetrics(ventureId: string, rows: DailyMetrics[]): void {
    const table = (this.state.metrics[ventureId] ??= {});
    for (const r of rows) table[`${r.date}|${r.cellId ?? "*"}|${r.geo ?? "*"}`] = r;
  }

  metrics(ventureId: string, filter?: (m: DailyMetrics) => boolean): DailyMetrics[] {
    const rows = Object.values(this.state.metrics[ventureId] ?? {}).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return filter ? rows.filter(filter) : rows;
  }

  upsertCohorts(ventureId: string, rows: CohortMetrics[]): void {
    const table = (this.state.cohorts[ventureId] ??= {});
    for (const r of rows) table[`${r.cohortDate}|${r.lane}|${r.ageDays}`] = r;
  }

  cohorts(ventureId: string, filter?: (c: CohortMetrics) => boolean): CohortMetrics[] {
    const rows = Object.values(this.state.cohorts[ventureId] ?? {});
    return filter ? rows.filter(filter) : rows;
  }

  // -- audiences (Bier P4: don't exhaust an audience) ----------------------------

  recordExposure(e: AudienceExposure): void {
    this.state.exposures.push(e);
  }

  exposures(filter?: (e: AudienceExposure) => boolean): AudienceExposure[] {
    return filter ? this.state.exposures.filter(filter) : this.state.exposures;
  }

  // -- quotas (rate budgets that survive restarts) ---------------------------------

  quota(key: string): QuotaWindow | undefined {
    return this.state.quotas[key];
  }

  setQuota(key: string, q: QuotaWindow): void {
    this.state.quotas[key] = q;
  }

  // -- freezes (platform strikes, tripwires) ---------------------------------------

  freeze(f: Freeze): void {
    this.state.freezes[f.scope] = f;
  }

  unfreeze(scope: string): void {
    delete this.state.freezes[scope];
  }

  /** Active freezes, optionally only those matching any of the given scopes. */
  freezes(scopes?: string[]): Freeze[] {
    const all = Object.values(this.state.freezes);
    return scopes ? all.filter((f) => scopes.includes(f.scope)) : all;
  }

  // -- money -------------------------------------------------------------------

  /**
   * Book a ledger entry. Idempotent on sourceKey: booking an existing key replaces the
   * amounts (e.g. a revenue day restated by the store) instead of adding a duplicate.
   * Only src/governance/ledger.ts calls this.
   */
  book(entry: Omit<LedgerEntry, "id" | "at"> & { at?: string }): LedgerEntry {
    const existing = this.state.ledger.findIndex((e) => e.sourceKey === entry.sourceKey);
    const row: LedgerEntry = {
      ...entry,
      id: existing >= 0 ? (this.state.ledger[existing] as LedgerEntry).id : this.nextId("ledger"),
      at: entry.at ?? this.clock.iso(),
    };
    if (existing >= 0) this.state.ledger[existing] = row;
    else this.state.ledger.push(row);
    return row;
  }

  ledger(filter?: (e: LedgerEntry) => boolean): LedgerEntry[] {
    return filter ? this.state.ledger.filter(filter) : this.state.ledger;
  }

  /** Sum of ledger amounts, optionally filtered by venture, categories and time. */
  net(opts: { ventureId?: string; categories?: LedgerCategory[]; since?: string; until?: string } = {}): number {
    return this.state.ledger
      .filter((e) => (opts.ventureId ? e.ventureId === opts.ventureId : true))
      .filter((e) => (opts.categories ? opts.categories.includes(e.category) : true))
      .filter((e) => (opts.since ? e.at >= opts.since : true))
      .filter((e) => (opts.until ? e.at < opts.until : true))
      .reduce((sum, e) => sum + e.amountCents, 0);
  }

  // -- events ------------------------------------------------------------------

  emit(type: StudioEventType, data: Record<string, unknown> = {}, ventureId?: string): StudioEvent {
    const event: StudioEvent = { seq: ++this.eventSeq, at: this.clock.iso(), type, data };
    if (ventureId) event.ventureId = ventureId;
    this.pendingEvents.push(event);
    this.recent.push(event);
    return event;
  }

  /** Events emitted by this process (the on-disk log holds the full history). */
  recentEvents(filter?: (e: StudioEvent) => boolean): StudioEvent[] {
    return filter ? this.recent.filter(filter) : this.recent;
  }

  // -- persistence -------------------------------------------------------------

  /** Persist the snapshot atomically, then append buffered events. */
  commit(): void {
    if (!this.dir) {
      this.pendingEvents = [];
      return;
    }
    const path = join(this.dir, "state.json");
    const tmp = `${path}.tmp`;
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, JSON.stringify(this.state, null, 1));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    if (this.pendingEvents.length) {
      appendFileSync(join(this.dir, "events.jsonl"), this.pendingEvents.map((e) => JSON.stringify(e)).join("\n") + "\n");
      this.pendingEvents = [];
    }
  }

  /** Release the single-writer lock. */
  close(): void {
    this.commit();
    if (this.lockPath && existsSync(this.lockPath)) rmSync(this.lockPath);
    this.lockPath = null;
  }

  snapshot(): StudioState {
    return structuredClone(this.state);
  }

  private acquireLock(dir: string): void {
    const path = join(dir, "LOCK");
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, JSON.stringify({ pid: process.pid, at: this.clock.iso() }));
      closeSync(fd);
      this.lockPath = path;
    } catch {
      throw new LockHeldError(`studio state at ${dir} is locked by another process (${path}); remove it if that process is gone`);
    }
  }
}
