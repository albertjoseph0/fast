/**
 * The running spec: the bundled spec.json, overridden by the verdict backend's tenant
 * config (GET /v1/config) and by PostHog flag payloads for the sticky experiment
 * variants. Only the remote-configurable surfaces (paywall, onboarding, share, core) can
 * change at runtime; prices never come from config, only from the store.
 */
import { useSyncExternalStore } from "react";
import specJson from "../spec.json";
import studioJson from "../studio.json";
import type { AppSpec, StudioJson } from "./types";

export const studio = studioJson as unknown as StudioJson;
export const bundledSpec = specJson as unknown as AppSpec;

export const REMOTE_KEYS = ["paywall", "onboarding", "share", "core"] as const;
export type RemoteKey = (typeof REMOTE_KEYS)[number];
export type SpecOverrides = Partial<Pick<AppSpec, RemoteKey>>;

let current: AppSpec = bundledSpec;
const listeners = new Set<() => void>();

export function getSpec(): AppSpec {
  return current;
}

function setSpec(next: AppSpec): void {
  current = next;
  for (const l of listeners) l();
}

export function useSpec(): AppSpec {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getSpec,
    getSpec,
  );
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Shallow-merge each remote surface onto the spec; unknown keys and wrong shapes are ignored. */
export function applyOverrides(base: AppSpec, overrides: unknown): AppSpec {
  if (!isObject(overrides)) return base;
  const next: AppSpec = { ...base };
  for (const key of REMOTE_KEYS) {
    const value = overrides[key];
    if (key === "onboarding") {
      if (Array.isArray(value) && value.length > 0) next.onboarding = value as AppSpec["onboarding"];
    } else if (isObject(value)) {
      (next as Record<RemoteKey, unknown>)[key] = { ...(base[key] as object), ...value };
    }
  }
  return next;
}

/** Fetch the tenant config for this variant; the bundled spec stands if the network fails. */
export async function loadRemoteSpec(variant: string | null, flagPayloads: SpecOverrides[] = []): Promise<AppSpec> {
  let spec = bundledSpec;
  if (studio.backendUrl) {
    try {
      const qs = `slug=${encodeURIComponent(studio.slug)}${variant ? `&variant=${encodeURIComponent(variant)}` : ""}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4_000);
      const res = await fetch(`${studio.backendUrl}/v1/config?${qs}`, { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) spec = applyOverrides(spec, ((await res.json()) as { config?: unknown }).config);
    } catch {
      // offline or slow: keep the bundled spec
    }
  }
  for (const payload of flagPayloads) spec = applyOverrides(spec, payload);
  setSpec(spec);
  return spec;
}
