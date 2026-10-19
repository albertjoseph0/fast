/** Verdict backend client (server/src/index.ts). */
import { studio } from "./spec";
import type { Profile } from "./storage";
import type { InputKind, VerdictSection } from "./types";

export interface VerdictInput {
  kind: InputKind;
  text?: string;
  imageBase64?: string;
  mediaType?: "image/jpeg" | "image/png" | "image/webp";
  fields?: Record<string, string>;
  profile?: Profile;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${studio.backendUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string } & T;
  if (!res.ok) throw new ApiError(res.status, data.error ?? "error", data.message ?? "Something went wrong. Please try again.");
  return data;
}

export function requestVerdict(appUserId: string, input: VerdictInput, consent: boolean): Promise<{ id: string; sections: VerdictSection[] }> {
  return post("/v1/verdict", { slug: studio.slug, appUserId, input, consent });
}

export function reportResult(appUserId: string, resultId: string, reason: string): Promise<{ ok: true }> {
  return post("/v1/report", { slug: studio.slug, appUserId, resultId, reason });
}

export function deleteServerData(appUserId: string): Promise<{ ok: true }> {
  return post("/v1/delete", { slug: studio.slug, appUserId });
}
