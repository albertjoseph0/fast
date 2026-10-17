/**
 * Image and video generation through the Vercel AI Gateway (AI SDK), plus a stub that
 * writes deterministic placeholder files for simulations and tests.
 *
 * Costs are conservative per-model estimates (gateway catalog, 2026-10): the gateway
 * returns no per-call price for media, so the estimate is what gets booked.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { createGateway } from "@ai-sdk/gateway";
import { experimental_generateVideo, generateImage } from "ai";
import type { StudioConfig } from "../config/schema.ts";
import type { CostMeter, MediaAsset, MediaPort } from "../core/ports.ts";
import type { Cents } from "../core/types.ts";
import { hashString } from "../core/rng.ts";

type ImageRequest = Parameters<MediaPort["image"]>[0];
type VideoRequest = Parameters<MediaPort["video"]>[0];

/** Cents per image at roughly 1024px and the quality a model defaults to. Unknown models use the fallback. */
export const IMAGE_CENTS: Readonly<Record<string, Cents>> = {
  "openai/gpt-image-2": 22,
  "openai/gpt-image-2.5-flare": 22,
  "openai/gpt-image-2.5-sunburst": 22,
  "openai/gpt-image-1.5": 20,
  "openai/gpt-image-1": 17,
  "openai/gpt-image-1-mini": 4,
  "google/gemini-3.1-flash-image": 7,
  "google/gemini-3.1-flash-lite-image": 4,
  "google/gemini-3-pro-image": 14,
  "bfl/flux-3-image": 5,
  "bfl/flux-kontext-pro": 4,
  "bfl/flux-kontext-max": 8,
  "bfl/flux-pro-1.1": 4,
  "bfl/flux-pro-1.1-ultra": 6,
  "bytedance/seedream-5.0-pro": 4,
  "bytedance/seedream-5.0-lite": 4,
  "meta/muse-image-1.0": 1,
  "recraft/recraft-v4.1": 8,
  "recraft/recraft-v4.1-flash": 1,
  "recraft/recraft-v4.1-pro": 30,
};
export const IMAGE_FALLBACK_CENTS: Cents = 25;

/** Cents per second at 1080p with audio. */
export const VIDEO_CENTS_PER_SECOND: Readonly<Record<string, number>> = {
  "google/veo-3.1-generate-001": 40,
  "google/veo-3.1-fast-generate-001": 15,
  "google/veo-3.1-lite-generate-001": 8,
  "google/veo-3.0-generate-001": 40,
  "google/veo-3.0-fast-generate-001": 15,
  "alibaba/wan-v3.0-video": 20,
  "alibaba/wan-v3.0-video-prime": 28,
  "minimax/minimax-h3": 13,
  "minimax/minimax-h3-max": 8,
  "klingai/kling-v3.0-t2v": 40,
  "klingai/kling-v2.6-t2v": 14,
  "bytedance/seedance-2.5": 60,
  "bytedance/seedance-2.0": 38,
};
export const VIDEO_FALLBACK_CENTS_PER_SECOND = 60;

export function imageCostCents(model: string): Cents {
  return IMAGE_CENTS[model] ?? IMAGE_FALLBACK_CENTS;
}

export function videoCostCents(model: string, seconds: number): Cents {
  return Math.ceil((VIDEO_CENTS_PER_SECOND[model] ?? VIDEO_FALLBACK_CENTS_PER_SECOND) * Math.max(0, seconds));
}

/** OpenAI and Google image/video models embed C2PA and/or SynthID provenance. */
export function embedsProvenance(model: string): boolean {
  return model.startsWith("openai/") || model.startsWith("google/");
}

/** Veo only renders 4, 6 or 8 second clips; other models take the requested length. */
export function clipSeconds(model: string, seconds: number): number {
  if (!model.startsWith("google/veo-")) return Math.max(1, Math.round(seconds));
  return [4, 6, 8].reduce((best, d) => (Math.abs(d - seconds) < Math.abs(best - seconds) ? d : best), 8);
}

type ImageSizing = { size: `${number}x${number}` } | { aspectRatio: `${number}:${number}` };

