import { describe, expect, it } from "vitest";
import { DryRunRecorder } from "../../../src/integrations/http.ts";
import { LiveSocialRead, LiveSocialWrite, createLiveSocial } from "../../../src/integrations/social/index.ts";
import type { PlatformLabels } from "../../../src/core/types.ts";
import { account, env0, fakeFetch, forbiddenFetch, image, jobFrom, piece, video } from "./helpers.ts";

const labels: PlatformLabels = {
  instagram: { is_ai_generated: true, is_paid_partnership: false },
  tiktok: { is_aigc: true, brand_content_toggle: false, brand_organic_toggle: true },
};

describe("LiveSocialWrite / LiveSocialRead", () => {
  it("dispatches publish and poll by platform in dry-run without network", async () => {
    const { config, store, clock } = env0();
    const recorder = new DryRunRecorder(null);
    const { read, write } = createLiveSocial({ config, store, clock, env: {}, dryRun: true, recorder, fetch: forbiddenFetch });
    const ig = account("instagram");
    store.accounts.put(ig);
    const job = await write.publish({ account: ig, platform: "instagram", piece: piece("instagram", [image(1)]), mode: "direct", labels });
    expect(job.op).toBe("social.publish");
    expect(job.externalRef).toMatchObject({ platform: "instagram", accountId: ig.id, contentId: "content_000001" });
    const poll = await read.poll(jobFrom(job));
    expect(poll.status).toBe("succeeded");
    expect(poll.result?.moderation).toBe("live");
    expect(String(poll.result?.externalId)).toMatch(/^dry_/);
    expect(recorder.list().map((r) => r.service)).toEqual(["instagram", "instagram"]);
  });

  it("refuses TikTok direct posts unless the config says the client is audited", async () => {
    const { config, store, clock } = env0();
    const write = new LiveSocialWrite({ config, store, clock, env: {}, dryRun: true, fetch: forbiddenFetch });
    const req = { account: account("tiktok"), platform: "tiktok" as const, piece: piece("tiktok", [video()]), mode: "direct" as const, labels };
    await expect(write.publish(req)).rejects.toThrow(/not audited/);
    const audited = new LiveSocialWrite({ config, store, clock, env: {}, dryRun: true, fetch: forbiddenFetch, tiktokAudited: true });
    await expect(audited.publish(req)).resolves.toMatchObject({ externalRef: { platform: "tiktok" } });
  });

  it("guards account platform, status and consent", async () => {
    const { config, store, clock } = env0();
    const write = new LiveSocialWrite({ config, store, clock, env: {}, dryRun: true, fetch: forbiddenFetch });
    const p = piece("instagram", [image(1)]);
    await expect(write.publish({ account: account("tiktok"), platform: "instagram", piece: p, mode: "direct", labels })).rejects.toThrow(/not instagram/);
    await expect(write.publish({ account: account("instagram", { status: "restricted" }), platform: "instagram", piece: p, mode: "direct", labels })).rejects.toThrow(/restricted/);
    const expired = account("instagram", { standingConsent: { scopes: [], grantedAt: "2025-01-01T00:00:00.000Z", expiresAt: "2026-01-01T00:00:00.000Z", grantedBy: "owner" } });
    await expect(write.publish({ account: expired, platform: "instagram", piece: p, mode: "direct", labels })).rejects.toThrow(/consent expired/);
    await expect(write.publish({ account: account("x"), platform: "x", piece: piece("x", [image(1)]), mode: "direct", labels })).rejects.toThrow(/not supported/);
  });

  it("routes postStats to the platform adapter", async () => {
    const { config, store, clock } = env0();
    const fake = fakeFetch([{ method: "GET", match: "part=statistics", json: { items: [{ statistics: { viewCount: "10", likeCount: "1", commentCount: "0" } }] } }]);
    const read = new LiveSocialRead({ config, store, clock, env: { YOUTUBE_TOKEN_ASTRA: "t" }, dryRun: false, fetch: fake.fetch });
    const stats = await read.postStats({ platform: "youtube", externalId: "v1", account: account("youtube") });
    expect(stats.views).toBe(10);
    expect(await read.poll(jobFrom({ op: "store.build", externalRef: {}, pollAfterSec: 1 }))).toMatchObject({ status: "failed" });
  });
});
