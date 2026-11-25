/**
 * Web-lane app hosting on Vercel, through its REST API:
 *   POST /v13/deployments?teamId=<team>   { name, target: "production", projectSettings: { framework: null },
 *                                           files: [{ file, data (base64), encoding: "base64" }] }
 *   GET  /v13/deployments/<id>?teamId=…   until readyState is READY (or ERROR/CANCELED)
 *   POST /v2/deployments/<id>/aliases     { alias: <host> }
 * The test territories are written into the deployment as geo.json, which the app's edge
 * function (api/geo.js) checks against the visitor's country: a web app is geofenced like a
 * store listing (P4), and scaling it is a redeploy with more territories.
 * The host must sit under a domain the Vercel team owns with a wildcard record
 * (config.web.appsDomain). Writes are dry-run by default and answered with "dry_" ids.
 */
import { readFileSync } from "node:fs";
import type { WebAppFile, WebAppWrite } from "../../core/ports.ts";
import { HttpClient } from "../http.ts";
import type { DryRunRecorder, HttpRequest } from "../http.ts";

export const ENV_VARS: readonly { name: string; purpose: string; required: boolean }[] = [
  { name: "VERCEL_TOKEN", purpose: "Vercel access token scoped to the team that owns the apps domain", required: true },
  { name: "VERCEL_TEAM_ID", purpose: "Vercel team id (team_…) that owns config.web.appsDomain", required: false },
  { name: "VERCEL_API_URL", purpose: "Vercel API base override (default https://api.vercel.com)", required: false },
];

export const VERCEL_API_URL = "https://api.vercel.com";
const MAX_INLINE_BYTES = 10 * 1024 * 1024;

export interface VercelAppOptions {
  env: Record<string, string | undefined>;
  dryRun: boolean;
  recorder?: DryRunRecorder;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Readiness polls before giving up (default 60, every 5 s). */
  maxPolls?: number;
}

export function vercelDryRunResponse(req: HttpRequest): unknown {
  const path = new URL(req.url).pathname;
  if (path.endsWith("/deployments")) return { id: "dry_dpl", url: "dry_dpl.vercel.app", readyState: "READY" };
  return { dryRun: true };
}

/** A Vercel project name for a host: lowercase, [a-z0-9-], at most 100 characters. */
export function projectName(host: string): string {
  return host.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100);
}

/** The deployment file list: the app's files plus geo.json carrying the allowed territories. */
export function deploymentFiles(files: WebAppFile[], territories: string[], read: (p: string) => Buffer = (p) => readFileSync(p)): { file: string; data: string; encoding: "base64" }[] {
  let total = 0;
  const out = files
    .filter((f) => f.path.replace(/^\/+/, "") !== "geo.json")
    .map((f) => {
      const bytes = read(f.localPath);
      total += bytes.byteLength;
      return { file: f.path.replace(/^\/+/, ""), data: bytes.toString("base64"), encoding: "base64" as const };
    });
  const geo = Buffer.from(JSON.stringify({ territories: [...territories].sort() }));
  out.push({ file: "geo.json", data: geo.toString("base64"), encoding: "base64" });
  if (total > MAX_INLINE_BYTES) throw new Error(`vercel: app is ${total} bytes; inline deployments are limited to ${MAX_INLINE_BYTES}`);
  return out;
}

export class VercelAppWrite implements WebAppWrite {
  readonly kind = "live" as const;
  private readonly http: HttpClient;
  private readonly api: string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: VercelAppOptions) {
    this.api = (opts.env.VERCEL_API_URL ?? VERCEL_API_URL).replace(/\/+$/, "");
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.http = new HttpClient({
      service: "vercel",
      dryRun: opts.dryRun,
      dryRunResponse: vercelDryRunResponse,
      timeoutMs: 120_000,
      defaultHeaders: () => this.authHeaders(),
      ...(opts.recorder ? { recorder: opts.recorder } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
  }

  private authHeaders(): Record<string, string> {
    const token = this.opts.env.VERCEL_TOKEN;
    if (!token) {
      if (this.opts.dryRun) return {};
      throw new Error("vercel: VERCEL_TOKEN is not set");
    }
    return { authorization: `Bearer ${token}` };
  }

  private url(path: string): string {
    const team = this.opts.env.VERCEL_TEAM_ID;
    return `${this.api}${path}${team ? `?${new URLSearchParams({ teamId: team }).toString()}` : ""}`;
  }

  async deployApp(req: { ventureId: string; host: string; files: WebAppFile[]; territories: string[] }): Promise<{ url: string; deploymentId: string }> {
    if (!this.opts.dryRun && /\.invalid$/i.test(req.host)) {
      throw new Error(`vercel: ${req.host} is a placeholder; set web.appsDomain to a domain your Vercel team owns`);
    }
    const created = await this.http.request<{ id: string; readyState?: string }>({
      method: "POST",
      url: this.url("/v13/deployments"),
      json: {
        name: projectName(req.host),
        target: "production",
        projectSettings: { framework: null },
        files: deploymentFiles(req.files, req.territories),
        meta: { ventureId: req.ventureId },
      },
      context: { ventureId: req.ventureId },
    });
    const id = created.data.id;
    if (!created.dryRun) await this.waitReady(id);
    await this.http.request({ method: "POST", url: this.url(`/v2/deployments/${encodeURIComponent(id)}/aliases`), json: { alias: req.host }, context: { ventureId: req.ventureId } });
    return { url: `https://${req.host}`, deploymentId: id };
  }

  private async waitReady(id: string): Promise<void> {
    const max = this.opts.maxPolls ?? 60;
    for (let i = 0; i < max; i++) {
      const res = await this.http.request<{ readyState?: string; errorMessage?: string }>({ method: "GET", url: this.url(`/v13/deployments/${encodeURIComponent(id)}`) });
      const state = res.data.readyState;
      if (state === "READY") return;
      if (state === "ERROR" || state === "CANCELED") throw new Error(`vercel: deployment ${id} ${state}${res.data.errorMessage ? `: ${res.data.errorMessage}` : ""}`);
      await this.sleep(5_000);
    }
    throw new Error(`vercel: deployment ${id} not ready after ${max} polls`);
  }
}