/** GPT Image models take explicit sizes (gpt-image-1 only three); the rest take an aspect ratio. */
export function imageSizing(model: string, aspect: ImageRequest["aspect"]): ImageSizing {
  if (model.startsWith("openai/gpt-image-1")) {
    return { size: aspect === "1:1" ? "1024x1024" : "1024x1536" };
  }
  if (model.startsWith("openai/")) {
    const sizes = { "1:1": "1024x1024", "9:16": "864x1536", "4:5": "1024x1280" } as const;
    return { size: sizes[aspect] };
  }
  return { aspectRatio: aspect };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeBytes(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

/** The AI SDK calls the gateway adapter makes; injectable for tests. */
export interface MediaSdk {
  generateImage: typeof generateImage;
  generateVideo: typeof experimental_generateVideo;
}

export interface MediaOptions {
  config: StudioConfig;
  meter: CostMeter;
  provider: "gateway" | "stub";
  env?: Record<string, string | undefined>;
  sdk?: MediaSdk;
}

export function createMedia(opts: MediaOptions): MediaPort {
  return opts.provider === "gateway" ? new GatewayMedia(opts) : new StubMedia();
}

const VIDEO_POLL = { intervalMs: 5_000, timeoutMs: 600_000 };

class GatewayMedia implements MediaPort {
  readonly kind = "gateway";
  private readonly config: StudioConfig;
  private readonly meter: CostMeter;
  private readonly gateway: ReturnType<typeof createGateway>;
  private readonly sdk: MediaSdk;

  constructor(opts: MediaOptions) {
    this.config = opts.config;
    this.meter = opts.meter;
    const env = opts.env ?? process.env;
    // In the sandbox a proxy injects the credential; the placeholder only satisfies the SDK.
    this.gateway = createGateway({ apiKey: env.AI_GATEWAY_API_KEY ?? "proxy-injected" });
    this.sdk = opts.sdk ?? { generateImage, generateVideo: experimental_generateVideo };
  }

  async image(req: ImageRequest): Promise<MediaAsset> {
    const model = this.config.media.imageModel;
    const cents = imageCostCents(model);
    this.meter.assertBudget("media", cents);
    const result = await this.sdk.generateImage({ model: this.gateway.imageModel(model), prompt: req.prompt, ...imageSizing(model, req.aspect) });
    const bytes = result.image.uint8Array;
    return this.finish(req, model, cents, bytes, result.image.mediaType || "image/png");
  }

  async video(req: VideoRequest): Promise<MediaAsset> {
    const model = this.config.media.videoModel;
    const seconds = clipSeconds(model, req.seconds);
    const cents = videoCostCents(model, seconds);
    this.meter.assertBudget("media", cents);
    const result = await this.sdk.generateVideo({
      model: this.gateway.videoModel(model),
      prompt: req.prompt,
      aspectRatio: req.aspect,
      duration: seconds,
      poll: VIDEO_POLL,
    });
    return this.finish(req, model, cents, result.video.uint8Array, result.video.mediaType || "video/mp4");
  }

  private async finish(req: ImageRequest | VideoRequest, model: string, cents: Cents, bytes: Uint8Array, mediaType: string): Promise<MediaAsset> {
    await writeBytes(req.outPath, bytes);
    const hash = sha256(bytes);
    this.meter.charge({
      kind: "media",
      ...(req.ventureId ? { ventureId: req.ventureId } : {}),
      cents,
      model,
      purpose: req.purpose,
      ref: `media:${req.outPath}:${hash.slice(0, 16)}`,
    });
    return { path: req.outPath, mediaType, bytes: bytes.byteLength, sha256: hash, model, costCents: cents, aiGenerated: true, c2pa: embedsProvenance(model) };
  }
}

// ---------------------------------------------------------------------------
// Stub
// ---------------------------------------------------------------------------

const STUB_DIMENSIONS: Record<ImageRequest["aspect"], [number, number]> = {
  "1:1": [64, 64],
  "9:16": [36, 64],
  "4:5": [51, 64],
};

function pngChunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A valid solid-color RGB PNG. */
export function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolor RGB
  const row = Buffer.alloc(1 + width * 3); // filter byte 0, then pixels
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
}

function promptColor(prompt: string): [number, number, number] {
  const h = hashString(prompt) >>> 0;
  return [(h >>> 16) & 0xff, (h >>> 8) & 0xff, h & 0xff];
}

class StubMedia implements MediaPort {
  readonly kind = "stub";

  async image(req: ImageRequest): Promise<MediaAsset> {
    const [w, h] = STUB_DIMENSIONS[req.aspect];
    const bytes = solidPng(w, h, promptColor(req.prompt));
    await writeBytes(req.outPath, bytes);
    return { path: req.outPath, mediaType: "image/png", bytes: bytes.byteLength, sha256: sha256(bytes), model: "stub/solid-png", costCents: 0, aiGenerated: true, c2pa: false };
  }

  async video(req: VideoRequest): Promise<MediaAsset> {
    const path = `${req.outPath}.json`;
    const shots = Math.max(1, Math.ceil(req.seconds / 3));
    const storyboard = {
      kind: "stub_storyboard",
      prompt: req.prompt,
      seconds: req.seconds,
      aspect: req.aspect,
      shots: Array.from({ length: shots }, (_, i) => ({
        index: i,
        startSecond: Math.min(req.seconds, i * 3),
        endSecond: Math.min(req.seconds, (i + 1) * 3),
        description: i === 0 ? `Hook: ${req.prompt}` : `Shot ${i + 1} continuing: ${req.prompt}`,
      })),
    };
    const bytes = Buffer.from(`${JSON.stringify(storyboard, null, 2)}\n`, "utf8");
    await writeBytes(path, bytes);
    return { path, mediaType: "application/json", bytes: bytes.byteLength, sha256: sha256(bytes), model: "stub/storyboard", costCents: 0, aiGenerated: true, c2pa: false };
  }
}
