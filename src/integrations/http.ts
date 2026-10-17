/**
 * Shared HTTP client for live integrations.
 *
 * Dry-run is the default for every live adapter: writes (anything but GET/HEAD) are
 * recorded to the outbox directory with secrets redacted and answered with a synthetic
 * response, so an operator can read exactly what the studio would have sent.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
}

export interface HttpResponse<T = unknown> {
  status: number;
  headers: Headers;
  data: T;
  dryRun: boolean;
}

export class HttpError extends Error {
  constructor(
    readonly service: string,
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`${service} ${status} ${url}: ${body.slice(0, 500)}`);
    this.name = "HttpError";
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
}

const SECRET_HEADER = /^(authorization|x-api-key|api-key|x-goog-api-key|cookie|x-access-token)$/i;

export class DryRunRecorder {
  private readonly records: DryRunRecord[] = [];

  /** @param dir where to write one JSON file per request, or null to keep them in memory */
  constructor(private readonly dir: string | null = null) {
    if (dir) mkdirSync(dir, { recursive: true });
  }

  record(service: string, req: HttpRequest): DryRunRecord {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers ?? {})) headers[k] = SECRET_HEADER.test(k) ? "<redacted>" : v;
    const rec: DryRunRecord = { seq: this.records.length + 1, service, method: req.method, url: req.url, headers };
    if (req.json !== undefined) rec.json = req.json;
    if (req.body !== undefined) rec.bodyBytes = typeof req.body === "string" ? req.body.length : req.body.byteLength;
    this.records.push(rec);
    if (this.dir) {
      const host = new URL(req.url).host.replace(/[^a-z0-9.-]/gi, "_");
      writeFileSync(join(this.dir, `${String(rec.seq).padStart(5, "0")}-${service}-${host}.json`), JSON.stringify(rec, null, 2));
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
}

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export class HttpClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: HttpClientOptions) {
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

    const isWrite = req.method !== "GET" && req.method !== "HEAD";
    if (this.opts.dryRun && isWrite) {
      this.opts.recorder?.record(this.opts.service, full);
      const data = (this.opts.dryRunResponse?.(full) ?? { dryRun: true }) as T;
      return { status: 200, headers: new Headers(), data, dryRun: true };
    }

    const maxRetries = this.opts.maxRetries ?? 3;
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 60_000);
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
        if (attempt < maxRetries) {
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
      // Only retry writes that carry an idempotency key; reads are always safe to retry.
      const safeToRetry = !isWrite || Boolean(req.idempotencyKey);
      if (RETRYABLE.has(res.status) && safeToRetry && attempt < maxRetries) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffMs(attempt));
        continue;
      }
      throw new HttpError(this.opts.service, res.status, req.url, text);
    }
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
