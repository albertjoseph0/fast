import type { SchemaName, SchemaOutputs } from "../../src/agents/schemas.ts";
import { defaultConfig } from "../../src/config/schema.ts";
import { SimClock } from "../../src/core/clock.ts";
import type { AgentContext } from "../../src/core/context.ts";
import type { LlmObjectRequest, LlmPort, LlmTextRequest, LlmUsage, MediaAsset, MediaPort, ReadPorts } from "../../src/core/ports.ts";
import { Rng } from "../../src/core/rng.ts";
import { StudioStore } from "../../src/core/store.ts";

export { astra, astraSpec, critique } from "../principles/fixtures.ts";

export const NOW = "2026-10-17T12:00:00.000Z";

type Handlers = { [N in SchemaName]?: (req: LlmObjectRequest<N>, call: number) => SchemaOutputs[N] };

/** Records every request and answers from per-schema handlers; unknown schemas throw. */
export class FakeLlm implements LlmPort {
  readonly kind = "stub" as const;
  readonly objectCalls: LlmObjectRequest<SchemaName>[] = [];
  readonly textCalls: LlmTextRequest[] = [];
  private readonly counts = new Map<SchemaName, number>();

  constructor(
    private readonly handlers: Handlers = {},
    private readonly textReply: string | ((req: LlmTextRequest) => string) = "A short analyst note.",
  ) {}

  async object<N extends SchemaName>(req: LlmObjectRequest<N>): Promise<SchemaOutputs[N]> {
    this.objectCalls.push(req as unknown as LlmObjectRequest<SchemaName>);
    const handler = this.handlers[req.schemaName] as ((r: LlmObjectRequest<N>, call: number) => SchemaOutputs[N]) | undefined;
    if (!handler) throw new Error(`FakeLlm: no handler for ${req.schemaName}`);
    const call = this.counts.get(req.schemaName) ?? 0;
    this.counts.set(req.schemaName, call + 1);
    return structuredClone(handler(req, call));
  }

  async text(req: LlmTextRequest): Promise<string> {
    this.textCalls.push(req);
    return typeof this.textReply === "function" ? this.textReply(req) : this.textReply;
  }

  usage(): LlmUsage {
    return { calls: this.objectCalls.length + this.textCalls.length, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costCents: 0 };
  }

  calls<N extends SchemaName>(name: N): LlmObjectRequest<N>[] {
    return this.objectCalls.filter((c) => c.schemaName === name) as unknown as LlmObjectRequest<N>[];
  }
}

/** Records image requests and returns deterministic assets without touching disk. */
export class FakeMedia implements MediaPort {
  readonly kind = "stub" as const;
  readonly images: Parameters<MediaPort["image"]>[0][] = [];

  async image(req: Parameters<MediaPort["image"]>[0]): Promise<MediaAsset> {
    this.images.push(req);
    return { path: req.outPath, mediaType: "image/png", bytes: 10, sha256: `sha_${this.images.length}`, model: "fake", costCents: 4, aiGenerated: true, c2pa: true };
  }

  async video(): Promise<MediaAsset> {
    throw new Error("FakeMedia: video not stubbed");
  }
}

export function agentContext(ports: Partial<ReadPorts> = {}): AgentContext {
  const clock = new SimClock(NOW);
  const missing = (name: string) =>
    new Proxy({}, { get: (_t, prop) => (prop === "kind" ? "sim" : () => Promise.reject(new Error(`unstubbed port ${name}.${String(prop)}`))) });
  return {
    config: defaultConfig(),
    ports: {
      clock,
      llm: missing("llm"),
      media: missing("media"),
      trends: missing("trends"),
      store: missing("store"),
      metrics: missing("metrics"),
      creators: missing("creators"),
      social: missing("social"),
      ads: missing("ads"),
      ...ports,
    } as ReadPorts,
    store: new StudioStore(null, clock, 1),
    rng: new Rng(1),
    today: clock.today(),
  };
}

/** Recursively freeze so any mutation in code under test throws. */
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}
