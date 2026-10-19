import { describe, expect, it } from "vitest";
import type { ContentPiece, ExternalJob, JobRef, OwnedAccount, Venture } from "../../src/core/types.ts";
import { addVenture, BASE_IDEA, campaign, day, days, harness, type Harness, openCampaign } from "./fixtures.ts";

function asJob(ref: JobRef, n = 1): ExternalJob {
  return { id: `job_${n}`, op: ref.op, actionId: `act_${n}`, externalRef: ref.externalRef, status: "running", nextPollAt: "", deadlineAt: "", attempts: 0, createdAt: "" };
}

/** Poll once per tick until the job leaves "running"; returns the ticks it took. */
async function settle(h: Harness, ref: JobRef, read: "store" | "social" = "store"): Promise<{ ticks: number; poll: Awaited<ReturnType<Harness["ports"]["read"]["store"]["poll"]>> }> {
  const port = h.ports.read[read];
  for (let ticks = 0; ticks < 10; ticks++) {
    const poll = await port.poll(asJob(ref));
    if (poll.status !== "running") return { ticks, poll };
    await day(h);
  }
  throw new Error("job never finished");
}

function piece(v: Venture, n: number, platform: ContentPiece["platform"] = "instagram"): ContentPiece {
  return {
    id: `cnt_${String(n).padStart(6, "0")}`,
    ventureId: v.id,
    formatId: "slideshow_story",
    draft: { formatId: "slideshow_story", platform, voice: "brand_third_person", hook: "He texts first? Check your signs", angle: "a", script: "", slides: [], caption: "c", hashtags: [], callToAction: "Try it" },
    media: [{ localPath: "/tmp/x.png", sha256: "ab", mediaType: "image/png", aiGenerated: true, c2pa: true }],
    channel: "owned_social",
    platform,
    similarityKey: `k${n}`,
    status: "approved",
  };
}

const account = (v: Venture, platform: OwnedAccount["platform"]): OwnedAccount => ({
  id: "acct_000001",
  ventureId: v.id,
  platform,
  handle: "astra.app",
  publishMode: "business_api",
  bioDisclosesBrand: true,
  standingConsent: { scopes: [], grantedAt: "", expiresAt: "", grantedBy: "owner" },
  status: "active",
});

