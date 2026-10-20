import { describe, expect, it } from "vitest";
import { DryRunRecorder } from "../../../src/integrations/http.ts";
import { GRAPH_API, InstagramClient } from "../../../src/integrations/social/instagram.ts";
import type { PlatformLabels } from "../../../src/core/types.ts";
import { account, env0, fakeFetch, forbiddenFetch, image, jobFrom, piece, video } from "./helpers.ts";
import type { FakeRoute } from "./helpers.ts";

const IG = "17841400000000001";
const labels: PlatformLabels = { instagram: { is_ai_generated: true, is_paid_partnership: false } };
const caption = "Astra read my chart and I feel attacked\n\n#astrology #zodiac";

function client(routes: FakeRoute[], dryRun = false) {
  const { config, store, clock } = env0();
  const fake = fakeFetch(routes);
  const ig = new InstagramClient({ config, store, clock, env: { INSTAGRAM_TOKEN_ASTRA: "igtok" }, dryRun, fetch: fake.fetch });
  return { ig, fake };
}

describe("InstagramClient.publish", () => {
  it("puts the AI label on a single image container", async () => {
    const { ig, fake } = client([{ method: "POST", match: `${IG}/media`, json: { id: "c1" } }]);
    const job = await ig.publish({ account: account("instagram"), platform: "instagram", piece: piece("instagram", [image(1)]), mode: "direct", labels });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.url).toBe(`${GRAPH_API}/${IG}/media`);
    expect(fake.calls[0]?.headers.authorization).toBe("Bearer igtok");
    expect(fake.calls[0]?.json).toEqual({ image_url: "https://cdn.fast.test/slide1.jpg", caption, is_ai_generated: true, is_paid_partnership: false });
    expect(job).toMatchObject({ op: "social.publish", externalRef: { platform: "instagram", containerId: "c1", igUserId: IG, accountId: "acct_instagram", contentId: "content_000001" } });
  });

  it("labels the carousel parent only", async () => {
    let n = 0;
    const { ig, fake } = client([{ method: "POST", match: `${IG}/media`, json: () => ({ id: `c${++n}` }) }]);
    const job = await ig.publish({
      account: account("instagram"),
      platform: "instagram",
      piece: piece("instagram", [image(1), image(2), image(3)]),
      mode: "direct",
      labels: { instagram: { is_ai_generated: true, is_paid_partnership: true } },
    });
    const bodies = fake.calls.map((c) => c.json);
    expect(bodies.slice(0, 3)).toEqual([1, 2, 3].map((i) => ({ image_url: `https://cdn.fast.test/slide${i}.jpg`, is_carousel_item: true })));
    for (const child of bodies.slice(0, 3)) expect(child).not.toHaveProperty("is_ai_generated");
    expect(bodies[3]).toEqual({ media_type: "CAROUSEL", children: "c1,c2,c3", caption, is_ai_generated: true, is_paid_partnership: true });
    expect(job.externalRef.containerId).toBe("c4");
  });

  it("creates a trial reel with graduation_strategy", async () => {
    const { ig, fake } = client([{ method: "POST", match: `${IG}/media`, json: { id: "r1" } }]);
    const job = await ig.publish({ account: account("instagram"), platform: "instagram", piece: piece("instagram", [video()]), mode: "trial_reel", labels });
    expect(fake.calls[0]?.json).toEqual({
      media_type: "REELS",
      video_url: "https://cdn.fast.test/reel.mp4",
      caption,
      is_ai_generated: true,
      is_paid_partnership: false,
      trial_params: { graduation_strategy: "SS_PERFORMANCE" },
    });
    expect(job.pollAfterSec).toBe(60);
    expect(job.externalRef.mode).toBe("trial_reel");
  });

  it("publishes slides requested as a trial reel as a direct carousel or image", async () => {
    let n = 0;
    const { ig, fake } = client([{ method: "POST", match: `${IG}/media`, json: () => ({ id: `c${++n}` }) }]);
    const slides = await ig.publish({ account: account("instagram"), platform: "instagram", piece: piece("instagram", [image(1), image(2), image(3)]), mode: "trial_reel", labels });
    expect(fake.calls.map((c) => c.json)[3]).toEqual({ media_type: "CAROUSEL", children: "c1,c2,c3", caption, is_ai_generated: true, is_paid_partnership: false });
    expect(slides.externalRef).toMatchObject({ containerId: "c4", mode: "direct" });
    const single = await ig.publish({ account: account("instagram"), platform: "instagram", piece: piece("instagram", [image(1)]), mode: "trial_reel", labels });
    expect(fake.calls[4]?.json).toEqual({ image_url: "https://cdn.fast.test/slide1.jpg", caption, is_ai_generated: true, is_paid_partnership: false });
    expect(single.externalRef.mode).toBe("direct");
    for (const call of fake.calls) expect(call.json).not.toHaveProperty("trial_params");
  });

  it("refuses unlabeled content, drafts and unhosted media", async () => {
    const { ig, fake } = client([]);
    const base = { account: account("instagram"), platform: "instagram" as const, mode: "direct" as const };
    await expect(ig.publish({ ...base, piece: piece("instagram", [image(1)]), labels: {} })).rejects.toThrow(/disclosure labels/);
    await expect(ig.publish({ ...base, piece: piece("instagram", [image(1)]), labels, mode: "inbox_draft" })).rejects.toThrow(/no draft API/);
    await expect(ig.publish({ ...base, piece: piece("instagram", [{ ...image(1), publicUrl: undefined } as never]), labels })).rejects.toThrow(/publicUrl/);
    expect(fake.calls).toHaveLength(0);
  });

  it("dry-run records containers and never calls fetch", async () => {
    const { config, store, clock } = env0();
    const recorder = new DryRunRecorder(null);
    const ig = new InstagramClient({ config, store, clock, env: { INSTAGRAM_TOKEN_ASTRA: "igtok" }, dryRun: true, recorder, fetch: forbiddenFetch });
    const job = await ig.publish({ account: account("instagram"), platform: "instagram", piece: piece("instagram", [image(1), image(2)]), mode: "direct", labels });
    expect(job.externalRef.containerId).toMatch(/^dry_/);
    const poll = await ig.poll(jobFrom(job), account("instagram"));
    expect(poll.status).toBe("succeeded");
    expect(String(poll.result?.externalId)).toMatch(/^dry_igmedia_/);
    expect(recorder.list().map((r) => r.url.replace(GRAPH_API, ""))).toEqual([`/${IG}/media`, `/${IG}/media`, `/${IG}/media`, `/${IG}/media_publish`]);
    expect(recorder.list()[0]?.headers.authorization).toBe("<redacted>");
    const stats = await ig.postStats(String(poll.result?.externalId), account("instagram"));
    expect(stats.views).toBeNull();
  });
});

