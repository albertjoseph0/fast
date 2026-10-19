import { describe, expect, it } from "vitest";
import { DryRunRecorder } from "../../../src/integrations/http.ts";
import { OFFLINE_PRIVACY, TIKTOK_API, TikTokClient, choosePrivacy } from "../../../src/integrations/social/tiktok.ts";
import type { PlatformLabels } from "../../../src/core/types.ts";
import { account, env0, fakeFetch, forbiddenFetch, image, jobFrom, piece, video } from "./helpers.ts";
import type { FakeRoute } from "./helpers.ts";

const labels: PlatformLabels = { tiktok: { is_aigc: true, brand_content_toggle: false, brand_organic_toggle: true } };
const caption = "Astra read my chart and I feel attacked\n\n#astrology #zodiac";
const ok = (data: unknown) => ({ data, error: { code: "ok", message: "", log_id: "L1" } });

function client(routes: FakeRoute[], opts: { audited?: boolean; dryRun?: boolean; env?: Record<string, string> } = {}) {
  const { config, store, clock } = env0();
  const fake = fakeFetch(routes);
  const tt = new TikTokClient({ config, store, clock, env: opts.env ?? { TIKTOK_TOKEN_ASTRA: "tttok" }, dryRun: opts.dryRun ?? false, fetch: fake.fetch, audited: opts.audited ?? false });
  return { tt, fake };
}

const creatorInfo = (options: string[], extra: object = {}): FakeRoute => ({
  method: "POST",
  match: "creator_info/query",
  json: ok({ creator_username: "astra.app", privacy_level_options: options, comment_disabled: false, duet_disabled: true, stitch_disabled: false, max_video_post_duration_sec: 600, ...extra }),
});

describe("choosePrivacy", () => {
  it("takes the widest offered level and never one that is not offered", () => {
    expect(choosePrivacy(["SELF_ONLY", "FOLLOWER_OF_CREATOR", "PUBLIC_TO_EVERYONE"], false)).toBe("PUBLIC_TO_EVERYONE");
    expect(choosePrivacy(["MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"], false)).toBe("MUTUAL_FOLLOW_FRIENDS");
    expect(choosePrivacy(["SELF_ONLY"], false)).toBe("SELF_ONLY");
    expect(() => choosePrivacy([], false)).toThrow(/no usable privacy level/);
    expect(() => choosePrivacy(["SELF_ONLY"], true)).toThrow(/branded content cannot be SELF_ONLY/);
  });
});

