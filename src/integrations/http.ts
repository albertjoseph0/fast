/**
 * Shared HTTP client for live integrations.
 *
 * Dry-run is the default for every live adapter: writes (anything but GET/HEAD) are
 * recorded to the outbox directory with secrets redacted and answered with a synthetic
 * response, so an operator can read exactly what the studio would have sent.
 */
import { createReadStream, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { join } from "node:path";
import type { VentureBindings } from "../core/types.ts";

export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface HttpRequest {
  method: HttpMethod;
  url: string;
  headers?: Record<string, string>;
  /** JSON body (serialized with content-type application/json). */
  json?: unknown;
  /** Raw body for uploads or form posts. */
  body?: Uint8Array | string;
  /** Sent as the Idempotency-Key header when present. */
  idempotencyKey?: string;
  /** Defaults to true for anything but GET/HEAD. Non-mutating POSTs (token refresh, queries) set false. */
  sideEffect?: boolean;
  /** Per-request timeout override (uploads need minutes). */
  timeoutMs?: number;
  /** Correlates dry-run records with outbox actions. */
  context?: { actionId?: string; ventureId?: string };
}

export interface HttpResponse<T = unknown> {
  status: number;
  headers: Headers;
  data: T;
  dryRun: boolean;
}

/** A venture binding an adapter needs is unset: the venture's integrations.bind_projects task supplies it. */
export class MissingBindingError extends Error {
  constructor(
    readonly service: string,
    readonly binding: keyof VentureBindings,
    readonly bundleId: string,
  ) {
    super(`${service}: no ${binding} bound for ${bundleId} (complete the venture's integrations.bind_projects task)`);
    this.name = "MissingBindingError";
  }
}

/** A non-2xx response. `url` and `body` are scrubbed of secret query values, since error messages reach reports and logs. */
export class HttpError extends Error {
  readonly url: string;
  readonly body: string;

  constructor(
    readonly service: string,
    readonly status: number,
    url: string,
    body: string,
  ) {
    const safe = scrubSecrets(url, body);
    super(`${service} ${status} ${safe.url}: ${safe.body.slice(0, 500)}`);
    this.name = "HttpError";
    this.url = safe.url;
    this.body = safe.body;
  }
}

export interface DryRunRecord {
  seq: number;
  service: string;
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  json?: unknown;
  bodyBytes?: number;
  context?: { actionId?: string; ventureId?: string };
}

const SECRET_KEY = /(token|secret|password|api[_-]?key|signature|credential|authorization|client_assertion|refresh)/i;

/** Recursively redact secret-looking keys in JSON bodies. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? "<redacted>" : redact(v);
    return out;
  }
  return value;
}

function redactUrl(raw: string): string {
  const url = new URL(raw);
  for (const key of [...url.searchParams.keys()]) if (SECRET_KEY.test(key)) url.searchParams.set(key, "<redacted>");
  return url.toString();
}

/** Mask secret query parameters in the URL, and their values wherever the body echoes them back. */
function scrubSecrets(raw: string, body: string): { url: string; body: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { url: raw, body };
  }
  let scrubbed = body;
  for (const [key, value] of url.searchParams) {
    if (!SECRET_KEY.test(key) || !value) continue;
    for (const form of [value, encodeURIComponent(value)]) scrubbed = scrubbed.split(form).join("<redacted>");
  }
  return { url: redactUrl(raw), body: scrubbed };
}

const SECRET_HEADER = /^(authorization|x-api-key|api-key|x-goog-api-key|cookie|x-access-token)$/i;

export class DryRunRecorder {
  private readonly records: DryRunRecord[] = [];

  /** @param dir where to write one JSON file per request, or null to keep them in memory */
  private seq: number;

  constructor(private readonly dir: string | null = null) {
    if (dir) mkdirSync(dir, { recursive: true });
    this.seq = dir ? readdirSync(dir).length : 0;
  }

  record(service: string, req: HttpRequest): DryRunRecord {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers ?? {})) headers[k] = SECRET_HEADER.test(k) ? "<redacted>" : v;
    const rec: DryRunRecord = { seq: ++this.seq, service, method: req.method, url: redactUrl(req.url), headers };
    if (req.json !== undefined) rec.json = redact(req.json);
    if (req.context) rec.context = req.context;
    if (req.body !== undefined) rec.bodyBytes = typeof req.body === "string" ? req.body.length : req.body.byteLength;
    this.records.push(rec);
    if (this.dir) {
      const host = new URL(req.url).host.replace(/[^a-z0-9.-]/gi, "_");
      const action = req.context?.actionId ?? "na";
      writeFileSync(join(this.dir, `${String(rec.seq).padStart(6, "0")}-${action}-${service}-${host}.json`), JSON.stringify(rec, null, 2));
    }
    return rec;
  }

  list(): readonly DryRunRecord[] {
    return this.records;
  }
}

