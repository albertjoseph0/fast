import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../../src/config/schema.ts";
import { SimClock } from "../../../src/core/clock.ts";
import { StudioStore } from "../../../src/core/store.ts";
import { DryRunRecorder } from "../../../src/integrations/http.ts";
import { VercelBlobWebWrite, cleanAliases, storeIdFromToken } from "../../../src/integrations/web/blob.ts";
import { LocalStaticWebWrite, contentTypeFor, safeSitePath } from "../../../src/integrations/web/static.ts";
import { fake, noFetch } from "../posthog/fakeFetch.ts";

function files() {
  const dir = mkdtempSync(join(tmpdir(), "fast-web-"));
  const img = join(dir, "card.PNG");
  writeFileSync(img, "png-bytes");
  const privacy = join(dir, "privacy.html");
  writeFileSync(privacy, "<h1>Privacy</h1>");
  const aasa = join(dir, "aasa.json");
  writeFileSync(aasa, "{}");
  return { dir, img, privacy, aasa, sha: createHash("sha256").update("png-bytes").digest("hex") };
}

const store = () => new StudioStore(null, new SimClock());

describe("path safety and content types", () => {
  it("rejects traversal and absolute paths", () => {
    expect(safeSitePath("/privacy.html")).toBe("privacy.html");
    expect(safeSitePath("a/./b.html")).toBe("a/b.html");
    for (const bad of ["../x", "a/../../x", "..", "a\\b", ""]) expect(() => safeSitePath(bad)).toThrow(/unsafe/);
  });

  it("knows web content types", () => {
    expect(contentTypeFor("privacy.html")).toBe("text/html; charset=utf-8");
    expect(contentTypeFor(".well-known/apple-app-site-association")).toBe("application/json");
    expect(cleanAliases("privacy.html")).toEqual(["privacy"]);
    expect(cleanAliases("help/index.html")).toEqual(["help"]);
    expect(cleanAliases("index.html")).toEqual([]);
  });
});

describe("LocalStaticWebWrite", () => {
  it("copies content-addressed assets and site files under <dataDir>/web/<ventureId> and returns WEB_BASE_URL URLs", async () => {
    const f = files();
    const web = new LocalStaticWebWrite({ config: defaultConfig({ dataDir: f.dir }), store: store(), env: { WEB_BASE_URL: "https://apps.example.com/" }, dryRun: false, fetch: noFetch });
    const asset = await web.putAsset({ ventureId: "v1", localPath: f.img, contentType: "image/png" });
    expect(asset).toEqual({ publicUrl: `https://apps.example.com/v1/assets/${f.sha.slice(0, 16)}.png`, sha256: f.sha });
    expect(readFileSync(join(f.dir, "web", "v1", "assets", `${f.sha.slice(0, 16)}.png`), "utf8")).toBe("png-bytes");

    const site = await web.publishSite({ ventureId: "v1", files: [{ path: "/privacy.html", localPath: f.privacy }, { path: ".well-known/apple-app-site-association", localPath: f.aasa }] });
    expect(site).toEqual({ baseUrl: "https://apps.example.com/v1" });
    expect(readFileSync(join(f.dir, "web", "v1", "privacy.html"), "utf8")).toBe("<h1>Privacy</h1>");
    expect(existsSync(join(f.dir, "web", "v1", ".well-known", "apple-app-site-association"))).toBe(true);
    await expect(web.publishSite({ ventureId: "v1", files: [{ path: "../../etc/x", localPath: f.privacy }] })).rejects.toThrow(/unsafe/);
    await expect(web.putAsset({ ventureId: "../v2", localPath: f.img, contentType: "image/png" })).rejects.toThrow(/unsafe venture id/);
  });

  it("needs WEB_BASE_URL outside dry-run", async () => {
    const f = files();
    const live = new LocalStaticWebWrite({ config: defaultConfig({ dataDir: f.dir }), store: store(), env: {}, dryRun: false });
    await expect(live.putAsset({ ventureId: "v1", localPath: f.img, contentType: "image/png" })).rejects.toThrow(/WEB_BASE_URL/);
    const dry = new LocalStaticWebWrite({ config: defaultConfig({ dataDir: f.dir }), store: store(), env: {}, dryRun: true });
    expect((await dry.publishSite({ ventureId: "v1", files: [] })).baseUrl).toBe("https://web.dry-run.invalid/v1");
  });
});

