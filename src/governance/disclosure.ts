/**
 * Derived disclosure: AI and commercial labels are computed from the content's media
 * provenance and channel, never written by an LLM. Platform label payloads are a pure
 * function of the disclosure, and policy rejects any publish whose labels differ.
 * Citations: TikTok AIGC + branded content toggles, Instagram "AI info" + paid
 * partnership label, YouTube altered/synthetic content disclosure, FTC Endorsement Guides 255.5.
 */
import type { ContentPiece, Disclosure, Iso, Platform, PlatformLabels } from "../core/types.ts";

const PERSON = /\b(person|people|man|men|woman|women|girl|guy|boy|face|faces|selfie|selfies|portrait|headshot|influencer|model|human|someone|couple)\b/i;
const REALISTIC = /\b(photo|photos|photograph\w*|photoreal\w*|realistic|hyper-?real\w*|lifelike|life-like|real[- ]life|dslr|candid|cinematic still)\b/i;

function visualText(piece: ContentPiece): string {
  return [piece.draft.script, ...piece.draft.slides.flatMap((s) => [s.text, s.imagePrompt])].join("\n");
}

/** Disclosure for a content piece as of `now`. */
export function deriveDisclosure(piece: ContentPiece, now: Iso): Disclosure {
  const aiGenerated = piece.media.some((m) => m.aiGenerated);
  let aiRealism: Disclosure["aiRealism"] = "none";
  if (aiGenerated) {
    const text = visualText(piece);
    const realistic = REALISTIC.test(text);
    aiRealism = realistic && PERSON.test(text) ? "photorealistic_person" : realistic ? "photorealistic_scene" : "stylized";
  }
  return {
    aiGenerated,
    aiRealism,
    commercial: piece.channel === "creator_ugc" ? "paid_partnership" : "own_brand",
    derivedAt: now,
  };
}

/** The exact label payload a publish to `platform` must carry. */
export function labelsFor(platform: Platform, d: Disclosure): PlatformLabels {
  const paid = d.commercial === "paid_partnership";
  switch (platform) {
    case "tiktok":
      return { tiktok: { is_aigc: d.aiGenerated, brand_content_toggle: paid, brand_organic_toggle: d.commercial === "own_brand" } };
    case "instagram":
      return { instagram: { is_ai_generated: d.aiGenerated, is_paid_partnership: paid } };
    case "youtube":
      return {
        youtube: {
          containsSyntheticMedia: d.aiRealism !== "none" && d.aiRealism !== "stylized",
          selfDeclaredMadeForKids: false,
          hasPaidProductPlacement: paid,
        },
      };
    default:
      return { other: { aiLabelInCaption: d.aiGenerated, adLabelInCaption: paid } };
  }
}
