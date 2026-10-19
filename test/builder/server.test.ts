import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { createHandler, moderate, RateLimiter, type MessagesClient } from "../../templates/expo-app/server/src/index.ts";
import { tempDir } from "./fixtures.ts";

const TENANT = {
  slug: "astra",
  appName: "Astra",
  systemPrompt: "SAFETY RULES\n\n<product_instructions>\nRead charts.\n</product_instructions>",
  model: "claude-opus-5-5",
  effort: "low",
  maxTokens: 1500,
  inputKind: "date_time_place",
  outputSections: ["Sun", "Moon"],
  freeUses: 1,
  entitlementId: "pro",
  revenueCatSecretEnv: "REVENUECAT_SECRET_KEY_ASTRA",
  rateLimit: { perMinute: 3, perDay: 10 },
  maxInputChars: 4000,
  supportEmail: "help@example.com",
  remoteConfig: { default: {}, v2: { paywall: { headline: "Variant two" } } },
};

function message(text: string, stop: Anthropic.Message["stop_reason"] = "end_turn"): Anthropic.Message {
  return { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text }], stop_reason: stop } as unknown as Anthropic.Message;
}

const GOOD = JSON.stringify({ sections: [{ title: "Moon", body: "Deep feelings." }, { title: "Sun", body: "Bold energy." }] });

interface Harness {
  url: string;
  calls: Anthropic.MessageCreateParamsNonStreaming[];
  rcCalls: { url: string; auth: string | null }[];
  logs: Record<string, unknown>[];
  reply: { value: Anthropic.Message };
  entitled: { value: boolean };
}

let server: Server | null = null;

async function start(opts: { secret?: string } = {}): Promise<Harness> {
  const dir = join(tempDir(), "tenants");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "astra.json"), JSON.stringify(TENANT));
  const h: Omit<Harness, "url"> = { calls: [], rcCalls: [], logs: [], reply: { value: message(GOOD) }, entitled: { value: false } };
  const anthropic: MessagesClient = {
    messages: {
      create: async (body) => {
        h.calls.push(body);
        return h.reply.value;
      },
    },
  };
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    h.rcCalls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
    const entitlements = h.entitled.value ? { pro: { expires_date: "2026-11-01T00:00:00Z" } } : {};
    return new Response(JSON.stringify({ subscriber: { entitlements } }), { status: 200 });
  }) as typeof fetch;
  const handler = createHandler({
    tenantsDir: dir,
    anthropic,
    fetch: fakeFetch,
    env: { REVENUECAT_SECRET_KEY_ASTRA: opts.secret ?? "sk_test" },
    now: () => Date.parse("2026-10-18T10:00:00Z"),
    log: (line) => h.logs.push(line),
  });
  server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { ...h, url: `http://127.0.0.1:${port}` };
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