describe("VercelBlobWebWrite", () => {
  const token = "vercel_blob_rw_StoreAbc_secret123";

  it("PUTs to the Blob API with the token, api version, store id and content type; returns the blob URL", async () => {
    const f = files();
    const http = fake([{ method: "PUT", match: "https://vercel.com/api/blob/?pathname=", json: (c) => ({ url: `https://storeabc.public.blob.vercel-storage.com/${new URL(c.url).searchParams.get("pathname")}`, pathname: "" }) }]);
    const web = new VercelBlobWebWrite({ config: defaultConfig(), store: store(), env: { BLOB_READ_WRITE_TOKEN: token }, dryRun: false, fetch: http.fetch });
    const asset = await web.putAsset({ ventureId: "v1", localPath: f.img, contentType: "image/png" });
    expect(asset).toEqual({ publicUrl: `https://storeabc.public.blob.vercel-storage.com/v1/assets/${f.sha.slice(0, 16)}.png`, sha256: f.sha });
    const call = http.calls[0]!;
    expect(call.url).toBe(`https://vercel.com/api/blob/?pathname=v1%2Fassets%2F${f.sha.slice(0, 16)}.png`);
    expect(call.headers).toMatchObject({
      authorization: `Bearer ${token}`,
      "x-api-version": "13",
      "x-vercel-blob-store-id": "StoreAbc",
      "x-vercel-blob-access": "public",
      "x-content-type": "image/png",
      "x-add-random-suffix": "0",
    });
    expect(call.body).toBe("png-bytes");
  });

  it("publishes a site with clean-URL aliases and returns its base URL", async () => {
    const f = files();
    const http = fake([{ method: "PUT", match: "vercel.com/api/blob", json: (c) => ({ url: `https://storeabc.public.blob.vercel-storage.com/${new URL(c.url).searchParams.get("pathname")}` }) }]);
    const web = new VercelBlobWebWrite({ config: defaultConfig(), store: store(), env: { BLOB_READ_WRITE_TOKEN: token }, dryRun: false, fetch: http.fetch });
    expect(await web.publishSite({ ventureId: "v1", files: [{ path: "privacy.html", localPath: f.privacy }] })).toEqual({ baseUrl: "https://storeabc.public.blob.vercel-storage.com/v1/site" });
    expect(http.calls.map((c) => new URL(c.url).searchParams.get("pathname"))).toEqual(["v1/site/privacy.html", "v1/site/privacy"]);
    expect(http.calls.every((c) => c.headers["x-content-type"] === "text/html; charset=utf-8" && c.headers["x-allow-overwrite"] === "1")).toBe(true);
  });

  it("dry-run records uploads without calling fetch", async () => {
    const f = files();
    const recorder = new DryRunRecorder(null);
    const web = new VercelBlobWebWrite({ config: defaultConfig(), store: store(), env: { BLOB_READ_WRITE_TOKEN: token }, dryRun: true, recorder, fetch: noFetch });
    const asset = await web.putAsset({ ventureId: "v1", localPath: f.img, contentType: "image/png" });
    expect(asset.publicUrl).toBe(`https://dry_run.blob.invalid/v1/assets/${f.sha.slice(0, 16)}.png`);
    expect(recorder.list()).toHaveLength(1);
    expect(recorder.list()[0]).toMatchObject({ service: "blob", method: "PUT", headers: { authorization: "<redacted>", "x-dry-run-upload-bytes": "9" } });
    expect(storeIdFromToken(token)).toBe("StoreAbc");
  });
});
