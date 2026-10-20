import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { SimClock } from "../../src/core/clock.ts";
import { StudioStore } from "../../src/core/store.ts";
import type { ExternalJob, JobRef, StoreListing, StoreProductDef, Venture, VentureBindings } from "../../src/core/types.ts";
import { defaultConfig } from "../../src/config/schema.ts";
import { DryRunRecorder } from "../../src/integrations/http.ts";
import { PLAY_TARGETED_FRACTION, androidStoreStatus, basePlanId, createLiveStorePorts, iosReviewPoll, iosStoreStatus } from "../../src/integrations/stores.ts";
import type { EasRunner } from "../../src/integrations/expo/eas.ts";
import { fakeFetch, forbiddenFetch } from "./apple/fakeFetch.ts";
import type { FakeRoute } from "./apple/fakeFetch.ts";

const ASC = "https://api.appstoreconnect.apple.com";
const PLAY = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.fast.astra";
const clock = new SimClock("2026-10-18T12:00:00Z");
let liveEnv: Record<string, string>;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "stores-test-"));
  const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  writeFileSync(join(dir, "key.p8"), ec.privateKey.export({ type: "pkcs8", format: "pem" }));
  writeFileSync(join(dir, "sa.json"), JSON.stringify({ client_email: "sa@x.iam.gserviceaccount.com", private_key: rsa.privateKey.export({ type: "pkcs8", format: "pem" }) }));
  liveEnv = {
    ASC_KEY_ID: "KEYDEFAULT",
    ASC_ISSUER_ID: "issuer-1",
    ASC_PRIVATE_KEY_PATH: join(dir, "key.p8"),
    TEAM_KEY_ID: "KEYTEAM",
    PLAY_SERVICE_ACCOUNT_JSON: join(dir, "sa.json"),
    EXPO_TOKEN: "expo-token",
  };
});

function bindings(patch: Partial<VentureBindings> = {}): VentureBindings {
  return {
    platforms: ["ios", "android"],
    publisherAccountIds: {},
    bundleId: "com.fast.astra",
    androidPackage: "com.fast.astra",
    ownedAccountIds: {},
    adAccountIds: {},
    products: [],
    ...patch,
  };
}

function venture(patch: Partial<Venture> = {}): Venture {
  return {
    id: "ven_000001",
    ideaId: "idea_000001",
    screeningId: "scr_000001",
    name: "Astra",
    slug: "astra",
    wedge: "zodiac TikTok",
    stage: "building",
    ladder: { kind: "single_player", steps: [["S1_distribution"]], stepIndex: 0, validated: [], currentExperimentId: null, experimentIds: [], iteration: 0, harnessFixes: 0, stepStartedAt: null },
    specVersion: 1,
    specHistory: [],
    baseline: { specVersion: 1, hookIds: [], paywallVariantId: null, onboardingVariantId: null },
    stores: [
      { platform: "ios", publisherAccountId: "pub_ios", bundleId: "com.fast.astra", status: "draft", territories: ["CA", "AU", "NZ"], rejectionReasons: [], updatedAt: clock.iso() },
      { platform: "android", publisherAccountId: "pub_play", bundleId: "com.fast.astra", status: "draft", territories: ["CA", "AU"], rejectionReasons: [], updatedAt: clock.iso() },
    ],
    bindings: bindings(),
    build: { projectDir: "/ventures/astra", version: "1.0.2", buildNumber: 7, specVersion: 1, checks: [], builtAt: clock.iso() },
    blockedOn: [],
    blockedMs: 0,
    timeboxStartedAt: null,
    history: [],
    createdAt: clock.iso(),
    updatedAt: clock.iso(),
    ...patch,
  } as Venture;
}

function setup(opts: { dryRun?: boolean; env?: Record<string, string>; routes?: FakeRoute[]; fetch?: typeof fetch; runner?: EasRunner; venture?: Venture } = {}) {
  const store = new StudioStore(null, clock);
  store.ventures.put(opts.venture ?? venture());
  const f = fakeFetch(opts.routes ?? []);
  const recorder = new DryRunRecorder();
  const ports = createLiveStorePorts({
    config: defaultConfig(),
    store,
    env: opts.env ?? {},
    dryRun: opts.dryRun ?? true,
    recorder,
    fetch: opts.fetch ?? f.fetch,
    clock,
    sleep: async () => undefined,
    ...(opts.runner ? { runner: opts.runner } : {}),
  });
  return { ...ports, store, f, recorder };
}

const forbiddenRunner: EasRunner = async (cmd, args) => {
  throw new Error(`unexpected spawn: ${cmd} ${args.join(" ")}`);
};

function job(ref: JobRef, ventureId = "ven_000001"): ExternalJob {
  return { id: "job_1", op: ref.op, ventureId, actionId: "act_1", externalRef: ref.externalRef, status: "running", nextPollAt: clock.iso(), deadlineAt: clock.iso(), attempts: 0, createdAt: clock.iso() };
}

const listing: StoreListing = {
  locale: "en-US",
  name: "Astra",
  subtitle: "Your chart, decoded",
  description: "Readings from your birth chart.",
  keywords: "astrology,zodiac",
  promotionalText: "New: weekly compatibility",
  supportUrl: "https://astra.test/support",
  privacyUrl: "https://astra.test/privacy",
};
const products: StoreProductDef[] = [{ productId: "com.fast.astra.week_699_t3", ladderId: "week_699_t3", period: "week", usdCents: 699, trialDays: 3, displayName: "Weekly", territories: [] }];

