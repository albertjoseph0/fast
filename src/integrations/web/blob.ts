/**
 * Vercel Blob hosting through its REST API, as @vercel/blob 2.8 calls it:
 *   PUT https://vercel.com/api/blob/?pathname=<pathname>
 *   authorization: Bearer <BLOB_READ_WRITE_TOKEN>, x-api-version: 13,
 *   x-vercel-blob-store-id (from the token), x-vercel-blob-access: public,
 *   x-content-type, x-add-random-suffix: 0, x-allow-overwrite
 * and the response carries the public `url`. Assets are content-addressed; site files are
 * uploaded under <ventureId>/site/, each HTML page also at its clean URL (privacy.html →
 * privacy), so the legal URLs the executor derives resolve on Blob's static hosting.
 * Uploads are dry-run by default and answered with URLs on the "dry_run.blob.invalid" host.
 */
import type { WebWrite } from "../../core/ports.ts";
import { HttpClient } from "../http.ts";
import type { HttpRequest } from "../http.ts";
import { assetPath, contentTypeFor, safeSegment, safeSitePath, sha256File } from "./static.ts";
import type { WebWriteOptions } from "./static.ts";

export const ENV_VARS: readonly { name: string; purpose: string; required: boolean }[] = [
  { name: "BLOB_READ_WRITE_TOKEN", purpose: "Vercel Blob read-write token (vercel_blob_rw_<storeId>_…) for a public store", required: true },
  { name: "VERCEL_BLOB_API_URL", purpose: "Blob API base override (default https://vercel.com/api/blob)", required: false },
];

export const BLOB_API_URL = "https://vercel.com/api/blob";
export const BLOB_API_VERSION = "13";

/** The store id embedded in a read-write token (vercel_blob_rw_<storeId>_<secret>). */
export function storeIdFromToken(token: string): string {
  return token.split("_")[3] ?? "";
}

/** Synthetic Blob response for a dry-run upload. */
export function blobDryRunResponse(req: HttpRequest): unknown {
  const pathname = new URL(req.url).searchParams.get("pathname") ?? "";
  const url = `https://dry_run.blob.invalid/${pathname}`;
  return { url, downloadUrl: `${url}?download=1`, pathname, contentType: req.headers?.["x-content-type"] ?? "" };
}

/** Clean-URL aliases for an HTML page: "privacy.html" → "privacy", "help/index.html" → "help". */
export function cleanAliases(rel: string): string[] {
  if (!/\.html$/i.test(rel) || rel.toLowerCase() === "index.html") return [];
  return [rel.replace(/(\/index)?\.html$/i, "")];
}

export class VercelBlobWebWrite implements WebWrite {
  readonly kind = "live" as const;
  private readonly http: HttpClient;
  private readonly api: string;

  constructor(private readonly opts: WebWriteOptions) {
    this.api = (opts.env.VERCEL_BLOB_API_URL ?? BLOB_API_URL).replace(/\/+$/, "");
    this.http = new HttpClient({
      service: "blob",
      dryRun: opts.dryRun,
      dryRunResponse: blobDryRunResponse,
      timeoutMs: 300_000,
      defaultHeaders: () => this.authHeaders(),
      ...(opts.recorder ? { recorder: opts.recorder } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
  }

  private authHeaders(): Record<string, string> {
    const token = this.opts.env.BLOB_READ_WRITE_TOKEN;
    if (!token) {
      if (this.opts.dryRun) return { "x-api-version": BLOB_API_VERSION };
      throw new Error("blob: BLOB_READ_WRITE_TOKEN is not set");
    }
    return { authorization: `Bearer ${token}`, "x-api-version": BLOB_API_VERSION, "x-vercel-blob-store-id": storeIdFromToken(token) };
  }

  /** Upload one file; returns its public URL. */
  async upload(pathname: string, localPath: string, contentType: string, allowOverwrite: boolean): Promise<string> {
    const res = await this.http.upload<{ url?: string }>({
      method: "PUT",
      url: `${this.api}/?${new URLSearchParams({ pathname }).toString()}`,
      headers: {
        "x-vercel-blob-access": "public",
        "x-content-type": contentType,
        "x-add-random-suffix": "0",
        "x-allow-overwrite": allowOverwrite ? "1" : "0",
      },
      file: { path: localPath },
    });
    if (!res.data.url) throw new Error(`blob: no url in upload response for ${pathname}`);
    return res.data.url;
  }

  async putAsset(req: { ventureId: string; localPath: string; contentType: string }): Promise<{ publicUrl: string; sha256: string }> {
    const sha256 = sha256File(req.localPath);
    const pathname = `${safeSegment(req.ventureId)}/${assetPath(req.localPath, sha256)}`;
    // Content-addressed: an existing blob at this path already holds these bytes.
    return { publicUrl: await this.upload(pathname, req.localPath, req.contentType, true), sha256 };
  }

  async publishSite(req: { ventureId: string; files: { path: string; localPath: string }[] }): Promise<{ baseUrl: string }> {
    const prefix = `${safeSegment(req.ventureId)}/site`;
    const files = req.files.map((f) => ({ rel: safeSitePath(f.path), localPath: f.localPath }));
    if (!files.length) throw new Error("blob: publishSite needs at least one file");
    let baseUrl = "";
    for (const f of files) {
      const type = contentTypeFor(f.rel);
      const url = await this.upload(`${prefix}/${f.rel}`, f.localPath, type, true);
      baseUrl ||= `${new URL(url).origin}/${prefix}`;
      for (const alias of cleanAliases(f.rel)) await this.upload(`${prefix}/${alias}`, f.localPath, type, true);
    }
    return { baseUrl };
  }
}
