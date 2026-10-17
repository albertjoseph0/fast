/**
 * Live smoke tests against the Vercel AI Gateway. Skipped unless LIVE_LLM=1; in this
 * sandbox run with NODE_USE_ENV_PROXY=1 so Node's fetch uses the auth-injecting proxy:
 *   LIVE_LLM=1 NODE_USE_ENV_PROXY=1 npx vitest run test/llm/live.test.ts
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SCHEMAS } from "../../src/agents/schemas.ts";
import { SystemClock } from "../../src/core/clock.ts";
import { defaultConfig } from "../../src/config/schema.ts";
import { createClaudeLlm } from "../../src/llm/claude.ts";
import { createMedia } from "../../src/llm/media.ts";
import { FakeMeter, archetypeIdea, objectRequest } from "./fixtures.ts";

describe.skipIf(process.env.LIVE_LLM !== "1")("live gateway", () => {
  it("returns a schema-valid Critique", async () => {
    const meter = new FakeMeter();
    const config = defaultConfig({ mode: "live", llm: { provider: "gateway" } });
    const llm = createClaudeLlm({ config, meter, clock: new SystemClock(), provider: "gateway", env: process.env });
    const critique = await llm.object(
      objectRequest(
        "Critique",
        { idea: archetypeIdea("Leafy"), lens: "growth_realist" },
        {
          role: "critic",
          effort: "low",
          maxTokens: 4000,
          system: "You are a skeptical growth reviewer for a consumer app studio.",
          instructions: "Critique the idea in <input> through the requested lens. Score 0..10. Keep each list to at most three short items.",
        },
      ),
    );
    expect(SCHEMAS.Critique.safeParse(critique).success).toBe(true);
    expect(critique.lens).toBe("growth_realist");
    expect(llm.usage().calls).toBeGreaterThanOrEqual(1);
    expect(meter.charges[0]?.cents).toBeGreaterThanOrEqual(1);
  }, 180_000);

  it("generates a small image", async () => {
    const dir = await mkdtemp(join(tmpdir(), "llm-live-"));
    try {
      const config = defaultConfig({ media: { provider: "gateway", imageModel: "openai/gpt-image-1-mini" } });
      const media = createMedia({ config, meter: new FakeMeter(), provider: "gateway", env: process.env });
      const asset = await media.image({ prompt: "A flat purple circle on a white background", aspect: "1:1", outPath: join(dir, "live.png"), purpose: "live_test" });
      const bytes = await readFile(asset.path);
      expect(bytes.length).toBe(asset.bytes);
      expect(asset.bytes).toBeGreaterThan(1000);
      expect(asset.c2pa).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