describe("createApp", () => {
  it("iOS returns the apple.create_app human task with the values to enter", async () => {
    const { write, f } = setup({ fetch: forbiddenFetch });
    const out = await write.createApp({ bindings: bindings(), platform: "ios", name: "Astra", sku: "ASTRA-001", primaryLocale: "en-US" });
    expect("humanTask" in out).toBe(true);
    if (!("humanTask" in out)) return;
    const task = out.humanTask;
    expect(task.kind).toBe("apple.create_app");
    expect(task.ventureId).toBe("ven_000001");
    expect(task.instructions).toContain("https://appstoreconnect.apple.com/apps");
    for (const value of ["`Astra`", "`com.fast.astra`", "`ASTRA-001`", "`en-US`"]) expect(task.instructions).toContain(value);
    expect(task.inputs).toEqual([{ key: "ascAppId", label: "Apple ID of the new app", pattern: "^\\d{9,11}$" }]);
    const pattern = new RegExp(task.inputs[0]!.pattern!);
    expect(pattern.test("6448311069")).toBe(true);
    expect(pattern.test("abc")).toBe(false);
    expect(f.calls).toEqual([]);
  });

  it("Android returns the play.create_app human task", async () => {
    const { write } = setup({ fetch: forbiddenFetch });
    const out = await write.createApp({ bindings: bindings(), platform: "android", name: "Astra", sku: "ASTRA-001", primaryLocale: "en-US" });
    if (!("humanTask" in out)) throw new Error("expected a human task");
    expect(out.humanTask.kind).toBe("play.create_app");
    expect(out.humanTask.instructions).toContain("https://play.google.com/console");
    const input = out.humanTask.inputs[0]!;
    expect(input.key).toBe("playUrl");
    expect(new RegExp(input.pattern!).test("https://play.google.com/store/apps/details?id=com.fast.astra")).toBe(true);
    expect(new RegExp(input.pattern!).test("https://play.google.com/store/apps/details?id=com.fastXastra")).toBe(false);
  });

  it("iOS returns the existing app id when App Store Connect already has the bundle", async () => {
    const { write, f } = setup({
      dryRun: false,
      env: liveEnv,
      routes: [{ match: `${ASC}/v1/apps?`, json: { data: [{ type: "apps", id: "6400000001", attributes: { bundleId: "com.fast.astra" } }] } }],
    });
    expect(await write.createApp({ bindings: bindings(), platform: "ios", name: "Astra", sku: "S", primaryLocale: "en-US" })).toEqual({ appId: "6400000001" });
    expect(f.calls[0]!.url).toContain("filter[bundleId]=com.fast.astra");
  });
});

describe("dry-run writes", () => {
  it("never call fetch or spawn, record the plan, and poll as succeeded", async () => {
    const { write, read, recorder } = setup({ fetch: forbiddenFetch, runner: forbiddenRunner });
    const shot = join(mkdtempSync(join(tmpdir(), "shots-")), "1.png");
    writeFileSync(shot, Buffer.alloc(64));
    const refs: JobRef[] = [];
    for (const platform of ["ios", "android"] as const) {
      const b = bindings();
      await write.registerBundleId({ bindings: b, platform, capabilities: ["push", "associated_domains"] });
      refs.push(await write.upsertSubscriptions({ bindings: b, platform, groupName: "Astra Pro", products }));
      refs.push(await write.startBuild({ bindings: b, platform, projectDir: "/ventures/astra" }));
      refs.push(await write.submitBuild({ bindings: b, platform, easBuildId: "eas-1" }));
      refs.push(await write.updateListing({ bindings: b, platform, listing, screenshotPaths: [shot] }));
      await write.setTerritories({ bindings: b, platform, territories: ["CA", "AU"] });
      refs.push(await write.submitForReview({ bindings: b, platform, storeBuildId: "7", notesForReviewer: "Tap Start." }));
      await write.release({ bindings: b, platform, phased: true }).catch((err: unknown) => {
        // Play has no production release to roll out in an offline dry run.
        expect(platform).toBe("android");
        expect(String(err)).toContain("no production release");
      });
      await write.removeFromSale({ bindings: b, platform });
    }
    expect(refs.map((r) => r.op)).toEqual([
      "store.upsert_subscriptions",
      "store.build",
      "store.submit_build",
      "store.update_listing",
      "store.review",
      "store.upsert_subscriptions",
      "store.build",
      "store.submit_build",
      "store.update_listing",
      "store.review",
    ]);
    expect(refs.every((r) => r.externalRef.dryRun === "dry_run")).toBe(true);
    const services = new Set(recorder.list().map((r) => r.service));
    expect([...services].sort()).toEqual(["asc", "eas", "play"]);
    const paths = recorder.list().map((r) => `${r.method} ${new URL(r.url).pathname}`);
    expect(paths).toContain("POST /v1/subscriptionIntroductoryOffers");
    expect(paths).toContain("POST /v1/reviewSubmissions");
    expect(paths).toContain("POST /v1/appStoreVersionReleaseRequests");
    expect(paths.filter((p) => p === "POST /v2/appAvailabilities")).toHaveLength(2);

    const polls = await Promise.all(refs.map((r) => read.poll(job(r))));
    expect(polls.every((p) => p.status === "succeeded")).toBe(true);
    expect(polls[1]!.result).toMatchObject({ easBuildId: refs[1]!.externalRef.easBuildId });
    expect(polls[2]!.result?.storeBuildId).toMatch(/^dry_build_/);
    expect(polls[4]!.result).toMatchObject({ reviewState: "approved" });
  });

  it("read ports return nothing offline", async () => {
    const { read } = setup({ fetch: forbiddenFetch });
    expect(await read.status({ bindings: bindings(), platform: "ios" })).toEqual({ platform: "ios", bundleId: "com.fast.astra" });
    expect(await read.reviews({ bindings: bindings(), platform: "android", since: "2026-10-01" })).toEqual([]);
  });
});

describe("credential resolution", () => {
  it("uses the venture's publisher account secretRefs", async () => {
    const { store, write, f } = setup({ dryRun: false, env: liveEnv, routes: [{ match: `${ASC}/v1/apps?`, json: { data: [] } }] });
    store.publishers.put({ id: "pub_team", entityId: "ent_1", platform: "ios", externalTeamId: "TEAM1", kind: "organization", status: "active", secretRefs: { keyId: "TEAM_KEY_ID", issuerId: "ASC_ISSUER_ID", privateKeyPath: "ASC_PRIVATE_KEY_PATH" } });
    await write.createApp({ bindings: bindings({ publisherAccountIds: { ios: "pub_team" } }), platform: "ios", name: "Astra", sku: "S", primaryLocale: "en-US" });
    const token = f.calls[0]!.headers.authorization!.replace("Bearer ", "");
    expect(JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString()).kid).toBe("KEYTEAM");
  });

  it("refuses to act through a suspended publisher account", async () => {
    const { store, write } = setup({ fetch: forbiddenFetch });
    store.publishers.put({ id: "pub_bad", entityId: "ent_1", platform: "ios", externalTeamId: "T", kind: "organization", status: "suspended", secretRefs: {} });
    await expect(write.registerBundleId({ bindings: bindings({ publisherAccountIds: { ios: "pub_bad" } }), platform: "ios", capabilities: [] })).rejects.toThrow(/suspended/);
  });
});

