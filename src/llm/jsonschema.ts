/**
 * Zod → JSON Schema for Claude structured outputs.
 *
 * The SDK helper zodOutputFormat() moves enum/const into descriptions, which loses the
 * decoder's strongest guarantee, so the studio converts schemas itself. Claude's grammar
 * supports types, properties, required, items, enum, const, anyOf, allOf, $ref/$defs and
 * a fixed set of string formats, and requires additionalProperties: false on every
 * object. Every other keyword is moved into the description as text the model can read;
 * the zod schema still validates it after decoding.
 */
import { z } from "zod";

const KEEP = new Set(["type", "properties", "required", "items", "enum", "const", "anyOf", "allOf", "$ref", "$defs", "description", "format", "additionalProperties", "minItems"]);

const FORMATS = new Set(["date-time", "time", "date", "duration", "email", "hostname", "uri", "ipv4", "ipv6", "uuid"]);

/** Keywords Claude rejects; they become "(constraints: ...)" text. */
const CONSTRAINTS = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
  "default",
  "format",
] as const;

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** zod's int() emits the safe-integer range; that is a representation detail, not a rule. */
function isSafeIntBound(key: string, value: unknown): boolean {
  return (key === "minimum" || key === "maximum") && (value === Number.MAX_SAFE_INTEGER || value === Number.MIN_SAFE_INTEGER);
}

function constraintText(node: Json): string[] {
  const out: string[] = [];
  for (const key of CONSTRAINTS) {
    if (!(key in node)) continue;
    const value = node[key];
    if (isSafeIntBound(key, value)) continue;
    if (key === "minItems" && typeof value === "number" && value <= 1) continue;
    if (key === "format" && typeof value === "string" && FORMATS.has(value)) continue;
    out.push(`${key} ${JSON.stringify(value)}`);
  }
  return out;
}

function withDescription(description: unknown, extra: string[]): string | undefined {
  const base = typeof description === "string" ? description : undefined;
  if (extra.length === 0) return base;
  const note = `(constraints: ${extra.join(", ")})`;
  return base ? `${base} ${note}` : note;
}

function convert(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(convert);
  if (!isObject(node)) return node;

  const extra = constraintText(node);
  const out: Json = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "oneOf") {
      out.anyOf = convert(value);
      continue;
    }
    if (!KEEP.has(key)) continue;
    if (key === "properties" || key === "$defs") {
      out[key] = isObject(value) ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, convert(v)])) : value;
    } else if (key === "items" || key === "anyOf" || key === "allOf") {
      out[key] = convert(value);
    } else if (key === "minItems") {
      if (typeof value === "number" && value <= 1) out.minItems = value;
    } else if (key === "format") {
      if (typeof value === "string" && FORMATS.has(value)) out.format = value;
    } else if (key !== "additionalProperties" && key !== "description") {
      out[key] = value;
    }
  }
  const description = withDescription(node.description, extra);
  if (description !== undefined) out.description = description;
  if (out.type === "object" || "properties" in out) {
    out.additionalProperties = false;
    if (!("properties" in out)) out.properties = {};
  }
  return splitTypeArray(out);
}

/**
 * `type: ["string", "null"]` becomes anyOf branches. Type-specific keywords go to the
 * non-null branches and the description stays on the wrapper.
 */
function splitTypeArray(node: Json): Json {
  if (!Array.isArray(node.type)) return node;
  const types = node.type as string[];
  if (types.length === 1) return { ...node, type: types[0] };
  const { type: _type, description, ...rest } = node;
  const anyOf = types.map((t) => {
    if (t === "null") return { type: "null" };
    const branch: Json = { type: t };
    for (const [k, v] of Object.entries(rest)) {
      if (k === "enum" && Array.isArray(v)) branch.enum = v.filter((x) => x !== null);
      else branch[k] = v;
    }
    if (t === "object") branch.additionalProperties = false;
    return branch;
  });
  return description === undefined ? { anyOf } : { anyOf, description };
}

/** The JSON Schema to send as output_config.format.schema for a zod schema. */
export function toClaudeSchema(schema: z.ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(schema, { target: "draft-2020-12" }) as Json;
  const { $schema: _drop, ...rest } = raw;
  return convert(rest) as Record<string, unknown>;
}

const ALLOWED_KEYS = new Set([...KEEP, "nullable"]);

/** Every way a schema breaks Claude's structured-output grammar, as "path: problem". Empty means compatible. */
export function assertClaudeCompatible(json: unknown): string[] {
  const violations: string[] = [];
  const visit = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((n, i) => visit(n, `${path}[${i}]`));
      return;
    }
    if (!isObject(node)) {
      violations.push(`${path}: schema node is not an object`);
      return;
    }
    for (const key of Object.keys(node)) {
      if (!ALLOWED_KEYS.has(key)) violations.push(`${path}: unsupported keyword ${key}`);
    }
    if (Array.isArray(node.type)) violations.push(`${path}: type arrays must be expressed as anyOf`);
    const isObj = node.type === "object" || "properties" in node;
    if (isObj && node.additionalProperties !== false) violations.push(`${path}: object without additionalProperties: false`);
    if (!isObj && "additionalProperties" in node) violations.push(`${path}: additionalProperties on a non-object`);
    if (typeof node.format === "string" && !FORMATS.has(node.format)) violations.push(`${path}: unsupported format ${node.format}`);
    if (typeof node.minItems === "number" && node.minItems > 1) violations.push(`${path}: minItems > 1`);
    if ("enum" in node && (!Array.isArray(node.enum) || node.enum.length === 0)) violations.push(`${path}: enum must be a non-empty array`);
    if (isObject(node.properties)) {
      const required = Array.isArray(node.required) ? (node.required as string[]) : [];
      for (const r of required) if (!(r in node.properties)) violations.push(`${path}: required ${r} is not a property`);
      for (const [k, v] of Object.entries(node.properties)) visit(v, `${path}.properties.${k}`);
    }
    if (isObject(node.$defs)) for (const [k, v] of Object.entries(node.$defs)) visit(v, `${path}.$defs.${k}`);
    if (node.items !== undefined) visit(node.items, `${path}.items`);
    for (const key of ["anyOf", "allOf"] as const) {
      const branches = node[key];
      if (branches === undefined) continue;
      if (!Array.isArray(branches) || branches.length === 0) violations.push(`${path}: ${key} must be a non-empty array`);
      else visit(branches, `${path}.${key}`);
    }
  };
  visit(json, "$");
  return violations;
}
