import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { SimClock } from "../../../src/core/clock.ts";
import { defaultConfig } from "../../../src/config/schema.ts";
import { DryRunRecorder } from "../../../src/integrations/http.ts";
import { PLAY_API, PlayClient, usdMoney } from "../../../src/integrations/google/play.ts";
import { fakeFetch, forbiddenFetch } from "../apple/fakeFetch.ts";
import type { FakeRoute } from "../apple/fakeFetch.ts";

const PKG = "com.fast.astra";
const APP = `${PLAY_API}/applications/${PKG}`;
let dir: string;
let saPath: string;
let publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"];

beforeAll(() => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  publicKey = pair.publicKey;
  dir = mkdtempSync(join(tmpdir(), "play-test-"));
  saPath = join(dir, "sa.json");
  writeFileSync(
    saPath,
    JSON.stringify({
      type: "service_account",
      client_email: "publisher@fast-studio.iam.gserviceaccount.com",
      private_key: pair.privateKey.export({ type: "pkcs8", format: "pem" }),
      token_uri: "https://oauth2.googleapis.com/token",
    }),
  );
});

const TOKEN_ROUTE: FakeRoute = { method: "POST", match: "https://oauth2.googleapis.com/token", json: { access_token: "ya29.test-token", expires_in: 3599, token_type: "Bearer" } };

function client(opts: { routes?: FakeRoute[]; dryRun?: boolean; clock?: SimClock; recorder?: DryRunRecorder } = {}) {
  const f = fakeFetch([TOKEN_ROUTE, ...(opts.routes ?? [])]);
  const play = new PlayClient({
    config: defaultConfig(),
    env: { PLAY_SERVICE_ACCOUNT_JSON: saPath },
    dryRun: opts.dryRun ?? false,
    secretRefs: { serviceAccountJsonPath: "PLAY_SERVICE_ACCOUNT_JSON" },
    fetch: f.fetch,
    clock: opts.clock ?? new SimClock("2026-10-18T12:00:00Z"),
    sleep: async () => undefined,
    ...(opts.recorder ? { recorder: opts.recorder } : {}),
  });
  return { play, f };
}

describe("Play service-account OAuth", () => {
  it("exchanges an RS256 JWT assertion and caches the token until expiry", async () => {
    const clock = new SimClock("2026-10-18T12:00:00Z");
    const { play, f } = client({ clock, routes: [{ method: "GET", match: `${APP}/reviews`, json: { reviews: [] } }] });
    await play.listReviews(PKG);
    await play.listReviews(PKG);
    const tokenCalls = f.calls.filter((c) => c.url.startsWith("https://oauth2.googleapis.com/token"));
    expect(tokenCalls).toHaveLength(1);
    const call = tokenCalls[0]!;
    expect(call.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(call.body);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [h, p, s] = form.get("assertion")!.split(".") as [string, string, string];
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const payload = JSON.parse(Buffer.from(p, "base64url").toString());
    expect(payload).toMatchObject({
      iss: "publisher@fast-studio.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/androidpublisher",
      aud: "https://oauth2.googleapis.com/token",
    });
    expect(payload.exp - payload.iat).toBe(3600);
    expect(verify("RSA-SHA256", Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, "base64url"))).toBe(true);
    const api = f.calls.filter((c) => c.url.startsWith(PLAY_API));
    expect(api.every((c) => c.headers.authorization === "Bearer ya29.test-token")).toBe(true);

    clock.advanceHours(1);
    await play.listReviews(PKG);
    expect(f.calls.filter((c) => c.url.startsWith("https://oauth2.googleapis.com/token"))).toHaveLength(2);
  });

  it("fails clearly without credentials outside dry-run", async () => {
    const play = new PlayClient({ config: defaultConfig(), env: {}, dryRun: false, secretRefs: {}, fetch: forbiddenFetch });
    await expect(play.accessToken()).rejects.toThrow(/PLAY_SERVICE_ACCOUNT_JSON/);
  });
});

