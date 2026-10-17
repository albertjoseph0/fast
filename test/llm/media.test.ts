import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, inflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../../src/config/schema.ts";
import { clipSeconds, createMedia, imageCostCents, imageSizing, videoCostCents, type MediaSdk } from "../../src/llm/media.ts";
import { FakeMeter } from "./fixtures.ts";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "llm-media-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Png {
  width: number;
  height: number;
  pixels: Buffer;
}

/** Minimal PNG reader that verifies the signature, every chunk CRC and the pixel payload size. */
function readPng(bytes: Buffer): Png {
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let at = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  const types: string[] = [];
  while (at < bytes.length) {
    const len = bytes.readUInt32BE(at);
    const type = bytes.toString("ascii", at + 4, at + 8);
    const data = bytes.subarray(at + 8, at + 8 + len);
    expect(bytes.readUInt32BE(at + 8 + len)).toBe(crc32(bytes.subarray(at + 4, at + 8 + len)));
    types.push(type);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      expect([data[8], data[9]]).toEqual([8, 2]);
    }
    if (type === "IDAT") idat.push(Buffer.from(data));
    at += 12 + len;
  }
  expect(types[0]).toBe("IHDR");
  expect(types.at(-1)).toBe("IEND");
  const pixels = inflateSync(Buffer.concat(idat));
  expect(pixels.length).toBe(height * (1 + width * 3));
  return { width, height, pixels };
}

describe("stub media", () => {
  const media = createMedia({ config: defaultConfig(), meter: new FakeMeter(), provider: "stub" });

  it.each([
    ["1:1", 64, 64],
    ["9:16", 36, 64],
    ["4:5", 51, 64],
  ] as const)("writes a valid solid-color %s PNG with its sha256", async (aspect, w, h) => {
    const outPath = join(dir, "nested", aspect.replace(":", "x"), "slide.png");
    const asset = await media.image({ prompt: "a purple zodiac card", aspect, outPath, purpose: "test" });
    const bytes = await readFile(outPath);
    const png = readPng(bytes);
    expect([png.width, png.height]).toEqual([w, h]);
    const first = png.pixels.subarray(1, 4);
    const last = png.pixels.subarray(png.pixels.length - 3);
    expect(first.equals(last)).toBe(true);
    expect(asset).toEqual({
      path: outPath,
      mediaType: "image/png",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      model: "stub/solid-png",
      costCents: 0,
      aiGenerated: true,
      c2pa: false,
    });
  });

  it("derives the color from the prompt deterministically", async () => {
    const a = await media.image({ prompt: "one", aspect: "1:1", outPath: join(dir, "a.png"), purpose: "t" });
    const b = await media.image({ prompt: "one", aspect: "1:1", outPath: join(dir, "b.png"), purpose: "t" });
    const c = await media.image({ prompt: "two", aspect: "1:1", outPath: join(dir, "c.png"), purpose: "t" });
    expect(a.sha256).toBe(b.sha256);
    expect(c.sha256).not.toBe(a.sha256);
  });

  it("writes a JSON storyboard for video next to the requested path", async () => {
    const outPath = join(dir, "hook.mp4");
    const asset = await media.video({ prompt: "a hook clip", seconds: 8, aspect: "9:16", outPath, purpose: "test" });
    expect(asset.path).toBe(`${outPath}.json`);
    expect(asset.mediaType).toBe("application/json");
    expect(asset.costCents).toBe(0);
    const board = JSON.parse(await readFile(asset.path, "utf8"));
    expect(board).toMatchObject({ kind: "stub_storyboard", prompt: "a hook clip", seconds: 8, aspect: "9:16" });
    expect(board.shots.length).toBe(3);
  });
});