describe("live iOS flows (fake App Store Connect)", () => {
  const created = (c: { json?: any }) => ({ data: { ...c.json.data, id: `new_${c.json.data.type}`, attributes: c.json.data.attributes ?? {} } });

  const contactEnv = { ASC_REVIEW_CONTACT_FIRST_NAME: "Ada", ASC_REVIEW_CONTACT_LAST_NAME: "Lovelace", ASC_REVIEW_CONTACT_PHONE: "+1 415 555 0100" };
  const product = { productId: "com.fast.astra.week_699_t3", ladderId: "week_699_t3", platform: "ios" as const, status: "created" as const };

  it("submitForReview fills the required metadata and submits the version with its first subscriptions", async () => {
    const { write, f } = setup({
      dryRun: false,
      env: { ...liveEnv, ...contactEnv },
      routes: [
        { method: "GET", match: "/appStoreVersions?", json: { data: [{ type: "appStoreVersions", id: "V1", attributes: { versionString: "1.0.2" } }] } },
        { method: "PATCH", match: "/v1/appStoreVersions/V1/relationships/build", status: 204 },
        { method: "PATCH", match: "/v1/appStoreVersions/V1", json: (c) => c.json },
        { method: "GET", match: /\/v1\/apps\/6400000001$/, json: { data: { type: "apps", id: "6400000001", attributes: { contentRightsDeclaration: null } } } },
        { method: "PATCH", match: "/v1/apps/6400000001", json: (c) => c.json },
        { method: "GET", match: "/v1/apps/6400000001/appPriceSchedule", json: { data: null } },
        { method: "GET", match: "/v1/apps/6400000001/appPricePoints", json: { data: [{ type: "appPricePoints", id: "PP0.99", attributes: { customerPrice: "0.99" } }, { type: "appPricePoints", id: "PP0", attributes: { customerPrice: "0.0" } }] } },
        { method: "POST", match: "/v1/appPriceSchedules", json: created },
        { method: "GET", match: "/appStoreReviewDetail", json: { data: { type: "appStoreReviewDetails", id: "RD1", attributes: {} } } },
        { method: "PATCH", match: "/v1/appStoreReviewDetails/RD1", json: (c) => c.json },
        { method: "GET", match: "/reviewSubmissions?", json: { data: [] } },
        { method: "GET", match: "/v1/apps/6400000001/subscriptionGroups", json: { data: [{ type: "subscriptionGroups", id: "G1", attributes: {} }] } },
        {
          method: "GET",
          match: "/v1/subscriptionGroups/G1/subscriptions",
          json: { data: [{ type: "subscriptions", id: "S1", attributes: { productId: product.productId, state: "READY_TO_SUBMIT" } }, { type: "subscriptions", id: "S9", attributes: { productId: "other.app.product", state: "READY_TO_SUBMIT" } }] },
        },
        { method: "GET", match: "/v1/subscriptionGroups/G1/versions", json: { data: [{ type: "subscriptionGroupVersions", id: "GV1", attributes: { state: "PREPARE_FOR_SUBMISSION" } }] } },
        { method: "GET", match: "/v1/subscriptions/S1/versions", json: { data: [] } },
        { method: "POST", match: "/v1/subscriptionVersions", json: created },
        { method: "POST", match: "/v1/reviewSubmissions", json: created },
        { method: "POST", match: "/v1/reviewSubmissionItems", json: created },
        { method: "PATCH", match: "/v1/reviewSubmissions/", json: (c) => c.json },
      ],
    });
    const ref = await write.submitForReview({
      bindings: bindings({ ascAppId: "6400000001", products: [product] }),
      platform: "ios",
      storeBuildId: "BUILD7",
      notesForReviewer: "Answer 3 questions; the verdict follows.",
    });
    expect(ref).toEqual({ op: "store.review", externalRef: { platform: "ios", appId: "6400000001", versionId: "V1", reviewSubmissionId: "new_reviewSubmissions" }, pollAfterSec: 3600 });
    const writes = f.writes().map((w) => [w.method, w.url.replace(ASC, ""), w.json?.data]);
    expect(writes[0]).toEqual(["PATCH", "/v1/appStoreVersions/V1/relationships/build", { type: "builds", id: "BUILD7" }]);
    expect(writes[1]).toEqual(["PATCH", "/v1/appStoreVersions/V1", { type: "appStoreVersions", id: "V1", attributes: { releaseType: "MANUAL", copyright: "2026 Fast Studio LLC" } }]);
    expect(writes[2]).toEqual(["PATCH", "/v1/apps/6400000001", { type: "apps", id: "6400000001", attributes: { contentRightsDeclaration: "DOES_NOT_USE_THIRD_PARTY_CONTENT" } }]);
    expect(writes[3]![1]).toBe("/v1/appPriceSchedules");
    const schedule = f.writes()[3]!.json;
    expect(schedule.data.relationships.baseTerritory).toEqual({ data: { type: "territories", id: "USA" } });
    expect(schedule.included).toEqual([{ type: "appPrices", id: "${price-free}", attributes: { startDate: null }, relationships: { appPricePoint: { data: { type: "appPricePoints", id: "PP0" } } } }]);
    expect(writes[4]![2]).toEqual({
      type: "appStoreReviewDetails",
      id: "RD1",
      attributes: { notes: "Answer 3 questions; the verdict follows.", contactEmail: "support@example.com", contactFirstName: "Ada", contactLastName: "Lovelace", contactPhone: "+1 415 555 0100" },
    });
    expect(writes.slice(5).map((w) => `${w[0]} ${w[1]}`)).toEqual([
      "POST /v1/reviewSubmissions",
      "POST /v1/subscriptionVersions",
      "POST /v1/reviewSubmissionItems",
      "POST /v1/reviewSubmissionItems",
      "POST /v1/reviewSubmissionItems",
      "PATCH /v1/reviewSubmissions/new_reviewSubmissions",
    ]);
    const items = f.writes().filter((w) => w.url.endsWith("/v1/reviewSubmissionItems")).map((w) => Object.entries(w.json.data.relationships).find(([k]) => k !== "reviewSubmission"));
    expect(items).toEqual([
      ["appStoreVersion", { data: { type: "appStoreVersions", id: "V1" } }],
      ["subscriptionGroupVersion", { data: { type: "subscriptionGroupVersions", id: "GV1" } }],
      ["subscriptionVersion", { data: { type: "subscriptionVersions", id: "new_subscriptionVersions" } }],
    ]);
    expect(f.writes().find((w) => w.url.endsWith("/v1/subscriptionVersions"))!.json.data.relationships).toEqual({ subscription: { data: { type: "subscriptions", id: "S1" } } });
  });

  it("submitForReview keeps a human's App Store answers and refuses to submit without a review contact", async () => {
    const missing = setup({ dryRun: false, env: { ...liveEnv, ASC_REVIEW_CONTACT_FIRST_NAME: "Ada" } });
    await expect(missing.write.submitForReview({ bindings: bindings({ ascAppId: "6400000001" }), platform: "ios", storeBuildId: "B", notesForReviewer: "n" })).rejects.toThrow(
      "App Review contact missing: set ASC_REVIEW_CONTACT_LAST_NAME, ASC_REVIEW_CONTACT_PHONE",
    );
    expect(missing.f.calls).toEqual([]);

    const { write, f } = setup({
      dryRun: false,
      env: { ...liveEnv, ...contactEnv },
      routes: [
        { method: "GET", match: "/appStoreVersions?", json: { data: [{ type: "appStoreVersions", id: "V1", attributes: { versionString: "1.0.2" } }] } },
        { method: "PATCH", match: "/v1/appStoreVersions/V1", status: 204 },
        { method: "GET", match: /\/v1\/apps\/6400000001$/, json: { data: { type: "apps", id: "6400000001", attributes: { contentRightsDeclaration: "USES_THIRD_PARTY_CONTENT" } } } },
        { method: "GET", match: "/v1/apps/6400000001/appPriceSchedule", json: { data: { type: "appPriceSchedules", id: "6400000001", attributes: {} } } },
        { method: "GET", match: "/appStoreReviewDetail", json: { data: { type: "appStoreReviewDetails", id: "RD1", attributes: {} } } },
        { method: "PATCH", match: "/v1/appStoreReviewDetails/RD1", json: (c) => c.json },
        { method: "GET", match: "/reviewSubmissions?", json: { data: [] } },
        { method: "POST", match: "/v1/reviewSubmissions", json: created },
        { method: "POST", match: "/v1/reviewSubmissionItems", json: created },
        { method: "PATCH", match: "/v1/reviewSubmissions/", json: (c) => c.json },
      ],
    });
    await write.submitForReview({ bindings: bindings({ ascAppId: "6400000001" }), platform: "ios", storeBuildId: "B", notesForReviewer: "n" });
    expect(f.writes().map((w) => `${w.method} ${w.url.replace(ASC, "")}`).filter((w) => w.includes("/v1/apps") || w.includes("PriceSchedule"))).toEqual([]);
  });

  it("submitForReview stops when a subscription still lacks metadata", async () => {
    const { write, f } = setup({
      dryRun: false,
      env: { ...liveEnv, ...contactEnv },
      routes: [
        { method: "GET", match: "/appStoreVersions?", json: { data: [{ type: "appStoreVersions", id: "V1", attributes: { versionString: "1.0.2" } }] } },
        { method: "PATCH", match: "/v1/appStoreVersions/V1", status: 204 },
        { method: "GET", match: /\/v1\/apps\/6400000001$/, json: { data: { type: "apps", id: "6400000001", attributes: { contentRightsDeclaration: "DOES_NOT_USE_THIRD_PARTY_CONTENT" } } } },
        { method: "GET", match: "/v1/apps/6400000001/appPriceSchedule", json: { data: { type: "appPriceSchedules", id: "6400000001", attributes: {} } } },
        { method: "GET", match: "/appStoreReviewDetail", json: { data: { type: "appStoreReviewDetails", id: "RD1", attributes: {} } } },
        { method: "PATCH", match: "/v1/appStoreReviewDetails/RD1", json: (c) => c.json },
        { method: "GET", match: "/reviewSubmissions?", json: { data: [] } },
        { method: "POST", match: "/v1/reviewSubmissions", json: created },
        { method: "GET", match: "/v1/apps/6400000001/subscriptionGroups", json: { data: [{ type: "subscriptionGroups", id: "G1", attributes: {} }] } },
        { method: "GET", match: "/v1/subscriptionGroups/G1/subscriptions", json: { data: [{ type: "subscriptions", id: "S1", attributes: { productId: product.productId, state: "MISSING_METADATA" } }] } },
      ],
    });
    await expect(write.submitForReview({ bindings: bindings({ ascAppId: "6400000001", products: [product] }), platform: "ios", storeBuildId: "B", notesForReviewer: "n" })).rejects.toThrow(
      /com\.fast\.astra\.week_699_t3 are missing metadata/,
    );
    expect(f.writes().some((w) => w.url.includes("/v1/reviewSubmissionItems") || (w.method === "PATCH" && w.url.includes("/v1/reviewSubmissions/")))).toBe(false);
  });

  it("upsertSubscriptions prices and opens only the storefronts a subscription still lacks", async () => {
    const terr = (id: string) => ({ type: "territories", id });
    const { write, f } = setup({
      dryRun: false,
      env: liveEnv,
      routes: [
        { method: "GET", match: "/v1/apps/6400000001/subscriptionGroups", json: { data: [{ type: "subscriptionGroups", id: "G1", attributes: { referenceName: "Astra Pro" } }] } },
        { method: "GET", match: "/subscriptionGroupLocalizations", json: { data: [{ type: "subscriptionGroupLocalizations", id: "GL", attributes: { locale: "en-US" } }] } },
        { method: "GET", match: "/v1/subscriptionGroups/G1/subscriptions", json: { data: [{ type: "subscriptions", id: "S1", attributes: { productId: products[0]!.productId, state: "APPROVED" } }] } },
        { method: "GET", match: "/subscriptionLocalizations", json: { data: [{ type: "subscriptionLocalizations", id: "SL", attributes: { locale: "en-US" } }] } },
        {
          method: "GET",
          match: "/v1/subscriptions/S1/prices",
          json: { data: ["USA", "CAN", "AUS", "NZL"].map((t) => ({ type: "subscriptionPrices", id: `P${t}`, attributes: {}, relationships: { territory: { data: terr(t) } } })) },
        },
        { method: "GET", match: "/v1/subscriptions/S1/pricePoints", json: { data: [{ type: "subscriptionPricePoints", id: "PP699", attributes: { customerPrice: "6.99" } }] } },
        {
          method: "GET",
          match: "/v1/subscriptionPricePoints/PP699/equalizations",
          json: { data: [{ type: "subscriptionPricePoints", id: "EQGBR", attributes: { customerPrice: "6.99" }, relationships: { territory: { data: terr("GBR") } } }] },
        },
        { method: "POST", match: "/v1/subscriptionPrices", json: created },
        { method: "GET", match: "/v1/subscriptions/S1/planAvailabilities", json: { data: [{ type: "subscriptionPlanAvailabilities", id: "PA1", attributes: { planType: "UPFRONT" } }] } },
        { method: "GET", match: "/v1/subscriptionPlanAvailabilities/PA1/availableTerritories", json: { data: ["CAN", "AUS", "NZL"].map(terr) } },
        { method: "PATCH", match: "/v1/subscriptionPlanAvailabilities/PA1/relationships/availableTerritories", status: 204 },
        { method: "GET", match: "/introductoryOffers", json: { data: ["CAN", "AUS", "NZL", "USA", "GBR"].map((t) => ({ type: "subscriptionIntroductoryOffers", id: `I${t}`, attributes: {}, relationships: { territory: { data: terr(t) } } })) } },
      ],
    });
    await write.upsertSubscriptions({ bindings: bindings({ ascAppId: "6400000001" }), platform: "ios", groupName: "Astra Pro", products: [{ ...products[0]!, territories: ["AU", "CA", "NZ", "US", "GB"] }] });
    expect(f.calls.find((c) => c.url.includes("/equalizations"))!.url).toContain("filter[territory]=GBR&");
    expect(f.writes().map((w) => [w.method, w.url.replace(ASC, ""), w.json])).toEqual([
      ["POST", "/v1/subscriptionPrices", { data: { type: "subscriptionPrices", attributes: { preserveCurrentPrice: false }, relationships: { subscription: { data: { type: "subscriptions", id: "S1" } }, territory: { data: terr("GBR") }, subscriptionPricePoint: { data: { type: "subscriptionPricePoints", id: "EQGBR" } } } } }],
      ["PATCH", "/v1/subscriptionPlanAvailabilities/PA1/relationships/availableTerritories", { data: ["CAN", "AUS", "NZL", "USA", "GBR"].map(terr) }],
    ]);
  });

  it("removeFromSale also takes every subscription off sale so none renews", async () => {
    const { write, f } = setup({
      dryRun: false,
      env: liveEnv,
      routes: [
        { method: "GET", match: "/v1/apps/6400000001/appAvailabilityV2", json: { data: { type: "appAvailabilities", id: "AV" } } },
        { method: "GET", match: "/v2/appAvailabilities/AV/territoryAvailabilities", json: { data: [{ type: "territoryAvailabilities", id: "TA-CAN", attributes: { available: true }, relationships: { territory: { data: { type: "territories", id: "CAN" } } } }] } },
        { method: "PATCH", match: "/v1/territoryAvailabilities/TA-CAN", json: (c) => c.json },
        { method: "GET", match: "/v1/apps/6400000001/subscriptionGroups", json: { data: [{ type: "subscriptionGroups", id: "G1", attributes: {} }] } },
        { method: "GET", match: "/v1/subscriptionGroups/G1/subscriptions", json: { data: [{ type: "subscriptions", id: "S1", attributes: {} }, { type: "subscriptions", id: "S2", attributes: {} }] } },
        { method: "GET", match: "/v1/subscriptions/S1/planAvailabilities", json: { data: [{ type: "subscriptionPlanAvailabilities", id: "PA1", attributes: { planType: "UPFRONT" } }] } },
        { method: "GET", match: "/v1/subscriptions/S2/planAvailabilities", json: { data: [{ type: "subscriptionPlanAvailabilities", id: "PA2", attributes: { planType: "UPFRONT" } }] } },
        { method: "GET", match: "/v1/subscriptionPlanAvailabilities/PA1/availableTerritories", json: { data: [{ type: "territories", id: "CAN" }] } },
        { method: "GET", match: "/v1/subscriptionPlanAvailabilities/PA2/availableTerritories", json: { data: [] } },
        { method: "PATCH", match: "/v1/subscriptionPlanAvailabilities/PA1/relationships/availableTerritories", status: 204 },
      ],
    });
    await write.removeFromSale({ bindings: bindings({ ascAppId: "6400000001" }), platform: "ios" });
    expect(f.writes().map((w) => [w.method, w.url.replace(ASC, ""), w.json])).toEqual([
      ["PATCH", "/v1/territoryAvailabilities/TA-CAN", { data: { type: "territoryAvailabilities", id: "TA-CAN", attributes: { available: false } } }],
      ["PATCH", "/v1/subscriptionPlanAvailabilities/PA1/relationships/availableTerritories", { data: [] }],
    ]);
  });

  it("release succeeds without a write when the version was already released", async () => {
    const versions = (state: string): FakeRoute[] => [
      { method: "GET", match: "filter[appVersionState]=PENDING_DEVELOPER_RELEASE", json: { data: [] } },
      { method: "GET", match: "/v1/apps/6400000001/appStoreVersions", json: { data: [{ type: "appStoreVersions", id: "V1", attributes: { appVersionState: state, createdDate: "2026-10-10" } }] } },
    ];
    for (const state of ["PROCESSING_FOR_DISTRIBUTION", "READY_FOR_DISTRIBUTION"]) {
      const { write, f } = setup({ dryRun: false, env: liveEnv, routes: versions(state) });
      await write.release({ bindings: bindings({ ascAppId: "6400000001" }), platform: "ios", phased: true });
      expect(f.writes()).toEqual([]);
    }
    const { write } = setup({ dryRun: false, env: liveEnv, routes: versions("WAITING_FOR_REVIEW") });
    await expect(write.release({ bindings: bindings({ ascAppId: "6400000001" }), platform: "ios", phased: false })).rejects.toThrow(/no version waiting for manual release \(latest version is WAITING_FOR_REVIEW\)/);
  });

  it("submitBuild writes the app id and the App Store Connect key file into eas.json before eas submit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eas-project-"));
    writeFileSync(join(dir, "eas.json"), JSON.stringify({ build: { production: {} }, submit: { production: { ios: {}, android: { track: "internal" } } } }));
    const calls: { args: string[]; easJson: unknown }[] = [];
    const runner: EasRunner = async (_cmd, args, opts) => {
      calls.push({ args, easJson: JSON.parse(readFileSync(join(opts.cwd, "eas.json"), "utf8")) });
      return { code: 0, stdout: "Submission details: https://expo.dev/accounts/f/projects/a/submissions/0f1e2d3c-4b5a-4968-8776-655443322110", stderr: "" };
    };
    const { write, store } = setup({ dryRun: false, env: liveEnv, runner, venture: venture({ build: { projectDir: dir, version: "1.0.2", buildNumber: 7, specVersion: 1, checks: [], builtAt: clock.iso() } as Venture["build"] }) });
    store.publishers.put({ id: "pub_ios", entityId: "ent_1", platform: "ios", externalTeamId: "TEAM123", kind: "organization", status: "active", secretRefs: {} });
    const ref = await write.submitBuild({ bindings: bindings({ ascAppId: "6400000001", publisherAccountIds: { ios: "pub_ios" } }), platform: "ios", easBuildId: "eas-1" });
    expect(ref.externalRef).toMatchObject({ easSubmissionId: "0f1e2d3c-4b5a-4968-8776-655443322110", appId: "6400000001" });
    expect(calls[0]!.args.slice(0, 2)).toEqual(["submit", "--platform"]);
    expect(calls[0]!.easJson).toEqual({
      build: { production: {} },
      submit: {
        production: {
          ios: { ascAppId: "6400000001", ascApiKeyPath: liveEnv.ASC_PRIVATE_KEY_PATH, ascApiKeyId: "KEYDEFAULT", ascApiKeyIssuerId: "issuer-1", appleTeamId: "TEAM123" },
          android: { track: "internal" },
        },
      },
    });
    expect(readFileSync(join(dir, "eas.json"), "utf8")).not.toContain("PRIVATE KEY");

    const { ASC_PRIVATE_KEY_PATH: _path, ...noKeyFile } = liveEnv;
    const inline = setup({ dryRun: false, env: noKeyFile, runner: forbiddenRunner, venture: venture({ build: { projectDir: dir, version: "1.0.2", buildNumber: 7, specVersion: 1, checks: [], builtAt: clock.iso() } as Venture["build"] }) });
    await expect(inline.write.submitBuild({ bindings: bindings({ ascAppId: "6400000001" }), platform: "ios", easBuildId: "eas-1" })).rejects.toThrow("EAS Submit needs the App Store Connect key as a .p8 file: set ASC_PRIVATE_KEY_PATH");
  });

  it("updateListing writes app info, version localization and screenshots against the build's version", async () => {
    const shot = join(mkdtempSync(join(tmpdir(), "shots-")), "a.png");
    writeFileSync(shot, Buffer.alloc(32));
    const { write, f } = setup({
      dryRun: false,
      env: liveEnv,
      routes: [
        { method: "GET", match: "/v1/apps/6400000001/appInfos", json: { data: [{ type: "appInfos", id: "INFO1", attributes: { state: "PREPARE_FOR_SUBMISSION" } }] } },
        { method: "GET", match: "/appInfoLocalizations", json: { data: [] } },
        { method: "POST", match: "/v1/appInfoLocalizations", json: created },
        { method: "GET", match: "/appStoreVersions?", json: { data: [] } },
        { method: "POST", match: "/v1/appStoreVersions", json: created },
        { method: "GET", match: "/appStoreVersionLocalizations", json: { data: [] } },
        { method: "POST", match: "/v1/appStoreVersionLocalizations", json: created },
        { method: "GET", match: "/appScreenshotSets", json: { data: [] } },
        { method: "POST", match: "/v1/appScreenshotSets", json: created },
        { method: "GET", match: "/appScreenshots", json: { data: [] } },
        { method: "POST", match: "/v1/appScreenshots", json: { data: { type: "appScreenshots", id: "SS1", attributes: { uploadOperations: [{ method: "PUT", url: "https://up.test/1", offset: 0, length: 32, requestHeaders: [] }] } } } },
        { method: "PUT", match: "https://up.test/1", text: "" },
        { method: "PATCH", match: "/v1/appScreenshots/SS1", json: (c) => c.json },
      ],
    });
    const ref = await write.updateListing({ bindings: bindings({ ascAppId: "6400000001" }), platform: "ios", listing, screenshotPaths: [shot] });
    expect(ref.externalRef).toEqual({ platform: "ios", appId: "6400000001", versionId: "new_appStoreVersions", screenshotIds: "SS1" });
    const body = (path: string) => f.writes().find((w) => w.url === `${ASC}${path}`)!.json.data;
    expect(body("/v1/appInfoLocalizations")).toMatchObject({ attributes: { locale: "en-US", name: "Astra", subtitle: "Your chart, decoded", privacyPolicyUrl: "https://astra.test/privacy" } });
    expect(body("/v1/appStoreVersions").attributes).toEqual({ platform: "IOS", versionString: "1.0.2", releaseType: "MANUAL" });
    expect(body("/v1/appStoreVersionLocalizations").attributes).toEqual({
      locale: "en-US",
      description: "Readings from your birth chart.",
      keywords: "astrology,zodiac",
      promotionalText: "New: weekly compatibility",
      supportUrl: "https://astra.test/support",
    });
  });

  it("maps review history and status", async () => {
    const { read } = setup({
      dryRun: false,
      env: liveEnv,
      routes: [
        { match: "/customerReviews", json: { data: [{ type: "customerReviews", id: "r1", attributes: { createdDate: "2026-10-17T08:00:00Z", territory: "CAN", rating: 4 } }] } },
        { match: "/v1/apps/6400000001/appStoreVersions", json: { data: [{ type: "appStoreVersions", id: "V1", attributes: { appVersionState: "READY_FOR_DISTRIBUTION", versionString: "1.0.2", createdDate: "2026-10-10" } }] } },
        { match: "/v1/apps/6400000001/appAvailabilityV2", json: { data: { type: "appAvailabilities", id: "AV" } } },
        {
          match: "/v2/appAvailabilities/AV/territoryAvailabilities",
          json: { data: [{ type: "territoryAvailabilities", id: "t", attributes: { available: true }, relationships: { territory: { data: { type: "territories", id: "NZL" } } } }] },
        },
        { match: "/v1/apps/6400000001", json: { data: { type: "apps", id: "6400000001", attributes: {} } } },
      ],
    });
    const b = bindings({ ascAppId: "6400000001" });
    expect(await read.reviews({ bindings: b, platform: "ios", since: "2026-10-01" })).toEqual([{ date: "2026-10-17", territory: "CA", rating: 4 }]);
    expect(await read.status({ bindings: b, platform: "ios" })).toEqual({ platform: "ios", bundleId: "com.fast.astra", appId: "6400000001", status: "live", versionString: "1.0.2", territories: ["NZ"] });
  });
});