describe("Play edits", () => {
  it("insert → listing → images → track → commit", async () => {
    const png = join(dir, "s1.png");
    writeFileSync(png, Buffer.alloc(300, 1));
    const { play, f } = client({
      routes: [
        { method: "POST", match: `${APP}/edits:`, json: {} },
        { method: "POST", match: `${APP}/edits`, json: { id: "EDIT1", expiryTimeSeconds: "1760000000" } },
        { method: "PUT", match: `${APP}/edits/EDIT1/listings/en-US`, json: (c) => c.json },
        { method: "DELETE", match: "/listings/en-US/phoneScreenshots", json: { deleted: [] } },
        { method: "POST", match: "/upload/androidpublisher/v3/applications/com.fast.astra/edits/EDIT1/listings/en-US/phoneScreenshots", json: { image: { id: "img1" } } },
        { method: "POST", match: "/listings/en-US/featureGraphic", json: { image: { id: "img2" } } },
        { method: "PUT", match: `${APP}/edits/EDIT1/tracks/production`, json: (c) => c.json },
      ],
    });
    const editId = await play.insertEdit(PKG);
    await play.updateListing(PKG, editId, { language: "en-US", title: "Astra", shortDescription: "Daily chart readings", fullDescription: "Long" });
    await play.deleteAllImages(PKG, editId, "en-US", "phoneScreenshots");
    await play.uploadImage(PKG, editId, "en-US", "phoneScreenshots", png);
    await play.updateTrack(PKG, editId, "production", [
      { versionCodes: ["42"], status: "inProgress", userFraction: 0.999, countryTargeting: { countries: ["CA", "AU"], includeRestOfWorld: false } },
    ]);
    await play.commitEdit(PKG, editId);
    const api = f.calls.filter((c) => !c.url.startsWith("https://oauth2"));
    expect(api.map((c) => `${c.method} ${c.url.replace("https://androidpublisher.googleapis.com", "")}`)).toEqual([
      `POST /androidpublisher/v3/applications/${PKG}/edits`,
      `PUT /androidpublisher/v3/applications/${PKG}/edits/EDIT1/listings/en-US`,
      `DELETE /androidpublisher/v3/applications/${PKG}/edits/EDIT1/listings/en-US/phoneScreenshots`,
      `POST /upload/androidpublisher/v3/applications/${PKG}/edits/EDIT1/listings/en-US/phoneScreenshots?uploadType=media`,
      `PUT /androidpublisher/v3/applications/${PKG}/edits/EDIT1/tracks/production`,
      `POST /androidpublisher/v3/applications/${PKG}/edits/EDIT1:commit`,
    ]);
    expect(api[1]!.json).toEqual({ language: "en-US", title: "Astra", shortDescription: "Daily chart readings", fullDescription: "Long" });
    expect(api[3]!.headers["content-type"]).toBe("image/png");
    expect(api[3]!.bodyBytes).toBe(300);
    await play.uploadImage(PKG, editId, "en-US", "featureGraphic", png, { aiGenerated: true });
    expect(f.calls.at(-1)!.url).toContain("/featureGraphic?uploadType=media&aiGeneratedState=aiGeneratedStateAiGeneratedDeveloperAttested");
    expect(api[4]!.json).toEqual({
      track: "production",
      releases: [{ versionCodes: ["42"], status: "inProgress", userFraction: 0.999, countryTargeting: { countries: ["CA", "AU"], includeRestOfWorld: false } }],
    });
  });

  it("keeps a hostile listing language inside its own path segment", async () => {
    const png = join(dir, "s2.png");
    writeFileSync(png, Buffer.alloc(10, 1));
    const f = fakeFetch([TOKEN_ROUTE, { match: "/listings/", json: {} }]);
    const paths: string[] = [];
    const play = new PlayClient({
      config: defaultConfig(),
      env: { PLAY_SERVICE_ACCOUNT_JSON: saPath },
      dryRun: false,
      secretRefs: { serviceAccountJsonPath: "PLAY_SERVICE_ACCOUNT_JSON" },
      fetch: ((input: string | URL | Request, init?: RequestInit) => {
        paths.push(new URL(String(input)).pathname);
        return f.fetch(input, init);
      }) as typeof fetch,
      clock: new SimClock("2026-10-18T12:00:00Z"),
      sleep: async () => undefined,
    });
    const language = "en-US/../../../subscriptions/X?";
    await play.updateListing(PKG, "E1", { language, title: "t", shortDescription: "s", fullDescription: "f" });
    await play.deleteAllImages(PKG, "E1", language, "phoneScreenshots");
    await play.uploadImage(PKG, "E1", language, "phoneScreenshots", png);
    const segment = encodeURIComponent(language);
    expect(paths.filter((p) => !p.startsWith("/token"))).toEqual([
      `/androidpublisher/v3/applications/${PKG}/edits/E1/listings/${segment}`,
      `/androidpublisher/v3/applications/${PKG}/edits/E1/listings/${segment}/phoneScreenshots`,
      `/upload/androidpublisher/v3/applications/${PKG}/edits/E1/listings/${segment}/phoneScreenshots`,
    ]);
  });

  it("uploads a bundle as media", async () => {
    const aab = join(dir, "app.aab");
    writeFileSync(aab, Buffer.alloc(1_024, 2));
    const { play, f } = client({ routes: [{ method: "POST", match: "/edits/E2/bundles?uploadType=media", json: { versionCode: 17, sha256: "x" } }] });
    expect(await play.uploadBundle(PKG, "E2", aab)).toBe(17);
    const call = f.calls.at(-1)!;
    expect(call.url).toBe(`https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${PKG}/edits/E2/bundles?uploadType=media`);
    expect(call.headers["content-type"]).toBe("application/octet-stream");
    expect(call.bodyBytes).toBe(1_024);
  });

  it("reads tracks inside a throwaway edit that is deleted afterwards", async () => {
    const { play, f } = client({
      routes: [
        { method: "POST", match: `${APP}/edits`, json: { id: "READ1" } },
        { method: "GET", match: `${APP}/edits/READ1/tracks`, json: { tracks: [{ track: "internal", releases: [{ status: "completed", versionCodes: ["5"] }] }] } },
        { method: "DELETE", match: `${APP}/edits/READ1`, status: 204 },
      ],
    });
    const tracks = await play.withReadEdit(PKG, (e) => play.listTracks(PKG, e));
    expect(tracks[0]?.releases?.[0]?.versionCodes).toEqual(["5"]);
    expect(f.calls.filter((c) => c.url.startsWith(PLAY_API)).map((c) => c.method)).toEqual(["POST", "GET", "DELETE"]);
  });
});