describe("InstagramClient.poll", () => {
  const ref = { op: "social.publish" as const, externalRef: { platform: "instagram", accountId: "acct_instagram", contentId: "content_000001", igUserId: IG, containerId: "c9" }, pollAfterSec: 10 };

  it("keeps polling while the container is in progress", async () => {
    const { ig } = client([{ method: "GET", match: `${GRAPH_API}/c9?`, json: { status_code: "IN_PROGRESS" } }]);
    expect(await ig.poll(jobFrom(ref), account("instagram"))).toEqual({ status: "running", pollAfterSec: 60 });
  });

  it("publishes a FINISHED container and returns the permalink", async () => {
    const { ig, fake } = client([
      { method: "GET", match: `${GRAPH_API}/c9?`, json: { status_code: "FINISHED" } },
      { method: "POST", match: `${IG}/media_publish`, json: { id: "m77" } },
      { method: "GET", match: `${GRAPH_API}/m77?`, json: { permalink: "https://www.instagram.com/reel/abc/" } },
    ]);
    const poll = await ig.poll(jobFrom(ref), account("instagram"));
    expect(fake.calls[1]?.json).toEqual({ creation_id: "c9" });
    expect(poll).toEqual({ status: "succeeded", result: { externalId: "m77", url: "https://www.instagram.com/reel/abc/", moderation: "live" } });
  });

  it("fails on ERROR and EXPIRED", async () => {
    const err = client([{ method: "GET", match: "c9", json: { status_code: "ERROR", status: "Error: media rejected" } }]);
    expect(await err.ig.poll(jobFrom(ref), account("instagram"))).toMatchObject({ status: "failed", result: { moderation: "rejected" } });
    const exp = client([{ method: "GET", match: "c9", json: { status_code: "EXPIRED" } }]);
    expect((await exp.ig.poll(jobFrom(ref), account("instagram"))).status).toBe("failed");
  });
});

describe("InstagramClient.postStats", () => {
  it("maps insights to PostStats", async () => {
    const { ig, fake } = client([
      {
        method: "GET",
        match: "m77/insights",
        json: {
          data: [
            { name: "views", values: [{ value: 1200 }] },
            { name: "likes", values: [{ value: 80 }] },
            { name: "comments", values: [{ value: 5 }] },
            { name: "shares", values: [{ value: 12 }] },
            { name: "saved", values: [{ value: 30 }] },
            { name: "profile_visits", total_value: { value: 9 } },
          ],
        },
      },
    ]);
    const stats = await ig.postStats("m77", account("instagram"));
    expect(fake.calls[0]?.url).toContain("metric=views,likes,comments,shares,saved,profile_visits");
    expect(stats).toEqual({ asOf: "2026-10-19T12:00:00.000Z", views: 1200, likes: 80, comments: 5, shares: 12, saves: 30, profileVisits: 9, linkClicks: null });
  });

  it("retries without profile_visits when the media type does not report it", async () => {
    const { ig, fake } = client([
      { method: "GET", match: "profile_visits", status: 400, json: { error: { message: "metric not supported" } } },
      { method: "GET", match: "m77/insights", json: { data: [{ name: "views", values: [{ value: 3 }] }] } },
    ]);
    const stats = await ig.postStats("m77", account("instagram"));
    expect(fake.calls).toHaveLength(2);
    expect(stats.views).toBe(3);
    expect(stats.profileVisits).toBeNull();
  });
});
