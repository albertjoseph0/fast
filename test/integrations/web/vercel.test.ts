import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DryRunRecorder } from "../../../src/integrations/http.ts";
import { VercelAppWrite, deploymentFiles, projectName } from "../../../src/integrations/web/vercel.ts";
import { fakeFetch, forbiddenFetch } from "../apple/fakeFetch.ts";

function appDir(): { path: string; localPath: string }[] {
  const dir = mkdtempSync(join(tmpdir(), "vercel-test-"));
  writeFileSync(join(dir, "index.html"), "<h1>hi</h1>");
  writeFileSync(join(dir, "geo.json"), "{\"territories\":[\"ZZ\"]}");
  return [
    { path: "/index.html", localPath: join(dir, "index.html") },
    { path: "geo.json", localPath: join(dir, "geo.json") },
  ];
}
const decode = (f: { data: string }) => Buffer.from(f.data, "base64").toString("utf8");

describe("vercel web apps", () => {
  it("names projects after the host", () => {
    expect(projectName("Astra.apps.example.com")).toBe("astra-apps-example-com");
  });

  it("inlines the app and replaces geo.json with the allowed territories", () => {
    const files = deploymentFiles(appDir(), ["NZ", "CA"]);
    expect(files.map((f) => f.file)).toEqual(["index.html", "geo.json"]);
    expect(decode(files[0]!)).toBe("<h1>hi</h1>");
    expect(JSON.parse(decode(files[1]!))).toEqual({ territories: ["CA", "NZ"] });
  });

  it("deploys, waits for READY and aliases the venture host", async () => {
    const f = fakeFetch([
      { method: "POST", match: "/v13/deployments", json: { id: "dpl_1", readyState: "QUEUED" } },
      { method: "GET", match: "/v13/deployments/dpl_1", once: true, json: { readyState: "BUILDING" } },
      { method: "GET", match: "/v13/deployments/dpl_1", json: { readyState: "READY" } },
      { method: "POST", match: "/v2/deployments/dpl_1/aliases", json: { alias: "astra.apps.example.com" } },
    ]);
    const sleeps: number[] = [];
    const vercel = new VercelAppWrite({ env: { VERCEL_TOKEN: "tok", VERCEL_TEAM_ID: "team_1" }, dryRun: false, fetch: f.fetch, sleep: async (ms) => void sleeps.push(ms) });
    const res = await vercel.deployApp({ ventureId: "ven_1", host: "astra.apps.example.com", files: appDir(), territories: ["NZ"] });

    expect(res).toEqual({ url: "https://astra.apps.example.com", deploymentId: "dpl_1" });
    expect(f.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "POST /v13/deployments",
      "GET /v13/deployments/dpl_1",
      "GET /v13/deployments/dpl_1",
      "POST /v2/deployments/dpl_1/aliases",
    ]);
    expect(sleeps).toEqual([5000]);
    for (const c of f.calls) {
      expect(c.headers.authorization).toBe("Bearer tok");
      expect(new URL(c.url).searchParams.get("teamId")).toBe("team_1");
    }
    expect(f.calls[0]?.json).toMatchObject({ name: "astra-apps-example-com", target: "production" });
    expect(f.calls[3]?.json).toEqual({ alias: "astra.apps.example.com" });
  });

  it("fails when the deployment errors", async () => {
    const f = fakeFetch([
      { method: "POST", match: "/v13/deployments", json: { id: "dpl_2" } },
      { method: "GET", match: "/v13/deployments/dpl_2", json: { readyState: "ERROR", errorMessage: "bad file" } },
    ]);
    const vercel = new VercelAppWrite({ env: { VERCEL_TOKEN: "tok" }, dryRun: false, fetch: f.fetch, sleep: async () => {} });
    await expect(vercel.deployApp({ ventureId: "ven_1", host: "astra.apps.example.com", files: appDir(), territories: ["NZ"] })).rejects.toThrow(/dpl_2 ERROR: bad file/);
    expect(f.calls.some((c) => c.url.includes("/aliases"))).toBe(false);
  });

  it("refuses the placeholder domain live", async () => {
    const vercel = new VercelAppWrite({ env: { VERCEL_TOKEN: "tok" }, dryRun: false, fetch: forbiddenFetch });
    await expect(vercel.deployApp({ ventureId: "ven_1", host: "astra.apps.example.invalid", files: appDir(), territories: ["NZ"] })).rejects.toThrow(/placeholder/);
  });

  it("records the deploy and alias in dry-run without polling", async () => {
    const recorder = new DryRunRecorder();
    const vercel = new VercelAppWrite({ env: {}, dryRun: true, recorder, fetch: forbiddenFetch });
    const res = await vercel.deployApp({ ventureId: "ven_1", host: "astra.apps.example.invalid", files: appDir(), territories: ["NZ"] });
    expect(res.deploymentId).toBe("dry_dpl");
    expect(recorder.list().map((r) => new URL(r.url).pathname)).toEqual(["/v13/deployments", "/v2/deployments/dry_dpl/aliases"]);
  });
});