describe("stores", () => {
  it("returns a human task for iOS app creation and an app id on Android", async () => {
    const h = harness(1);
    const v = addVenture(h, 1, BASE_IDEA, []);
    const ios = await h.ports.write.store.createApp({ bindings: v.bindings, platform: "ios", name: "Astra", sku: "astra-1", primaryLocale: "en-US" });
    expect("humanTask" in ios).toBe(true);
    if (!("humanTask" in ios)) return;
    expect(ios.humanTask.kind).toBe("apple.create_app");
    expect(ios.humanTask.ventureId).toBe(v.id);
    const input = ios.humanTask.inputs.find((i) => i.key === "ascAppId");
    expect(input?.pattern).toBe("^\\d{9,11}$");
    expect(new RegExp(input?.pattern ?? "").test("6525536635")).toBe(true);
    const android = await h.ports.write.store.createApp({ bindings: v.bindings, platform: "android", name: "Astra", sku: "astra-1", primaryLocale: "en-US" });
    expect(android).toEqual({ appId: v.bindings.androidPackage });

    // Once a human has created the record, the call finds it.
    h.store.ventures.put({ ...v, bindings: { ...v.bindings, ascAppId: "6525536635" } });
    expect(await h.ports.write.store.createApp({ bindings: v.bindings, platform: "ios", name: "Astra", sku: "astra-1", primaryLocale: "en-US" })).toEqual({ appId: "6525536635" });
    expect((await h.ports.read.store.status({ bindings: v.bindings, platform: "ios" })).appId).toBe("6525536635");
  });

  it("runs every store operation as a job that takes at least one tick, then releases", async () => {
    const h = harness(2);
    const v = addVenture(h, 1, BASE_IDEA, []);
    const s = h.ports.write.store;
    const b = v.bindings;
    expect((await s.registerBundleId({ bindings: b, platform: "ios", capabilities: ["push"] })).bundleIdResourceId).toMatch(/^SIMBNDL/);

    const subs = await settle(h, await s.upsertSubscriptions({ bindings: b, platform: "ios", groupName: "Astra Pro", products: [] }));
    expect(subs.ticks).toBeGreaterThanOrEqual(1);
    const build = await settle(h, await s.startBuild({ bindings: b, platform: "ios", projectDir: "/tmp/astra" }));
    expect(build.ticks).toBeGreaterThanOrEqual(1);
    expect(build.ticks).toBeLessThanOrEqual(3);
    const easBuildId = String(build.poll.result?.easBuildId ?? "eas_retry");
    const upload = await settle(h, await s.submitBuild({ bindings: b, platform: "ios", easBuildId }));
    expect(upload.ticks).toBeGreaterThanOrEqual(1);
    const storeBuildId = String(upload.poll.result?.storeBuildId);
    expect(storeBuildId).toMatch(/^simbuild_/);
    expect((await h.ports.read.store.status({ bindings: b, platform: "ios" })).status).toBe("ready_to_submit");
    const listing = await settle(h, await s.updateListing({ bindings: b, platform: "ios", listing: { locale: "en-US", name: "Astra", subtitle: "", description: "", keywords: "", promotionalText: "", supportUrl: "https://x", privacyUrl: "https://x" }, screenshotPaths: ["/tmp/1.png"] }));
    expect(listing.ticks).toBeGreaterThanOrEqual(1);
    await s.setTerritories({ bindings: b, platform: "ios", territories: ["CA", "AU", "NZ"] });

    const review = await settle(h, await s.submitForReview({ bindings: b, platform: "ios", storeBuildId, notesForReviewer: "n" }));
    expect(review.ticks).toBeGreaterThanOrEqual(1);
    expect(review.ticks).toBeLessThanOrEqual(3);
    expect(["approved", "rejected"]).toContain(review.poll.result?.reviewState);
    const status = await h.ports.read.store.status({ bindings: b, platform: "ios" });
    if (review.poll.result?.reviewState === "approved") {
      expect(status.status).toBe("pending_release");
      await s.release({ bindings: b, platform: "ios", phased: false });
      const live = await h.ports.read.store.status({ bindings: b, platform: "ios" });
      expect(live.status).toBe("live");
      expect(live.territories).toEqual(["CA", "AU", "NZ"]);
    } else {
      expect(status.status).toBe("rejected");
      expect(status.rejectionReasons?.length).toBeGreaterThan(0);
      await expect(s.release({ bindings: b, platform: "ios", phased: false })).rejects.toThrow();
    }
  });

  it("rejects ~4% of submissions, and ~15% when the differentiation is thin", () => {
    const h = harness(3);
    const strong = addVenture(h, 1, BASE_IDEA, []);
    const thin = addVenture(h, 2, { ...BASE_IDEA, differentiation: "Better astrology" }, []);
    const rate = (v: Venture) => {
      let rejected = 0;
      const reasons = new Set<string>();
      for (let i = 0; i < 4000; i++) {
        const d = h.world.reviewDecision(v.bindings.bundleId, `simbuild_${i}`);
        if (d.reviewState === "rejected") {
          rejected++;
          for (const r of d.rejectionReasons) reasons.add(r);
        }
      }
      return { rate: rejected / 4000, reasons };
    };
    const s = rate(strong);
    const t = rate(thin);
    expect(s.rate).toBeGreaterThan(0.03);
    expect(s.rate).toBeLessThan(0.05);
    expect(t.rate).toBeGreaterThan(0.13);
    expect(t.rate).toBeLessThan(0.17);
    expect(t.reasons.has("Guideline 4.3(a) - Design - Spam")).toBe(true);
    expect([...s.reasons].some((r) => r.startsWith("Guideline 3.1.2"))).toBe(true);
  });

  it("serves store reviews with ratings from live storefronts", async () => {
    const h = harness(4);
    const v = addVenture(h, 1, BASE_IDEA, ["CA"]);
    await openCampaign(h, campaign(h, v, 1, "CA", { budgetCents: 300_000 }));
    await days(h, 14);
    const reviews = await h.ports.read.store.reviews({ bindings: v.bindings, platform: "ios", since: "2026-03-01" });
    expect(reviews.length).toBeGreaterThan(0);
    expect(reviews.every((r) => r.territory === "CA" && r.rating >= 1 && r.rating <= 5 && r.date < h.clock.today())).toBe(true);
  });
});

