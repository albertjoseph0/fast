/**
 * Canonical hashing for actions. Approvals bind to payloadHash, so the same logical
 * payload must always hash the same regardless of key order or whitespace.
 */
import { createHash } from "node:crypto";
import type { ActionKind } from "../core/types.ts";

/** JSON with object keys sorted recursively and no whitespace. Undefined object fields are dropped, as JSON.stringify does. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const json = JSON.stringify(value);
    return json === undefined ? "null" : json;
  }
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  if (typeof (value as { toJSON?: unknown }).toJSON === "function") return canonicalJson((value as { toJSON(): unknown }).toJSON());
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && typeof v !== "function")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** sha256 of the canonical JSON of { kind, ventureId, payload }. */
export function payloadHash(kind: ActionKind, ventureId: string | undefined, payload: unknown): string {
  return sha256Hex(canonicalJson({ kind, ventureId, payload }));
}
