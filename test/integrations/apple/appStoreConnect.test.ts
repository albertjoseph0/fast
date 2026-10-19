import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { SimClock } from "../../../src/core/clock.ts";
import { defaultConfig } from "../../../src/config/schema.ts";
import { DryRunRecorder } from "../../../src/integrations/http.ts";
import { AscClient, sanitizeBundleName } from "../../../src/integrations/apple/appStoreConnect.ts";
import { ASC_TERRITORIES, fromAscTerritory, toAscTerritory } from "../../../src/integrations/apple/territories.ts";
import { fakeFetch, forbiddenFetch } from "./fakeFetch.ts";
import type { FakeRoute } from "./fakeFetch.ts";

const ASC = "https://api.appstoreconnect.apple.com";
const REFS = { keyId: "ASC_KEY_ID", issuerId: "ASC_ISSUER_ID", privateKeyPath: "ASC_PRIVATE_KEY_PATH" };

let dir: string;
let keyPath: string;
let publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"];
let env: Record<string, string>;

beforeAll(() => {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  publicKey = pair.publicKey;
  dir = mkdtempSync(join(tmpdir(), "asc-test-"));
  keyPath = join(dir, "AuthKey_TEST.p8");
  writeFileSync(keyPath, pair.privateKey.export({ type: "pkcs8", format: "pem" }));
  env = { ASC_KEY_ID: "KEY1234567", ASC_ISSUER_ID: "69a6de7e-0000-47e3-e053-5b8c7c11a4d1", ASC_PRIVATE_KEY_PATH: keyPath };
});

function client(opts: { routes?: FakeRoute[]; dryRun?: boolean; clock?: SimClock; env?: Record<string, string>; recorder?: DryRunRecorder; fetch?: typeof fetch } = {}) {
  const f = fakeFetch(opts.routes ?? []);
  const asc = new AscClient({
    config: defaultConfig(),
    env: opts.env ?? env,
    dryRun: opts.dryRun ?? false,
    secretRefs: REFS,
    fetch: opts.fetch ?? f.fetch,
    clock: opts.clock ?? new SimClock("2026-10-18T12:00:00Z"),
    sleep: async () => undefined,
    ...(opts.recorder ? { recorder: opts.recorder } : {}),
  });
  return { asc, f };
}

const res = (type: string, id: string, attributes: Record<string, unknown> = {}, relationships?: Record<string, unknown>) => ({
  type,
  id,
  attributes,
  ...(relationships ? { relationships } : {}),
});
const created = (call: { json?: any }) => ({ data: { ...call.json.data, id: `new_${call.json.data.type}`, attributes: call.json.data.attributes ?? {} } });

function decodeJwt(token: string) {
  const [h, p, s] = token.split(".") as [string, string, string];
  const json = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  return { header: json(h), payload: json(p), data: `${h}.${p}`, signature: Buffer.from(s, "base64url") };
}

describe("App Store Connect token", () => {
  it("is an ES256 JWT with kid, issuer, audience and a lifetime of at most 20 minutes", () => {
    const { asc } = client();
    const { header, payload, data, signature } = decodeJwt(asc.token());
    expect(header).toEqual({ alg: "ES256", typ: "JWT", kid: "KEY1234567" });
    expect(payload.iss).toBe(env.ASC_ISSUER_ID);
    expect(payload.aud).toBe("appstoreconnect-v1");
    expect(payload.iat).toBe(Date.parse("2026-10-18T12:00:00Z") / 1000);
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(20 * 60);
    expect(signature).toHaveLength(64);
    expect(verify("sha256", Buffer.from(data), { key: publicKey, dsaEncoding: "ieee-p1363" }, signature)).toBe(true);
  });

  it("is reused until a minute before expiry, then refreshed", () => {
    const clock = new SimClock("2026-10-18T12:00:00Z");
    const { asc } = client({ clock });
    const first = asc.token();
    clock.advanceHours(10 / 60);
    expect(asc.token()).toBe(first);
    clock.advanceHours(8.5 / 60);
    const second = asc.token();
    expect(second).not.toBe(first);
    expect(decodeJwt(second).payload.iat).toBe(decodeJwt(first).payload.iat + 18.5 * 60);
  });

  it("accepts the key inline and names missing variables", () => {
    const pem = (generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }) as string).replace(/\n/g, "\\n");
    const inline = new AscClient({ config: defaultConfig(), env: { ...env, ASC_PRIVATE_KEY_PATH: "", PEM: pem }, dryRun: false, secretRefs: { ...REFS, privateKey: "PEM" } });
    expect(decodeJwt(inline.token()).header.kid).toBe("KEY1234567");
    const missing = new AscClient({ config: defaultConfig(), env: {}, dryRun: false, secretRefs: REFS });
    expect(() => missing.token()).toThrow(/ASC_KEY_ID, ASC_ISSUER_ID, ASC_PRIVATE_KEY_PATH/);
    expect(missing.offline).toBe(false);
  });
});

