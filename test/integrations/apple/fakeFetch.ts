/** A routing fake for `fetch` that records every request (shared by the store integration tests). */

export interface RecordedCall {
  method: string;
  /** Decoded URL, so filter[...] brackets read naturally. */
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
  text?: string;
  contentType?: string;
  /** Remove the route after it answered once. */
  once?: boolean;
}

export interface FakeFetch {
  fetch: typeof fetch;
  calls: RecordedCall[];
  routes: FakeRoute[];
  /** Calls whose method is not GET/HEAD. */
  writes(): RecordedCall[];
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
    writes: () => calls.filter((c) => c.method !== "GET" && c.method !== "HEAD"),
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
      if (!route) return new Response(JSON.stringify({ errors: [{ status: "404", detail: `no fake route for ${method} ${url}` }] }), { status: 404, headers: { "content-type": "application/json" } });
      if (route.once) state.routes.splice(i, 1);
      const payload = typeof route.json === "function" ? (route.json as (c: RecordedCall) => unknown)(call) : route.json;
      const bodyText = route.text ?? (payload === undefined ? "" : JSON.stringify(payload));
      const status = route.status ?? 200;
      return new Response(status === 204 ? null : bodyText, { status, headers: { "content-type": route.contentType ?? "application/json" } });
    }) as typeof fetch,
  };
  return state;
}

/** A fetch that fails the test if it is ever called. */
export const forbiddenFetch = (async (input: string | URL | Request) => {
  throw new Error(`unexpected network call: ${String(input)}`);
}) as typeof fetch;
