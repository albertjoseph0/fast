/**
 * Local static web hosting: files are copied under <dataDir>/web/<ventureId>/ and served at
 * WEB_BASE_URL/<ventureId>/ once that directory is deployed (a human/CI task,
 * "web.deploy_site"; the host must serve clean URLs, e.g. /privacy for privacy.html).
 * Assets are content-addressed (sha256), so re-hosting the same file is a no-op.
 * Copying is local and reversible, so it happens in dry-run too; nothing is sent anywhere.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, normalize, posix } from "node:path";
import type { WebWrite } from "../../core/ports.ts";
import type { StudioStore } from "../../core/store.ts";
import type { StudioConfig } from "../../config/schema.ts";
import type { DryRunRecorder } from "../http.ts";

export const ENV_VARS: readonly { name: string; purpose: string; required: boolean }[] = [
  { name: "WEB_BASE_URL", purpose: "Public URL where <dataDir>/web is deployed, e.g. https://apps.example.com (no trailing slash)", required: true },
];

/** Placeholder host for dry runs without WEB_BASE_URL. */
export const DRY_RUN_WEB_BASE = "https://web.dry-run.invalid";

export interface WebWriteOptions {
  config: StudioConfig;
  store: StudioStore;
  env: Record<string, string | undefined>;
  dryRun: boolean;
  recorder?: DryRunRecorder;
  fetch?: typeof fetch;
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Content-addressed asset path: assets/<first 16 hex of sha256><ext>. */
export function assetPath(localPath: string, sha256: string): string {
  const ext = extname(localPath).toLowerCase().replace(/[^.a-z0-9]/g, "");
  return `assets/${sha256.slice(0, 16)}${ext}`;
}

/** A site-relative path ("/privacy.html" → "privacy.html"); rejects traversal and absolute paths. */
export function safeSitePath(path: string): string {
  const rel = path.replace(/^\/+/, "");
  const norm = posix.normalize(rel);
  if (!rel || isAbsolute(rel) || norm === ".." || norm.startsWith("../") || norm === "." || rel.includes("\\") || rel.includes("\0")) {
    throw new Error(`web: unsafe site path ${JSON.stringify(path)}`);
  }
  return norm;
}

/** Venture ids become one path segment. */
export function safeSegment(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`web: unsafe venture id ${JSON.stringify(id)}`);
  return id;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".woff2": "font/woff2",
};

/** Content type by extension; extensionless well-known files (apple-app-site-association) are JSON. */
export function contentTypeFor(path: string): string {
  const ext = extname(path).toLowerCase();
  if (!ext) return path.includes(".well-known/") ? "application/json" : "application/octet-stream";
  return TYPES[ext] ?? "application/octet-stream";
}

export function webBase(env: Record<string, string | undefined>, dryRun: boolean): string {
  const base = env.WEB_BASE_URL?.replace(/\/+$/, "");
  if (base) return base;
  if (dryRun) return DRY_RUN_WEB_BASE;
  throw new Error("web: WEB_BASE_URL is not set");
}

/** Live WebWrite backed by a local directory that a human or CI deploys. */
export class LocalStaticWebWrite implements WebWrite {
  readonly kind = "live" as const;
  readonly root: string;

  constructor(private readonly opts: WebWriteOptions) {
    this.root = join(opts.config.dataDir, "web");
  }

  private copy(from: string, to: string): void {
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }

  async putAsset(req: { ventureId: string; localPath: string; contentType: string }): Promise<{ publicUrl: string; sha256: string }> {
    const venture = safeSegment(req.ventureId);
    const sha256 = sha256File(req.localPath);
    const rel = assetPath(req.localPath, sha256);
    const dest = join(this.root, venture, normalize(rel));
    if (!existsSync(dest)) this.copy(req.localPath, dest);
    return { publicUrl: `${webBase(this.opts.env, this.opts.dryRun)}/${venture}/${rel}`, sha256 };
  }

  async publishSite(req: { ventureId: string; files: { path: string; localPath: string }[] }): Promise<{ baseUrl: string }> {
    const venture = safeSegment(req.ventureId);
    const files = req.files.map((f) => ({ rel: safeSitePath(f.path), localPath: f.localPath }));
    for (const f of files) this.copy(f.localPath, join(this.root, venture, normalize(f.rel)));
    return { baseUrl: `${webBase(this.opts.env, this.opts.dryRun)}/${venture}` };
  }
}
