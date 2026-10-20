import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SimClock } from "../../src/core/clock.ts";
import { LockHeldError, StudioStore } from "../../src/core/store.ts";

function stateDir(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "fast-lock-")), "state");
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("studio state lock", () => {
  it("refuses a second writer while the first holds the lock, and releases it on close", () => {
    const dir = stateDir();
    const first = new StudioStore(dir, new SimClock());
    expect(() => new StudioStore(dir, new SimClock())).toThrow(LockHeldError);
    first.close();
    new StudioStore(dir, new SimClock()).close();
  });

  it("takes over a lock left by a process that no longer exists", () => {
    const dir = stateDir();
    // Pids are capped well below this on Linux and macOS, so no live process has it.
    writeFileSync(join(dir, "LOCK"), JSON.stringify({ pid: 2 ** 30, at: "2026-01-05T09:00:00.000Z" }));
    const store = new StudioStore(dir, new SimClock());
    store.close();
  });

  it("keeps a lock it cannot read: a writer may be creating it", () => {
    const dir = stateDir();
    writeFileSync(join(dir, "LOCK"), "");
    expect(() => new StudioStore(dir, new SimClock())).toThrow(LockHeldError);
  });
});