describe("TikTokClient.publish", () => {
  it("sends a photo carousel to the inbox as MEDIA_UPLOAD with the AIGC flag", async () => {
    const { tt, fake } = client([{ method: "POST", match: "content/init", json: ok({ publish_id: "p_pub_1" }) }]);
    const job = await tt.publish({ account: account("tiktok"), platform: "tiktok", piece: piece("tiktok", [image(1), image(2)]), mode: "inbox_draft", labels });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.url).toBe(`${TIKTOK_API}/post/publish/content/init/`);
    expect(fake.calls[0]?.headers.authorization).toBe("Bearer tttok");
    expect(fake.calls[0]?.json).toEqual({
      media_type: "PHOTO",
      post_mode: "MEDIA_UPLOAD",
      post_info: { title: "your birth chart says you text first", description: caption },
      source_info: { source: "PULL_FROM_URL", photo_cover_index: 0, photo_images: ["https://cdn.fast.test/slide1.jpg", "https://cdn.fast.test/slide2.jpg"] },
      is_aigc: true,
    });
    expect(job.externalRef).toMatchObject({ platform: "tiktok", publishId: "p_pub_1", mode: "inbox_draft", kind: "photo" });
  });

  it("sends a video draft through inbox/video/init and flags labels for the human", async () => {
    const { tt, fake } = client([{ method: "POST", match: "inbox/video/init", json: ok({ publish_id: "v_inbox_1" }) }]);
    const job = await tt.publish({ account: account("tiktok"), platform: "tiktok", piece: piece("tiktok", [video()]), mode: "inbox_draft", labels });
    expect(fake.calls[0]?.json).toEqual({ source_info: { source: "PULL_FROM_URL", video_url: "https://cdn.fast.test/reel.mp4" } });
    expect(job.externalRef.labelsToApplyInApp).toBe("ai_generated,your_brand");
  });

  it("refuses direct mode when the client is not audited, before any network call", async () => {
    const { tt, fake } = client([creatorInfo(["PUBLIC_TO_EVERYONE"])]);
    await expect(tt.publish({ account: account("tiktok"), platform: "tiktok", piece: piece("tiktok", [video()]), mode: "direct", labels })).rejects.toThrow(/not audited/);
    expect(fake.calls).toHaveLength(0);
  });

  it("direct video takes privacy and interaction limits from creator_info", async () => {
    const { tt, fake } = client([creatorInfo(["FOLLOWER_OF_CREATOR", "SELF_ONLY"]), { method: "POST", match: "/video/init", json: ok({ publish_id: "v_pub_1" }) }], { audited: true });
    await tt.publish({ account: account("tiktok"), platform: "tiktok", piece: piece("tiktok", [video()]), mode: "direct", labels });
    expect(fake.calls.map((c) => c.url)).toEqual([`${TIKTOK_API}/post/publish/creator_info/query/`, `${TIKTOK_API}/post/publish/video/init/`]);
    expect(fake.calls[1]?.json).toEqual({
      post_info: {
        title: caption,
        privacy_level: "FOLLOWER_OF_CREATOR",
        disable_comment: false,
        disable_duet: true,
        disable_stitch: false,
        brand_content_toggle: false,
        brand_organic_toggle: true,
        is_aigc: true,
      },
      source_info: { source: "PULL_FROM_URL", video_url: "https://cdn.fast.test/reel.mp4" },
    });
  });

  it("direct photo posts carry branded-content toggles and a non-private level", async () => {
    const { tt, fake } = client([creatorInfo(["SELF_ONLY", "MUTUAL_FOLLOW_FRIENDS"]), { method: "POST", match: "content/init", json: ok({ publish_id: "p_pub_2" }) }], { audited: true });
    const branded: PlatformLabels = { tiktok: { is_aigc: false, brand_content_toggle: true, brand_organic_toggle: false } };
    await tt.publish({ account: account("tiktok"), platform: "tiktok", piece: piece("tiktok", [image(1)]), mode: "direct", labels: branded });
    expect(fake.calls[1]?.json).toEqual({
      media_type: "PHOTO",
      post_mode: "DIRECT_POST",
      post_info: {
        title: "your birth chart says you text first",
        description: caption,
        privacy_level: "MUTUAL_FOLLOW_FRIENDS",
        disable_comment: false,
        brand_content_toggle: true,
        brand_organic_toggle: false,
        auto_add_music: true,
      },
      source_info: { source: "PULL_FROM_URL", photo_cover_index: 0, photo_images: ["https://cdn.fast.test/slide1.jpg"] },
      is_aigc: false,
    });
  });

  it("refuses unlabeled content and trial reels", async () => {
    const { tt } = client([]);
    await expect(tt.publish({ account: account("tiktok"), platform: "tiktok", piece: piece("tiktok", [image(1)]), mode: "inbox_draft", labels: {} })).rejects.toThrow(/disclosure labels/);
    await expect(tt.publish({ account: account("tiktok"), platform: "tiktok", piece: piece("tiktok", [video()]), mode: "trial_reel", labels })).rejects.toThrow(/Instagram-only/);
  });

  it("surfaces TikTok error envelopes", async () => {
    const { tt } = client([{ method: "POST", match: "content/init", json: { error: { code: "spam_risk_too_many_pending_share", message: "too many", log_id: "X" } } }]);
    await expect(tt.publish({ account: account("tiktok"), platform: "tiktok", piece: piece("tiktok", [image(1)]), mode: "inbox_draft", labels })).rejects.toThrow(/spam_risk_too_many_pending_share/);
  });

  it("dry-run without credentials makes no fetch calls", async () => {
    const { config, store, clock } = env0();
    const recorder = new DryRunRecorder(null);
    const tt = new TikTokClient({ config, store, clock, env: {}, dryRun: true, recorder, fetch: forbiddenFetch, audited: true });
    const job = await tt.publish({ account: account("tiktok"), platform: "tiktok", piece: piece("tiktok", [video()]), mode: "direct", labels });
    expect(job.externalRef.publishId).toMatch(/^dry_ttpublish_/);
    expect((recorder.list()[0]?.json as any).post_info.privacy_level).toBe(OFFLINE_PRIVACY);
    expect(await tt.poll(jobFrom(job), account("tiktok"))).toMatchObject({ status: "succeeded", result: { moderation: "live", dryRun: true } });
  });

  it("dry-run with credentials reads creator_info but never sends the post", async () => {
    const fake = fakeFetch([creatorInfo(["PUBLIC_TO_EVERYONE"])]);
    const { config, store, clock } = env0();
    const tt = new TikTokClient({ config, store, clock, env: { TIKTOK_TOKEN_ASTRA: "tttok" }, dryRun: true, fetch: fake.fetch, audited: true });
    await tt.publish({ account: account("tiktok"), platform: "tiktok", piece: piece("tiktok", [video()]), mode: "direct", labels });
    expect(fake.calls.map((c) => c.url)).toEqual([`${TIKTOK_API}/post/publish/creator_info/query/`]);
  });
});

