/**
 * Content: short-form drafts for owned accounts, attention probes and creator references,
 * and slide rendering. Owned accounts never pose as a person, so first-person creator
 * voice is only allowed in creator references; any draft whose copy fails the lint is dropped.
 */
import { join } from "node:path";
import type { AgentContext } from "../core/context.ts";
import type { AppSpec, ContentDraft, Idea, MediaRef, Platform } from "../core/types.ts";
import { formatSummaries } from "../playbook/formats.ts";
import { lintCopyAll } from "../principles/copy.ts";
import { SCHEMA, type SchemaInputs } from "./schemas.ts";
import { hasBlock, rolePrompt } from "./shared.ts";

export type ContentPurpose = SchemaInputs["ContentBatch"]["purpose"];

const OWNED_PURPOSES: readonly ContentPurpose[] = ["attention_probe", "owned_post"];
const ALL_VOICES: ContentDraft["voice"][] = ["brand_third_person", "product_demo", "creator_first_person"];
const OWNED_VOICES: ContentDraft["voice"][] = ["brand_third_person", "product_demo"];
const SLIDE_RULES = "Vertical social slide image. No text, no logos, no watermarks, no real or famous people.";

const SYSTEM = rolePrompt(
  "You are the content lead of an app studio. You write short-form slideshows and video scripts that make people install a single-player AI verdict app.",
  [
    "Use only the formats in the input and set formatId to one of their ids. Build on the top hooks; vary the angle across drafts.",
    "The hook is the first 1-2 seconds or the first slide and must stop the scroll. Reveal the app mid-carousel (isAppReveal) on the verdict moment.",
    "Use only the voices in allowedVoices. Brand and demo voices speak as the app, never as a person with a life story.",
    "No user counts, ratings, rankings, testimonials, prices, currency, trial lengths, income or health promises, and no fake urgency, anywhere in hooks, slides, scripts or captions.",
    "Slide text is at most 140 characters. Image prompts describe stylized scenes or the app screen; avoid photorealistic people.",
    "Never ask viewers to like, follow, comment or share for a reward.",
  ],
  { playbook: true },
);

/** Draft content for a venture; drafts in a disallowed voice or with blocked copy are dropped. */
export async function draftContent(
  ctx: AgentContext,
  opts: { ventureId: string; idea: Idea; spec?: AppSpec; purpose: ContentPurpose; platform: Platform; count: number; hooks: string[] },
): Promise<ContentDraft[]> {
  const { idea, spec } = opts;
  const owned = OWNED_PURPOSES.includes(opts.purpose);
  const allowedVoices = owned ? OWNED_VOICES : ALL_VOICES;
  const batch = await ctx.ports.llm.object({
    role: "content",
    schemaName: SCHEMA.contentBatch,
    system: SYSTEM,
    instructions: `Write ${opts.count} ${opts.platform} drafts for ${opts.purpose.replace(/_/g, " ")}.`,
    input: {
      purpose: opts.purpose,
      platform: opts.platform,
      count: opts.count,
      product: {
        name: spec?.appName ?? idea.title,
        oneLiner: idea.oneLiner,
        verdictMoment: idea.verdictMoment,
        shareArtifact: spec?.share.artifact ?? idea.shareArtifact,
        wedge: idea.wedge.name,
      },
      formats: formatSummaries({ platform: opts.platform, channel: owned ? "owned" : "creator" }),
      topHooks: opts.hooks,
      allowedVoices,
    },
    ventureId: opts.ventureId,
    purpose: `content_${opts.purpose}`,
  });
  return batch.drafts
    .filter((d) => allowedVoices.includes(d.voice))
    .filter((d) => !hasBlock(draftFindings(d)))
    .slice(0, opts.count)
    .map((d) => ({ ...d, platform: opts.platform }));
}

function draftFindings(d: ContentDraft) {
  return lintCopyAll(
    [
      { text: d.hook, path: "hook" },
      { text: d.caption, path: "caption" },
      { text: d.script, path: "script" },
      { text: d.callToAction, path: "callToAction" },
      ...d.slides.map((s, i) => ({ text: s.text, path: `slides[${i}].text` })),
    ],
    "content",
  );
}

/** One 9:16 image per slide, up to maxSlides, written to `${outDir}/slide-N.png`. */
export async function renderDraft(
  ctx: AgentContext,
  opts: { ventureId: string; draft: ContentDraft; outDir: string; maxSlides: number },
): Promise<MediaRef[]> {
  const out: MediaRef[] = [];
  const slides = opts.draft.slides.slice(0, Math.max(0, opts.maxSlides));
  for (const [i, slide] of slides.entries()) {
    const asset = await ctx.ports.media.image({
      prompt: `${slide.imagePrompt.trim()}. ${SLIDE_RULES}`,
      aspect: "9:16",
      outPath: join(opts.outDir, `slide-${i + 1}.png`),
      ventureId: opts.ventureId,
      purpose: "content_slide",
    });
    out.push({ localPath: asset.path, sha256: asset.sha256, mediaType: asset.mediaType, aiGenerated: true, c2pa: asset.c2pa });
  }
  return out;
}
