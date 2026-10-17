import { describe, expect, it } from "vitest";
import { deriveDisclosure, labelsFor } from "../../src/governance/disclosure.ts";
import { canonicalJson, payloadHash, sha256Hex } from "../../src/governance/hash.ts";
import { computePayout } from "../../src/governance/payouts.ts";
import { START, piece } from "./fixtures.ts";

describe("hash", () => {
  it("canonicalJson sorts keys recursively and drops undefined fields", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[1,{"y":2,"z":1}]},"b":1}');
    expect(canonicalJson([undefined, null, "x"])).toBe('[null,null,"x"]');
  });

  it("sha256Hex matches the known digest", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("payloadHash is order-independent and sensitive to kind, venture and payload", () => {
    const h = payloadHash("ads.pause", "ven_1", { adCampaignId: "a", reason: "r" });
    expect(payloadHash("ads.pause", "ven_1", { reason: "r", adCampaignId: "a" })).toBe(h);
    expect(payloadHash("ads.pause", "ven_2", { adCampaignId: "a", reason: "r" })).not.toBe(h);
    expect(payloadHash("ads.pause", "ven_1", { adCampaignId: "a", reason: "r2" })).not.toBe(h);
    expect(payloadHash("venture.kill", "ven_1", { adCampaignId: "a", reason: "r" })).not.toBe(h);
    expect(payloadHash("venture.kill", undefined, { reason: "r" })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("deriveDisclosure", () => {
  it("is none without AI media and own_brand for owned content", () => {
    const d = deriveDisclosure(piece({ media: [{ localPath: "x", sha256: "s", mediaType: "image/png", aiGenerated: false, c2pa: false }] }), START);
    expect(d).toEqual({ aiGenerated: false, aiRealism: "none", commercial: "own_brand", derivedAt: START });
  });

  it("is stylized for AI media without realism wording", () => {
    expect(deriveDisclosure(piece(), START).aiRealism).toBe("stylized");
  });

  it("flags photorealistic people and scenes", () => {
    const person = piece();
    person.draft.slides = [{ text: "x", imagePrompt: "photorealistic selfie of a woman in a cafe", isAppReveal: false }];
    expect(deriveDisclosure(person, START).aiRealism).toBe("photorealistic_person");
    const scene = piece();
    scene.draft.script = "A realistic photo of a city skyline at night";
    expect(deriveDisclosure(scene, START).aiRealism).toBe("photorealistic_scene");
  });

  it("is a paid partnership for creator UGC", () => {
    expect(deriveDisclosure(piece({ channel: "creator_ugc" }), START).commercial).toBe("paid_partnership");
  });
});

describe("labelsFor", () => {
  const owned = { aiGenerated: true, aiRealism: "stylized", commercial: "own_brand", derivedAt: START } as const;
  const paidReal = { aiGenerated: true, aiRealism: "photorealistic_person", commercial: "paid_partnership", derivedAt: START } as const;

  it("maps TikTok AIGC and branded toggles", () => {
    expect(labelsFor("tiktok", owned)).toEqual({ tiktok: { is_aigc: true, brand_content_toggle: false, brand_organic_toggle: true } });
    expect(labelsFor("tiktok", paidReal)).toEqual({ tiktok: { is_aigc: true, brand_content_toggle: true, brand_organic_toggle: false } });
  });

  it("maps Instagram AI info and paid partnership", () => {
    expect(labelsFor("instagram", paidReal)).toEqual({ instagram: { is_ai_generated: true, is_paid_partnership: true } });
  });

  it("maps YouTube synthetic media only for realistic content", () => {
    expect(labelsFor("youtube", owned)).toEqual({ youtube: { containsSyntheticMedia: false, selfDeclaredMadeForKids: false, hasPaidProductPlacement: false } });
    expect(labelsFor("youtube", paidReal)).toEqual({ youtube: { containsSyntheticMedia: true, selfDeclaredMadeForKids: false, hasPaidProductPlacement: true } });
  });

  it("uses caption labels elsewhere", () => {
    expect(labelsFor("x", paidReal)).toEqual({ other: { aiLabelInCaption: true, adLabelInCaption: true } });
    expect(labelsFor("threads", { ...owned, aiGenerated: false, aiRealism: "none" })).toEqual({ other: { aiLabelInCaption: false, adLabelInCaption: false } });
  });
});

describe("computePayout", () => {
  const terms = { flatFeeCents: 1_500, cpmCents: 150, maxPayoutCents: 15_000 };

  it("is flat plus floored CPM", () => {
    expect(computePayout(terms, { viewsAtLock: 40_000, campaignRemainingCents: 1e9 })).toBe(1_500 + 6_000);
    expect(computePayout(terms, { viewsAtLock: 1_999, campaignRemainingCents: 1e9 })).toBe(1_500 + 299);
  });

  it("caps at the per-video max and the campaign remaining", () => {
    expect(computePayout(terms, { viewsAtLock: 1_000_000, campaignRemainingCents: 1e9 })).toBe(15_000);
    expect(computePayout(terms, { viewsAtLock: 40_000, campaignRemainingCents: 2_000 })).toBe(2_000);
  });

  it("is never negative", () => {
    expect(computePayout(terms, { viewsAtLock: 10, campaignRemainingCents: -500 })).toBe(0);
    expect(computePayout(terms, { viewsAtLock: -10, campaignRemainingCents: 1e9 })).toBe(1_500);
  });
});
