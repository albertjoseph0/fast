/**
 * Claude adapter: the Anthropic Messages API, called directly or through the Vercel AI
 * Gateway (which speaks the same protocol at https://ai-gateway.vercel.sh).
 *
 * Structured outputs use output_config.format with the studio's own JSON Schema
 * (jsonschema.ts), then zod validates the decoded JSON. Thinking is left adaptive (Opus
 * 5.5 rejects disabling it) and depth is set through an explicit effort on every call.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { StudioConfig } from "../config/schema.ts";
import type { Clock, CostMeter, Effort, LlmObjectRequest, LlmPort, LlmTextRequest, LlmUsage } from "../core/ports.ts";
import type { AgentRole } from "../core/types.ts";
import { SCHEMAS, type SchemaName, type SchemaOutputs } from "../agents/schemas.ts";
import { LlmError } from "./errors.ts";
import { toClaudeSchema } from "./jsonschema.ts";
import { costCents } from "./pricing.ts";
import { renderPrompt } from "./prompt.ts";

export type LlmProvider = "anthropic" | "gateway" | "stub";

/**
 * An explicit config provider wins. In auto mode a simulation always uses the stub; live
 * mode prefers the direct API key, then the gateway (a key, or a proxy that injects one).
 */
export function resolveLlmProvider(config: StudioConfig, env: Record<string, string | undefined>): LlmProvider {
  const explicit = config.llm.provider;
  if (explicit !== "auto") return explicit;
  if (config.mode === "sim") return "stub";
  if (env.ANTHROPIC_API_KEY) return "anthropic";
  if (env.AI_GATEWAY_API_KEY || env.HTTPS_PROXY || env.https_proxy) return "gateway";
  return "stub";
}

export const GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh";
/** Server-side refusal fallback, scalar "default" form (direct Anthropic API only). */
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";
export const DEFAULT_MAX_TOKENS = 16_000;
export const MAX_TOKENS_CAP = 64_000;
/** Above this, non-streaming requests risk the SDK's long-request guard, so the adapter streams. */
const STREAM_ABOVE_TOKENS = 16_000;
/** Pre-call budget check; the real cost is charged from usage afterwards. */
const BUDGET_ESTIMATE_CENTS = 5;

type ChatMessage = { role: "user" | "assistant"; content: string };

export interface ClaudeRequestBody {
  model: string;
  max_tokens: number;
  system: { type: "text"; text: string; cache_control: { type: "ephemeral" } }[];
  messages: ChatMessage[];
  output_config: { effort: Effort; format?: { type: "json_schema"; schema: Record<string, unknown> } };
  betas?: string[];
  fallbacks?: "default";
}

export interface ClaudeResponse {
  model?: string;
  content: { type: string; text?: string }[];
  stop_reason: string | null;
  stop_details?: { category?: string | null; explanation?: string | null } | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
}

interface MessagesLike {
  create(body: ClaudeRequestBody): PromiseLike<ClaudeResponse>;
  stream(body: ClaudeRequestBody): { finalMessage(): PromiseLike<ClaudeResponse> };
}

/** The slice of the Anthropic SDK client the adapter calls; tests inject a fake. */
export interface AnthropicLike {
  messages: MessagesLike;
  beta: { messages: MessagesLike };
}

export interface ClaudeLlmOptions {
  config: StudioConfig;
  meter: CostMeter;
  clock: Clock;
  provider: "anthropic" | "gateway";
  env?: Record<string, string | undefined>;
  client?: AnthropicLike;
}

export function createClaudeLlm(opts: ClaudeLlmOptions): LlmPort {
  return new ClaudeLlm(opts);
}

function defaultClient(provider: "anthropic" | "gateway", env: Record<string, string | undefined>): AnthropicLike {
  const client =
    provider === "gateway"
      ? new Anthropic({ baseURL: GATEWAY_BASE_URL, apiKey: null, authToken: env.AI_GATEWAY_API_KEY ?? "proxy-injected" })
      : new Anthropic({ apiKey: env.ANTHROPIC_API_KEY ?? null });
  return client as unknown as AnthropicLike;
}

const schemaCache = new Map<SchemaName, Record<string, unknown>>();

function claudeSchema(name: SchemaName): Record<string, unknown> {
  let schema = schemaCache.get(name);
  if (!schema) {
    schema = toClaudeSchema(SCHEMAS[name]);
    schemaCache.set(name, schema);
  }
  return schema;
}

function responseText(res: ClaudeResponse): string {
  return res.content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false; issue: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, issue: `response is not valid JSON: ${(err as Error).message}` };
  }
}

function repairInstructions(issues: string[]): string {
  return [
    "Your previous answer did not validate against the required schema. Fix these issues and answer again with the complete JSON object:",
    ...issues.map((i) => `- ${i}`),
  ].join("\n");
}

interface CallMeta {
  role: AgentRole;
  purpose: string;
  ventureId?: string;
  effort?: Effort;
}

class ClaudeLlm implements LlmPort {
  readonly kind = "claude";
  private readonly config: StudioConfig;
  private readonly meter: CostMeter;
  private readonly clock: Clock;
  private readonly provider: "anthropic" | "gateway";
  private readonly client: AnthropicLike;
  private callCounter = 0;
  private readonly totals: LlmUsage = { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costCents: 0 };

  constructor(opts: ClaudeLlmOptions) {
    this.config = opts.config;
    this.meter = opts.meter;
    this.clock = opts.clock;
    this.provider = opts.provider;
    this.client = opts.client ?? defaultClient(opts.provider, opts.env ?? process.env);
  }