async function post(h: Harness, path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${h.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const verdict = (appUserId = "user_1", extra: Record<string, unknown> = {}) => ({
  slug: "astra",
  appUserId,
  consent: true,
  input: { kind: "date_time_place", fields: { date: "2000-01-01", place: "Toronto" }, profile: { goal: "Love" } },
  ...extra,
});

describe("verdict server", () => {
  it("serves health and tenant remote config by variant", async () => {
    const h = await start();
    expect(await (await fetch(`${h.url}/healthz`)).json()).toEqual({ ok: true });
    expect(await (await fetch(`${h.url}/v1/config?slug=astra&variant=v2`)).json()).toEqual({ config: { paywall: { headline: "Variant two" } } });
    expect(await (await fetch(`${h.url}/v1/config?slug=astra&variant=unknown`)).json()).toEqual({ config: {} });
    expect((await fetch(`${h.url}/v1/config?slug=nope`)).status).toBe(404);
  });

  it("rejects requests without AI consent before calling anything", async () => {
    const h = await start();
    const res = await post(h, "/v1/verdict", verdict("user_1", { consent: false }));
    expect(res).toMatchObject({ status: 403, json: { error: "consent_required" } });
    expect(h.calls).toHaveLength(0);
    expect(h.rcCalls).toHaveLength(0);
  });

  it("calls Claude with the tenant prompt at low effort, a section schema and no thinking parameter", async () => {
    const h = await start();
    const res = await post(h, "/v1/verdict", verdict());
    expect(res.status).toBe(200);
    expect(res.json.sections).toEqual([
      { title: "Sun", body: "Bold energy." },
      { title: "Moon", body: "Deep feelings." },
    ]);
    expect(typeof res.json.id).toBe("string");
    const call = h.calls[0];
    expect(call).toMatchObject({ model: "claude-opus-5-5", max_tokens: 1500, system: TENANT.systemPrompt, output_config: { effort: "low", format: { type: "json_schema" } } });
    expect(call).not.toHaveProperty("thinking");
    expect(JSON.stringify(call?.output_config?.format?.schema)).toContain('"enum":["Sun","Moon"]');
    const content = call?.messages[0]?.content as Anthropic.TextBlockParam[];
    expect(content.at(-1)?.text).toContain("<fields>");
    expect(content.at(-1)?.text).toContain("Toronto");
  });

  it("allows the free uses, then requires an active RevenueCat entitlement", async () => {
    const h = await start();
    expect((await post(h, "/v1/verdict", verdict())).status).toBe(200);
    expect(h.rcCalls).toHaveLength(0);
    expect(await post(h, "/v1/verdict", verdict())).toMatchObject({ status: 402, json: { error: "payment_required" } });
    expect(h.rcCalls[0]).toEqual({ url: "https://api.revenuecat.com/v1/subscribers/user_1", auth: "Bearer sk_test" });

    h.entitled.value = true;
    expect((await post(h, "/v1/verdict", verdict("user_2"))).status).toBe(200);
    expect((await post(h, "/v1/verdict", verdict("user_2"))).status).toBe(200);
    expect(h.rcCalls.filter((c) => c.url.endsWith("user_2"))).toHaveLength(1);
  });

  it("rate-limits per user", async () => {
    const h = await start();
    h.entitled.value = true;
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await post(h, "/v1/verdict", verdict())).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect((await post(h, "/v1/verdict", verdict("user_other"))).status).toBe(200);
  });

  it("hides refusals and blocklisted output behind a neutral error", async () => {
    const h = await start();
    h.entitled.value = true;
    h.reply.value = message("", "refusal");
    expect(await post(h, "/v1/verdict", verdict())).toMatchObject({ status: 422, json: { error: "refused" } });
    h.reply.value = message("I can't help with that request.");
    expect(await post(h, "/v1/verdict", verdict())).toMatchObject({ status: 422, json: { error: "refused" } });
    h.reply.value = message(JSON.stringify({ sections: [{ title: "Sun", body: "Honestly, kys." }] }));
    expect(await post(h, "/v1/verdict", verdict("user_3"))).toMatchObject({ status: 422, json: { error: "moderated" } });
    expect(h.logs.some((l) => l.event === "moderated")).toBe(true);
  });

  it("does not spend a free use on a failed verdict", async () => {
    const h = await start();
    h.reply.value = message("", "refusal");
    expect((await post(h, "/v1/verdict", verdict())).status).toBe(422);
    h.reply.value = message(GOOD);
    expect((await post(h, "/v1/verdict", verdict())).status).toBe(200);
    expect(h.rcCalls).toHaveLength(0);
  });

  it("deletes a user's server state and logs reports", async () => {
    const h = await start();
    expect((await post(h, "/v1/verdict", verdict())).status).toBe(200);
    expect(await post(h, "/v1/delete", { slug: "astra", appUserId: "user_1" })).toEqual({ status: 200, json: { ok: true } });
    expect((await post(h, "/v1/verdict", verdict())).status).toBe(200);
    expect(await post(h, "/v1/report", { slug: "astra", appUserId: "user_1", resultId: "r1", reason: "Inaccurate" })).toEqual({ status: 200, json: { ok: true } });
    expect(h.logs).toContainEqual({ event: "report", slug: "astra", appUserId: "user_1", resultId: "r1", reason: "Inaccurate" });
  });

  it("validates requests", async () => {
    const h = await start();
    expect((await post(h, "/v1/verdict", { ...verdict(), slug: "../etc" })).status).toBe(404);
    expect((await post(h, "/v1/verdict", { ...verdict(), appUserId: "" })).status).toBe(400);
    const res = await fetch(`${h.url}/v1/verdict`, { method: "POST", body: "{not json" });
    expect(res.status).toBe(400);
    expect((await post(h, "/v1/verdict", verdict("user_9", { input: {} }))).status).toBe(400);
  });

  it("fails closed when the RevenueCat secret is missing", async () => {
    const h = await start({ secret: "" });
    await post(h, "/v1/verdict", verdict());
    expect(await post(h, "/v1/verdict", verdict())).toMatchObject({ status: 503, json: { error: "billing_unavailable" } });
  });
});

describe("server helpers", () => {
  it("moderates blocklisted output only", () => {
    expect(moderate([{ title: "Sun", body: "You shine." }])).toEqual([]);
    expect(moderate([{ title: "Sun", body: "you will die soon" }])).not.toEqual([]);
  });

  it("limits per minute and per day", () => {
    const limiter = new RateLimiter();
    const limits = { perMinute: 2, perDay: 3 };
    expect([0, 1, 2].map((t) => limiter.allow("k", limits, t))).toEqual([true, true, false]);
    expect(limiter.allow("k", limits, 61_000)).toBe(true);
    expect(limiter.allow("k", limits, 130_000)).toBe(false);
    expect(limiter.allow("k", limits, 86_400_001)).toBe(true);
  });
});
