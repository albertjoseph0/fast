/**
 * The one error type LLM adapters throw for failures the caller may handle. SDK
 * transport errors are wrapped with code "api" and kept as `cause`, so callers can still
 * tell an Anthropic.RateLimitError from an Anthropic.BadRequestError.
 */
export type LlmErrorCode = "refusal" | "schema_invalid" | "max_tokens" | "budget_exceeded" | "api";

export class LlmError extends Error {
  readonly code: LlmErrorCode;
  /** Zod issues of the last attempt (schema_invalid only). */
  readonly issues?: string[];

  constructor(code: LlmErrorCode, message: string, opts: { issues?: string[]; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "LlmError";
    this.code = code;
    if (opts.issues) this.issues = opts.issues;
  }
}
