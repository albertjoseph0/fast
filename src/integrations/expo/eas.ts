/**
 * EAS Build and Submit through eas-cli (spawned as a child process; the runner is
 * injectable for tests). Builds and submissions are started with --no-wait and polled.
 *
 * Dry-run never spawns a mutating command: it logs the exact command line (and records it
 * to the DryRunRecorder outbox when one is given) and returns ids starting "dry_eas_".
 * `eas submit` has no --json flag, so the submission id is read from its log output.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StudioStore } from "../../core/store.ts";
import type { StudioConfig } from "../../config/schema.ts";
import type { StorePlatform } from "../../core/types.ts";
import type { DryRunRecorder } from "../http.ts";

export const ENV_VARS: readonly { name: string; purpose: string; required: boolean }[] = [
  { name: "EXPO_TOKEN", purpose: "Expo robot or personal access token (default name of secretRefs.token)", required: true },
  { name: "EAS_BIN", purpose: "eas-cli executable (default: eas on PATH)", required: false },
];

export interface EasRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type EasRunner = (cmd: string, args: string[], opts: { cwd: string; env: Record<string, string | undefined>; timeoutMs: number }) => Promise<EasRunResult>;

export type EasBuildStatus = "NEW" | "IN_QUEUE" | "IN_PROGRESS" | "PENDING_CANCEL" | "FINISHED" | "ERRORED" | "CANCELED" | "UNKNOWN";

export interface EasBuild {
  id: string;
  status: EasBuildStatus;
  platform: StorePlatform;
  appVersion?: string;
  appBuildVersion?: string;
  artifactUrl?: string;
  error?: string;
}

export type EasSubmissionStatus = "AWAITING_BUILD" | "IN_QUEUE" | "IN_PROGRESS" | "FINISHED" | "ERRORED" | "CANCELED" | "UNKNOWN";

export interface EasSubmission {
  id: string;
  status: EasSubmissionStatus;
  error?: string;
}

export interface EasCommandRecord {
  argv: string[];
  cwd: string;
  dryRun: boolean;
}

export interface EasCliOptions {
  /** Accepted for uniform construction with the other live clients. */
  config?: StudioConfig;
  store?: StudioStore;
  env: Record<string, string | undefined>;
  dryRun: boolean;
  recorder?: DryRunRecorder;
  /** Env var NAME holding the Expo token (secretRefs.token). */
  secretRefs?: Record<string, string>;
  runner?: EasRunner;
  bin?: string;
  timeoutMs?: number;
}

export class EasError extends Error {
  constructor(
    readonly argv: string[],
    readonly code: number,
    readonly stderr: string,
  ) {
    super(`eas ${argv.join(" ")} exited ${code}: ${stderr.slice(-800)}`);
    this.name = "EasError";
  }
}

/** Default runner: spawn without a shell, collect output, kill on timeout. */
export const spawnRunner: EasRunner = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });

const STATUSES: readonly EasBuildStatus[] = ["NEW", "IN_QUEUE", "IN_PROGRESS", "PENDING_CANCEL", "FINISHED", "ERRORED", "CANCELED"];