export interface HttpClientOptions {
  /** Short service name for errors and dry-run records, e.g. "asc", "revenuecat". */
  service: string;
  dryRun: boolean;
  recorder?: DryRunRecorder;
  /** Synthetic response body for a dry-run write. Defaults to `{ dryRun: true }`. */
  dryRunResponse?: (req: HttpRequest) => unknown;
  fetch?: typeof fetch;
  maxRetries?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  defaultHeaders?: () => Record<string, string> | Promise<Record<string, string>>;
  /** Extra statuses this service treats as transient. */
  retryableStatuses?: number[];
}

const RETRYABLE = [408, 425, 429, 500, 502, 503, 504];

export class HttpClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  private readonly retryable: Set<number>;

  constructor(private readonly opts: HttpClientOptions) {
    this.retryable = new Set([...RETRYABLE, ...(opts.retryableStatuses ?? [])]);
    this.fetchImpl = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get dryRun(): boolean {
    return this.opts.dryRun;
  }

  async request<T = unknown>(req: HttpRequest): Promise<HttpResponse<T>> {
    const headers: Record<string, string> = { ...(await this.opts.defaultHeaders?.()), ...req.headers };
    if (req.json !== undefined) headers["content-type"] ??= "application/json";
    if (req.idempotencyKey) headers["idempotency-key"] = req.idempotencyKey;
    const full: HttpRequest = { ...req, headers };

    const isWrite = req.sideEffect ?? (req.method !== "GET" && req.method !== "HEAD");
    // Writes that are not idempotent are never retried: a timeout may hide a server-side success.
    const safeToRetry = !isWrite || Boolean(req.idempotencyKey);
    if (this.opts.dryRun && isWrite) {
      this.opts.recorder?.record(this.opts.service, full);
      const data = (this.opts.dryRunResponse?.(full) ?? { dryRun: true }) as T;
      return { status: 200, headers: new Headers(), data, dryRun: true };
    }

    const maxRetries = this.opts.maxRetries ?? 3;
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? this.opts.timeoutMs ?? 60_000);
      let res: Response;
      try {
        res = await this.fetchImpl(req.url, {
          method: req.method,
          headers,
          body: req.json !== undefined ? JSON.stringify(req.json) : (req.body as RequestInit["body"]),
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        if (attempt < maxRetries && safeToRetry) {
          await this.sleep(backoffMs(attempt));
          continue;
        }
        throw err;
      }
      clearTimeout(timer);
      const text = await res.text();
      if (res.ok) {
        const type = res.headers.get("content-type") ?? "";
        const data = (text && type.includes("json") ? JSON.parse(text) : text) as T;
        return { status: res.status, headers: res.headers, data, dryRun: false };
      }
      if (this.retryable.has(res.status) && safeToRetry && attempt < maxRetries) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffMs(attempt));
        continue;
      }
      throw new HttpError(this.opts.service, res.status, req.url, text);
    }
  }

  /**
   * Stream a file (or a byte range of it) as the request body, for presigned upload
   * operations (App Store Connect), resumable uploads (YouTube) and chunked uploads (TikTok).
   */
  async upload<T = unknown>(req: {
    method: "PUT" | "POST" | "PATCH";
    url: string;
    headers?: Record<string, string>;
    file: { path: string; offset?: number; length?: number };
    idempotencyKey?: string;
    context?: HttpRequest["context"];
  }): Promise<HttpResponse<T>> {
    const offset = req.file.offset ?? 0;
    const length = req.file.length ?? statSync(req.file.path).size - offset;
    if (this.opts.dryRun) {
      return this.request<T>({ method: req.method, url: req.url, headers: { ...req.headers, "x-dry-run-upload-bytes": String(length) }, body: "", ...(req.context ? { context: req.context } : {}) });
    }
    const stream = Readable.toWeb(createReadStream(req.file.path, { start: offset, end: offset + length - 1 })) as unknown as ReadableStream;
    const headers = { "content-length": String(length), ...(await this.opts.defaultHeaders?.()), ...req.headers };
    const res = await this.fetchImpl(req.url, { method: req.method, headers, body: stream, duplex: "half" } as RequestInit);
    const text = await res.text();
    if (!res.ok) throw new HttpError(this.opts.service, res.status, req.url, text);
    const type = res.headers.get("content-type") ?? "";
    return { status: res.status, headers: res.headers, data: (text && type.includes("json") ? JSON.parse(text) : text) as T, dryRun: false };
  }

  get<T = unknown>(url: string, headers?: Record<string, string>): Promise<HttpResponse<T>> {
    return this.request<T>({ method: "GET", url, ...(headers ? { headers } : {}) });
  }

  post<T = unknown>(url: string, json: unknown, headers?: Record<string, string>): Promise<HttpResponse<T>> {
    return this.request<T>({ method: "POST", url, json, ...(headers ? { headers } : {}) });
  }

  patch<T = unknown>(url: string, json: unknown, headers?: Record<string, string>): Promise<HttpResponse<T>> {
    return this.request<T>({ method: "PATCH", url, json, ...(headers ? { headers } : {}) });
  }
}

function backoffMs(attempt: number): number {
  return Math.min(30_000, 500 * 2 ** attempt);
}

/** Build a URL with query parameters, skipping undefined values. */
export function withQuery(base: string, params: Record<string, string | number | boolean | undefined>): string {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
  return url.toString();
}
