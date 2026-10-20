import { describe, expect, it } from "vitest";
import { produceIcon } from "../../src/agents/brand.ts";
import { draftContent, renderDraft } from "../../src/agents/content.ts";
import type { ContentDraft } from "../../src/core/types.ts";
import { FakeLlm, FakeMedia, agentContext, astra, astraSpec } from "./fixtures.ts";

function draft(overrides: Partial<ContentDraft> = {}): ContentDraft {
  return {
    formatId: "slideshow_verdict",
    platform: "tiktok",
    voice: "brand_third_person",
    hook: "Your moon sign explains your texting",
    angle: "texting",
    script: "",
    slides: [
      { text: "Your moon sign explains your texting", imagePrompt: "Stylized phone with chat bubbles", isAppReveal: false },
      { text: "Astra reads your big three", imagePrompt: "App screen showing a chart", isAppReveal: true },
      { text: "Try it on yours", imagePrompt: "Night sky", isAppReveal: false },
    ],
    caption: "Which moon are you?",
    hashtags: ["astrology"],
    callToAction: "Link in bio",
    ...overrides,
  };
}

const base = { ventureId: "ven_000001", idea: astra(), platform: "instagram" as const, count: 5, hooks: ["Your moon sign explains your texting"] };

describe("draftContent", () => {
  it("drops creator first-person voice from owned purposes and forces the requested platform", async () => {
    const llm = new FakeLlm({
      ContentBatch: () => ({
        drafts: [draft({ angle: "a" }), draft({ angle: "b", voice: "creator_first_person" }), draft({ angle: "c", voice: "product_demo" })],
      }),
    });
    const out = await draftContent(agentContext({ llm }), { ...base, purpose: "owned_post" });
    expect(out.map((d) => d.angle)).toEqual(["a", "c"]);
    expect(out.every((d) => d.platform === "instagram")).toBe(true);

    const req = llm.calls("ContentBatch")[0];
    expect(req?.role).toBe("content");
    expect(req?.ventureId).toBe("ven_000001");
    expect(req?.input.allowedVoices).not.toContain("creator_first_person");
    expect(req?.input.formats.length).toBeGreaterThan(0);
    expect(req?.input.formats.every((f) => f.platforms.includes("instagram"))).toBe(true);
    expect(req?.input.product.name).toBe("Astra");
    expect(req?.input.topHooks).toEqual(base.hooks);
  });

  it("drops first-person voice for attention probes but keeps it for creator references", async () => {
    const handlers = { ContentBatch: () => ({ drafts: [draft({ voice: "creator_first_person" })] }) };
    expect(await draftContent(agentContext({ llm: new FakeLlm(handlers) }), { ...base, purpose: "attention_probe" })).toEqual([]);
    const llm = new FakeLlm(handlers);
    const ref = await draftContent(agentContext({ llm }), { ...base, purpose: "creator_reference", spec: astraSpec() });
    expect(ref).toHaveLength(1);
    expect(llm.calls("ContentBatch")[0]?.input.allowedVoices).toContain("creator_first_person");
    expect(llm.calls("ContentBatch")[0]?.input.product.shareArtifact).toBe(astraSpec().share.artifact);
  });

  it("drops drafts whose hook, caption, slides or hashtags fail the copy lint, and caps at count", async () => {
    const llm = new FakeLlm({
      ContentBatch: () => ({
        drafts: [
          draft({ angle: "hook", hook: "Join 2 million users reading their charts" }),
          draft({ angle: "caption", caption: "Only $4.99 a week" }),
          draft({ angle: "slide", slides: [{ text: "Rated 5 stars", imagePrompt: "x", isAppReveal: true }] }),
          draft({ angle: "hashtag", hashtags: ["astrology", "1 million users"] }),
          draft({ angle: "ok1" }),
          draft({ angle: "ok2" }),
          draft({ angle: "ok3" }),
        ],
      }),
    });
    const out = await draftContent(agentContext({ llm }), { ...base, purpose: "owned_post", count: 2 });
    expect(out.map((d) => d.angle)).toEqual(["ok1", "ok2"]);
  });
});

describe("renderDraft", () => {
  it("renders one 9:16 image per slide up to maxSlides as AI-generated media", async () => {
    const media = new FakeMedia();
    const refs = await renderDraft(agentContext({ media }), { ventureId: "ven_000001", draft: draft(), outDir: "/tmp/out", maxSlides: 2 });
    expect(refs).toHaveLength(2);
    expect(media.images.map((i) => i.aspect)).toEqual(["9:16", "9:16"]);
    expect(media.images.map((i) => i.outPath)).toEqual(["/tmp/out/slide-1.png", "/tmp/out/slide-2.png"]);
    expect(media.images[0]?.prompt).toContain("Stylized phone with chat bubbles");
    expect(media.images[0]?.ventureId).toBe("ven_000001");
    expect(refs[0]).toEqual({ localPath: "/tmp/out/slide-1.png", sha256: "sha_1", mediaType: "image/png", aiGenerated: true, c2pa: true });
  });

  it("renders nothing for a draft without slides", async () => {
    const media = new FakeMedia();
    expect(await renderDraft(agentContext({ media }), { ventureId: "v", draft: draft({ slides: [] }), outDir: "/o", maxSlides: 5 })).toEqual([]);
    expect(media.images).toHaveLength(0);
  });
});

describe("produceIcon", () => {
  it("generates a 1:1 icon from the brand icon prompt", async () => {
    const media = new FakeMedia();
    const ref = await produceIcon(agentContext({ media }), { ventureId: "ven_000001", spec: astraSpec(), outDir: "/p/assets" });
    const req = media.images[0];
    expect(req?.aspect).toBe("1:1");
    expect(req?.purpose).toBe("icon");
    expect(req?.outPath).toBe("/p/assets/icon.png");
    expect(req?.prompt).toContain("A gold crescent on deep purple");
    expect(req?.prompt).toContain("#2B1B5A");
    expect(ref).toMatchObject({ localPath: "/p/assets/icon.png", aiGenerated: true, c2pa: true });
  });
});