describe("Play monetization", () => {
  it("creates a subscription with converted regional prices, activates it and adds a free trial", async () => {
    const { play, f } = client({
      routes: [
        { method: "GET", match: `${APP}/subscriptions/com.fast.astra.week_699_t3`, status: 404, json: { error: { code: 404 } } },
        {
          method: "POST",
          match: `${APP}/pricing:convertRegionPrices`,
          json: {
            convertedRegionPrices: {
              CA: { regionCode: "CA", price: { currencyCode: "CAD", units: "9", nanos: 490000000 } },
              AU: { regionCode: "AU", price: { currencyCode: "AUD", units: "10", nanos: 990000000 } },
              JP: { regionCode: "JP", price: { currencyCode: "JPY", units: "1100" } },
            },
            regionVersion: { version: "2025/03" },
          },
        },
        { method: "POST", match: ":activate", json: {} },
        { method: "POST", match: `${APP}/subscriptions/com.fast.astra.week_699_t3/basePlans/week-699-t3/offers?`, json: (c) => c.json },
        { method: "POST", match: `${APP}/subscriptions?`, json: (c) => c.json },
      ],
    });
    expect(
      await play.upsertSubscription(PKG, {
        productId: "com.fast.astra.week_699_t3",
        basePlanId: "week-699-t3",
        title: "Astra Weekly",
        languageCode: "en-US",
        billingPeriod: "P1W",
        usdCents: 699,
        regions: ["ca", "AU"],
        trialDays: 3,
      }),
    ).toEqual({ created: true });
    const writes = f.writes().filter((c) => !c.url.startsWith("https://oauth2"));
    expect(writes.map((w) => w.url.replace(APP, ""))).toEqual([
      "/pricing:convertRegionPrices",
      "/subscriptions?productId=com.fast.astra.week_699_t3&regionsVersion.version=2025/03",
      "/subscriptions/com.fast.astra.week_699_t3/basePlans/week-699-t3:activate",
      "/subscriptions/com.fast.astra.week_699_t3/basePlans/week-699-t3/offers?offerId=trial-3d&regionsVersion.version=2025/03",
      "/subscriptions/com.fast.astra.week_699_t3/basePlans/week-699-t3/offers/trial-3d:activate",
    ]);
    expect(writes[0]!.json).toEqual({ price: { currencyCode: "USD", units: "6", nanos: 990000000 } });
    expect(writes[1]!.json).toEqual({
      packageName: PKG,
      productId: "com.fast.astra.week_699_t3",
      listings: [{ languageCode: "en-US", title: "Astra Weekly" }],
      basePlans: [
        {
          basePlanId: "week-699-t3",
          autoRenewingBasePlanType: { billingPeriodDuration: "P1W" },
          regionalConfigs: [
            { regionCode: "CA", newSubscriberAvailability: true, price: { currencyCode: "CAD", units: "9", nanos: 490000000 } },
            { regionCode: "AU", newSubscriberAvailability: true, price: { currencyCode: "AUD", units: "10", nanos: 990000000 } },
          ],
        },
      ],
    });
    expect(writes[3]!.json).toEqual({
      packageName: PKG,
      productId: "com.fast.astra.week_699_t3",
      basePlanId: "week-699-t3",
      offerId: "trial-3d",
      phases: [{ recurrenceCount: 1, duration: "P3D", regionalConfigs: [{ regionCode: "CA", free: {} }, { regionCode: "AU", free: {} }] }],
      regionalConfigs: [
        { regionCode: "CA", newSubscriberAvailability: true },
        { regionCode: "AU", newSubscriberAvailability: true },
      ],
      targeting: { acquisitionRule: { scope: { thisSubscription: {} } } },
    });
  });

  it("leaves an existing subscription untouched", async () => {
    const { play, f } = client({ routes: [{ method: "GET", match: `${APP}/subscriptions/p1`, json: { productId: "p1", basePlans: [{ basePlanId: "b", state: "ACTIVE" }] } }] });
    expect(await play.upsertSubscription(PKG, { productId: "p1", basePlanId: "b", title: "T", languageCode: "en-US", billingPeriod: "P1M", usdCents: 1499, regions: ["CA"], trialDays: 0 })).toEqual({
      created: false,
    });
    expect(f.writes().filter((c) => !c.url.startsWith("https://oauth2"))).toEqual([]);
  });

  it("formats USD money", () => {
    expect(usdMoney(699)).toEqual({ currencyCode: "USD", units: "6", nanos: 990000000 });
    expect(usdMoney(3999)).toEqual({ currencyCode: "USD", units: "39", nanos: 990000000 });
    expect(usdMoney(500)).toEqual({ currencyCode: "USD", units: "5", nanos: 0 });
  });
});