describe("creator marketplace", () => {
  it("searches the deterministic pool by niche, geo share and median views", async () => {
    const h = harness(5);
    const found = await h.ports.read.creators.searchCreators({ niche: "zodiac TikTok", platform: "tiktok", minMedianViews: 5_000, geo: "AU", limit: 10 });
    expect(found.length).toBeGreaterThan(0);
    expect(found.length).toBeLessThanOrEqual(10);
    for (const c of found) {
      expect(c.medianViews30d).toBeGreaterThanOrEqual(5_000);
      expect(c.audienceGeo.AU ?? 0).toBeGreaterThanOrEqual(0.5);
      expect(c.audienceGeo.US ?? 0).toBeGreaterThan(0);
    }
    expect(await harness(5).ports.read.creators.searchCreators({ niche: "zodiac TikTok", platform: "tiktok", minMedianViews: 5_000, geo: "AU", limit: 10 })).toEqual(found);
  });

  it("returns untrusted captions with prompt injections and undisclosed creators at their base rates", async () => {
    const h = harness(6);
    const v = addVenture(h, 1, BASE_IDEA, ["CA", "AU", "NZ"]);
    const campaigns = [];
    for (let i = 0; i < 12; i++) campaigns.push(await openCampaign(h, campaign(h, v, i + 1, ["CA", "AU", "NZ"][i % 3] as string, { budgetCents: 500_000 })));
    await days(h, 12);
    const subs = [];
    for (const c of campaigns) subs.push(...(await h.ports.read.creators.listSubmissions({ campaignExternalId: c.externalId as string })));
    expect(subs.length).toBeGreaterThan(400);
    const injected = subs.filter((s) => /ignore all previous instructions|AI reviewer|<\/untrusted>/i.test(s.untrustedCaption)).length / subs.length;
    expect(injected).toBeGreaterThan(0.01);
    expect(injected).toBeLessThan(0.06);
    const posted = subs.filter((s) => s.stage === "posted");
    expect(posted.length).toBeGreaterThan(100);
    let undisclosed = 0;
    for (const s of posted) {
      const fact = await h.ports.read.creators.verifyPost({ submissionExternalId: s.externalId, postUrl: s.postUrl as string, platform: s.platform });
      expect(fact.viewsFromPlatform).toBeGreaterThan(0);
      if (!fact.platformDisclosureLabel) {
        undisclosed++;
        expect(s.untrustedCaption).not.toContain("#ad");
      }
    }
    expect(undisclosed / posted.length).toBeGreaterThan(0.01);
    expect(undisclosed / posted.length).toBeLessThan(0.12);
  });

  it("posts only after the draft is approved, and views accrue over 7 days", async () => {
    const h = harness(7);
    const v = addVenture(h, 1, BASE_IDEA, ["CA"]);
    const c = await openCampaign(h, campaign(h, v, 1, "CA"));
    for (let i = 0; i < 4; i++) {
      h.world.advanceDay();
      h.clock.advanceDays(1);
    }
    const drafts = await h.ports.read.creators.listSubmissions({ campaignExternalId: c.externalId as string });
    expect(drafts.length).toBeGreaterThan(0);
    // No reviews yet: only the creators who skip the draft step have posted.
    expect(drafts.filter((s) => s.stage === "posted").length).toBeLessThan(drafts.length);
    const s = drafts.find((x) => x.stage === "draft_submitted");
    if (!s) throw new Error("no draft");
    await h.ports.write.creators.reviewDraft({ submissionExternalId: s.externalId, approve: true, note: "ok" });
    const views: number[] = [];
    for (let i = 0; i < 10; i++) {
      h.world.advanceDay();
      h.clock.advanceDays(1);
      const now = (await h.ports.read.creators.listSubmissions({ campaignExternalId: c.externalId as string })).find((x) => x.externalId === s.externalId);
      if (now?.stage !== "posted") continue;
      views.push((await h.ports.read.creators.verifyPost({ submissionExternalId: s.externalId, postUrl: now.postUrl as string, platform: now.platform })).viewsFromPlatform);
    }
    expect(views.length).toBeGreaterThanOrEqual(7);
    for (let i = 1; i < views.length; i++) expect(views[i]).toBeGreaterThanOrEqual(views[i - 1] as number);
    expect(views.at(-1)).toBe(views.at(-2));
  });

  it("pays out idempotently on the idempotency key", async () => {
    const h = harness(8);
    const v = addVenture(h, 1, BASE_IDEA, ["CA"]);
    const c = await openCampaign(h, campaign(h, v, 1, "CA"));
    await days(h, 4);
    const [s1, s2] = await h.ports.read.creators.listSubmissions({ campaignExternalId: c.externalId as string });
    if (!s1 || !s2) throw new Error("no submissions");
    const basis = { views: 10_000, viewsAsOf: h.clock.iso(), flatFeeCents: 1_500, cpmCents: 150, capCents: 15_000 };
    const pay = h.ports.write.creators.payout;
    const first = await pay({ submissionExternalId: s1.externalId, amountCents: 3_000, idempotencyKey: "creator.payout:ven_000001:sub_1", basis });
    const again = await pay({ submissionExternalId: s1.externalId, amountCents: 3_000, idempotencyKey: "creator.payout:ven_000001:sub_1", basis });
    expect(again.payoutId).toBe(first.payoutId);
    expect(h.world.payoutCount()).toBe(1);
    await expect(pay({ submissionExternalId: s1.externalId, amountCents: 9_000, idempotencyKey: "creator.payout:ven_000001:sub_1", basis })).rejects.toThrow(/idempotency/);
    const other = await pay({ submissionExternalId: s2.externalId, amountCents: 3_000, idempotencyKey: "creator.payout:ven_000001:sub_2", basis });
    expect(other.payoutId).not.toBe(first.payoutId);
    expect(h.world.payoutCount()).toBe(2);
    await expect(pay({ submissionExternalId: "nope", amountCents: 100, idempotencyKey: "k3", basis })).rejects.toThrow();
    expect((await h.ports.write.creators.createCampaign(c)).externalId).toBe(c.externalId);
    expect(await h.ports.write.creators.offerDeal({ creatorExternalId: s1.creatorExternalId, deal: { id: "deal_1" } as never })).toEqual(await h.ports.write.creators.offerDeal({ creatorExternalId: s1.creatorExternalId, deal: { id: "deal_1" } as never }));
  });
});

