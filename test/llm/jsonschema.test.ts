import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SCHEMAS, type SchemaName } from "../../src/agents/schemas.ts";
import { CoreNeed } from "../../src/core/types.ts";
import { assertClaudeCompatible, toClaudeSchema } from "../../src/llm/jsonschema.ts";
import { CLAUDE_PRICES, costCents, normalizeModelId, priceFor } from "../../src/llm/pricing.ts";

type Json = Record<string, unknown>;

function find(node: unknown, pred: (n: Json) => boolean): Json[] {
  const out: Json[] = [];
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== "object") return;
    if (pred(n as Json)) out.push(n as Json);
    Object.values(n).forEach(walk);
  };
  walk(node);
  return out;
}

describe("toClaudeSchema", () => {
  const names = Object.keys(SCHEMAS) as SchemaName[];

  it.each(names)("%s converts to a Claude-compatible schema", (name) => {
    const schema = toClaudeSchema(SCHEMAS[name]);
    expect(assertClaudeCompatible(schema)).toEqual([]);
    expect(schema.$schema).toBeUndefined();
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
  });

  it("keeps enums as enums (the SDK helper would move them into descriptions)", () => {
    const coreNeeds = CoreNeed.options;
    const ideaBatch = toClaudeSchema(SCHEMAS.IdeaBatch);
    const enums = find(ideaBatch, (n) => Array.isArray(n.enum) && (n.enum as string[]).includes("love"));
    expect(enums.length).toBeGreaterThan(0);
    expect(enums[0]?.enum).toEqual(coreNeeds);
    const digest = toClaudeSchema(SCHEMAS.SignalDigest);
    expect(JSON.stringify(digest)).toContain(JSON.stringify(coreNeeds));
  });

  it("keeps discriminated-union literals as const branches under anyOf", () => {
    const variant = toClaudeSchema(SCHEMAS.VariantProposal);
    const kinds = find(variant, (n) => typeof n.const === "string").map((n) => n.const);
    expect(kinds).toEqual(expect.arrayContaining(["hooks", "onboarding", "paywall", "share", "core", "positioning"]));
    expect(JSON.stringify(variant)).not.toContain("oneOf");
  });

  it("drops zod's safe-integer bounds but moves real constraints into the description", () => {
    const schema = toClaudeSchema(
      z.object({
        n: z.number().int(),
        name: z.string().max(30).describe("Short name"),
        score: z.number().min(0).max(10),
        tags: z.array(z.string()).min(3),
        one: z.array(z.string()).min(1),
        email: z.email(),
        site: z.url(),
        when: z.iso.datetime(),
        pick: z.string().regex(/^[a-z]+$/),
      }),
    );
    expect(assertClaudeCompatible(schema)).toEqual([]);
    const props = schema.properties as Record<string, Json>;
    expect(props.n).toEqual({ type: "integer" });
    expect(props.name?.description).toBe("Short name (constraints: maxLength 30)");
    expect(props.score?.description).toBe("(constraints: minimum 0, maximum 10)");
    expect(props.tags?.minItems).toBeUndefined();
    expect(props.tags?.description).toBe("(constraints: minItems 3)");
    expect(props.one?.minItems).toBe(1);
    expect(props.email?.format).toBe("email");
    expect(props.when?.format).toBe("date-time");
    expect(props.pick?.pattern).toBeUndefined();
    expect(String(props.pick?.description)).toContain("pattern");
  });

  it("expresses nullable fields as anyOf with null", () => {
    const schema = toClaudeSchema(z.object({ a: z.string().nullable(), b: z.object({ x: z.number() }).nullable() }));
    expect(assertClaudeCompatible(schema)).toEqual([]);
    const props = schema.properties as Record<string, Json>;
    const branches = (props.a?.anyOf ?? []) as Json[];
    expect(branches).toContainEqual({ type: "null" });
    expect(branches).toContainEqual({ type: "string" });
    const objBranch = ((props.b?.anyOf ?? []) as Json[]).find((b) => b.type === "object");
    expect(objBranch?.additionalProperties).toBe(false);
  });
});

describe("assertClaudeCompatible", () => {
  it("reports every violation with a path", () => {
    const issues = assertClaudeCompatible({
      type: "object",
      properties: {
        a: { type: "string", maxLength: 3 },
        b: { type: ["string", "null"] },
        c: { type: "object", properties: {} },
        d: { type: "array", items: { type: "string" }, minItems: 2 },
        e: { type: "string", format: "phone" },
      },
      required: ["a", "zz"],
      additionalProperties: false,
    });
    expect(issues).toEqual(
      expect.arrayContaining([
        "$.properties.a: unsupported keyword maxLength",
        "$.properties.b: type arrays must be expressed as anyOf",
        "$.properties.c: object without additionalProperties: false",
        "$.properties.d: minItems > 1",
        "$.properties.e: unsupported format phone",
        "$: required zz is not a property",
      ]),
    );
  });
});

describe("pricing", () => {
  it("prices the current Claude models per million tokens", () => {
    expect(costCents("claude-opus-5-5", { inputTokens: 1_000_000, outputTokens: 0 })).toBe(400);
    expect(costCents("claude-opus-5-5", { inputTokens: 0, outputTokens: 1_000_000 })).toBe(2000);
    expect(costCents("claude-sonnet-5-5", { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(1200);
    expect(costCents("claude-haiku-5-5", { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(60);
    expect(costCents("claude-fable-5-1", { inputTokens: 1_000_000, outputTokens: 0 })).toBe(1000);
  });

  it("bills cache reads at 0.1x and cache writes at 1.25x input", () => {
    expect(costCents("claude-opus-5-5", { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 })).toBe(40);
    expect(costCents("claude-opus-5-5", { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000 })).toBe(500);
  });

  it("rounds up, never books negative zero, and maps gateway and snapshot ids", () => {
    expect(costCents("claude-opus-5-5", { inputTokens: 1, outputTokens: 1 })).toBe(1);
    expect(Object.is(costCents("claude-opus-5-5", { inputTokens: 0, outputTokens: 0 }), 0)).toBe(true);
    expect(normalizeModelId("anthropic/claude-opus-5.5")).toBe("claude-opus-5-5");
    expect(normalizeModelId("claude-sonnet-5-5-20260928")).toBe("claude-sonnet-5-5");
    expect(priceFor("anthropic/claude-haiku-5.5")).toEqual(CLAUDE_PRICES["claude-haiku-5-5"]);
  });

  it("prices unknown models at the most expensive tier", () => {
    expect(costCents("mystery-model", { inputTokens: 1_000_000, outputTokens: 0 })).toBe(1000);
  });
});
