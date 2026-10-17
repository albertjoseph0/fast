/**
 * factory — operate the studio.
 *
 *   factory sim [--days 120] [--seed 42] [--data DIR] [--llm stub|gateway|anthropic] [--quiet]
 *   factory init [--data .factory]            write a live config (dry-run on)
 *   factory tick                              run today's operating day (live)
 *   factory status | report                   portfolio, cash and queues
 *   factory approvals                         actions waiting for a human
 *   factory approve <id> [--as NAME] [--note TEXT]
 *   factory reject <id> --reason TEXT [--as NAME]
 *   factory tasks | task <id>                 human tasks and their instructions
 *   factory complete <id> key=value ... [--as NAME]
 *   factory execute                           run approved actions now
 *   factory stop | resume                     kill switch for every external action
 *   factory freeze <scope> --reason TEXT | unfreeze <scope>
 *   factory go-live --confirm                 turn dry-run off (real API writes)
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { StudioConfig } from "../config/schema.ts";
import type { Action } from "../core/types.ts";
import { runSimulation, type SimulationResult } from "../orchestrator/runner.ts";
import { createLiveStudio } from "../orchestrator/wiring.ts";

const usd = (cents: number) => `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

function fail(message: string): never {
  process.stderr.write(`factory: ${message}\n`);
  process.exit(1);
}

function loadConfig(dataDir: string): StudioConfig {
  const path = join(dataDir, "config.json");
  if (!existsSync(path)) fail(`no ${path}; run \`factory init\` first`);
  return StudioConfig.parse(JSON.parse(readFileSync(path, "utf8")));
}

function printSimulation(r: SimulationResult): void {
  const lines = [
    `Simulated ${r.days} days (${r.startDate} → ${r.endDate}), seed ${r.seed}, ${(r.elapsedMs / 1000).toFixed(1)} s`,
    `Cash ${usd(r.cashStartCents)} → ${usd(r.cashEndCents)} · revenue ${usd(r.revenueCents)} · creators ${usd(r.spendCents.creators)} · ads ${usd(r.spendCents.ads)} · AI ${usd(r.spendCents.ai + r.spendCents.media)} · inference ${usd(r.spendCents.inference)}`,
    `Ideas ${r.ideas} → screened in ${r.screenedIn} → ventures ${r.ventures} → live ${r.everLive} → scaled ${r.validated}`,
    `Stages ${Object.entries(r.byStage).map(([k, v]) => `${k} ${v}`).join(", ")}`,
    `Experiments ${r.experiments.registered} (${Object.entries(r.experiments.decided).map(([k, v]) => `${k} ${v}`).join(", ") || "none decided"})`,
    `Actions ${r.actions.total} (${Object.entries(r.actions.byStatus).map(([k, v]) => `${k} ${v}`).join(", ")}) · human tasks ${r.humanTasks.done}/${r.humanTasks.opened} done`,
    ...(r.llm ? [`LLM ${r.llm.calls} calls, ${r.llm.inputTokens} in / ${r.llm.outputTokens} out tokens, ${usd(r.llm.costCents)}`] : []),
    "",
    ...r.ventureLines.map((v) => `  ${v.id} ${v.name.padEnd(18)} ${v.stage.padEnd(11)} ${v.detail}`),
    ...(r.errors.length ? ["", `${r.errors.length} errors (first 10):`, ...r.errors.slice(0, 10).map((e) => `  ${e}`)] : []),
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

function describeAction(a: Action): string {
  const cost = a.costCents ? ` ${usd(a.costCents)}` : "";
  const findings = a.findings.length ? `\n      ${a.findings.map((f) => `${f.severity} ${f.ruleId}: ${f.message}`).join("\n      ")}` : "";
  return `  ${a.id} ${a.kind}${cost} ${a.ventureId ?? ""} — ${a.summary}${findings}`;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      days: { type: "string" },
      seed: { type: "string" },
      data: { type: "string" },
      llm: { type: "string" },
      media: { type: "string" },
      quiet: { type: "boolean" },
      as: { type: "string" },
      note: { type: "string" },
      reason: { type: "string" },
      confirm: { type: "boolean" },
      json: { type: "boolean" },
    },
  });
  const [command = "help", ...rest] = positionals;
  const dataDir = resolve(values.data ?? ".factory");
  const who = values.as ?? "owner";

  if (command === "sim") {
    const days = Number(values.days ?? 120);
    const seed = Number(values.seed ?? 42);
    const llm = values.llm as "stub" | "gateway" | "anthropic" | undefined;
    const media = values.media as "stub" | "gateway" | undefined;
    const simDir = values.data ? dataDir : resolve(".factory-sim", `seed-${seed}`);
    if (existsSync(join(simDir, "state"))) rmSync(join(simDir, "state"), { recursive: true, force: true });
    mkdirSync(simDir, { recursive: true });
    const result = await runSimulation({
      days,
      seed,
      dataDir: simDir,
      config: { ...(llm ? { llm: { provider: llm } } : {}), ...(media ? { media: { provider: media } } : {}) },
      onTick: (s) => {
        if (!values.quiet) process.stdout.write(`day ${String(s.tick).padStart(3)} ${s.date} cash ${usd(s.cashCents).padStart(10)} · ${s.ventures.filter((v) => !["killed", "exited"].includes(v.stage)).length} active · ${s.awaitingApproval} approvals · ${s.openTasks} tasks${s.errors.length ? ` · ${s.errors.length} errors` : ""}\n`);
      },
    });
    if (values.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else printSimulation(result);
    process.stdout.write(`\nState, events and daily reports: ${simDir}\n`);
    return;
  }

  if (command === "init") {
    mkdirSync(dataDir, { recursive: true });
    const path = join(dataDir, "config.json");
    if (existsSync(path)) fail(`${path} exists`);
    const config = StudioConfig.parse({ mode: "live", dryRun: true, dataDir });
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
    process.stdout.write(`Wrote ${path} (live mode, dry-run on). Edit company details, then run \`factory tick\`.\n`);
    return;
  }

  if (command === "help" || command === "--help") {
    process.stdout.write(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0]?.replace(/^\/\*\*\n/, "").replace(/^ \* ?/gm, "") ?? "");
    return;
  }

  const config = loadConfig(dataDir);
  if (command === "stop") {
    writeFileSync(join(dataDir, config.autonomy.killSwitchFile), `stopped by ${who} at ${new Date().toISOString()}\n`);
    process.stdout.write("Kill switch on: no external action will run until `factory resume`.\n");
    return;
  }
  if (command === "resume") {
    rmSync(join(dataDir, config.autonomy.killSwitchFile), { force: true });
    process.stdout.write("Kill switch off.\n");
    return;
  }
  if (command === "go-live") {
    if (!values.confirm) fail("go-live sends real API writes (store submissions, payouts, ad spend); rerun with --confirm");
    writeFileSync(join(dataDir, "config.json"), `${JSON.stringify({ ...config, dryRun: false }, null, 2)}\n`);
    process.stdout.write("Dry-run off. Governance limits, approvals and the kill switch still apply.\n");
    return;
  }

  const { studio, store } = await createLiveStudio({ config, dataDir });
  const gov = studio.governance;
  try {
    switch (command) {
      case "tick": {
        const s = await studio.tick();
        process.stdout.write(s.skipped ? `Already ran ${s.date}.\n` : `Day ${s.tick} (${s.date}): ${s.executed} executed, ${s.awaitingApproval} awaiting approval, ${s.openTasks} human tasks. Report: ${s.reportPath}\n`);
        for (const p of s.phases) process.stdout.write(`  ${p.name}: ${p.error ? `ERROR ${p.error}` : p.detail}\n`);
        break;
      }
      case "status": {
        process.stdout.write(`Cash ${usd(studio.ledger.cash())} · free ${usd(studio.ledger.freeCash())} · kill switch ${gov.killSwitchActive() ? "ON" : "off"} · ${config.dryRun ? "dry-run" : "LIVE"}\n`);
        for (const v of store.ventures.list()) process.stdout.write(`  ${v.id} ${v.name} ${v.stage}${v.blockedOn.length ? ` (blocked on ${v.blockedOn.join(",")})` : ""}\n`);
        process.stdout.write(`${store.actions.count((a) => a.status === "awaiting_approval")} approvals, ${store.tasks.count((t) => t.status === "open")} human tasks\n`);
        break;
      }
      case "report": {
        const path = join(dataDir, "reports", "latest.md");
        process.stdout.write(existsSync(path) ? readFileSync(path, "utf8") : "No report yet; run `factory tick`.\n");
        break;
      }
      case "approvals":
        for (const a of gov.list({ status: ["awaiting_approval"] })) process.stdout.write(`${describeAction(a)}\n`);
        break;
      case "approve": {
        const id = rest[0] ?? fail("approve <action id>");
        const a = gov.approve(id, who, { channel: "cli", ...(values.note ? { note: values.note } : {}) });
        process.stdout.write(`${a.id} → ${a.status}\n`);
        break;
      }
      case "reject": {
        const id = rest[0] ?? fail("reject <action id> --reason TEXT");
        const a = gov.reject(id, who, values.reason ?? fail("--reason is required"));
        process.stdout.write(`${a.id} → ${a.status}\n`);
        break;
      }
      case "tasks":
        for (const t of gov.tasks({ status: ["open"] })) process.stdout.write(`  ${t.id} ${t.kind} ${t.ventureId ?? ""} — ${t.title}\n`);
        break;
      case "task": {
        const t = store.tasks.require(rest[0] ?? fail("task <task id>"));
        process.stdout.write(`${t.title}\n\n${t.instructions}\n\nInputs:\n${t.inputs.map((i) => `  ${i.key}: ${i.label}${i.pattern ? ` (${i.pattern})` : ""}`).join("\n")}\n`);
        break;
      }
      case "complete": {
        const id = rest[0] ?? fail("complete <task id> key=value ...");
        const outputs = Object.fromEntries(rest.slice(1).map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));
        const t = gov.completeTask(id, outputs, who);
        process.stdout.write(`${t.id} done\n`);
        break;
      }
      case "execute":
        process.stdout.write(`${await studio.executeApproved()} actions executed\n`);
        break;
      case "freeze":
        store.freeze({ scope: rest[0] ?? fail("freeze <scope> --reason TEXT"), reason: values.reason ?? fail("--reason is required"), at: new Date().toISOString(), by: who });
        process.stdout.write(`Frozen ${rest[0]}\n`);
        break;
      case "unfreeze":
        store.unfreeze(rest[0] ?? fail("unfreeze <scope>"));
        process.stdout.write(`Unfrozen ${rest[0]}\n`);
        break;
      default:
        fail(`unknown command ${command}; run \`factory help\``);
    }
    store.commit();
  } finally {
    store.close();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