describe("TikTokClient.poll and stats", () => {
  const ref = { op: "social.publish" as const, externalRef: { platform: "tiktok", accountId: "acct_tiktok", contentId: "content_000001", publishId: "v_pub_1", mode: "direct", kind: "video" }, pollAfterSec: 30 };
  const status = (data: object): FakeRoute => ({ method: "POST", match: "status/fetch", json: ok(data) });

  it("maps status values", async () => {
    expect((await client([status({ status: "PROCESSING_DOWNLOAD" })]).tt.poll(jobFrom(ref), account("tiktok"))).status).toBe("running");
    const inbox = await client([status({ status: "SEND_TO_USER_INBOX" })]).tt.poll(jobFrom(ref), account("tiktok"));
    expect(inbox).toMatchObject({ status: "running", pollAfterSec: 3_600, result: { moderation: "pending_human" } });
    const failed = await client([status({ status: "FAILED", fail_reason: "picture_size_check_failed" })]).tt.poll(jobFrom(ref), account("tiktok"));
    expect(failed).toMatchObject({ status: "failed", error: expect.stringContaining("picture_size_check_failed") });
    const { tt, fake } = client([{ method: "POST", match: "status/fetch", text: '{"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[7300000000000000001]},"error":{"code":"ok"}}' }]);
    const done = await tt.poll(jobFrom(ref), account("tiktok"));
    expect(fake.calls[0]?.json).toEqual({ publish_id: "v_pub_1" });
    expect(done).toEqual({ status: "succeeded", result: { externalId: "7300000000000000001", url: "https://www.tiktok.com/@astra.app/video/7300000000000000001", moderation: "live" } });
  });

  it("reads Display API counts", async () => {
    const { tt, fake } = client([{ method: "POST", match: "video/query", json: ok({ videos: [{ id: "730", view_count: 5000, like_count: 300, comment_count: 12, share_count: 40 }] }) }]);
    const stats = await tt.postStats("730", account("tiktok"));
    expect(fake.calls[0]?.url).toContain("fields=id,view_count,like_count,comment_count,share_count");
    expect(fake.calls[0]?.json).toEqual({ filters: { video_ids: ["730"] } });
    expect(stats).toMatchObject({ views: 5000, likes: 300, comments: 12, shares: 40, saves: null });
  });

  it("refreshes the access token when a refresh token and client credentials exist", async () => {
    const { tt, fake } = client(
      [{ method: "POST", match: "oauth/token", json: { access_token: "fresh", expires_in: 86_400 } }, { method: "POST", match: "video/query", json: ok({ videos: [] }) }],
      { env: { TIKTOK_TOKEN_ASTRA_REFRESH_TOKEN: "rt", TIKTOK_CLIENT_KEY: "ck", TIKTOK_CLIENT_SECRET: "cs" } },
    );
    await tt.postStats("730", account("tiktok"));
    await tt.postStats("730", account("tiktok"));
    expect(fake.calls.filter((c) => c.url.includes("oauth/token"))).toHaveLength(1);
    expect(fake.calls[0]?.body).toBe("client_key=ck&client_secret=cs&grant_type=refresh_token&refresh_token=rt");
    expect(fake.calls[1]?.headers.authorization).toBe("Bearer fresh");
  });
});
