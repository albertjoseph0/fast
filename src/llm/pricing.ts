/**
 * Claude token prices (USD per million tokens, 2026-10). Cache reads bill at 0.1x the
 * input rate and 5-minute cache writes at 1.25x. Gateway ids ("anthropic/claude-opus-5.5")
 * resolve to the same entries; the Vercel AI Gateway adds no markup.
 */
import type { Cents } from "../core/types.ts";

export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}

export const CLAUDE_PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-opus-5-5": { inputPerMTok: 4, outputPerMTok: 20 },
  "claude-sonnet-5-5": { inputPerMTok: 2, outputPerMTok: 10 },
  "claude-haiku-5-5": { inputPerMTok: 0.1, outputPerMTok: 0.5 },
  "claude-fable-5-1": { inputPerMTok: 10, outputPerMTok: 50 },
};

export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_MULTIPLIER = 1.25;

/** Unknown models are priced at the most expensive tier so budgets fail safe. */
const FALLBACK_PRICE: ModelPrice = { inputPerMTok: 10, outputPerMTok: 50 };

export interface TokenUsage {
  /** Uncached input tokens (the API's input_tokens). */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** "anthropic/claude-opus-5.5" and dated snapshots map to the table key "claude-opus-5-5". */
export function normalizeModelId(model: string): string {
  const bare = model.replace(/^anthropic\//, "").replace(/\./g, "-");
  if (CLAUDE_PRICES[bare]) return bare;
  const prefix = Object.keys(CLAUDE_PRICES).find((k) => bare.startsWith(`${k}-`));
  return prefix ?? bare;
}

export function priceFor(model: string): ModelPrice {
  return CLAUDE_PRICES[normalizeModelId(model)] ?? FALLBACK_PRICE;
}

/** Exact cost in USD. */
export function costUsd(model: string, usage: TokenUsage): number {
  const p = priceFor(model);
  const inputEquivalent =
    usage.inputTokens + (usage.cacheReadTokens ?? 0) * CACHE_READ_MULTIPLIER + (usage.cacheWriteTokens ?? 0) * CACHE_WRITE_MULTIPLIER;
  return (inputEquivalent * p.inputPerMTok + usage.outputTokens * p.outputPerMTok) / 1_000_000;
}

/** Cost in integer cents, rounded up so the ledger never under-books. */
export function costCents(model: string, usage: TokenUsage): Cents {
  const cents = costUsd(model, usage) * 100;
  return Math.max(0, Math.ceil(cents - 1e-9));
}
