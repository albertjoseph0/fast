/**
 * Brand: the app icon, generated from the designer's icon prompt. Generated media is
 * always marked AI-generated and keeps its provenance metadata.
 */
import { join } from "node:path";
import type { AgentContext } from "../core/context.ts";
import type { AppSpec, MediaRef } from "../core/types.ts";

const ICON_RULES = "Square iOS app icon, full-bleed, one bold centered symbol, flat colors, no text, no letters, no logos of other brands, no photos of people.";

/** Generate `${outDir}/icon.png` (1:1) from spec.brand.iconPrompt. */
export async function produceIcon(ctx: AgentContext, opts: { ventureId: string; spec: AppSpec; outDir: string }): Promise<MediaRef> {
  const { brand } = opts.spec;
  const asset = await ctx.ports.media.image({
    prompt: `${brand.iconPrompt.trim()}. Colors: ${brand.primaryColor} and ${brand.accentColor} on ${brand.backgroundColor}. ${ICON_RULES}`,
    aspect: "1:1",
    outPath: join(opts.outDir, "icon.png"),
    ventureId: opts.ventureId,
    purpose: "icon",
  });
  return { localPath: asset.path, sha256: asset.sha256, mediaType: asset.mediaType, aiGenerated: true, c2pa: asset.c2pa };
}
