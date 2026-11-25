/**
 * Verdict backend client (server/src/index.ts). Verdicts and deletion carry the install
 * token the server minted for this install; the server keys free uses and limits on it.
 */
import { studio } from "./spec";
import { getJson, KEYS, setJson, type Profile } from "./storage";
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

async function installToken(): Promise<string> {
  const stored = await getJson<string | null>(KEYS.installToken, null);
  if (stored) return stored;
  const { installToken: token } = await post<{ installToken: string }>("/v1/install", { slug: studio.slug });
  await setJson(KEYS.installToken, token);
  return token;
}

/** A token the server no longer accepts (it restarted with a new signing key) is replaced once. */
async function postAsInstall<T>(path: string, body: Record<string, unknown>): Promise<T> {
  try {
    return await post<T>(path, { ...body, installToken: await installToken() });
  } catch (err) {
    if (!(err instanceof ApiError && err.code === "install_token")) throw err;
    await setJson(KEYS.installToken, null);
    return post<T>(path, { ...body, installToken: await installToken() });
  }
}

export function requestVerdict(appUserId: string, input: VerdictInput, consent: boolean): Promise<{ id: string; sections: VerdictSection[] }> {
  return postAsInstall("/v1/verdict", { slug: studio.slug, appUserId, input, consent });
}

/** Publish this install's result so the share link shows it to the friend who opens it. */
export function createShare(resultId: string): Promise<{ shareId: string }> {
  return postAsInstall("/v1/share", { slug: studio.slug, resultId });
}

/** A friend's shared result, when they arrived by a share link. Null when it is gone. */
export async function fetchShared(shareId: string): Promise<{ appName: string; title: string; body: string } | null> {
  const res = await fetch(`${studio.backendUrl}/v1/shared?slug=${encodeURIComponent(studio.slug)}&id=${encodeURIComponent(shareId)}`).catch(() => null);
  if (!res?.ok) return null;
  return (await res.json().catch(() => null)) as { appName: string; title: string; body: string } | null;
}

export function reportResult(appUserId: string, resultId: string, reason: string): Promise<{ ok: true }> {
  return post("/v1/report", { slug: studio.slug, appUserId, resultId, reason });
}

export function deleteServerData(appUserId: string): Promise<{ ok: true }> {
  return postAsInstall("/v1/delete", { slug: studio.slug, appUserId });
}