describe("gateway media", () => {
  function fakeSdk() {
    const image = new Uint8Array([1, 2, 3, 4]);
    const video = new Uint8Array([9, 9, 9]);
    const sdk = {
      generateImage: vi.fn(async () => ({ image: { uint8Array: image, mediaType: "image/png", base64: "" } })),
      generateVideo: vi.fn(async () => ({ video: { uint8Array: video, mediaType: "video/mp4", base64: "" } })),
    };
    return { sdk: sdk as unknown as MediaSdk, mocks: sdk, image, video };
  }

  it("generates an image, writes it, books the estimate and flags provenance", async () => {
    const meter = new FakeMeter();
    const { sdk, mocks, image } = fakeSdk();
    const config = defaultConfig({ media: { provider: "gateway", imageModel: "openai/gpt-image-2" } });
    const media = createMedia({ config, meter, provider: "gateway", env: { AI_GATEWAY_API_KEY: "test" }, sdk });
    const outPath = join(dir, "gw", "img.png");
    const asset = await media.image({ prompt: "card", aspect: "9:16", outPath, ventureId: "ven_000001", purpose: "slide" });
    const arg = (mocks.generateImage.mock.calls[0] as unknown[] | undefined)?.[0] as { prompt: string; size?: string; aspectRatio?: string };
    expect(arg.prompt).toBe("card");
    expect(arg.size).toBe("864x1536");
    expect(arg.aspectRatio).toBeUndefined();
    expect(new Uint8Array(await readFile(outPath))).toEqual(image);
    expect(asset.c2pa).toBe(true);
    expect(asset.costCents).toBe(imageCostCents("openai/gpt-image-2"));
    expect(meter.asserts).toEqual([{ kind: "media", estimateCents: asset.costCents }]);
    expect(meter.charges).toHaveLength(1);
    expect(meter.charges[0]).toMatchObject({ kind: "media", ventureId: "ven_000001", cents: asset.costCents, model: "openai/gpt-image-2", purpose: "slide" });
  });

  it("generates video through a polled gateway job with a supported clip length", async () => {
    const meter = new FakeMeter();
    const { sdk, mocks } = fakeSdk();
    const config = defaultConfig({ media: { provider: "gateway" } });
    const media = createMedia({ config, meter, provider: "gateway", env: {}, sdk });
    const asset = await media.video({ prompt: "hook", seconds: 7, aspect: "9:16", outPath: join(dir, "gw", "v.mp4"), purpose: "hook" });
    const arg = (mocks.generateVideo.mock.calls[0] as unknown[] | undefined)?.[0] as { aspectRatio: string; duration: number; poll: unknown };
    expect(arg.aspectRatio).toBe("9:16");
    expect(arg.duration).toBe(8);
    expect(arg.poll).toEqual({ intervalMs: 5_000, timeoutMs: 600_000 });
    expect(asset.model).toBe("google/veo-3.1-fast-generate-001");
    expect(asset.costCents).toBe(videoCostCents("google/veo-3.1-fast-generate-001", 8));
    expect(asset.costCents).toBe(120);
    expect(asset.c2pa).toBe(true);
    expect(asset.mediaType).toBe("video/mp4");
  });

  it("stops before generating when the media budget is spent", async () => {
    const meter = new FakeMeter();
    meter.failWith = new Error("daily media budget exceeded");
    const { sdk, mocks } = fakeSdk();
    const media = createMedia({ config: defaultConfig(), meter, provider: "gateway", env: {}, sdk });
    await expect(media.image({ prompt: "x", aspect: "1:1", outPath: join(dir, "no.png"), purpose: "t" })).rejects.toThrow("budget");
    expect(mocks.generateImage).not.toHaveBeenCalled();
  });

  it("maps sizes, clip lengths and provenance per model family", () => {
    expect(imageSizing("openai/gpt-image-1-mini", "4:5")).toEqual({ size: "1024x1536" });
    expect(imageSizing("google/gemini-3.1-flash-image", "4:5")).toEqual({ aspectRatio: "4:5" });
    expect(clipSeconds("google/veo-3.1-lite-generate-001", 5)).toBe(4);
    expect(clipSeconds("minimax/minimax-h3", 12.4)).toBe(12);
    expect(imageCostCents("unknown/model")).toBe(25);
    expect(createMedia({ config: defaultConfig({ media: { imageModel: "bfl/flux-3-image" } }), meter: new FakeMeter(), provider: "stub" }).kind).toBe("stub");
  });
});
