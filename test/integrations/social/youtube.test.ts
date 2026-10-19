import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { defaultConfig } from "../../../src/config/schema.ts";
import { DryRunRecorder } from "../../../src/integrations/http.ts";
import { INSERT_QUOTA_KEY, YOUTUBE_UPLOAD_URL, YouTubeClient } from "../../../src/integrations/social/youtube.ts";
import type { PlatformLabels } from "../../../src/core/types.ts";
import { account, env0, fakeFetch, forbiddenFetch, jobFrom, piece, video } from "./helpers.ts";
import type { FakeRoute } from "./helpers.ts";

const labels: PlatformLabels = { youtube: { containsSyntheticMedia: true, selfDeclaredMadeForKids: false, hasPaidProductPlacement: false } };
const SESSION = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=XYZ";
let videoPath: string;

beforeAll(() => {
  videoPath = join(mkdtempSync(join(tmpdir(), "yt-test-")), "short.mp4");
  writeFileSync(videoPath, Buffer.alloc(2048, 7));
});

function setup(routes: FakeRoute[], opts: { dryRun?: boolean; inserts?: number } = {}) {
  const { store, clock } = env0();
  const config = opts.inserts === undefined ? defaultConfig() : defaultConfig({ distribution: { youtubeProjectInsertsPerDay: opts.inserts } });
  const fake = fakeFetch(routes);
  const yt = new YouTubeClient({ config, store, clock, env: { YOUTUBE_TOKEN_ASTRA: "yttok" }, dryRun: opts.dryRun ?? false, fetch: fake.fetch });
  return { yt, fake, store };
}

const uploadRoutes = (): FakeRoute[] => [
  { method: "POST", match: "uploadType=resumable&part=", json: {}, headers: { location: SESSION } },
  { method: "PUT", match: "upload_id=XYZ", json: { id: "vid123", status: { uploadStatus: "uploaded" } } },
];

describe("YouTubeClient.publish", () => {
  it("runs the resumable flow with synthetic-media disclosure", async () => {
    const { yt, fake, store } = setup(uploadRoutes());
    const job = await yt.publish({ account: account("youtube"), platform: "youtube", piece: piece("youtube", [video(videoPath)]), mode: "direct", labels });
    const [session, put] = fake.calls;
    expect(session?.url).toBe(`${YOUTUBE_UPLOAD_URL}?uploadType=resumable&part=snippet,status`);
    expect(session?.headers).toMatchObject({ authorization: "Bearer yttok", "x-upload-content-length": "2048", "x-upload-content-type": "video/mp4" });
    expect(session?.json).toEqual({
      snippet: {
        title: "your birth chart says you text first",
        description: "Astra read my chart and I feel attacked\n\n#astrology #zodiac",
        tags: ["astrology", "zodiac"],
        categoryId: "22",
      },
      status: { privacyStatus: "public", selfDeclaredMadeForKids: false, containsSyntheticMedia: true },
    });
    expect(put?.method).toBe("PUT");
    expect(put?.url).toBe(SESSION);
    expect(put?.bodyBytes).toBe(2048);
    expect(put?.headers).toMatchObject({ "content-type": "video/mp4", "content-length": "2048" });
    expect(job).toEqual({ op: "social.publish", externalRef: { platform: "youtube", accountId: "acct_youtube", contentId: "content_000001", videoId: "vid123", privacyStatus: "public" }, pollAfterSec: 120 });
    expect(store.quota(INSERT_QUOTA_KEY)).toEqual({ windowStart: "2026-10-19", used: 1, limit: 80 });
  });

  it("uploads drafts private and declares paid placement when labelled", async () => {
    const { yt, fake } = setup(uploadRoutes());
    await yt.publish({
      account: account("youtube"),
      platform: "youtube",
      piece: piece("youtube", [video(videoPath)]),
      mode: "inbox_draft",
      labels: { youtube: { containsSyntheticMedia: false, selfDeclaredMadeForKids: false, hasPaidProductPlacement: true } },
    });
    expect(fake.calls[0]?.url).toContain("part=snippet,status,paidProductPlacementDetails");
    expect(fake.calls[0]?.json).toMatchObject({ status: { privacyStatus: "private", containsSyntheticMedia: false }, paidProductPlacementDetails: { hasPaidProductPlacement: true } });
  });

  it("stops at the daily insert cap", async () => {
    const { yt, fake } = setup(uploadRoutes(), { inserts: 1 });
    const req = { account: account("youtube"), platform: "youtube" as const, piece: piece("youtube", [video(videoPath)]), mode: "direct" as const, labels };
    await yt.publish(req);
    expect(yt.insertsRemaining()).toBe(0);
    await expect(yt.publish(req)).rejects.toThrow(/quota spent/);
    expect(fake.calls).toHaveLength(2);
  });

  it("refuses unlabeled, non-video and trial-reel requests", async () => {
    const { yt } = setup([]);
    const base = { account: account("youtube"), platform: "youtube" as const, mode: "direct" as const };
    await expect(yt.publish({ ...base, piece: piece("youtube", [video(videoPath)]), labels: {} })).rejects.toThrow(/disclosure labels/);
    await expect(yt.publish({ ...base, piece: piece("youtube", [video(videoPath)]), labels, mode: "trial_reel" })).rejects.toThrow(/Instagram-only/);
    await expect(yt.publish({ ...base, piece: piece("youtube", [{ ...video(videoPath), mediaType: "image/jpeg" }]), labels })).rejects.toThrow(/exactly one video/);
  });

  it("dry-run records both steps, makes no fetch calls and spends no quota", async () => {
    const { store, clock, config } = env0();
    const recorder = new DryRunRecorder(null);
    const yt = new YouTubeClient({ config, store, clock, env: { YOUTUBE_TOKEN_ASTRA: "yttok" }, dryRun: true, recorder, fetch: forbiddenFetch });
    const job = await yt.publish({ account: account("youtube"), platform: "youtube", piece: piece("youtube", [video(videoPath)]), mode: "direct", labels });
    expect(job.externalRef.videoId).toMatch(/^dry_ytvideo_/);
    expect(recorder.list().map((r) => r.method)).toEqual(["POST", "PUT"]);
    expect(recorder.list()[1]?.headers["x-dry-run-upload-bytes"]).toBe("2048");
    expect(store.quota(INSERT_QUOTA_KEY)).toBeUndefined();
    expect(await yt.poll(jobFrom(job), account("youtube"))).toMatchObject({ status: "succeeded", result: { moderation: "live" } });
  });
});