/** Parse the first JSON value in eas-cli output (stray log lines before it are skipped). */
export function parseJsonOutput(stdout: string): unknown {
  const start = stdout.search(/[[{]/);
  if (start < 0) throw new Error(`eas: no JSON in output: ${stdout.slice(0, 200)}`);
  return JSON.parse(stdout.slice(start));
}

/** Normalize one build object from `eas build --json` or `eas build:view --json`. */
export function parseBuild(raw: unknown): EasBuild {
  const b = (raw ?? {}) as Record<string, unknown>;
  const status = String(b.status ?? "").toUpperCase().replace(/-/g, "_") as EasBuildStatus;
  const artifacts = (b.artifacts ?? {}) as Record<string, unknown>;
  const error = (b.error ?? null) as { message?: string } | null;
  const id = String(b.id ?? "");
  if (!id) throw new Error("eas: build JSON has no id");
  const artifactUrl = artifacts.applicationArchiveUrl ?? artifacts.buildUrl;
  return {
    id,
    status: STATUSES.includes(status) ? status : "UNKNOWN",
    platform: String(b.platform ?? "").toLowerCase() === "android" ? "android" : "ios",
    ...(b.appVersion ? { appVersion: String(b.appVersion) } : {}),
    ...(b.appBuildVersion ? { appBuildVersion: String(b.appBuildVersion) } : {}),
    ...(typeof artifactUrl === "string" ? { artifactUrl } : {}),
    ...(error?.message ? { error: error.message } : {}),
  };
}

const SUBMISSION_STATUSES: readonly EasSubmissionStatus[] = ["AWAITING_BUILD", "IN_QUEUE", "IN_PROGRESS", "FINISHED", "ERRORED", "CANCELED"];

/** Normalize the submission object from `eas submit:view --json`. */
export function parseSubmission(raw: unknown): EasSubmission {
  const s = (raw ?? {}) as Record<string, unknown>;
  const id = String(s.id ?? "");
  if (!id) throw new Error("eas: submission JSON has no id");
  const status = String(s.status ?? "").toUpperCase().replace(/-/g, "_") as EasSubmissionStatus;
  const error = (s.error ?? null) as { errorCode?: string; message?: string } | null;
  const message = [error?.errorCode, error?.message].filter(Boolean).join(": ");
  return { id, status: SUBMISSION_STATUSES.includes(status) ? status : "UNKNOWN", ...(message ? { error: message } : {}) };
}

/**
 * Merge `fields` into eas.json's submit.<profile>.<platform>. With --non-interactive, eas-cli
 * reads ascAppId and the App Store Connect key (ascApiKeyPath/Id/IssuerId) only from there.
 */
export function patchSubmitProfile(projectDir: string, profile: string, platform: StorePlatform, fields: Record<string, string>): void {
  const path = join(projectDir, "eas.json");
  if (!existsSync(path)) throw new Error(`eas submit: ${path} does not exist`);
  const eas = JSON.parse(readFileSync(path, "utf8")) as { submit?: Record<string, Record<string, Record<string, unknown>>> };
  const submit = eas.submit ?? {};
  const current = submit[profile] ?? {};
  eas.submit = { ...submit, [profile]: { ...current, [platform]: { ...current[platform], ...fields } } };
  writeFileSync(path, `${JSON.stringify(eas, null, 2)}\n`);
}

/** Submission id from the "…/submissions/<uuid>" link eas submit prints. */
export function parseSubmissionId(output: string): string | null {
  return /\/submissions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(output)?.[1] ?? null;
}

function dryId(kind: string, platform: StorePlatform, argv: string[], cwd: string): string {
  return `dry_eas_${kind}_${platform}_${createHash("sha256").update(`${cwd}\n${argv.join(" ")}`).digest("hex").slice(0, 12)}`;
}

export class EasCli {
  private readonly runner: EasRunner;
  private readonly log: EasCommandRecord[] = [];

  constructor(private readonly opts: EasCliOptions) {
    this.runner = opts.runner ?? spawnRunner;
  }

  get dryRun(): boolean {
    return this.opts.dryRun;
  }

  /** Every command run or (in dry-run) planned, in order. */
  commands(): readonly EasCommandRecord[] {
    return this.log;
  }

  /** Start a production store build without waiting. */
  async build(req: { platform: StorePlatform; projectDir: string; profile?: string; env?: Record<string, string> }): Promise<EasBuild> {
    const argv = ["build", "--platform", req.platform, "--profile", req.profile ?? "production", "--non-interactive", "--no-wait", "--json"];
    if (this.opts.dryRun) {
      this.plan(argv, req.projectDir);
      return { id: dryId("build", req.platform, argv, req.projectDir), status: "NEW", platform: req.platform };
    }
    const out = await this.run(argv, req.projectDir, req.env);
    const parsed = parseJsonOutput(out.stdout);
    const builds = (Array.isArray(parsed) ? parsed : [parsed]).map(parseBuild);
    const build = builds.find((b) => b.platform === req.platform) ?? builds[0];
    if (!build) throw new Error("eas build: no build in output");
    return build;
  }

  /** Current state of a build. Dry-run builds report FINISHED. */
  async buildStatus(req: { id: string; projectDir: string }): Promise<EasBuild> {
    if (req.id.startsWith("dry_")) return { id: req.id, status: "FINISHED", platform: req.id.includes("_android_") ? "android" : "ios" };
    const out = await this.run(["build:view", req.id, "--json"], req.projectDir);
    return parseBuild(parseJsonOutput(out.stdout));
  }

  /**
   * Submit a finished build to App Store Connect / Google Play without waiting. `submitProfile`
   * fields (ids and file paths only, never key material) are written into eas.json first.
   */
  async submit(req: {
    platform: StorePlatform;
    buildId: string;
    projectDir: string;
    profile?: string;
    env?: Record<string, string>;
    submitProfile?: Record<string, string>;
  }): Promise<{ id: string | null }> {
    const profile = req.profile ?? "production";
    const argv = ["submit", "--platform", req.platform, "--profile", profile, "--id", req.buildId, "--non-interactive", "--no-wait"];
    if (this.opts.dryRun) {
      this.plan(argv, req.projectDir);
      return { id: dryId("submit", req.platform, argv, req.projectDir) };
    }
    if (req.submitProfile) patchSubmitProfile(req.projectDir, profile, req.platform, req.submitProfile);
    const out = await this.run(argv, req.projectDir, req.env);
    return { id: parseSubmissionId(`${out.stdout}\n${out.stderr}`) };
  }

  /** Current state of a submission (`eas submit --no-wait` only schedules it). Dry-run submissions report FINISHED. */
  async submissionStatus(req: { id: string; projectDir: string }): Promise<EasSubmission> {
    if (req.id.startsWith("dry_")) return { id: req.id, status: "FINISHED" };
    const out = await this.run(["submit:view", req.id, "--json"], req.projectDir);
    return parseSubmission(parseJsonOutput(out.stdout));
  }

  private plan(argv: string[], cwd: string): void {
    this.log.push({ argv: [this.bin(), ...argv], cwd, dryRun: true });
    this.opts.recorder?.record("eas", {
      method: "POST",
      url: `https://eas-cli.invalid/${encodeURIComponent(argv[0] ?? "")}`,
      json: { argv: [this.bin(), ...argv], cwd },
    });
  }

  private bin(): string {
    return this.opts.bin ?? this.opts.env.EAS_BIN ?? "eas";
  }

  private async run(argv: string[], cwd: string, extraEnv: Record<string, string> = {}): Promise<EasRunResult> {
    const tokenVar = this.opts.secretRefs?.token ?? "EXPO_TOKEN";
    const token = this.opts.env[tokenVar];
    if (!token) throw new Error(`EAS: ${tokenVar} is not set`);
    this.log.push({ argv: [this.bin(), ...argv], cwd, dryRun: false });
    const env = { ...this.opts.env, ...extraEnv, EXPO_TOKEN: token, CI: "1" };
    const out = await this.runner(this.bin(), argv, { cwd, env, timeoutMs: this.opts.timeoutMs ?? 600_000 });
    if (out.code !== 0) throw new EasError(argv, out.code, out.stderr || out.stdout);
    return out;
  }
}