describe("poll", () => {
  const view = (status: string, extra: Record<string, unknown> = {}) => JSON.stringify({ id: "eas-1", status, platform: "IOS", appVersion: "1.0.2", appBuildVersion: "7", ...extra });
  const runnerFor = (stdout: string): EasRunner => async () => ({ code: 0, stdout, stderr: "" });

  it("maps EAS build states", async () => {
    const ref: JobRef = { op: "store.build", externalRef: { platform: "ios", easBuildId: "eas-1", projectDir: "/p" }, pollAfterSec: 1 };
    const done = setup({ dryRun: false, env: liveEnv, runner: runnerFor(view("FINISHED", { artifacts: { applicationArchiveUrl: "https://x/app.ipa" } })) });
    expect(await done.read.poll(job(ref))).toEqual({ status: "succeeded", result: { easBuildId: "eas-1", artifactUrl: "https://x/app.ipa", appVersion: "1.0.2", appBuildVersion: "7" } });
    const failed = setup({ dryRun: false, env: liveEnv, runner: runnerFor(view("ERRORED", { error: { message: "Pod install failed" } })) });
    expect(await failed.read.poll(job(ref))).toMatchObject({ status: "failed", error: "Pod install failed" });
    const queued = setup({ dryRun: false, env: liveEnv, runner: runnerFor(view("IN_QUEUE")) });
    expect(await queued.read.poll(job(ref))).toMatchObject({ status: "running", pollAfterSec: 120 });
  });

  it("maps ASC build processing for a submitted build", async () => {
    const ref: JobRef = { op: "store.submit_build", externalRef: { platform: "ios", easBuildId: "eas-1", projectDir: "/p", appId: "6400000001" }, pollAfterSec: 1 };
    const build = (state: string): FakeRoute => ({ match: "/v1/builds?", json: { data: [{ type: "builds", id: "BUILD7", attributes: { processingState: state } }] } });
    const valid = setup({ dryRun: false, env: liveEnv, runner: runnerFor(view("FINISHED")), routes: [build("VALID")] });
    expect(await valid.read.poll(job(ref))).toEqual({ status: "succeeded", result: { storeBuildId: "BUILD7", processingState: "VALID" } });
    expect(valid.f.calls[0]!.url).toContain("filter[version]=7&filter[preReleaseVersion.version]=1.0.2");
    const processing = setup({ dryRun: false, env: liveEnv, runner: runnerFor(view("FINISHED")), routes: [build("PROCESSING")] });
    expect((await processing.read.poll(job(ref))).status).toBe("running");
    const invalid = setup({ dryRun: false, env: liveEnv, runner: runnerFor(view("FINISHED")), routes: [build("INVALID")] });
    expect((await invalid.read.poll(job(ref))).status).toBe("failed");
  });

  it("fails a submitted build as soon as its EAS submission errors, flagging when a new binary is needed", async () => {
    const ref: JobRef = { op: "store.submit_build", externalRef: { platform: "ios", easBuildId: "eas-1", projectDir: "/p", appId: "6400000001", easSubmissionId: "sub-1" }, pollAfterSec: 1 };
    const runner = (submission: Record<string, unknown>): EasRunner => async (_cmd, args) => ({ code: 0, stdout: args[0] === "submit:view" ? JSON.stringify({ id: "sub-1", platform: "IOS", ...submission }) : view("FINISHED"), stderr: "" });
    const noBuild: FakeRoute = { match: "/v1/builds?", json: { data: [] } };
    const duplicate = setup({ dryRun: false, env: liveEnv, runner: runner({ status: "ERRORED", error: { errorCode: "SUBMISSION_SERVICE_IOS_UNKNOWN_ERROR", message: "The bundle version must be higher than the previously uploaded version." } }), routes: [noBuild] });
    expect(await duplicate.read.poll(job(ref))).toEqual({
      status: "failed",
      result: { easSubmissionId: "sub-1", easSubmissionStatus: "ERRORED", rebuild: true },
      error: "SUBMISSION_SERVICE_IOS_UNKNOWN_ERROR: The bundle version must be higher than the previously uploaded version.",
    });
    const auth = setup({ dryRun: false, env: liveEnv, runner: runner({ status: "ERRORED", error: { message: "Invalid App Store Connect API key" } }), routes: [noBuild] });
    expect(await auth.read.poll(job(ref))).toMatchObject({ status: "failed", result: { rebuild: false }, error: "Invalid App Store Connect API key" });
    const uploading = setup({ dryRun: false, env: liveEnv, runner: runner({ status: "IN_PROGRESS" }), routes: [noBuild] });
    expect(await uploading.read.poll(job(ref))).toMatchObject({ status: "running", pollAfterSec: 300 });
  });

  it("maps a Play upload once the version code shows up on a track", async () => {
    const ref: JobRef = { op: "store.submit_build", externalRef: { platform: "android", easBuildId: "eas-1", projectDir: "/p", appId: "com.fast.astra" }, pollAfterSec: 1 };
    const { read } = setup({
      dryRun: false,
      env: liveEnv,
      runner: runnerFor(view("FINISHED", { platform: "ANDROID" })),
      routes: [
        { method: "POST", match: "oauth2.googleapis.com/token", json: { access_token: "t", expires_in: 3600 } },
        { method: "POST", match: `${PLAY}/edits`, json: { id: "E1" } },
        { method: "GET", match: `${PLAY}/edits/E1/tracks`, json: { tracks: [{ track: "internal", releases: [{ status: "draft", versionCodes: ["7"] }] }] } },
        { method: "DELETE", match: `${PLAY}/edits/E1`, status: 204 },
      ],
    });
    expect(await read.poll(job(ref))).toEqual({ status: "succeeded", result: { storeBuildId: "7" } });
  });

  it("maps screenshot delivery states", async () => {
    const ref: JobRef = { op: "store.update_listing", externalRef: { platform: "ios", appId: "A", versionId: "V", screenshotIds: "S1,S2" }, pollAfterSec: 1 };
    const shots = (s1: string, s2: string): FakeRoute[] => [
      { match: "/v1/appScreenshots/S1", json: { data: { type: "appScreenshots", id: "S1", attributes: { assetDeliveryState: { state: s1 } } } } },
      { match: "/v1/appScreenshots/S2", json: { data: { type: "appScreenshots", id: "S2", attributes: { assetDeliveryState: { state: s2, errors: s2 === "FAILED" ? [{ code: "IMAGE_TOO_SMALL", description: "wrong size" }] : [] } } } } },
    ];
    expect((await setup({ dryRun: false, env: liveEnv, routes: shots("COMPLETE", "COMPLETE") }).read.poll(job(ref))).status).toBe("succeeded");
    expect((await setup({ dryRun: false, env: liveEnv, routes: shots("COMPLETE", "UPLOAD_COMPLETE") }).read.poll(job(ref))).status).toBe("running");
    expect(await setup({ dryRun: false, env: liveEnv, routes: shots("COMPLETE", "FAILED") }).read.poll(job(ref))).toMatchObject({ status: "failed", error: "S2: IMAGE_TOO_SMALL wrong size" });
  });

  it("maps App Review states", async () => {
    const ref: JobRef = { op: "store.review", externalRef: { platform: "ios", appId: "A", versionId: "V1", reviewSubmissionId: "RS1" }, pollAfterSec: 1 };
    const routes = (version: string, submission: string): FakeRoute[] => [
      { match: "/v1/appStoreVersions/V1", json: { data: { type: "appStoreVersions", id: "V1", attributes: { appVersionState: version } } } },
      { match: "/v1/reviewSubmissions/RS1", json: { data: { type: "reviewSubmissions", id: "RS1", attributes: { state: submission } } } },
    ];
    expect(await setup({ dryRun: false, env: liveEnv, routes: routes("PENDING_DEVELOPER_RELEASE", "COMPLETE") }).read.poll(job(ref))).toEqual({
      status: "succeeded",
      result: { reviewState: "approved", versionState: "PENDING_DEVELOPER_RELEASE", productStates: {} },
    });
    const withProducts = await setup({
      dryRun: false,
      env: liveEnv,
      routes: [
        ...routes("PENDING_DEVELOPER_RELEASE", "COMPLETE"),
        { match: "/v1/apps/A/subscriptionGroups", json: { data: [{ type: "subscriptionGroups", id: "G1", attributes: {} }] } },
        {
          match: "/v1/subscriptionGroups/G1/subscriptions",
          json: { data: [{ type: "subscriptions", id: "S1", attributes: { productId: "p.week", state: "APPROVED" } }, { type: "subscriptions", id: "S2", attributes: { productId: "p.year", state: "REJECTED" } }] },
        },
      ],
    }).read.poll(job(ref));
    expect(withProducts.result?.productStates).toEqual({ "p.week": "APPROVED", "p.year": "REJECTED" });
    const rejected = await setup({ dryRun: false, env: liveEnv, routes: routes("REJECTED", "UNRESOLVED_ISSUES") }).read.poll(job(ref));
    expect(rejected).toMatchObject({ status: "failed", result: { reviewState: "rejected" } });
    expect((rejected.result?.rejectionReasons as string[])[0]).toContain("Resolution Center");
    expect((await setup({ dryRun: false, env: liveEnv, routes: routes("IN_REVIEW", "IN_REVIEW") }).read.poll(job(ref))).result).toMatchObject({ reviewState: "in_review" });
  });

  it("reads Play approval from the public store page of the target country", async () => {
    const ref: JobRef = { op: "store.review", externalRef: { platform: "android", packageName: "com.fast.astra", versionCode: "7", geo: "CA" }, pollAfterSec: 1 };
    const pending = setup({ dryRun: false, env: liveEnv, routes: [{ match: "play.google.com/store/apps/details", status: 404, text: "Not Found", contentType: "text/html" }] });
    expect(await pending.read.poll(job(ref))).toMatchObject({ status: "running", result: { reviewState: "in_review" } });
    expect(pending.f.calls[0]!.url).toBe("https://play.google.com/store/apps/details?id=com.fast.astra&gl=CA&hl=en");
    const live = setup({ dryRun: false, env: liveEnv, routes: [{ match: "play.google.com/store/apps/details", text: "<html>", contentType: "text/html" }] });
    expect(await live.read.poll(job(ref))).toEqual({ status: "succeeded", result: { reviewState: "approved", storeBuildId: "7" } });
  });
});

