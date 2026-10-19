/**
 * Multi-tenant verdict service: one deployment serves every studio app. Each app is a
 * tenant file (tenants/<slug>.json) holding its composed system prompt (fixed safety
 * preamble first, then the product prompt), output sections, free uses and entitlement.
 *
 *   POST /v1/verdict  { slug, appUserId, input, consent }  → { id, sections }
 *   POST /v1/report   { slug, appUserId, resultId, reason } → { ok }
 *   POST /v1/delete   { slug, appUserId }                   → { ok }
 *   GET  /v1/config?slug=&variant=                          → { config }
 *   GET  /healthz
 *
 * Env: ANTHROPIC_API_KEY, PORT (8080), TENANTS_DIR (./tenants), and one RevenueCat secret
 * key per tenant under the env var name its tenant file lists.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

export interface Tenant {
  slug: string;
  appName: string;
  systemPrompt: string;
  model: string;
  effort: "low";
  maxTokens: number;
  inputKind: "photo" | "screenshot" | "text" | "date_time_place" | "audio_file" | "choices" | "none";
  outputSections: string[];
  freeUses: number;
  entitlementId: string;
  revenueCatSecretEnv: string;
  rateLimit: { perMinute: number; perDay: number };
  maxInputChars: number;
  supportEmail: string;
  remoteConfig: Record<string, unknown>;
}

export interface VerdictInput {
  kind?: string;
  text?: string;
  imageBase64?: string;
  mediaType?: string;
  fields?: Record<string, unknown>;
  profile?: Record<string, unknown>;
}

export interface Section {
  title: string;
  body: string;
}

/** The slice of the Anthropic client the service uses (a fake in tests). */
export interface MessagesClient {
  messages: { create(body: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> };
}

export interface ServerDeps {
  tenantsDir: string;
  anthropic: MessagesClient;
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
  now?: () => number;
  log?: (line: Record<string, unknown>) => void;
}

const DEFAULT_MODEL = "claude-opus-5-5";
const SLUG = /^[a-z0-9-]{1,64}$/;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ENTITLEMENT_CACHE_MS = 60_000;

/** Output that is never shown, whatever the prompt said. */
const BLOCKLIST: readonly RegExp[] = [
  /\b(kill|hurt|harm) (yourself|urself)\b/i,
  /\bkys\b/i,
  /\b(how to|ways to) (kill|hurt|harm) (myself|yourself|someone)\b/i,
  /\b(suicide|overdose) (method|methods|instructions)\b/i,
  /\b(porn|pornographic|nudes?|sexually explicit)\b/i,
  /\b(subhuman|inferior race|ethnic cleansing)\b/i,
  /\b(you will die|you are going to die)\b/i,
];
const REFUSAL = /^\s*(i('m| am) (sorry|not able)|i can(no|')t (help|do|assist|provide|create))/i;

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Sliding-window limits per key: per minute and per day. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  allow(key: string, limits: { perMinute: number; perDay: number }, now: number): boolean {
    const day = 86_400_000;
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < day);
    const lastMinute = recent.filter((t) => now - t < 60_000).length;
    if (lastMinute >= limits.perMinute || recent.length >= limits.perDay) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  forget(key: string): void {
    this.hits.delete(key);
  }
}

/** Blocklist hits in the output, empty when it may be shown. */
export function moderate(sections: Section[]): string[] {
  const text = sections.map((s) => `${s.title}\n${s.body}`).join("\n");
  return BLOCKLIST.filter((re) => re.test(text)).map((re) => re.source);
}

export function loadTenant(dir: string, slug: string): Tenant | null {
  if (!SLUG.test(slug)) return null;
  const path = join(dir, `${slug}.json`);
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Tenant>;
  if (typeof raw.systemPrompt !== "string" || !raw.systemPrompt.trim()) throw new Error(`tenant ${slug} has no system prompt`);
  return {
    slug,
    appName: raw.appName ?? slug,
    systemPrompt: raw.systemPrompt,
    model: raw.model ?? DEFAULT_MODEL,
    effort: "low",
    maxTokens: raw.maxTokens ?? 1_500,
    inputKind: raw.inputKind ?? "text",
    outputSections: raw.outputSections ?? [],
    freeUses: raw.freeUses ?? 0,
    entitlementId: raw.entitlementId ?? "pro",
    revenueCatSecretEnv: raw.revenueCatSecretEnv ?? "REVENUECAT_SECRET_KEY",
    rateLimit: raw.rateLimit ?? { perMinute: 6, perDay: 60 },
    maxInputChars: raw.maxInputChars ?? 4_000,
    supportEmail: raw.supportEmail ?? "",
    remoteConfig: raw.remoteConfig ?? { default: {} },
  };
}

