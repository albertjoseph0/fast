/**
 * Simulated ports: every ReadPorts and WritePorts member backed by the SimWorld, with the
 * same shapes, async jobs and human tasks as the live adapters.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import type { StudioConfig } from "../config/schema.ts";
import type {
  AdsRead,
  AdsWrite,
  Clock,
  CreatorRead,
  CreatorWrite,
  LlmPort,
  MediaPort,
  MetricsPort,
  MonetizationWrite,
  PortSet,
  RemoteConfigWrite,
  SocialRead,
  SocialWrite,
  StoreRead,
  StoreWrite,
  TrendPort,
  WebWrite,
} from "../core/ports.ts";
import { hashString } from "../core/rng.ts";
import type { StudioStore } from "../core/store.ts";
import type { HumanTaskDraft, PlatformLabels, PostStats, StorePlatform, VentureBindings } from "../core/types.ts";
import { chart, search } from "./catalog.ts";
import type { SimWorld } from "./world.ts";

const h32 = (text: string) => hashString(text) >>> 0;

/** The same task live adapters return: App Store Connect cannot create apps by API. */
function createAppTask(ventureId: string | undefined, name: string, bundleId: string, sku: string, locale: string): HumanTaskDraft {
  return {
    kind: "apple.create_app",
    ...(ventureId ? { ventureId } : {}),
    title: `Create the iOS app record in App Store Connect${ventureId ? ` (${ventureId})` : ""}`,
    instructions: [
      "App Store Connect's API cannot create apps (POST /v1/apps returns 403), so a human creates the record.",
      "1. Open [App Store Connect → Apps](https://appstoreconnect.apple.com/apps) and choose **+ → New App**.",
      `2. Platform iOS; name "${name}", primary language ${locale}, bundle ID ${bundleId}, SKU ${sku}.`,
      "3. Do not set pricing or availability: the studio sets territories to the test storefronts only.",
      "4. Copy the numeric **Apple ID** from App Information.",
    ].join("\n"),
    inputs: [{ key: "ascAppId", label: "Apple ID of the app (App Information → Apple ID)", pattern: "^\\d{9,11}$" }],
  };
}

function aiLabelled(labels: PlatformLabels): boolean {
  return Boolean(labels.tiktok?.is_aigc || labels.instagram?.is_ai_generated || labels.youtube?.containsSyntheticMedia || labels.other?.aiLabelInCaption);
}

