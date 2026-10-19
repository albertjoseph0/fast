/**
 * App Store screenshots: deterministic 1290x2796 SVGs (6.9" iPhone) with the caption, brand
 * colours and a stylised phone showing the app's screens, rasterized to opaque RGB PNGs
 * (App Store Connect accepts PNG/JPEG only, at exact sizes, without transparency).
 */
import { crc32, deflateSync } from "node:zlib";
import { Resvg } from "@resvg/resvg-js";
import type { AppSpec } from "../core/types.ts";
import { escapeXml } from "./privacy.ts";

export const SCREENSHOT_SIZE = { width: 1290, height: 2796 } as const;

const FONT = "Inter, 'Helvetica Neue', Helvetica, Arial, sans-serif";
const W = SCREENSHOT_SIZE.width;
const H = SCREENSHOT_SIZE.height;
const PHONE = { x: 165, y: 860, w: 960, h: 1990, r: 130, bezel: 28 };
const SCREEN = { x: PHONE.x + PHONE.bezel, y: PHONE.y + PHONE.bezel, w: PHONE.w - 2 * PHONE.bezel, h: PHONE.h - 2 * PHONE.bezel, r: PHONE.r - PHONE.bezel };

export interface Palette {
  primary: string;
  accent: string;
  background: string;
  text: string;
}

function hex(value: string, fallback: string): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!m?.[1]) return fallback;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return `#${h.toLowerCase()}`;
}

