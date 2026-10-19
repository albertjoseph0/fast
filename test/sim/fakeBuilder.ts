/** A builder stand-in for studio tests: a minimal project tree with the paths the pipeline reads
 * (project assets, site with legal pages, store screenshots). */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RenderApp } from "../../src/orchestrator/deps.ts";

export const renderApp: RenderApp = ({ venture, spec, outRoot }) => {
  const root = join(outRoot, venture.slug);
  const projectDir = join(root, "app");
  mkdirSync(join(projectDir, "assets"), { recursive: true });
  mkdirSync(join(root, "site"), { recursive: true });
  mkdirSync(join(root, "store", "screenshots"), { recursive: true });
  const appJson = join(projectDir, "app.json");
  const site = ["index", "privacy", "terms", "support"].map((page) => join(root, "site", `${page}.html`));
  const shot = join(root, "store", "screenshots", "1.png");
  writeFileSync(appJson, JSON.stringify({ expo: { name: spec.appName, slug: spec.slug, version: "1.0.0" } }));
  for (const file of site) writeFileSync(file, `<!doctype html><title>${spec.appName}</title>`);
  writeFileSync(shot, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return {
    projectDir,
    version: "1.0.0",
    buildNumber: venture.specVersion,
    specVersion: venture.specVersion,
    checks: [],
    builtAt: venture.updatedAt,
    files: [appJson, ...site, shot],
  };
};
