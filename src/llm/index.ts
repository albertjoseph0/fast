/**
 * LLM and media ports: the Claude adapter (Anthropic API or Vercel AI Gateway), the
 * deterministic stub and gateway media generation.
 */
import type { StudioConfig } from "../config/schema.ts";
import type { Clock, CostMeter, LlmPort } from "../core/ports.ts";
import { createClaudeLlm, resolveLlmProvider } from "./claude.ts";
import { StubLlm } from "./stub.ts";

export interface CreateLlmOptions {
  config: StudioConfig;
  meter: CostMeter;
  clock: Clock;
  env: Record<string, string | undefined>;
  /** Overrides config.seed for the stub. */
  seed?: number;
}

/** The LLM port for this config and environment (see resolveLlmProvider). */
export function createLlm(opts: CreateLlmOptions): LlmPort {
  const provider = resolveLlmProvider(opts.config, opts.env);
  if (provider === "stub") return new StubLlm({ seed: opts.seed ?? opts.config.seed });
  return createClaudeLlm({ config: opts.config, meter: opts.meter, clock: opts.clock, provider, env: opts.env });
}

export {
  createClaudeLlm,
  resolveLlmProvider,
  DEFAULT_MAX_TOKENS,
  MAX_TOKENS_CAP,
  FALLBACK_BETA,
  GATEWAY_BASE_URL,
  type AnthropicLike,
  type ClaudeLlmOptions,
  type ClaudeRequestBody,
  type ClaudeResponse,
  type LlmProvider,
} from "./claude.ts";
export { StubLlm } from "./stub.ts";
export { createMedia, embedsProvenance, imageCostCents, solidPng, videoCostCents, type MediaOptions, type MediaSdk } from "./media.ts";
export { LlmError, type LlmErrorCode } from "./errors.ts";
export { assertClaudeCompatible, toClaudeSchema } from "./jsonschema.ts";
export { CLAUDE_PRICES, costCents, costUsd, normalizeModelId, priceFor, type ModelPrice, type TokenUsage } from "./pricing.ts";
