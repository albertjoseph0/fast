/** A routing fake for `fetch` that records every request (shared by the data-integration tests). */

export interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  json?: any;
}

export interface Route {
  method?: string;
  match: RegExp | string;
  status?: number;
  json?: ((call: Call) => unknown) | object | string | number | boolean | null;
  contentType?: string;
  once?: boolean;
}

export interface Fake {
  fetch: typeof fetch;
  calls: Call[];
  routes: Route[];
  writes(): Call[];
}

async function bodyText(body: unknown): Promise<string | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
  if (typeof (body as ReadableStream).getReader === "function") {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    const chunks: Buffer[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  return String(body);
}

export function fake(routes: Route[] = []): Fake {
  const calls: Call[] = [];
  const state: Fake = {
    calls,
    routes,
    writes: () => calls.filter((c) => c.method !== "GET" && c.method !== "HEAD"),
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
      const text = await bodyText(init?.body);
      const call: Call = { method, url, headers, ...(text !== undefined ? { body: text } : {}) };
      if (text && headers["content-type"]?.includes("json")) call.json = JSON.parse(text);
      calls.push(call);
      const i = state.routes.findIndex((r) => (!r.method || r.method === method) && (typeof r.match === "string" ? decodeURIComponent(url).includes(r.match) : r.match.test(decodeURIComponent(url))));
      const route = state.routes[i];
      if (!route) return new Response(JSON.stringify({ error: `no route for ${method} ${url}` }), { status: 404, headers: { "content-type": "application/json" } });
      if (route.once) state.routes.splice(i, 1);
      const payload = typeof route.json === "function" ? (route.json as (c: Call) => unknown)(call) : route.json;
      const status = route.status ?? 200;
      return new Response(payload === undefined ? "" : JSON.stringify(payload), { status, headers: { "content-type": route.contentType ?? "application/json" } });
    }) as typeof fetch,
  };
  return state;
}

/** A fetch that fails the test if called. */
export const noFetch = (async (input: string | URL | Request) => {
  throw new Error(`unexpected network call: ${String(input)}`);
}) as typeof fetch;

export const noSleep = async (): Promise<void> => {};