describe("AscClient requests", () => {
  it("sends the bearer token and filters apps by exact bundle id", async () => {
    const { asc, f } = client({
      routes: [{ match: `${ASC}/v1/apps?`, json: { data: [res("apps", "111", { bundleId: "com.x.app.extra" }), res("apps", "222", { bundleId: "com.x.app" })] } }],
    });
    expect((await asc.findAppByBundleId("com.x.app"))?.id).toBe("222");
    const call = f.calls[0]!;
    expect(call.url).toBe(`${ASC}/v1/apps?filter[bundleId]=com.x.app&limit=10`);
    expect(call.headers.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it("registers a bundle id with capabilities", async () => {
    const { asc, f } = client({
      routes: [
        { method: "GET", match: "/v1/bundleIds?", json: { data: [] } },
        { method: "POST", match: "/v1/bundleIds", json: created },
        { method: "POST", match: "/v1/bundleIdCapabilities", json: created },
      ],
    });
    const out = await asc.registerBundleId({ identifier: "com.fast.astra", name: "Astra: AI astrology!", capabilities: ["PUSH_NOTIFICATIONS", "ASSOCIATED_DOMAINS"] });
    expect(out).toEqual({ id: "new_bundleIds", enabled: ["PUSH_NOTIFICATIONS", "ASSOCIATED_DOMAINS"] });
    const writes = f.writes();
    expect(writes[0]!.url).toBe(`${ASC}/v1/bundleIds`);
    expect(writes[0]!.json).toEqual({ data: { type: "bundleIds", attributes: { identifier: "com.fast.astra", name: "Astra AI astrology", platform: "IOS" } } });
    expect(writes[1]!.json).toEqual({
      data: { type: "bundleIdCapabilities", attributes: { capabilityType: "PUSH_NOTIFICATIONS" }, relationships: { bundleId: { data: { type: "bundleIds", id: "new_bundleIds" } } } },
    });
    expect(writes[2]!.json.data.attributes.capabilityType).toBe("ASSOCIATED_DOMAINS");
  });

  it("reuses an existing bundle id and only enables missing capabilities", async () => {
    const { asc, f } = client({
      routes: [
        { method: "GET", match: "/v1/bundleIds?", json: { data: [res("bundleIds", "B1", { identifier: "com.fast.astra" })] } },
        { method: "GET", match: "/v1/bundleIds/B1/bundleIdCapabilities", json: { data: [res("bundleIdCapabilities", "C1", { capabilityType: "PUSH_NOTIFICATIONS" })] } },
        { method: "POST", match: "/v1/bundleIdCapabilities", json: created },
      ],
    });
    expect(await asc.registerBundleId({ identifier: "com.fast.astra", name: "Astra", capabilities: ["PUSH_NOTIFICATIONS", "ASSOCIATED_DOMAINS"] })).toEqual({
      id: "B1",
      enabled: ["ASSOCIATED_DOMAINS"],
    });
    expect(f.writes()).toHaveLength(1);
  });

  it("updates an existing app info localization and creates a missing version localization", async () => {
    const { asc, f } = client({
      routes: [
        { method: "GET", match: "/v1/apps/A1/appInfos", json: { data: [res("appInfos", "INFO_LIVE", { state: "READY_FOR_DISTRIBUTION" }), res("appInfos", "INFO_EDIT", { state: "PREPARE_FOR_SUBMISSION" })] } },
        { method: "GET", match: "/v1/appInfos/INFO_EDIT/appInfoLocalizations", json: { data: [res("appInfoLocalizations", "L1", { locale: "en-US" })] } },
        { method: "PATCH", match: "/v1/appInfoLocalizations/L1", json: (c) => c.json },
        { method: "GET", match: "/v1/appStoreVersions/V1/appStoreVersionLocalizations", json: { data: [] } },
        { method: "POST", match: "/v1/appStoreVersionLocalizations", json: created },
      ],
    });
    const info = await asc.getAppInfo("A1");
    expect(info?.id).toBe("INFO_EDIT");
    await asc.upsertAppInfoLocalization("INFO_EDIT", "en-US", { name: "Astra", subtitle: "Daily chart readings", privacyPolicyUrl: "https://x.test/privacy" });
    await asc.upsertVersionLocalization("V1", "en-US", { description: "D", keywords: "a,b", promotionalText: "P", supportUrl: "https://x.test/support" });
    const [patch, post] = f.writes();
    expect(patch!.method).toBe("PATCH");
    expect(patch!.url).toBe(`${ASC}/v1/appInfoLocalizations/L1`);
    expect(patch!.json).toEqual({ data: { type: "appInfoLocalizations", id: "L1", attributes: { name: "Astra", subtitle: "Daily chart readings", privacyPolicyUrl: "https://x.test/privacy" } } });
    expect(post!.json).toEqual({
      data: {
        type: "appStoreVersionLocalizations",
        attributes: { locale: "en-US", description: "D", keywords: "a,b", promotionalText: "P", supportUrl: "https://x.test/support" },
        relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: "V1" } } },
      },
    });
  });

  it("creates a MANUAL-release version when none is editable, or renames the editable one", async () => {
    const none = client({ routes: [{ method: "GET", match: "/appStoreVersions?", json: { data: [] } }, { method: "POST", match: "/v1/appStoreVersions", json: created }] });
    await none.asc.ensureEditableVersion("A1", "1.0.1");
    expect(none.f.calls[0]!.url).toContain("filter[appVersionState]=PREPARE_FOR_SUBMISSION,DEVELOPER_REJECTED,REJECTED,METADATA_REJECTED,INVALID_BINARY,READY_FOR_REVIEW");
    expect(none.f.writes()[0]!.json).toEqual({
      data: { type: "appStoreVersions", attributes: { platform: "IOS", versionString: "1.0.1", releaseType: "MANUAL" }, relationships: { app: { data: { type: "apps", id: "A1" } } } },
    });
    const some = client({
      routes: [
        { method: "GET", match: "/appStoreVersions?", json: { data: [res("appStoreVersions", "V9", { versionString: "1.0.0" })] } },
        { method: "PATCH", match: "/v1/appStoreVersions/V9", json: (c) => c.json },
      ],
    });
    expect((await some.asc.ensureEditableVersion("A1", "1.0.1")).id).toBe("V9");
    expect(some.f.writes()[0]!.json).toEqual({ data: { type: "appStoreVersions", id: "V9", attributes: { versionString: "1.0.1" } } });
  });

  it("uploads a screenshot: set → reservation → PUT upload operations → commit with MD5", async () => {
    const png = join(dir, "shot-1.png");
    const bytes = Buffer.alloc(2_000, 7);
    writeFileSync(png, bytes);
    const { asc, f } = client({
      routes: [
        { method: "GET", match: "/v1/appStoreVersionLocalizations/LOC1/appScreenshotSets", json: { data: [] } },
        { method: "POST", match: "/v1/appScreenshotSets", json: created },
        { method: "GET", match: "/v1/appScreenshotSets/new_appScreenshotSets/appScreenshots", json: { data: [res("appScreenshots", "OLD1")] } },
        { method: "DELETE", match: "/v1/appScreenshots/OLD1", status: 204, text: "" },
        {
          method: "POST",
          match: "/v1/appScreenshots",
          json: {
            data: res("appScreenshots", "SS1", {
              fileName: "shot-1.png",
              fileSize: 2_000,
              uploadOperations: [
                { method: "PUT", url: "https://upload.example/part1", offset: 0, length: 1_200, requestHeaders: [{ name: "Content-Type", value: "image/png" }] },
                { method: "PUT", url: "https://upload.example/part2", offset: 1_200, length: 800, requestHeaders: [{ name: "Content-Type", value: "image/png" }] },
              ],
            }),
          },
        },
        { method: "PUT", match: "https://upload.example/", status: 200, text: "" },
        { method: "PATCH", match: "/v1/appScreenshots/SS1", json: (c) => c.json },
      ],
    });
    expect(await asc.replaceScreenshots("LOC1", [png])).toEqual(["SS1"]);
    expect(f.calls.map((c) => `${c.method} ${c.url.replace(ASC, "")}`)).toEqual([
      "GET /v1/appStoreVersionLocalizations/LOC1/appScreenshotSets?filter[screenshotDisplayType]=APP_IPHONE_67",
      "POST /v1/appScreenshotSets",
      "GET /v1/appScreenshotSets/new_appScreenshotSets/appScreenshots",
      "DELETE /v1/appScreenshots/OLD1",
      "POST /v1/appScreenshots",
      "PUT https://upload.example/part1",
      "PUT https://upload.example/part2",
      "PATCH /v1/appScreenshots/SS1",
    ]);
    expect(f.calls[1]!.json.data).toEqual({
      type: "appScreenshotSets",
      attributes: { screenshotDisplayType: "APP_IPHONE_67" },
      relationships: { appStoreVersionLocalization: { data: { type: "appStoreVersionLocalizations", id: "LOC1" } } },
    });
    expect(f.calls[4]!.json.data.attributes).toEqual({ fileName: "shot-1.png", fileSize: 2_000 });
    const [part1, part2] = [f.calls[5]!, f.calls[6]!];
    expect(part1.headers["content-type"]).toBe("image/png");
    expect(part1.headers.authorization).toBeUndefined();
    expect([part1.bodyBytes, part2.bodyBytes]).toEqual([1_200, 800]);
    expect(f.calls[7]!.json).toEqual({
      data: { type: "appScreenshots", id: "SS1", attributes: { uploaded: true, sourceFileChecksum: createHash("md5").update(bytes).digest("hex") } },
    });
  });

  it("creates v2 availability with every territory listed when none exists", async () => {
    const { asc, f } = client({
      routes: [
        { method: "GET", match: "/v1/apps/A1/appAvailabilityV2", status: 404, json: { errors: [] } },
        { method: "GET", match: "/v1/territories", json: { data: ["USA", "CAN", "AUS", "NZL", "GBR"].map((t) => res("territories", t, { currency: "X" })) } },
        { method: "POST", match: "/v2/appAvailabilities", json: created },
      ],
    });
    await asc.setTerritories("A1", ["CA", "AU", "NZ"]);
    const body = f.writes()[0]!.json;
    expect(body.data.attributes).toEqual({ availableInNewTerritories: false });
    expect(body.data.relationships.app).toEqual({ data: { type: "apps", id: "A1" } });
    expect(body.data.relationships.territoryAvailabilities.data).toContainEqual({ type: "territoryAvailabilities", id: "${ta-CAN}" });
    const avail = Object.fromEntries(body.included.map((i: any) => [i.relationships.territory.data.id, i.attributes.available]));
    expect(avail).toEqual({ AUS: true, CAN: true, GBR: false, NZL: true, USA: false });
    expect(body.included[0]).toMatchObject({ type: "territoryAvailabilities", id: "${ta-AUS}" });
  });

  it("patches only the territory availabilities that change", async () => {
    const ta = (id: string, t: string, available: boolean) => res("territoryAvailabilities", id, { available }, { territory: { data: { type: "territories", id: t } } });
    const { asc, f } = client({
      routes: [
        { method: "GET", match: "/v1/apps/A1/appAvailabilityV2", json: { data: res("appAvailabilities", "AV1") } },
        { method: "GET", match: "/v2/appAvailabilities/AV1/territoryAvailabilities", json: { data: [ta("t1", "USA", true), ta("t2", "CAN", true), ta("t3", "AUS", false)] } },
        { method: "PATCH", match: "/v1/territoryAvailabilities/", json: (c) => c.json },
      ],
    });
    await asc.setTerritories("A1", ["CA", "AU"]);
    expect(f.writes().map((w) => [w.url.replace(ASC, ""), w.json.data.attributes.available])).toEqual([
      ["/v1/territoryAvailabilities/t1", false],
      ["/v1/territoryAvailabilities/t3", true],
    ]);
    expect(f.calls[1]!.url).toContain("include=territory");
  });

  it("creates a subscription group, subscription, prices, availability and free trials", async () => {
    const point = (id: string, price: string, t = "USA") => res("subscriptionPricePoints", id, { customerPrice: price }, { territory: { data: { type: "territories", id: t } } });
    const { asc, f } = client({
      routes: [
        { method: "GET", match: "/v1/apps/A1/subscriptionGroups", json: { data: [] } },
        { method: "POST", match: "/v1/subscriptionGroups", json: created },
        { method: "GET", match: "/subscriptionGroupLocalizations", json: { data: [] } },
        { method: "POST", match: "/v1/subscriptionGroupLocalizations", json: created },
        { method: "GET", match: "/v1/subscriptionGroups/new_subscriptionGroups/subscriptions", json: { data: [] } },
        { method: "POST", match: "/v1/subscriptions", json: created },
        { method: "POST", match: "/v1/subscriptionLocalizations", json: created },
        {
          method: "GET",
          match: "/v1/subscriptions/new_subscriptions/pricePoints?filter[territory]=USA&limit=200",
          once: true,
          json: { data: [point("pp-499", "4.99"), point("pp-599", "5.99")], links: { next: `${ASC}/v1/subscriptions/new_subscriptions/pricePoints?cursor=2` } },
        },
        { method: "GET", match: "pricePoints?cursor=2", json: { data: [point("pp-699", "6.99")] } },
        { method: "GET", match: "/v1/subscriptionPricePoints/pp-699/equalizations", json: { data: [point("eq-can", "9.99", "CAN"), point("eq-aus", "10.99", "AUS")] } },
        { method: "POST", match: "/v1/subscriptionPrices", json: created },
        { method: "POST", match: "/v1/subscriptionPlanAvailabilities", json: created },
        { method: "GET", match: "/introductoryOffers", json: { data: [] } },
        { method: "POST", match: "/v1/subscriptionIntroductoryOffers", json: created },
      ],
    });
    const group = await asc.ensureSubscriptionGroup("A1", "Astra Pro", { locale: "en-US", name: "Astra Pro" });
    const { subscription, created: isNew } = await asc.ensureSubscription(group.id, { productId: "com.fast.astra.week_699_t3", name: "Weekly week_699_t3", displayName: "Weekly", period: "week", groupLevel: 1 }, "en-US");
    expect(isNew).toBe(true);
    expect(await asc.setSubscriptionPrices(subscription.id, 699, ["CA", "AU"])).toBe(3);
    await asc.setSubscriptionAvailability(subscription.id, ["CA", "AU"]);
    expect(await asc.ensureFreeTrial(subscription.id, 3, ["CA", "AU"])).toBe(2);

    const posts = f.writes().map((w) => [w.url.replace(ASC, ""), w.json.data]);
    expect(posts[0]).toEqual(["/v1/subscriptionGroups", { type: "subscriptionGroups", attributes: { referenceName: "Astra Pro" }, relationships: { app: { data: { type: "apps", id: "A1" } } } }]);
    expect(posts[1]![1]).toMatchObject({ type: "subscriptionGroupLocalizations", attributes: { locale: "en-US", name: "Astra Pro" } });
    expect(posts[2]).toEqual([
      "/v1/subscriptions",
      {
        type: "subscriptions",
        attributes: { name: "Weekly week_699_t3", productId: "com.fast.astra.week_699_t3", subscriptionPeriod: "ONE_WEEK", groupLevel: 1, familySharable: false },
        relationships: { group: { data: { type: "subscriptionGroups", id: "new_subscriptionGroups" } } },
      },
    ]);
    expect(posts[3]![1]).toEqual({ type: "subscriptionLocalizations", attributes: { locale: "en-US", name: "Weekly" }, relationships: { subscription: { data: { type: "subscriptions", id: "new_subscriptions" } } } });
    const prices = posts.filter(([u]) => u === "/v1/subscriptionPrices").map(([, d]) => [d.relationships.territory.data.id, d.relationships.subscriptionPricePoint.data.id]);
    expect(prices).toEqual([
      ["USA", "pp-699"],
      ["CAN", "eq-can"],
      ["AUS", "eq-aus"],
    ]);
    const availability = posts.find(([u]) => u === "/v1/subscriptionPlanAvailabilities")![1];
    expect(availability.attributes).toEqual({ availableInNewTerritories: false, planType: "UPFRONT" });
    expect(availability.relationships.availableTerritories.data).toEqual([
      { type: "territories", id: "CAN" },
      { type: "territories", id: "AUS" },
    ]);
    const trial = posts.find(([u]) => u === "/v1/subscriptionIntroductoryOffers")![1];
    expect(trial).toEqual({
      type: "subscriptionIntroductoryOffers",
      attributes: { duration: "THREE_DAYS", offerMode: "FREE_TRIAL", numberOfPeriods: 1 },
      relationships: { subscription: { data: { type: "subscriptions", id: "new_subscriptions" } }, territory: { data: { type: "territories", id: "CAN" } } },
    });
    expect(f.calls.find((c) => c.url.includes("/equalizations"))!.url).toContain("filter[territory]=CAN,AUS");
  });

  it("refuses to invent a price the App Store does not offer", async () => {
    const { asc } = client({ routes: [{ method: "GET", match: "/pricePoints", json: { data: [] } }] });
    await expect(asc.setSubscriptionPrices("S1", 701, [])).rejects.toThrow(/No App Store price point at 7.01 USD/);
    await expect(asc.ensureFreeTrial("S1", 5, ["CA"])).rejects.toThrow(/Unsupported/);
  });

  it("looks builds up by build number and marketing version", async () => {
    const { asc, f } = client({ routes: [{ method: "GET", match: "/v1/builds?", json: { data: [res("builds", "BUILD1", { processingState: "VALID", version: "12" })] } }] });
    expect((await asc.findBuild("A1", { version: "12", shortVersion: "1.0.1" }))?.attributes.processingState).toBe("VALID");
    expect(f.calls[0]!.url).toBe(
      `${ASC}/v1/builds?filter[app]=A1&filter[version]=12&filter[preReleaseVersion.version]=1.0.1&filter[preReleaseVersion.platform]=IOS&sort=-uploadedDate&limit=5`,
    );
  });

  it("submits for review: create submission → add version item → PATCH submitted", async () => {
    const { asc, f } = client({
      routes: [
        { method: "GET", match: "/v1/apps/A1/reviewSubmissions", json: { data: [] } },
        { method: "POST", match: "/v1/reviewSubmissions", json: created },
        { method: "POST", match: "/v1/reviewSubmissionItems", json: created },
        { method: "PATCH", match: "/v1/reviewSubmissions/new_reviewSubmissions", json: (c) => c.json },
      ],
    });
    expect(await asc.submitForReview("A1", "V1")).toBe("new_reviewSubmissions");
    const [create, item, submit] = f.writes();
    expect(f.calls[0]!.url).toContain("filter[state]=READY_FOR_REVIEW");
    expect(create!.json).toEqual({ data: { type: "reviewSubmissions", attributes: { platform: "IOS" }, relationships: { app: { data: { type: "apps", id: "A1" } } } } });
    expect(item!.json).toEqual({
      data: {
        type: "reviewSubmissionItems",
        relationships: { reviewSubmission: { data: { type: "reviewSubmissions", id: "new_reviewSubmissions" } }, appStoreVersion: { data: { type: "appStoreVersions", id: "V1" } } },
      },
    });
    expect(submit!.json).toEqual({ data: { type: "reviewSubmissions", id: "new_reviewSubmissions", attributes: { submitted: true } } });
  });

  it("attaches the build, writes review notes, and releases with a phased rollout", async () => {
    const { asc, f } = client({
      routes: [
        { method: "PATCH", match: "/relationships/build", status: 204, text: "" },
        { method: "GET", match: "/v1/appStoreVersions/V1/appStoreReviewDetail", json: { data: null } },
        { method: "POST", match: "/v1/appStoreReviewDetails", json: created },
        { method: "GET", match: "/v1/appStoreVersions/V1/appStoreVersionPhasedRelease", json: { data: null } },
        { method: "POST", match: "/v1/appStoreVersionPhasedReleases", json: created },
        { method: "POST", match: "/v1/appStoreVersionReleaseRequests", json: created },
      ],
    });
    await asc.attachBuild("V1", "BUILD1");
    await asc.upsertReviewDetail("V1", { notes: "Tap Start; the verdict appears after 3 questions.", contactEmail: "a@b.test" });
    await asc.enablePhasedRelease("V1");
    await asc.requestRelease("V1");
    const w = f.writes();
    expect(w[0]!.url).toBe(`${ASC}/v1/appStoreVersions/V1/relationships/build`);
    expect(w[0]!.json).toEqual({ data: { type: "builds", id: "BUILD1" } });
    expect(w[1]!.json.data).toMatchObject({ type: "appStoreReviewDetails", attributes: { notes: "Tap Start; the verdict appears after 3 questions.", contactEmail: "a@b.test" } });
    expect(w[2]!.json).toEqual({
      data: { type: "appStoreVersionPhasedReleases", attributes: { phasedReleaseState: "ACTIVE" }, relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: "V1" } } } },
    });
    expect(w[3]!.json).toEqual({ data: { type: "appStoreVersionReleaseRequests", relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: "V1" } } } } });
  });

  it("pages customer reviews newest-first and stops at `since`", async () => {
    const review = (id: string, date: string, territory: string, rating: number) => res("customerReviews", id, { createdDate: date, territory, rating, title: "t", body: "b" });
    const { asc, f } = client({
      routes: [
        {
          match: "customerReviews?sort",
          json: { data: [review("r1", "2026-10-17T10:00:00Z", "CAN", 5), review("r2", "2026-10-16T10:00:00Z", "AUS", 1)], links: { next: `${ASC}/v1/apps/A1/customerReviews?cursor=2` } },
        },
        { match: "customerReviews?cursor=2", json: { data: [review("r3", "2026-10-15T10:00:00Z", "NZL", 3), review("r4", "2026-10-01T00:00:00Z", "USA", 4)] } },
      ],
    });
    const out = await asc.customerReviews("A1", "2026-10-10");
    expect(out.map((r) => [r.id, r.territory, r.rating])).toEqual([
      ["r1", "CA", 5],
      ["r2", "AU", 1],
      ["r3", "NZ", 3],
    ]);
    expect(f.calls[0]!.url).toBe(`${ASC}/v1/apps/A1/customerReviews?sort=-createdDate&limit=200`);
  });
});