describe("YouTubeClient.poll and stats", () => {
  const ref = { op: "social.publish" as const, externalRef: { platform: "youtube", accountId: "acct_youtube", contentId: "content_000001", videoId: "vid123", privacyStatus: "public" }, pollAfterSec: 120 };
  const statusRoute = (status: object): FakeRoute => ({ method: "GET", match: "part=status", json: { items: [{ id: "vid123", status }] } });

  it("maps processing states", async () => {
    expect((await setup([statusRoute({ uploadStatus: "uploaded" })]).yt.poll(jobFrom(ref), account("youtube"))).status).toBe("running");
    expect(await setup([statusRoute({ uploadStatus: "processed", privacyStatus: "public" })]).yt.poll(jobFrom(ref), account("youtube"))).toEqual({
      status: "succeeded",
      result: { externalId: "vid123", url: "https://www.youtube.com/shorts/vid123", moderation: "live" },
    });
    expect(await setup([statusRoute({ uploadStatus: "processed", privacyStatus: "private" })]).yt.poll(jobFrom(ref), account("youtube"))).toMatchObject({ status: "running", result: { moderation: "pending_human" } });
    expect(await setup([statusRoute({ uploadStatus: "rejected", rejectionReason: "duplicate" })]).yt.poll(jobFrom(ref), account("youtube"))).toMatchObject({ status: "failed", result: { moderation: "rejected" } });
  });

  it("reads statistics", async () => {
    const { yt, fake } = setup([{ method: "GET", match: "part=statistics", json: { items: [{ id: "vid123", statistics: { viewCount: "900", likeCount: "40", commentCount: "3" } }] } }]);
    const stats = await yt.postStats("vid123", account("youtube"));
    expect(fake.calls[0]?.url).toBe("https://www.googleapis.com/youtube/v3/videos?part=statistics&id=vid123");
    expect(stats).toMatchObject({ views: 900, likes: 40, comments: 3, shares: null });
  });
});