describe("live Android flows (fake Play)", () => {
  const oauth: FakeRoute = { method: "POST", match: "oauth2.googleapis.com/token", json: { access_token: "t", expires_in: 3600 } };

  it("submitForReview targets the venture's storefronts on a staged production release", async () => {
    const { write, f } = setup({
      dryRun: false,
      env: liveEnv,
      routes: [
        oauth,
        { method: "POST", match: `${PLAY}/edits/E1:commit`, json: {} },
        { method: "POST", match: `${PLAY}/edits`, json: { id: "E1" } },
        { method: "GET", match: `${PLAY}/edits/E1/tracks/production`, json: { track: "production", releases: [] } },
        { method: "PUT", match: `${PLAY}/edits/E1/tracks/production`, json: (c) => c.json },
      ],
    });
    const ref = await write.submitForReview({ bindings: bindings(), platform: "android", storeBuildId: "7", notesForReviewer: "n" });
    expect(ref.externalRef).toMatchObject({ platform: "android", versionCode: "7", geo: "CA" });
    const put = f.calls.find((c) => c.method === "PUT")!;
    expect(put.json).toEqual({
      track: "production",
      releases: [{ versionCodes: ["7"], status: "inProgress", userFraction: PLAY_TARGETED_FRACTION, countryTargeting: { countries: ["CA", "AU"], includeRestOfWorld: false } }],
    });
    expect(f.calls.at(-1)!.url).toBe(`${PLAY}/edits/E1:commit`);
  });

  it("setTerritories refuses to retarget a fully rolled-out release", async () => {
    const { write, f } = setup({
      dryRun: false,
      env: liveEnv,
      routes: [
        oauth,
        { method: "POST", match: `${PLAY}/edits`, json: { id: "E2" } },
        { method: "GET", match: `${PLAY}/edits/E2/tracks/production`, json: { track: "production", releases: [{ status: "completed", versionCodes: ["7"] }] } },
        { method: "DELETE", match: `${PLAY}/edits/E2`, status: 204 },
      ],
    });
    await expect(write.setTerritories({ bindings: bindings(), platform: "android", territories: ["CA"] })).rejects.toThrow(/Countries\/regions/);
    expect(f.calls.at(-1)!.method).toBe("DELETE");
  });

  it("removeFromSale halts the active production release", async () => {
    const { write, f } = setup({
      dryRun: false,
      env: liveEnv,
      routes: [
        oauth,
        { method: "POST", match: `${PLAY}/edits/E3:commit`, json: {} },
        { method: "POST", match: `${PLAY}/edits`, json: { id: "E3" } },
        { method: "GET", match: `${PLAY}/edits/E3/tracks/production`, json: { track: "production", releases: [{ status: "inProgress", versionCodes: ["7"], userFraction: 0.999 }] } },
        { method: "PUT", match: `${PLAY}/edits/E3/tracks/production`, json: (c) => c.json },
      ],
    });
    await write.removeFromSale({ bindings: bindings(), platform: "android" });
    expect(f.calls.find((c) => c.method === "PUT")!.json.releases[0].status).toBe("halted");
  });
});