function outputSchema(sections: string[]): Record<string, unknown> {
  const title = sections.length ? { type: "string", enum: sections } : { type: "string" };
  return {
    type: "object",
    properties: {
      sections: {
        type: "array",
        items: { type: "object", properties: { title, body: { type: "string" } }, required: ["title", "body"], additionalProperties: false },
      },
    },
    required: ["sections"],
    additionalProperties: false,
  };
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/** User turn: the input as data in tags, plus the image when the tenant takes one. */
export function userContent(tenant: Tenant, input: VerdictInput): Anthropic.ContentBlockParam[] {
  const blocks: Anthropic.ContentBlockParam[] = [];
  if (input.imageBase64 && (tenant.inputKind === "photo" || tenant.inputKind === "screenshot")) {
    const mediaType = input.mediaType ?? "image/jpeg";
    if (!IMAGE_TYPES.has(mediaType)) throw new HttpError(400, "bad_image", "Unsupported image type.");
    if (Buffer.byteLength(input.imageBase64, "base64") > MAX_IMAGE_BYTES) throw new HttpError(413, "image_too_large", "That image is too large.");
    blocks.push({ type: "image", source: { type: "base64", media_type: mediaType as "image/jpeg", data: input.imageBase64 } });
  }
  const parts: string[] = [];
  if (input.profile && Object.keys(input.profile).length) parts.push(`<profile>\n${clip(JSON.stringify(input.profile), tenant.maxInputChars)}\n</profile>`);
  if (input.fields && Object.keys(input.fields).length) parts.push(`<fields>\n${clip(JSON.stringify(input.fields), tenant.maxInputChars)}\n</fields>`);
  if (input.text?.trim()) parts.push(`<user_input>\n${clip(input.text.trim(), tenant.maxInputChars)}\n</user_input>`);
  if (!parts.length && !blocks.length) throw new HttpError(400, "empty_input", "Please add something first.");
  const sections = tenant.outputSections.length ? ` Return the sections ${tenant.outputSections.map((s) => `"${s}"`).join(", ")}, in that order.` : "";
  parts.push(`Create the result for the user from the data above.${sections} Respond as JSON.`);
  blocks.push({ type: "text", text: parts.join("\n\n") });
  return blocks;
}

/** Parsed, ordered sections, or null when the model output is unusable. */
export function parseSections(message: Anthropic.Message, allowed: string[]): Section[] | null {
  const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  if (REFUSAL.test(text)) return null;
  try {
    const parsed = JSON.parse(text) as { sections?: unknown };
    if (!Array.isArray(parsed.sections)) return null;
    const sections = parsed.sections.flatMap((s): Section[] => {
      const o = s as Partial<Section>;
      return typeof o.title === "string" && typeof o.body === "string" && o.body.trim() ? [{ title: o.title, body: o.body.trim() }] : [];
    });
    const filtered = allowed.length ? sections.filter((s) => allowed.includes(s.title)) : sections;
    filtered.sort((a, b) => allowed.indexOf(a.title) - allowed.indexOf(b.title));
    return filtered.length ? filtered : null;
  } catch {
    return null;
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "too_large", "Request too large.");
    chunks.push(chunk as Buffer);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object");
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "bad_json", "Malformed request.");
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function str(value: unknown, field: string, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new HttpError(400, "bad_request", `Missing or invalid ${field}.`);
  return value;
}

/** The request handler; state (usage counts, rate limits, entitlement cache) lives in memory per instance. */
export function createHandler(deps: ServerDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line) => console.log(JSON.stringify(line)));
  const tenants = new Map<string, Tenant>();
  const usage = new Map<string, number>();
  const entitlements = new Map<string, { active: boolean; at: number }>();
  const limiter = new RateLimiter();

  function tenantFor(slug: string): Tenant {
    const cached = tenants.get(slug);
    if (cached) return cached;
    const tenant = loadTenant(deps.tenantsDir, slug);
    if (!tenant) throw new HttpError(404, "unknown_app", "Unknown app.");
    tenants.set(slug, tenant);
    return tenant;
  }

  async function entitled(tenant: Tenant, appUserId: string): Promise<boolean> {
    const key = `${tenant.slug}|${appUserId}`;
    const hit = entitlements.get(key);
    if (hit && now() - hit.at < ENTITLEMENT_CACHE_MS) return hit.active;
    const secret = deps.env[tenant.revenueCatSecretEnv];
    if (!secret) throw new HttpError(503, "billing_unavailable", "Subscriptions are temporarily unavailable.");
    const res = await deps.fetch(`https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(appUserId)}`, {
      headers: { authorization: `Bearer ${secret}`, accept: "application/json" },
    });
    if (!res.ok) throw new HttpError(503, "billing_unavailable", "Subscriptions are temporarily unavailable.");
    const data = (await res.json()) as { subscriber?: { entitlements?: Record<string, { expires_date?: string | null; grace_period_expires_date?: string | null }> } };
    const e = data.subscriber?.entitlements?.[tenant.entitlementId];
    const until = [e?.expires_date, e?.grace_period_expires_date].filter((d): d is string => typeof d === "string").map((d) => Date.parse(d));
    const active = Boolean(e) && (e?.expires_date === null || until.some((t) => t > now()));
    entitlements.set(key, { active, at: now() });
    return active;
  }

  async function verdict(body: Record<string, unknown>): Promise<{ id: string; sections: Section[] }> {
    const tenant = tenantFor(str(body.slug, "slug", 64));
    const appUserId = str(body.appUserId, "appUserId");
    if (body.consent !== true) throw new HttpError(403, "consent_required", "Please allow AI processing in Settings to get a result.");
    const input = (typeof body.input === "object" && body.input !== null ? body.input : {}) as VerdictInput;
    const key = `${tenant.slug}|${appUserId}`;
    if (!limiter.allow(key, tenant.rateLimit, now())) throw new HttpError(429, "rate_limited", "You're going a bit fast. Try again in a minute.");
    const used = usage.get(key) ?? 0;
    const free = used < tenant.freeUses;
    if (!free && !(await entitled(tenant, appUserId))) throw new HttpError(402, "payment_required", "Subscribe to get more results.");

    const message = await deps.anthropic.messages.create({
      model: tenant.model,
      max_tokens: tenant.maxTokens,
      system: tenant.systemPrompt,
      messages: [{ role: "user", content: userContent(tenant, input) }],
      output_config: { effort: "low", format: { type: "json_schema", schema: outputSchema(tenant.outputSections) } },
    });
    if (message.stop_reason === "refusal") throw new HttpError(422, "refused", "We couldn't create a result for that. Try something different.");
    const sections = parseSections(message, tenant.outputSections);
    if (!sections) throw new HttpError(422, "refused", "We couldn't create a result for that. Try something different.");
    const hits = moderate(sections);
    if (hits.length) {
      log({ event: "moderated", slug: tenant.slug, rules: hits });
      throw new HttpError(422, "moderated", "We couldn't create a result for that. Try something different.");
    }
    if (free) usage.set(key, used + 1);
    return { id: randomUUID(), sections };
  }

  return async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true });
      if (req.method === "GET" && url.pathname === "/v1/config") {
        const tenant = tenantFor(str(url.searchParams.get("slug"), "slug", 64));
        const variant = url.searchParams.get("variant");
        const config = (variant && tenant.remoteConfig[variant]) || tenant.remoteConfig.default || {};
        return send(res, 200, { config });
      }
      if (req.method !== "POST") return send(res, 404, { error: "not_found", message: "Not found." });
      const body = await readJson(req);
      if (url.pathname === "/v1/verdict") return send(res, 200, await verdict(body));
      if (url.pathname === "/v1/report") {
        const tenant = tenantFor(str(body.slug, "slug", 64));
        log({ event: "report", slug: tenant.slug, appUserId: str(body.appUserId, "appUserId"), resultId: str(body.resultId, "resultId"), reason: str(body.reason, "reason", 500) });
        return send(res, 200, { ok: true });
      }
      if (url.pathname === "/v1/delete") {
        const tenant = tenantFor(str(body.slug, "slug", 64));
        const key = `${tenant.slug}|${str(body.appUserId, "appUserId")}`;
        usage.delete(key);
        entitlements.delete(key);
        limiter.forget(key);
        log({ event: "delete", slug: tenant.slug });
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: "not_found", message: "Not found." });
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.code, message: err.message });
      log({ event: "error", message: (err as Error).message });
      return send(res, 500, { error: "internal", message: "Something went wrong. Please try again." });
    }
  };
}

function main(): void {
  const handler = createHandler({
    tenantsDir: resolve(process.env.TENANTS_DIR ?? "tenants"),
    anthropic: new Anthropic(),
    fetch,
    env: process.env,
  });
  const port = Number(process.env.PORT ?? 8080);
  createServer((req, res) => void handler(req, res)).listen(port, () => console.log(JSON.stringify({ event: "listening", port })));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