function luminance(color: string): number {
  const n = Number.parseInt(color.slice(1), 16);
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Brand colours, sanitized (LLM-written strings never reach the SVG raw) and contrast-safe. */
export function palette(spec: AppSpec): Palette {
  const background = hex(spec.brand.backgroundColor, "#ffffff");
  const primary = hex(spec.brand.primaryColor, "#222222");
  const accent = hex(spec.brand.accentColor, "#3355ff");
  const wanted = hex(spec.brand.textColor, "#111111");
  const text = contrast(wanted, background) >= 4.5 ? wanted : luminance(background) > 0.4 ? "#111111" : "#ffffff";
  return { primary, accent, background, text };
}

/** Greedy word wrap by an average glyph width; long words are hard-split. */
export function wrap(text: string, maxChars: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.trim().split(/\s+/).filter(Boolean)) {
    let w = word;
    while (w.length > maxChars) {
      if (line) lines.push(line);
      lines.push(w.slice(0, maxChars));
      line = "";
      w = w.slice(maxChars);
    }
    if (!line) line = w;
    else if (line.length + 1 + w.length <= maxChars) line = `${line} ${w}`;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function fitLines(text: string, width: number, sizes: number[], maxLines: number): { size: number; lines: string[] } {
  for (const size of sizes) {
    const lines = wrap(text, Math.floor(width / (size * 0.56)));
    if (lines.length <= maxLines) return { size, lines };
  }
  const size = sizes[sizes.length - 1] ?? 64;
  const lines = wrap(text, Math.floor(width / (size * 0.56)));
  const kept = lines.slice(0, maxLines);
  if (lines.length > maxLines && kept.length) kept[kept.length - 1] = `${kept[kept.length - 1]}…`;
  return { size, lines: kept };
}

function textBlock(lines: string[], x: number, y: number, size: number, attrs: string): string {
  const tspans = lines.map((l, i) => `<tspan x="${x}" y="${y + i * Math.round(size * 1.18)}">${escapeXml(l)}</tspan>`).join("");
  return `<text font-family="${FONT}" font-size="${size}" ${attrs}>${tspans}</text>`;
}

function bars(x: number, y: number, widths: number[], color: string): string {
  return widths.map((w, i) => `<rect x="${x}" y="${y + i * 40}" width="${w}" height="20" rx="10" fill="${color}" opacity="0.28"/>`).join("");
}

function resultScreen(spec: AppSpec, p: Palette): string {
  const left = SCREEN.x + 64;
  const width = SCREEN.w - 128;
  const head = fitLines(spec.share.cardHeadline, width, [64, 56, 48], 2);
  let y = SCREEN.y + 260 + head.lines.length * 70;
  const out = [textBlock(head.lines, left, SCREEN.y + 260, head.size, `font-weight="700" fill="${p.text}"`)];
  for (const [i, section] of spec.core.outputSections.slice(0, 4).entries()) {
    out.push(
      `<rect x="${left}" y="${y}" width="${width}" height="260" rx="40" fill="${i === 0 ? p.primary : p.text}" opacity="${i === 0 ? 0.9 : 0.08}"/>`,
      textBlock(fitLines(section, width - 96, [44, 38], 1).lines, left + 48, y + 80, 44, `font-weight="700" fill="${i === 0 ? contrastOn(p.primary) : p.text}"`),
      bars(left + 48, y + 130, [width - 140, width - 260, width - 380], i === 0 ? contrastOn(p.primary) : p.text),
    );
    y += 300;
  }
  return out.join("");
}

function inputScreen(spec: AppSpec, p: Palette): string {
  const left = SCREEN.x + 64;
  const width = SCREEN.w - 128;
  const label = fitLines(spec.core.inputLabel, width, [64, 56, 48], 3);
  const top = SCREEN.y + 260;
  const boxY = top + label.lines.length * 76 + 40;
  return [
    textBlock(label.lines, left, top, label.size, `font-weight="700" fill="${p.text}"`),
    `<rect x="${left}" y="${boxY}" width="${width}" height="760" rx="48" fill="${p.text}" opacity="0.07"/>`,
    `<rect x="${left}" y="${boxY}" width="${width}" height="760" rx="48" fill="none" stroke="${p.accent}" stroke-width="6" stroke-dasharray="24 18"/>`,
    `<circle cx="${left + width / 2}" cy="${boxY + 330}" r="90" fill="${p.accent}" opacity="0.9"/>`,
    `<rect x="${left + width / 2 - 12}" y="${boxY + 280}" width="24" height="100" rx="12" fill="${contrastOn(p.accent)}"/>`,
    `<rect x="${left + width / 2 - 50}" y="${boxY + 318}" width="100" height="24" rx="12" fill="${contrastOn(p.accent)}"/>`,
    bars(left + 120, boxY + 500, [width - 240, width - 360], p.text),
    `<rect x="${left}" y="${SCREEN.y + SCREEN.h - 300}" width="${width}" height="140" rx="70" fill="${p.accent}"/>`,
  ].join("");
}

function shareScreen(spec: AppSpec, p: Palette): string {
  const left = SCREEN.x + 80;
  const width = SCREEN.w - 160;
  const top = SCREEN.y + 280;
  const head = fitLines(spec.share.cardHeadline, width - 120, [72, 60, 52], 3);
  const mark = spec.share.watermark.trim() || spec.appName;
  return [
    `<rect x="${left}" y="${top}" width="${width}" height="1250" rx="56" fill="${p.primary}"/>`,
    `<rect x="${left}" y="${top}" width="${width}" height="1250" rx="56" fill="none" stroke="${p.accent}" stroke-width="10"/>`,
    textBlock(head.lines, left + 60, top + 170, head.size, `font-weight="800" fill="${contrastOn(p.primary)}"`),
    bars(left + 60, top + 520, [width - 120, width - 220, width - 160, width - 300, width - 200], contrastOn(p.primary)),
    `<circle cx="${left + width / 2}" cy="${top + 960}" r="110" fill="${p.accent}"/>`,
    textBlock(fitLines(mark, width - 120, [40, 34], 1).lines, left + 60, top + 1190, 40, `font-weight="600" fill="${contrastOn(p.primary)}" opacity="0.85"`),
  ].join("");
}

function contrastOn(color: string): string {
  return luminance(color) > 0.4 ? "#111111" : "#ffffff";
}

const SCREENS = [resultScreen, inputScreen, shareScreen] as const;

/** One SVG per screenshot caption, in caption order. */
export function screenshotSvgs(spec: AppSpec): { name: string; svg: string; caption: string }[] {
  const p = palette(spec);
  return spec.aso.screenshotCaptions.map((caption, i) => {
    const cap = fitLines(caption, W - 220, [120, 104, 92, 80], 3);
    const capTop = 300 + (3 - cap.lines.length) * Math.round(cap.size * 0.55);
    const screen = SCREENS[i % SCREENS.length] ?? resultScreen;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.background}"/><stop offset="1" stop-color="${p.primary}"/></linearGradient>
<clipPath id="screen"><rect x="${SCREEN.x}" y="${SCREEN.y}" width="${SCREEN.w}" height="${SCREEN.h}" rx="${SCREEN.r}"/></clipPath>
</defs>
<rect width="${W}" height="${H}" fill="url(#bg)"/>
<circle cx="${W + 20}" cy="40" r="240" fill="${p.accent}" opacity="0.18"/>
${textBlock(cap.lines, W / 2, capTop, cap.size, `font-weight="800" fill="${p.text}" text-anchor="middle"`)}
<rect x="${PHONE.x - 6}" y="${PHONE.y - 6}" width="${PHONE.w + 12}" height="${PHONE.h + 12}" rx="${PHONE.r + 6}" fill="${p.accent}" opacity="0.35"/>
<rect x="${PHONE.x}" y="${PHONE.y}" width="${PHONE.w}" height="${PHONE.h}" rx="${PHONE.r}" fill="#0b0b0f"/>
<g clip-path="url(#screen)">
<rect x="${SCREEN.x}" y="${SCREEN.y}" width="${SCREEN.w}" height="${SCREEN.h}" fill="${p.background}"/>
${textBlock([spec.appName], SCREEN.x + 64, SCREEN.y + 150, 44, `font-weight="700" fill="${p.accent}"`)}
${screen(spec, p)}
</g>
<rect x="${W / 2 - 120}" y="${SCREEN.y + 26}" width="240" height="70" rx="35" fill="#000000"/>
</svg>
`;
    return { name: String(i + 1), svg, caption };
  });
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

/** Opaque 8-bit RGB PNG from RGBA pixels, composited over white (no alpha channel). */
export function encodeRgbPng(rgba: Buffer, width: number, height: number): Buffer {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      const d = y * stride + 1 + x * 3;
      const a = (rgba[s + 3] ?? 255) / 255;
      raw[d] = Math.round((rgba[s] ?? 0) * a + 255 * (1 - a));
      raw[d + 1] = Math.round((rgba[s + 1] ?? 0) * a + 255 * (1 - a));
      raw[d + 2] = Math.round((rgba[s + 2] ?? 0) * a + 255 * (1 - a));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Rasterize with system fonts, falling back to the generic sans-serif family. */
export function rasterize(svg: string): Buffer {
  const image = new Resvg(svg, {
    font: { loadSystemFonts: true, defaultFontFamily: "sans-serif" },
    fitTo: { mode: "original" },
    background: "#ffffff",
    logLevel: "off",
  }).render();
  return encodeRgbPng(image.pixels, image.width, image.height);
}

/** Width, height and colour type from a PNG's IHDR, or null if it is not a PNG. */
export function pngInfo(png: Buffer): { width: number; height: number; colorType: number } | null {
  if (png.length < 26 || png.readUInt32BE(0) !== 0x89504e47 || png.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20), colorType: png.readUInt8(25) };
}
