import { describe, expect, it } from "vitest";
import { DryRunRecorder } from "../../../src/integrations/http.ts";
import { EasCli, EasError, parseBuild, parseJsonOutput, parseSubmissionId } from "../../../src/integrations/expo/eas.ts";
import type { EasRunner } from "../../../src/integrations/expo/eas.ts";

const BUILD_JSON = [
  {
    id: "8a9b7c6d-1111-4222-8333-944455556666",
    status: "IN_QUEUE",
    platform: "IOS",
    appVersion: "1.0.0",
    appBuildVersion: "7",
    artifacts: null,
    error: null,
  },
];

function recordingRunner(responses: { code?: number; stdout?: string; stderr?: string }[]) {
  const calls: { cmd: string; args: string[]; cwd: string; env: Record<string, string | undefined> }[] = [];
  const runner: EasRunner = async (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts.cwd, env: opts.env });
    const r = responses.shift() ?? {};
    return { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { runner, calls };
}

describe("EasCli dry-run", () => {
  it("never spawns, logs the exact command lines and returns dry_eas_ ids", async () => {
    const recorder = new DryRunRecorder();
    const { runner, calls } = recordingRunner([]);
    const eas = new EasCli({ env: {}, dryRun: true, runner, recorder });
    const build = await eas.build({ platform: "ios", projectDir: "/work/astra" });
    const submit = await eas.submit({ platform: "android", buildId: "b-1", projectDir: "/work/astra" });
    expect(calls).toEqual([]);
    expect(build).toMatchObject({ id: expect.stringMatching(/^dry_eas_build_ios_[0-9a-f]{12}$/), status: "NEW", platform: "ios" });
    expect(submit.id).toMatch(/^dry_eas_submit_android_/);
    expect(eas.commands()).toEqual([
      { argv: ["eas", "build", "--platform", "ios", "--profile", "production", "--non-interactive", "--no-wait", "--json"], cwd: "/work/astra", dryRun: true },
      { argv: ["eas", "submit", "--platform", "android", "--profile", "production", "--id", "b-1", "--non-interactive", "--no-wait"], cwd: "/work/astra", dryRun: true },
    ]);
    expect(recorder.list().map((r) => (r.json as { argv: string[] }).argv.slice(1, 2))).toEqual([["build"], ["submit"]]);
    expect(await eas.buildStatus({ id: build.id, projectDir: "/work/astra" })).toMatchObject({ status: "FINISHED", platform: "ios" });
  });
});

describe("EasCli live", () => {
  it("passes EXPO_TOKEN and credentials, and parses build JSON after stray log lines", async () => {
    const { runner, calls } = recordingRunner([{ stdout: `Compressing project files...\n${JSON.stringify(BUILD_JSON)}\n` }]);
    const eas = new EasCli({ env: { PATH: "/usr/bin", MY_EXPO: "tok_123" }, dryRun: false, runner, secretRefs: { token: "MY_EXPO" } });
    const build = await eas.build({ platform: "ios", projectDir: "/p", env: { EXPO_ASC_KEY_ID: "K1" } });
    expect(build).toEqual({ id: "8a9b7c6d-1111-4222-8333-944455556666", status: "IN_QUEUE", platform: "ios", appVersion: "1.0.0", appBuildVersion: "7" });
    expect(calls[0]).toMatchObject({ cmd: "eas", cwd: "/p", args: ["build", "--platform", "ios", "--profile", "production", "--non-interactive", "--no-wait", "--json"] });
    expect(calls[0]!.env).toMatchObject({ PATH: "/usr/bin", EXPO_TOKEN: "tok_123", EXPO_ASC_KEY_ID: "K1", CI: "1" });
  });

  it("reads build status and artifacts from build:view --json", async () => {
    const view = { id: "b-2", status: "FINISHED", platform: "ANDROID", appVersion: "1.0.0", appBuildVersion: "12", artifacts: { buildUrl: "https://expo.dev/artifacts/eas/x.aab" } };
    const { runner, calls } = recordingRunner([{ stdout: JSON.stringify(view) }]);
    const eas = new EasCli({ env: { EXPO_TOKEN: "t" }, dryRun: false, runner });
    expect(await eas.buildStatus({ id: "b-2", projectDir: "/p" })).toEqual({
      id: "b-2",
      status: "FINISHED",
      platform: "android",
      appVersion: "1.0.0",
      appBuildVersion: "12",
      artifactUrl: "https://expo.dev/artifacts/eas/x.aab",
    });
    expect(calls[0]!.args).toEqual(["build:view", "b-2", "--json"]);
  });

  it("extracts the submission id from submit output", async () => {
    const out = "✔ Scheduled iOS submission\nSubmission details: https://expo.dev/accounts/fast/projects/astra/submissions/0f1e2d3c-4b5a-4968-8776-655443322110\n";
    const { runner } = recordingRunner([{ stdout: out }]);
    const eas = new EasCli({ env: { EXPO_TOKEN: "t" }, dryRun: false, runner });
    expect(await eas.submit({ platform: "ios", buildId: "b-3", projectDir: "/p" })).toEqual({ id: "0f1e2d3c-4b5a-4968-8776-655443322110" });
  });

  it("raises EasError on a non-zero exit and refuses to run without a token", async () => {
    const { runner } = recordingRunner([{ code: 1, stderr: "Build failed: credentials are not set up" }]);
    const eas = new EasCli({ env: { EXPO_TOKEN: "t" }, dryRun: false, runner });
    const err = await eas.build({ platform: "ios", projectDir: "/p" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EasError);
    expect((err as EasError).message).toContain("credentials are not set up");
    const noToken = new EasCli({ env: {}, dryRun: false, runner });
    await expect(noToken.buildStatus({ id: "x", projectDir: "/p" })).rejects.toThrow(/EXPO_TOKEN is not set/);
  });
});

describe("eas output parsing", () => {
  it("normalizes statuses and errors", () => {
    expect(parseBuild({ id: "a", status: "errored", platform: "ios", error: { message: "Gradle failed" } })).toMatchObject({ status: "ERRORED", error: "Gradle failed" });
    expect(parseBuild({ id: "a", status: "in-progress", platform: "android" })).toMatchObject({ status: "IN_PROGRESS", platform: "android" });
    expect(parseBuild({ id: "a", status: "weird" }).status).toBe("UNKNOWN");
    expect(() => parseBuild({ status: "FINISHED" })).toThrow(/no id/);
    expect(() => parseJsonOutput("no json here")).toThrow(/no JSON/);
    expect(parseSubmissionId("nothing")).toBeNull();
  });
});