describe("Play reviews", () => {
  it("pages reviews and flattens the user comment", async () => {
    const { play } = client({
      routes: [
        {
          method: "GET",
          match: `${APP}/reviews?maxResults=100&token=p2`,
          json: { reviews: [{ reviewId: "r2", comments: [{ userComment: { text: "meh", starRating: 2, reviewerLanguage: "en_AU", lastModified: { seconds: "1760700000" } } }] }] },
        },
        {
          method: "GET",
          match: `${APP}/reviews?maxResults=100`,
          json: {
            reviews: [{ reviewId: "r1", comments: [{ userComment: { text: "love it", starRating: 5, reviewerLanguage: "en_CA", lastModified: { seconds: "1760790000" } } }] }],
            tokenPagination: { nextPageToken: "p2" },
          },
        },
      ],
    });
    const reviews = await play.listReviews(PKG);
    expect(reviews.map((r) => [r.reviewId, r.starRating, r.language])).toEqual([
      ["r1", 5, "en_CA"],
      ["r2", 2, "en_AU"],
    ]);
    expect(reviews[0]!.lastModified).toBe(new Date(1760790000 * 1000).toISOString());
  });
});

describe("Play dry-run", () => {
  it("without credentials never calls Google and returns dry_ ids", async () => {
    const recorder = new DryRunRecorder();
    const play = new PlayClient({ config: defaultConfig(), env: {}, dryRun: true, secretRefs: {}, fetch: forbiddenFetch, recorder });
    expect(play.offline).toBe(true);
    const editId = await play.insertEdit(PKG);
    expect(editId).toMatch(/^dry_edit_/);
    await play.updateTrack(PKG, editId, "production", [{ versionCodes: ["1"], status: "completed" }]);
    await play.commitEdit(PKG, editId);
    await play.upsertSubscription(PKG, { productId: "p", basePlanId: "b", title: "T", languageCode: "en-US", billingPeriod: "P1W", usdCents: 699, regions: ["CA"], trialDays: 3 });
    expect(await play.appExists(PKG)).toBeNull();
    expect(await play.listReviews(PKG)).toEqual([]);
    expect(recorder.list().map((r) => `${r.method} ${new URL(r.url).pathname.replace(`/androidpublisher/v3/applications/${PKG}`, "")}`)).toEqual([
      "POST /edits",
      `PUT /edits/${editId}/tracks/production`,
      `POST /edits/${editId}:commit`,
      "POST /subscriptions",
      "POST /subscriptions/p/basePlans/b:activate",
      "POST /subscriptions/p/basePlans/b/offers",
      "POST /subscriptions/p/basePlans/b/offers/trial-3d:activate",
    ]);
  });

  it("with credentials still fetches a token and reads, but records writes", async () => {
    const recorder = new DryRunRecorder();
    const { play, f } = client({ dryRun: true, recorder });
    const editId = await play.insertEdit(PKG);
    await play.updateTrack(PKG, editId, "production", []);
    expect(f.calls.map((c) => c.url)).toEqual(["https://oauth2.googleapis.com/token"]);
    expect(recorder.list()).toHaveLength(2);
    expect(recorder.list()[0]!.headers.authorization).toBe("<redacted>");
  });
});