describe("AscClient dry-run", () => {
  it("without credentials never calls Apple and answers writes with dry_ ids", async () => {
    const recorder = new DryRunRecorder();
    const asc = new AscClient({ config: defaultConfig(), env: {}, dryRun: true, secretRefs: REFS, fetch: forbiddenFetch, recorder });
    expect(asc.offline).toBe(true);
    const png = join(dir, "dry.png");
    writeFileSync(png, Buffer.alloc(10));
    const bundle = await asc.registerBundleId({ identifier: "com.fast.dry", name: "Dry", capabilities: ["PUSH_NOTIFICATIONS"] });
    expect(bundle.id).toMatch(/^dry_bundleIds_/);
    const version = await asc.ensureEditableVersion("dry_apps_x", "1.0.0");
    const loc = await asc.upsertVersionLocalization(version.id, "en-US", { description: "x" });
    const shots = await asc.replaceScreenshots(loc.id, [png]);
    expect(shots[0]).toMatch(/^dry_appScreenshots_/);
    await asc.setTerritories("dry_apps_x", ["CA"]);
    const records = recorder.list();
    expect(records.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      "POST /v1/bundleIds",
      "POST /v1/bundleIdCapabilities",
      "POST /v1/appStoreVersions",
      "POST /v1/appStoreVersionLocalizations",
      "POST /v1/appScreenshotSets",
      "POST /v1/appScreenshots",
      `PUT /asc-upload/${shots[0]}`,
      `PATCH /v1/appScreenshots/${shots[0]}`,
      "POST /v2/appAvailabilities",
    ]);
  });

  it("with credentials sends reads only and records writes with the token redacted", async () => {
    const recorder = new DryRunRecorder();
    const { asc, f } = client({ dryRun: true, recorder, routes: [{ method: "GET", match: "/v1/bundleIds?", json: { data: [] } }] });
    await asc.registerBundleId({ identifier: "com.fast.dry", name: "Dry", capabilities: ["ASSOCIATED_DOMAINS"] });
    expect(f.calls.map((c) => c.method)).toEqual(["GET"]);
    expect(recorder.list()).toHaveLength(2);
    expect(recorder.list()[0]!.headers.authorization).toBe("<redacted>");
  });
});

describe("territories and names", () => {
  it("maps storefront codes to App Store territory ids and back", () => {
    expect(ASC_TERRITORIES).toHaveLength(233);
    expect(["CA", "AU", "NZ", "US", "gb", "UK"].map(toAscTerritory)).toEqual(["CAN", "AUS", "NZL", "USA", "GBR", "GBR"]);
    expect(toAscTerritory("CAN")).toBe("CAN");
    expect(fromAscTerritory("NZL")).toBe("NZ");
    expect(() => toAscTerritory("QQ")).toThrow(/Unknown/);
    for (const t of ASC_TERRITORIES) expect(toAscTerritory(fromAscTerritory(t))).toBe(t);
  });

  it("sanitizes bundle id names", () => {
    expect(sanitizeBundleName("Astra: love & stars!")).toBe("Astra love stars");
    expect(sanitizeBundleName("***")).toBe("App");
  });
});
