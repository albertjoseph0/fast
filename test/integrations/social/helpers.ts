/** Routing fake fetch and fixtures shared by the social and ads integration tests. */
import { SimClock } from "../../../src/core/clock.ts";
import { StudioStore } from "../../../src/core/store.ts";
import { defaultConfig } from "../../../src/config/schema.ts";
import type { ContentPiece, ExternalJob, JobRef, MediaRef, OwnedAccount, Platform } from "../../../src/core/types.ts";

export interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  bodyBytes?: number;
  json?: any;
}

export interface FakeRoute {
  method?: string;
  match: RegExp | string;
  status?: number;
  json?: ((call: RecordedCall) => unknown) | object | string | number | boolean | null;
  /** Raw response body, sent instead of `json` (for numbers JSON.stringify cannot express). */
  text?: string;
  headers?: Record<string, string>;
  once?: boolean;
}

export interface FakeFetch {
  fetch: typeof fetch;
  calls: RecordedCall[];
  routes: FakeRoute[];
}

async function readBody(body: unknown): Promise<{ text?: string; bytes?: number }> {
  if (body === undefined || body === null) return {};
  if (typeof body === "string") return { text: body, bytes: Buffer.byteLength(body) };
  if (body instanceof Uint8Array) return { text: Buffer.from(body).toString("utf8"), bytes: body.byteLength };
  if (typeof (body as ReadableStream).getReader === "function") {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    const chunks: Buffer[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
    const buf = Buffer.concat(chunks);
    return { text: buf.toString("utf8"), bytes: buf.byteLength };
  }
  return { text: String(body) };
}

export function fakeFetch(routes: FakeRoute[] = []): FakeFetch {
  const calls: RecordedCall[] = [];
  const state: FakeFetch = {
    calls,
    routes,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = decodeURIComponent(String(input));
      const method = (init?.method ?? "GET").toUpperCase();
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
      const { text, bytes } = await readBody(init?.body);
      const call: RecordedCall = { method, url, headers, ...(text !== undefined ? { body: text } : {}), ...(bytes !== undefined ? { bodyBytes: bytes } : {}) };
      if (text && headers["content-type"]?.includes("json")) call.json = JSON.parse(text);
      calls.push(call);
      const i = state.routes.findIndex((r) => (!r.method || r.method === method) && (typeof r.match === "string" ? url.includes(r.match) : r.match.test(url)));
      const route = state.routes[i];
      if (!route) return new Response(JSON.stringify({ error: { message: `no fake route for ${method} ${url}` } }), { status: 404, headers: { "content-type": "application/json" } });
      if (route.once) state.routes.splice(i, 1);
      const payload = typeof route.json === "function" ? (route.json as (c: RecordedCall) => unknown)(call) : route.json;
      const status = route.status ?? 200;
      const bodyText = route.text ?? (payload === undefined ? undefined : JSON.stringify(payload));
      return new Response(status === 204 || bodyText === undefined ? null : bodyText, {
        status,
        headers: { "content-type": "application/json", ...route.headers },
      });
    }) as typeof fetch,
  };
  return state;
}

/** A fetch that fails the test if it is ever called. */
export const forbiddenFetch = (async (input: string | URL | Request) => {
  throw new Error(`unexpected network call: ${String(input)}`);
}) as typeof fetch;

export const noSleep = async (): Promise<void> => {};

export function env0() {
  const clock = new SimClock("2026-10-19T12:00:00.000Z");
  const store = new StudioStore(null, clock, 1);
  const config = defaultConfig();
  return { clock, store, config };
}

export function account(platform: Platform, overrides: Partial<OwnedAccount> = {}): OwnedAccount {
  return {
    id: `acct_${platform}`,
    ventureId: "ven_000001",
    platform,
    handle: "astra.app",
    externalId: "17841400000000001",
    publishMode: "business_api",
    bioDisclosesBrand: true,
    standingConsent: { scopes: ["publish"], grantedAt: "2026-10-01T00:00:00.000Z", expiresAt: "2027-10-01T00:00:00.000Z", grantedBy: "owner" },
    tokenSecretRef: `${platform.toUpperCase()}_TOKEN_ASTRA`,
    status: "active",
    ...overrides,
  };
}

export function image(n: number): MediaRef {
  return { localPath: `/media/slide${n}.jpg`, publicUrl: `https://cdn.fast.test/slide${n}.jpg`, sha256: `sha${n}`, mediaType: "image/jpeg", aiGenerated: true, c2pa: true };
}

export function video(path = "/media/reel.mp4"): MediaRef {
  return { localPath: path, publicUrl: "https://cdn.fast.test/reel.mp4", sha256: "shavid", mediaType: "video/mp4", aiGenerated: true, c2pa: true };
}

export function piece(platform: Platform, media: MediaRef[], overrides: Partial<ContentPiece> = {}): ContentPiece {
  return {
    id: "content_000001",
    ventureId: "ven_000001",
    formatId: "slideshow_reveal",
    draft: {
      formatId: "slideshow_reveal",
      platform,
      voice: "brand_third_person",
      hook: "your birth chart says you text first",
      angle: "astrology roast",
      script: "",
      slides: [],
      caption: "Astra read my chart and I feel attacked",
      hashtags: ["astrology", "#zodiac"],
      callToAction: "link in bio",
    },
    media,
    channel: "owned_social",
    platform,
    similarityKey: "k",
    status: "approved",
    ...overrides,
  };
}

/** The ExternalJob the orchestrator would persist for a JobRef. */
export function jobFrom(ref: JobRef, overrides: Partial<ExternalJob> = {}): ExternalJob {
  return {
    id: "job_000001",
    op: ref.op,
    ventureId: "ven_000001",
    actionId: "act_000001",
    externalRef: ref.externalRef,
    status: "running",
    nextPollAt: "2026-10-19T12:00:00.000Z",
    deadlineAt: "2026-10-26T12:00:00.000Z",
    attempts: 0,
    createdAt: "2026-10-19T12:00:00.000Z",
    ...overrides,
  };
}