  async object<N extends SchemaName>(req: LlmObjectRequest<N>): Promise<SchemaOutputs[N]> {
    const schema = SCHEMAS[req.schemaName];
    const messages: ChatMessage[] = [{ role: "user", content: renderPrompt(req.instructions, req.input, req.untrusted ?? []) }];
    const format = { type: "json_schema" as const, schema: claudeSchema(req.schemaName) };
    let repaired = false;
    for (;;) {
      const text = await this.complete(req, req.system, messages, format);
      const json = parseJson(text);
      let issues: string[];
      if (json.ok) {
        const parsed = schema.safeParse(json.value);
        if (parsed.success) return parsed.data;
        issues = parsed.error.issues.map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`);
      } else {
        issues = [json.issue];
      }
      if (repaired) {
        throw new LlmError("schema_invalid", `${req.schemaName} output failed validation after one repair attempt`, { issues });
      }
      repaired = true;
      messages.push({ role: "assistant", content: text }, { role: "user", content: repairInstructions(issues) });
    }
  }

  async text(req: LlmTextRequest): Promise<string> {
    const messages: ChatMessage[] = [{ role: "user", content: renderPrompt(req.instructions, req.input) }];
    return (await this.complete(req, req.system, messages, undefined)).trim();
  }

  usage(): LlmUsage {
    return { ...this.totals };
  }

  /** One logical completion: a refusal throws, and a max_tokens stop is retried once with double the budget. */
  private async complete(
    meta: CallMeta & { maxTokens?: number },
    system: string,
    messages: ChatMessage[],
    format: ClaudeRequestBody["output_config"]["format"],
  ): Promise<string> {
    let maxTokens = Math.min(meta.maxTokens ?? DEFAULT_MAX_TOKENS, MAX_TOKENS_CAP);
    let grown = false;
    for (;;) {
      const body = this.body(meta, system, messages, maxTokens, format);
      const res = await this.send(body, meta);
      if (res.stop_reason === "refusal") {
        const why = res.stop_details?.explanation ?? res.stop_details?.category ?? "no details";
        throw new LlmError("refusal", `Claude declined the ${meta.purpose} request (${why})`);
      }
      if (res.stop_reason === "max_tokens") {
        if (grown || maxTokens >= MAX_TOKENS_CAP) {
          throw new LlmError("max_tokens", `output exceeded max_tokens ${maxTokens} for ${meta.purpose}`);
        }
        grown = true;
        maxTokens = Math.min(maxTokens * 2, MAX_TOKENS_CAP);
        continue;
      }
      return responseText(res);
    }
  }

  private body(
    meta: CallMeta,
    system: string,
    messages: ChatMessage[],
    maxTokens: number,
    format: ClaudeRequestBody["output_config"]["format"],
  ): ClaudeRequestBody {
    const effort = meta.effort ?? this.config.llm.effortByRole[meta.role] ?? "medium";
    const body: ClaudeRequestBody = {
      model: this.modelFor(meta.role),
      max_tokens: maxTokens,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      // Copied so later appends to the caller's history never alter a sent request.
      messages: [...messages],
      output_config: format ? { effort, format } : { effort },
    };
    if (this.provider === "anthropic") {
      body.betas = [FALLBACK_BETA];
      body.fallbacks = "default";
    }
    return body;
  }

  private modelFor(role: AgentRole): string {
    const { model, fastModel, fastRoles, gatewayModelMap } = this.config.llm;
    const base = fastRoles.includes(role) ? fastModel : model;
    return this.provider === "gateway" ? (gatewayModelMap[base] ?? base) : base;
  }

  private async send(body: ClaudeRequestBody, meta: CallMeta): Promise<ClaudeResponse> {
    try {
      this.meter.assertBudget("llm", BUDGET_ESTIMATE_CENTS);
    } catch (err) {
      throw new LlmError("budget_exceeded", (err as Error).message, { cause: err });
    }
    const api = this.provider === "anthropic" ? this.client.beta.messages : this.client.messages;
    let res: ClaudeResponse;
    try {
      // Stream through the gateway: proxies drop long idle non-streaming requests (seen as 502s on
      // high-effort idea batches), and streaming keeps bytes flowing while the model thinks.
      const stream = this.provider === "gateway" || body.max_tokens > STREAM_ABOVE_TOKENS;
      res = stream ? await api.stream(body).finalMessage() : await api.create(body);
    } catch (err) {
      throw new LlmError("api", `Claude API call failed for ${meta.purpose}: ${(err as Error).message}`, { cause: err });
    }
    this.record(res, body.model, meta);
    return res;
  }

  private record(res: ClaudeResponse, requestedModel: string, meta: CallMeta): void {
    const u = res.usage;
    const usage = {
      inputTokens: u.input_tokens,
      outputTokens: u.output_tokens,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    };
    // A server-side fallback bills at the model that actually served the turn.
    const model = res.model || requestedModel;
    const cents = costCents(model, usage);
    this.callCounter += 1;
    this.totals.calls += 1;
    this.totals.inputTokens += usage.inputTokens + usage.cacheWriteTokens;
    this.totals.outputTokens += usage.outputTokens;
    this.totals.cacheReadTokens += usage.cacheReadTokens;
    this.totals.costCents += cents;
    this.meter.charge({
      kind: "llm",
      ...(meta.ventureId ? { ventureId: meta.ventureId } : {}),
      cents,
      model,
      purpose: meta.purpose,
      ref: `${this.clock.iso()}:${meta.role}:${this.callCounter}`,
    });
  }
}