/** Build the full simulated port set around a world. */
export function createSimPorts(opts: { world: SimWorld; clock: Clock; store: StudioStore; config: StudioConfig; llm: LlmPort; media: MediaPort }): PortSet {
  const { world, clock } = opts;
  const appKey = (b: VentureBindings, p: StorePlatform) => `${b.bundleId}|${p}`;
  const ventureOf = (b: VentureBindings) => world.ventureByBundle(b.bundleId);

  const trends: TrendPort = {
    kind: "sim",
    topApps: async (req) => chart(req.country, req.chart, req.limit, clock.today()),
    searchApps: async (req) => search(req.term, req.country, req.limit),
  };

  const storeRead: StoreRead = {
    kind: "sim",
    status: async (req) => world.storeStatus(req.bindings.bundleId, req.platform),
    reviews: async (req) => world.storeReviews(req.bindings.bundleId, req.since),
    poll: async (job) => world.pollJob(job.externalRef.simJobId),
  };

  const storeWrite: StoreWrite = {
    kind: "sim",
    registerBundleId: async (req) => {
      const app = world.app(req.bindings.bundleId, req.platform);
      app.bundleIdResourceId ??= `SIMBNDL${(h32(`${world.seed}:${req.bindings.bundleId}:${req.platform}`) % 1e8).toString(36).toUpperCase()}`;
      return { bundleIdResourceId: app.bundleIdResourceId };
    },
    createApp: async (req) => {
      const app = world.app(req.bindings.bundleId, req.platform);
      if (req.platform === "ios") {
        // Once a human has created the record (bindings.ascAppId), the call finds it, as live does.
        if (app.appId) return { appId: app.appId };
        return { humanTask: createAppTask(ventureOf(req.bindings)?.id, req.name, req.bindings.bundleId, req.sku, req.primaryLocale) };
      }
      app.appId ??= req.bindings.androidPackage;
      app.status = app.status === "not_created" ? "draft" : app.status;
      return { appId: app.appId };
    },
    upsertSubscriptions: async (req) =>
      world.createJob("store.upsert_subscriptions", {
        appKey: appKey(req.bindings, req.platform),
        minDays: 1,
        maxDays: 1,
        label: `subs:${req.bindings.bundleId}`,
        result: { productIds: req.products.map((p) => p.productId), subscriptionGroupId: `simgrp_${(h32(req.groupName) % 1e6).toString(36)}` },
      }),
    startBuild: async (req) => {
      // Not derived from projectDir: render roots are often temp dirs, and ids seed the job's stream.
      const easBuildId = `eas_${(h32(`${world.seed}:${req.bindings.bundleId}:${req.platform}:${clock.iso()}`) % 1e10).toString(36)}`;
      return world.createJob("store.build", {
        appKey: appKey(req.bindings, req.platform),
        minDays: 1,
        maxDays: 2,
        label: `build:${easBuildId}`,
        result: { easBuildId, artifactUrl: `https://expo.dev/artifacts/eas/${easBuildId}.${req.platform === "ios" ? "ipa" : "aab"}` },
        failChance: 0.03,
        error: "EAS build failed: Run fastlane step exited with non-zero code",
      });
    },
    submitBuild: async (req) => {
      const app = world.app(req.bindings.bundleId, req.platform);
      app.status = "build_processing";
      return world.createJob("store.submit_build", {
        appKey: appKey(req.bindings, req.platform),
        minDays: 1,
        maxDays: 1,
        label: `upload:${req.easBuildId}`,
        result: { storeBuildId: `simbuild_${(h32(req.easBuildId) % 1e10).toString(36)}` },
      });
    },
    updateListing: async (req) =>
      world.createJob("store.update_listing", {
        appKey: appKey(req.bindings, req.platform),
        minDays: 1,
        maxDays: 1,
        label: `listing:${req.bindings.bundleId}:${req.listing.name}`,
        result: { locale: req.listing.locale, screenshots: req.screenshotPaths.length },
      }),
    setTerritories: async (req) => {
      const app = world.app(req.bindings.bundleId, req.platform);
      app.territories = [...req.territories];
      app.updatedAt = clock.iso();
    },
    submitForReview: async (req) => {
      const app = world.app(req.bindings.bundleId, req.platform);
      app.status = "waiting_for_review";
      app.storeBuildId = req.storeBuildId;
      app.updatedAt = clock.iso();
      const decision = world.reviewDecision(req.bindings.bundleId, req.storeBuildId);
      return world.createJob("store.review", { appKey: appKey(req.bindings, req.platform), minDays: 1, maxDays: 3, label: `review:${req.storeBuildId}`, result: decision });
    },
    release: async (req) => {
      world.settleJobs();
      const app = world.app(req.bindings.bundleId, req.platform);
      if (["waiting_for_review", "in_review", "rejected", "metadata_rejected"].includes(app.status)) throw new Error(`cannot release ${req.bindings.bundleId}: review state is ${app.status}`);
      if (app.status !== "live") app.liveSince = clock.iso();
      app.status = "live";
      app.updatedAt = clock.iso();
    },
    removeFromSale: async (req) => {
      const app = world.app(req.bindings.bundleId, req.platform);
      app.status = "removed";
      app.updatedAt = clock.iso();
    },
  };

  const monetization: MonetizationWrite = {
    kind: "sim",
    configure: async (req) => ({ offeringIds: world.setOffering(req.bindings.bundleId, req.productIds) }),
  };

  const remoteConfig: RemoteConfigWrite = {
    kind: "sim",
    setFlag: async (req) => {
      const v = ventureOf(req.bindings);
      if (!v) throw new Error(`no venture for bundle ${req.bindings.bundleId}`);
      world.setFlag(v.id, req.key, req.variants);
      return { flagKey: req.key };
    },
  };

  const metrics: MetricsPort = {
    kind: "sim",
    cellMetric: async (req) => world.cellMetric(req),
    internalShare: async (req) => world.internalShare(req.cellId),
    daily: async (req) => world.daily(req.ventureId, req.since, req.until),
    cohorts: async (req) => world.cohortRows(req.ventureId, req.cohortSince, req.cohortUntil, req.maxAgeDays),
  };

  const creatorsRead: CreatorRead = {
    kind: "sim",
    searchCreators: async (req) => world.searchCreators(req),
    listSubmissions: async (req) => world.listSubmissions(req.campaignExternalId),
    verifyPost: async (req) => world.verifyPost(req.submissionExternalId),
    balance: async () => ({ availableCents: world.walletBalance() }),
  };

  const creatorsWrite: CreatorWrite = {
    kind: "sim",
    createCampaign: async (campaign) => ({ externalId: world.openCampaign(campaign) }),
    closeCampaign: async (req) => world.closeCampaign(req.campaignExternalId),
    sendMessage: async (req) => world.recordMessage(req.creatorExternalId, req.text),
    offerDeal: async (req) => ({ externalId: world.offerDeal(req.deal.id) }),
    reviewDraft: async (req) => world.reviewSubmission(req.submissionExternalId, "draft", req.approve, req.note),
    reviewPost: async (req) => world.reviewSubmission(req.submissionExternalId, "post", req.approve, req.note),
    payout: async (req) => world.payout(req),
  };

  const socialRead: SocialRead = {
    kind: "sim",
    postStats: async (req): Promise<PostStats> => {
      const s = world.postStats(req.externalId);
      const views = s.views;
      const scaled = (rate: number) => (views === null ? null : Math.round(views * rate));
      return {
        asOf: clock.iso(),
        views,
        likes: scaled(0.06),
        comments: scaled(0.004),
        shares: scaled(0.01),
        saves: scaled(0.008),
        profileVisits: scaled(0.01),
        linkClicks: req.platform === "tiktok" ? null : scaled(0.002),
        ...(s.geo ? { audienceGeo: s.geo } : {}),
      };
    },
    poll: async (job) => world.pollJob(job.externalRef.simJobId),
  };

  const socialWrite: SocialWrite = {
    kind: "sim",
    publish: async (req) => world.publishOwned({ piece: req.piece, platform: req.platform, handle: req.account.handle, mode: req.mode, aiLabelled: aiLabelled(req.labels) }),
  };

  const adsRead: AdsRead = {
    kind: "sim",
    stats: async (req) => world.adStats(req.campaignExternalId, req.since, req.until),
  };

  const adsWrite: AdsWrite = {
    kind: "sim",
    createCampaign: async (req) => {
      const v = ventureOf(req.bindings);
      if (!v) throw new Error(`no venture for bundle ${req.bindings.bundleId}`);
      if (!req.endAt) throw new Error("ad campaigns need an end date");
      return { campaignExternalId: world.createAd({ ventureId: v.id, network: req.network, type: req.type, os: req.os, dailyBudgetCents: req.dailyBudgetCents, startAt: req.startAt, endAt: req.endAt, geos: req.geos, creatives: req.creatives }) };
    },
    setDailyBudget: async (req) => world.setAdBudget(req.campaignExternalId, req.dailyBudgetCents),
    pause: async (req) => world.pauseAd(req.campaignExternalId),
  };

  const web: WebWrite = {
    kind: "sim",
    putAsset: async (req) => {
      const bytes = existsSync(req.localPath) ? readFileSync(req.localPath) : Buffer.from(`${req.ventureId}:${basename(req.localPath)}`);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      return { publicUrl: `https://sim.example/m/${req.ventureId}/${sha256}`, sha256 };
    },
    publishSite: async (req) => ({ baseUrl: `https://${req.ventureId}.sim.example` }),
  };

  return {
    read: { clock, llm: opts.llm, media: opts.media, trends, store: storeRead, metrics, creators: creatorsRead, social: socialRead, ads: adsRead },
    write: { store: storeWrite, monetization, remoteConfig, creators: creatorsWrite, social: socialWrite, ads: adsWrite, web },
  };
}
