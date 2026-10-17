#!/usr/bin/env node
// Runs the TypeScript CLI through tsx. NODE_USE_ENV_PROXY makes Node's fetch honour HTTPS_PROXY.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), cli, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY ?? "1" },
});
process.exit(result.status ?? 1);