describe("state mapping helpers", () => {
  it("maps App Store version states", () => {
    expect(iosStoreStatus("PREPARE_FOR_SUBMISSION")).toBe("draft");
    expect(iosStoreStatus("WAITING_FOR_REVIEW")).toBe("waiting_for_review");
    expect(iosStoreStatus("IN_REVIEW")).toBe("in_review");
    expect(iosStoreStatus("PENDING_DEVELOPER_RELEASE")).toBe("pending_release");
    expect(iosStoreStatus("READY_FOR_DISTRIBUTION")).toBe("live");
    expect(iosStoreStatus("METADATA_REJECTED")).toBe("metadata_rejected");
    expect(iosStoreStatus("REJECTED")).toBe("rejected");
  });

  it("maps review polls", () => {
    expect(iosReviewPoll({ appId: "A", versionState: "METADATA_REJECTED" }).result).toMatchObject({ reviewState: "metadata_rejected" });
    expect(iosReviewPoll({ appId: "A", versionState: "WAITING_FOR_REVIEW", submissionState: "WAITING_FOR_REVIEW" })).toMatchObject({ status: "running", pollAfterSec: 3600 });
    expect(iosReviewPoll({ appId: "A", submissionState: "CANCELING" }).status).toBe("failed");
  });

  it("maps Play tracks and base plan ids", () => {
    expect(androidStoreStatus([])).toBe("draft");
    expect(androidStoreStatus([{ track: "internal", releases: [{ status: "completed", versionCodes: ["1"] }] }])).toBe("ready_to_submit");
    expect(androidStoreStatus([{ track: "production", releases: [{ status: "inProgress", versionCodes: ["1"], userFraction: 0.5 }] }])).toBe("live");
    expect(androidStoreStatus([{ track: "production", releases: [{ status: "halted", versionCodes: ["1"] }] }])).toBe("removed");
    expect(basePlanId("week_699_t3")).toBe("week-699-t3");
    expect(basePlanId("1year")).toBe("p-1year");
  });
});