describe("social", () => {
  it("publishes owned posts as jobs: live on the next tick, private for unaudited TikTok direct posts", async () => {
    const h = harness(9);
    const v = addVenture(h, 1, BASE_IDEA, ["CA"]);
    const labels = { instagram: { is_ai_generated: true, is_paid_partnership: false } };
    const ref = await h.ports.write.social.publish({ account: account(v, "instagram"), platform: "instagram", piece: piece(v, 1), mode: "trial_reel", labels });
    const done = await settle(h, ref, "social");
    expect(done.ticks).toBe(1);
    expect(done.poll.status).toBe("succeeded");
    expect(done.poll.result?.moderation).toBe("live");
    expect(String(done.poll.result?.url)).toMatch(/^https:\/\/www\.instagram\.com\/reel\//);
    const tiktok = await settle(h, await h.ports.write.social.publish({ account: account(v, "tiktok"), platform: "tiktok", piece: piece(v, 2, "tiktok"), mode: "direct", labels: { tiktok: { is_aigc: true, brand_content_toggle: false, brand_organic_toggle: true } } }), "social");
    expect(tiktok.poll.result?.moderation).toBe("private");
    await days(h, 7);
    const stats = await h.ports.read.social.postStats({ platform: "instagram", externalId: String(done.poll.result?.externalId) });
    expect(stats.views).toBeGreaterThan(0);
    expect(Object.values(stats.audienceGeo ?? {}).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 1);
    expect((await h.ports.read.social.postStats({ platform: "instagram", externalId: "missing" })).views).toBeNull();
  });
});

describe("ads", () => {
  it("spends into live storefronts only, with attribution incomplete for the last two days", async () => {
    const h = harness(10);
    const v = addVenture(h, 1, BASE_IDEA, ["CA"]);
    const { campaignExternalId } = await h.ports.write.ads.createCampaign({
      bindings: v.bindings,
      network: "meta",
      adAccountId: "act_sim",
      os: "ios",
      type: "creative",
      dailyBudgetCents: 20_000,
      startAt: h.clock.iso(),
      endAt: "2026-03-20T00:00:00.000Z",
      geos: ["CA", "US"],
      creatives: [],
      keywords: [],
      name: "probe",
    });
    await days(h, 6);
    const stats = await h.ports.read.ads.stats({ network: "meta", campaignExternalId, since: "2026-03-01", until: "2026-03-31" });
    expect(stats.length).toBe(6);
    expect(stats.slice(0, -2).every((s) => s.attributionComplete)).toBe(true);
    expect(stats.slice(-2).every((s) => !s.attributionComplete)).toBe(true);
    for (const s of stats) {
      expect(s.spendCents).toBeLessThanOrEqual(20_000);
      expect(s.impressions).toBe(Math.round((s.spendCents / 1_000) * 1000));
    }
    expect(stats.reduce((n, s) => n + s.installs, 0)).toBeGreaterThan(0);
    const paid = h.world.cohortsOf(v.id).filter((c) => c.channel === "paid_ads");
    expect(paid.length).toBeGreaterThan(0);
    expect(paid.every((c) => c.geo === "CA" && c.sourceId === campaignExternalId)).toBe(true);
    await h.ports.write.ads.pause({ network: "meta", campaignExternalId });
    await days(h, 2);
    const after = await h.ports.read.ads.stats({ network: "meta", campaignExternalId, since: "2026-03-08", until: "2026-03-31" });
    expect(after).toEqual([]);
  });
});

describe("trends, monetization, remote config and web", () => {
  it("serves charts and search from the fictional catalog", async () => {
    const h = harness(11);
    const top = await h.ports.read.trends.topApps({ country: "us", chart: "top-free", limit: 25 });
    expect(top.length).toBe(25);
    expect(top.map((a) => a.rank)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(await h.ports.read.trends.topApps({ country: "us", chart: "top-free", limit: 25 })).toEqual(top);
    const found = await h.ports.read.trends.searchApps({ term: "astrology compatibility", country: "us", limit: 5 });
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]?.description.toLowerCase()).toMatch(/astrology|compatibility/);
  });

  it("returns offering ids, flag keys and public URLs", async () => {
    const h = harness(12);
    const v = addVenture(h, 1, BASE_IDEA, []);
    const { offeringIds } = await h.ports.write.monetization.configure({ bindings: v.bindings, productIds: ["com.x.week_699_t3"], entitlementId: "pro" });
    expect(offeringIds.default).toMatch(/^ofrng_/);
    expect(await h.ports.write.remoteConfig.setFlag({ bindings: v.bindings, key: "paywall", variants: [{ id: "cell_1", rolloutPct: 100, payload: {} }] })).toEqual({ flagKey: "paywall" });
    const asset = await h.ports.write.web.putAsset({ ventureId: v.id, localPath: "/nonexistent/file.png", contentType: "image/png" });
    expect(asset.publicUrl).toBe(`https://sim.example/m/${v.id}/${asset.sha256}`);
    expect(await h.ports.write.web.publishSite({ ventureId: v.id, files: [] })).toEqual({ baseUrl: `https://${v.id}.sim.example` });
  });
});
