/**
 * Live store ports: App Store Connect and Google Play for listings, products, review and
 * release; EAS for builds and binary submission.
 *
 * Credentials are resolved per venture: bindings.publisherAccountIds[platform] → the
 * PublisherAccount's secretRefs (env var NAMES) → env. Neither store can create apps
 * through its API, so createApp returns a human task with the exact values to enter.
 * Every long-running operation returns a JobRef whose externalRef carries what poll()
 * needs; poll() maps external states onto JobPoll (results use the keys the orchestrator
 * folds back: easBuildId, artifactUrl, storeBuildId, reviewState, rejectionReasons).
 */
import type { Clock, StoreRead, StoreWrite } from "../core/ports.ts";
import type { StudioStore } from "../core/store.ts";
import type {
  ExternalJob,
  HumanTaskDraft,
  JobPoll,
  JobRef,
  PublisherAccount,
  StoreListing,
  StorePlatform,
  StoreProductDef,
  StoreRecord,
  StoreStatus,
  Venture,
  VentureBindings,
} from "../core/types.ts";
import type { StudioConfig } from "../config/schema.ts";
import { HttpClient, HttpError } from "./http.ts";
import type { DryRunRecorder } from "./http.ts";
import { AscClient } from "./apple/appStoreConnect.ts";
import type { AscResource } from "./apple/appStoreConnect.ts";
import { PlayClient } from "./google/play.ts";
import type { PlayRelease, PlayTrackResource } from "./google/play.ts";
import { EasCli } from "./expo/eas.ts";
import type { EasRunner } from "./expo/eas.ts";

export const ENV_VARS: readonly { name: string; purpose: string; required: boolean }[] = [
  { name: "ASC_REVIEW_CONTACT_FIRST_NAME", purpose: "App Review contact first name (required by Apple on the first submission)", required: false },
  { name: "ASC_REVIEW_CONTACT_LAST_NAME", purpose: "App Review contact last name", required: false },
  { name: "ASC_REVIEW_CONTACT_PHONE", purpose: "App Review contact phone, e.g. +1 415 555 0100", required: false },
  { name: "EXPO_TOKEN", purpose: "Expo token for EAS; a publisher can name another variable in secretRefs.expoToken", required: true },
];

export interface LiveStorePortsOptions {
  config: StudioConfig;
  store: StudioStore;
  env: Record<string, string | undefined>;
  dryRun: boolean;
  recorder?: DryRunRecorder;
  fetch?: typeof fetch;
  runner?: EasRunner;
  clock?: Clock;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_REFS: Record<StorePlatform, Record<string, string>> = {
  ios: { keyId: "ASC_KEY_ID", issuerId: "ASC_ISSUER_ID", privateKeyPath: "ASC_PRIVATE_KEY_PATH" },
  android: { serviceAccountJsonPath: "PLAY_SERVICE_ACCOUNT_JSON" },
};

const CAPABILITIES: Record<string, string> = {
  push: "PUSH_NOTIFICATIONS",
  associated_domains: "ASSOCIATED_DOMAINS",
  sign_in_with_apple: "APPLE_ID_AUTH",
};

/**
 * Play only allows country targeting on staged (inProgress) production releases, so a
 * full rollout restricted to the test storefronts is the largest fraction the API accepts.
 */
export const PLAY_TARGETED_FRACTION = 0.999;
const PLAY_PHASED_FRACTION = 0.2;

const APPROVED_STATES = new Set([
  "ACCEPTED",
  "PENDING_DEVELOPER_RELEASE",
  "PENDING_APPLE_RELEASE",
  "PROCESSING_FOR_DISTRIBUTION",
  "PROCESSING_FOR_APP_STORE",
  "READY_FOR_DISTRIBUTION",
  "READY_FOR_SALE",
]);

/** App Store version state → studio store status. */
export function iosStoreStatus(state: string | undefined): StoreStatus {
  switch (state) {
    case undefined:
    case "PREPARE_FOR_SUBMISSION":
    case "DEVELOPER_REJECTED":
      return "draft";
    case "READY_FOR_REVIEW":
      return "ready_to_submit";
    case "WAITING_FOR_EXPORT_COMPLIANCE":
      return "build_processing";
    case "WAITING_FOR_REVIEW":
      return "waiting_for_review";
    case "IN_REVIEW":
      return "in_review";
    case "REJECTED":
    case "INVALID_BINARY":
      return "rejected";
    case "METADATA_REJECTED":
      return "metadata_rejected";
    case "READY_FOR_DISTRIBUTION":
    case "READY_FOR_SALE":
    case "REPLACED_WITH_NEW_VERSION":
      return "live";
    case "DEVELOPER_REMOVED_FROM_SALE":
    case "REMOVED_FROM_SALE":
      return "removed";
    default:
      return APPROVED_STATES.has(state) ? "pending_release" : "draft";
  }
}

/** App Store version + review submission states → JobPoll for a store.review job. */
export function iosReviewPoll(req: { versionState?: string; submissionState?: string; appId: string }): JobPoll {
  const { versionState, submissionState } = req;
  const where = `see the Resolution Center: https://appstoreconnect.apple.com/apps/${req.appId}/distribution`;
  if (versionState && APPROVED_STATES.has(versionState)) return { status: "succeeded", result: { reviewState: "approved", versionState } };
  if (versionState === "METADATA_REJECTED") {
    return { status: "failed", result: { reviewState: "metadata_rejected", rejectionReasons: [`App Review rejected the metadata; ${where}`] }, error: "metadata rejected" };
  }
  if (versionState === "REJECTED" || versionState === "INVALID_BINARY" || submissionState === "UNRESOLVED_ISSUES") {
    const reason = versionState === "INVALID_BINARY" ? "Apple marked the binary invalid" : "App Review rejected the submission";
    return { status: "failed", result: { reviewState: "rejected", rejectionReasons: [`${reason}; ${where}`] }, error: reason };
  }
  if (versionState === "DEVELOPER_REJECTED" || submissionState === "CANCELING") {
    return { status: "failed", result: { reviewState: "rejected", rejectionReasons: ["Submission was withdrawn from review"] }, error: "withdrawn" };
  }
  return { status: "running", result: { reviewState: "in_review", versionState: versionState ?? "", submissionState: submissionState ?? "" }, pollAfterSec: versionState === "IN_REVIEW" ? 1_800 : 3_600 };
}

/** Play production track → studio store status. Play exposes no review state. */
export function androidStoreStatus(tracks: PlayTrackResource[]): StoreStatus {
  const production = tracks.find((t) => t.track === "production")?.releases ?? [];
  const statuses = new Set(production.map((r) => r.status));
  if (statuses.has("completed") || statuses.has("inProgress")) return "live";
  if (statuses.has("halted")) return "removed";
  const testing = tracks.some((t) => t.track !== "production" && (t.releases ?? []).some((r) => (r.versionCodes ?? []).length > 0));
  return testing ? "ready_to_submit" : "draft";
}

function rating(value: number): 1 | 2 | 3 | 4 | 5 {
  return Math.min(5, Math.max(1, Math.round(value))) as 1 | 2 | 3 | 4 | 5;
}

/** RFC-1034 base plan id from a ladder id ("week_699_t3" → "week-699-t3"). */
export function basePlanId(ladderId: string): string {
  const id = ladderId.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return (/^[a-z]/.test(id) ? id : `p-${id}`).slice(0, 63);
}

const BILLING: Record<StoreProductDef["period"], "P1W" | "P1M" | "P1Y"> = { week: "P1W", month: "P1M", year: "P1Y" };

function isDry(ref: Record<string, string>): boolean {
  return Object.values(ref).some((v) => v.startsWith("dry_"));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class LiveStores implements StoreRead, StoreWrite {
  readonly kind = "live" as const;
  private readonly ascClients = new Map<string, AscClient>();
  private readonly playClients = new Map<string, PlayClient>();
  private readonly easClients = new Map<string, EasCli>();
  private readonly publicWeb: HttpClient;

  constructor(private readonly opts: LiveStorePortsOptions) {
    this.publicWeb = new HttpClient({ service: "play", dryRun: false, maxRetries: 1, ...(opts.fetch ? { fetch: opts.fetch } : {}), ...(opts.sleep ? { sleep: opts.sleep } : {}) });
  }

  // -- StoreWrite ------------------------------------------------------------------------

  async registerBundleId(req: { bindings: VentureBindings; platform: StorePlatform; capabilities: string[] }): Promise<{ bundleIdResourceId: string }> {
    if (req.platform === "android") return { bundleIdResourceId: req.bindings.androidPackage };
    const capabilities = [...new Set(req.capabilities.map((c) => CAPABILITIES[c] ?? c.toUpperCase()))];
    const result = await this.asc(req.bindings).registerBundleId({
      identifier: req.bindings.bundleId,
      name: this.venture(req.bindings)?.name ?? req.bindings.bundleId,
      capabilities,
    });
    return { bundleIdResourceId: result.id };
  }

  async createApp(req: { bindings: VentureBindings; platform: StorePlatform; name: string; sku: string; primaryLocale: string }): Promise<{ appId: string } | { humanTask: HumanTaskDraft }> {
    const ventureId = this.venture(req.bindings)?.id;
    if (req.platform === "ios") {
      const asc = this.asc(req.bindings);
      const existing = asc.offline ? null : await asc.findAppByBundleId(req.bindings.bundleId);
      if (existing) return { appId: existing.id };
      return { humanTask: appleCreateAppTask({ ...req, bundleId: req.bindings.bundleId, ...(ventureId ? { ventureId } : {}) }) };
    }
    const pkg = req.bindings.androidPackage;
    if ((await this.play(req.bindings).appExists(pkg)) === true) return { appId: pkg };
    return { humanTask: playCreateAppTask({ ...req, packageName: pkg, ...(ventureId ? { ventureId } : {}) }) };
  }

  async upsertSubscriptions(req: { bindings: VentureBindings; platform: StorePlatform; groupName: string; products: StoreProductDef[] }): Promise<JobRef> {
    const locale = this.opts.config.company.defaultLocale;
    if (req.platform === "ios") {
      const asc = this.asc(req.bindings);
      const appId = await this.iosAppId(req.bindings);
      const group = await asc.ensureSubscriptionGroup(appId, req.groupName, { locale, name: this.venture(req.bindings)?.name ?? req.groupName });
      const ids: string[] = [];
      for (const def of req.products) {
        const territories = def.territories.length > 0 ? def.territories : this.territories(req.bindings, "ios");
        const { subscription, created } = await asc.ensureSubscription(
          group.id,
          // Same content at different durations shares one level, so users can crossgrade.
          { productId: def.productId, name: `${def.displayName} ${def.ladderId}`, displayName: def.displayName, period: def.period, groupLevel: 1 },
          locale,
        );
        if (created || !(await asc.subscriptionHasPrices(subscription.id))) await asc.setSubscriptionPrices(subscription.id, def.usdCents, territories);
        if (created || !(await asc.subscriptionHasAvailability(subscription.id))) await asc.setSubscriptionAvailability(subscription.id, territories);
        if (def.trialDays > 0) await asc.ensureFreeTrial(subscription.id, def.trialDays, territories);
        ids.push(subscription.id);
      }
      return this.job("store.upsert_subscriptions", { platform: "ios", appId, groupId: group.id, subscriptionIds: ids.join(",") }, 300);
    }
    const play = this.play(req.bindings);
    const pkg = req.bindings.androidPackage;
    for (const def of req.products) {
      await play.upsertSubscription(pkg, {
        productId: def.productId,
        basePlanId: basePlanId(def.ladderId),
        title: def.displayName,
        languageCode: locale,
        billingPeriod: BILLING[def.period],
        usdCents: def.usdCents,
        regions: def.territories.length > 0 ? def.territories : this.territories(req.bindings, "android"),
        trialDays: def.trialDays,
      });
    }
    return this.job("store.upsert_subscriptions", { platform: "android", packageName: pkg, productIds: req.products.map((p) => p.productId).join(",") }, 120);
  }

  async startBuild(req: { bindings: VentureBindings; platform: StorePlatform; projectDir: string }): Promise<JobRef> {
    const build = await this.eas(req.bindings).build({ platform: req.platform, projectDir: req.projectDir, env: this.easEnv(req.bindings, req.platform) });
    return this.job("store.build", { platform: req.platform, easBuildId: build.id, projectDir: req.projectDir }, 300);
  }

  async submitBuild(req: { bindings: VentureBindings; platform: StorePlatform; easBuildId: string }): Promise<JobRef> {
    const projectDir = this.projectDir(req.bindings);
    const eas = this.eas(req.bindings);
    const submission = await eas.submit({ platform: req.platform, buildId: req.easBuildId, projectDir, env: this.easEnv(req.bindings, req.platform) });
    const appId = req.platform === "ios" ? await this.iosAppId(req.bindings) : req.bindings.androidPackage;
    return this.job("store.submit_build", { platform: req.platform, easBuildId: req.easBuildId, projectDir, appId, ...(submission.id ? { easSubmissionId: submission.id } : {}) }, 600);
  }

  async updateListing(req: { bindings: VentureBindings; platform: StorePlatform; listing: StoreListing; screenshotPaths: string[] }): Promise<JobRef> {
    const { listing } = req;
    if (req.platform === "ios") {
      const asc = this.asc(req.bindings);
      const appId = await this.iosAppId(req.bindings);
      const appInfo = await asc.getAppInfo(appId);
      if (appInfo || asc.dryRun) {
        await asc.upsertAppInfoLocalization(appInfo?.id ?? `dry_appInfos_${appId}`, listing.locale, { name: listing.name, subtitle: listing.subtitle, privacyPolicyUrl: listing.privacyUrl });
      } else {
        throw new Error(`App Store Connect app ${appId} has no app info record`);
      }
      const version = await asc.ensureEditableVersion(appId, this.versionString(req.bindings));
      const localization = await asc.upsertVersionLocalization(version.id, listing.locale, {
        description: listing.description,
        keywords: listing.keywords,
        promotionalText: listing.promotionalText,
        supportUrl: listing.supportUrl,
        ...(listing.marketingUrl ? { marketingUrl: listing.marketingUrl } : {}),
      });
      const screenshotIds = req.screenshotPaths.length > 0 ? await asc.replaceScreenshots(localization.id, req.screenshotPaths, "APP_IPHONE_67") : [];
      return this.job("store.update_listing", { platform: "ios", appId, versionId: version.id, screenshotIds: screenshotIds.join(",") }, 60);
    }
    const play = this.play(req.bindings);
    const pkg = req.bindings.androidPackage;
    const editId = await play.insertEdit(pkg);
    await play.updateListing(pkg, editId, {
      language: listing.locale,
      title: listing.name.slice(0, 30),
      shortDescription: (listing.promotionalText.length <= 80 ? listing.promotionalText : listing.subtitle).slice(0, 80),
      fullDescription: listing.description.slice(0, 4_000),
    });
    await play.patchDetails(pkg, editId, { contactWebsite: listing.supportUrl, contactEmail: this.opts.config.company.supportEmail });
    if (req.screenshotPaths.length > 0) {
      await play.deleteAllImages(pkg, editId, listing.locale, "phoneScreenshots");
      for (const path of req.screenshotPaths.slice(0, 8)) await play.uploadImage(pkg, editId, listing.locale, "phoneScreenshots", path);
    }
    await play.commitEdit(pkg, editId);
    return this.job("store.update_listing", { platform: "android", packageName: pkg, editId }, 1);
  }

  async setTerritories(req: { bindings: VentureBindings; platform: StorePlatform; territories: string[] }): Promise<void> {
    if (req.platform === "ios") return this.asc(req.bindings).setTerritories(await this.iosAppId(req.bindings), req.territories);
    const countries = req.territories.map((t) => t.toUpperCase());
    await this.editProduction(req.bindings, (releases) => {
      if (releases.some((r) => r.status === "completed")) {
        throw new Error("Play: the production release is fully rolled out, so the API cannot retarget countries; change them in Play Console > Production > Countries/regions");
      }
      const staged = releases.filter((r) => r.status === "inProgress" || r.status === "halted");
      // No staged release yet: the next submission targets the venture's territories.
      if (staged.length === 0) return null;
      return releases.map((r) => (staged.includes(r) ? { ...r, countryTargeting: { countries, includeRestOfWorld: false } } : r));
    });
  }

  async submitForReview(req: { bindings: VentureBindings; platform: StorePlatform; storeBuildId: string; notesForReviewer: string }): Promise<JobRef> {
    if (req.platform === "ios") {
      const asc = this.asc(req.bindings);
      const appId = await this.iosAppId(req.bindings);
      const version = await asc.ensureEditableVersion(appId, this.versionString(req.bindings));
      await asc.attachBuild(version.id, req.storeBuildId);
      await asc.updateVersion(version.id, { releaseType: "MANUAL" });
      await asc.upsertReviewDetail(version.id, { notes: req.notesForReviewer, contactEmail: this.opts.config.company.supportEmail, ...this.reviewContact() });
      const reviewSubmissionId = await asc.submitForReview(appId, version.id);
      return this.job("store.review", { platform: "ios", appId, versionId: version.id, reviewSubmissionId }, 3_600);
    }
    const countries = this.territories(req.bindings, "android").map((t) => t.toUpperCase());
    const release: PlayRelease = {
      versionCodes: [req.storeBuildId],
      status: "inProgress",
      userFraction: PLAY_TARGETED_FRACTION,
      countryTargeting: { countries, includeRestOfWorld: false },
    };
    const editId = await this.editProduction(req.bindings, () => [release]);
    return this.job("store.review", { platform: "android", packageName: req.bindings.androidPackage, versionCode: req.storeBuildId, geo: countries[0] ?? "US", editId: editId ?? "" }, 3_600);
  }

  async release(req: { bindings: VentureBindings; platform: StorePlatform; phased: boolean }): Promise<void> {
    if (req.platform === "ios") {
      const asc = this.asc(req.bindings);
      const appId = await this.iosAppId(req.bindings);
      const pending = (await asc.findVersions(appId, ["PENDING_DEVELOPER_RELEASE"]))[0];
      if (!pending && !asc.dryRun) throw new Error(`App Store Connect app ${appId} has no version waiting for manual release`);
      const versionId = pending?.id ?? `dry_appStoreVersions_${appId}`;
      if (req.phased) await asc.enablePhasedRelease(versionId);
      await asc.requestRelease(versionId);
      return;
    }
    await this.editProduction(req.bindings, (releases) => {
      const latest = releases.find((r) => (r.versionCodes ?? []).length > 0 && r.status !== "halted");
      if (!latest) throw new Error("Play: no production release to roll out");
      const fraction = req.phased ? PLAY_PHASED_FRACTION : PLAY_TARGETED_FRACTION;
      const next: PlayRelease = latest.countryTargeting || req.phased ? { ...latest, status: "inProgress", userFraction: fraction } : { ...latest, status: "completed" };
      if (next.status === "completed") delete next.userFraction;
      return releases.map((r) => (r === latest ? next : r));
    });
  }

  async removeFromSale(req: { bindings: VentureBindings; platform: StorePlatform }): Promise<void> {
    if (req.platform === "ios") return this.asc(req.bindings).setTerritories(await this.iosAppId(req.bindings), []);
    await this.editProduction(req.bindings, (releases) => {
      const active = releases.filter((r) => r.status === "inProgress" || r.status === "completed");
      if (active.length === 0) return null;
      return releases.map((r) => (active.includes(r) ? { ...r, status: "halted" } : r));
    });
  }

  // -- StoreRead -------------------------------------------------------------------------

  async status(req: { bindings: VentureBindings; platform: StorePlatform }): Promise<Partial<StoreRecord>> {
    const base: Partial<StoreRecord> = { platform: req.platform, bundleId: req.platform === "ios" ? req.bindings.bundleId : req.bindings.androidPackage };
    if (req.platform === "ios") {
      const asc = this.asc(req.bindings);
      if (asc.offline) return base;
      const app = req.bindings.ascAppId ? await asc.getApp(req.bindings.ascAppId) : await asc.findAppByBundleId(req.bindings.bundleId);
      if (!app) return { ...base, status: "not_created" };
      const version = await asc.latestVersion(app.id);
      const territories = await asc.availableTerritories(app.id);
      const state = (version?.attributes.appVersionState ?? version?.attributes.appStoreState) as string | undefined;
      const status = territories !== null && territories.length === 0 && iosStoreStatus(state) === "live" ? "removed" : iosStoreStatus(state);
      return {
        ...base,
        appId: app.id,
        status,
        ...(version?.attributes.versionString ? { versionString: String(version.attributes.versionString) } : {}),
        ...(territories ? { territories } : {}),
      };
    }
    const play = this.play(req.bindings);
    if (play.offline) return base;
    const pkg = req.bindings.androidPackage;
    try {
      const tracks = await play.withReadEdit(pkg, (editId) => play.listTracks(pkg, editId));
      const production = tracks.find((t) => t.track === "production")?.releases ?? [];
      const countries = production.find((r) => r.countryTargeting)?.countryTargeting?.countries;
      return { ...base, appId: pkg, status: androidStoreStatus(tracks), ...(countries ? { territories: [...countries].sort() } : {}) };
    } catch (err) {
      if (err instanceof HttpError && (err.status === 404 || err.status === 403)) return { ...base, status: "not_created" };
      throw err;
    }
  }

  async reviews(req: { bindings: VentureBindings; platform: StorePlatform; since: string }): Promise<{ date: string; territory: string; rating: 1 | 2 | 3 | 4 | 5 }[]> {
    if (req.platform === "ios") {
      const asc = this.asc(req.bindings);
      if (asc.offline) return [];
      const appId = await this.iosAppId(req.bindings);
      return (await asc.customerReviews(appId, req.since)).map((r) => ({ date: r.createdDate.slice(0, 10), territory: r.territory, rating: rating(r.rating) }));
    }
    const play = this.play(req.bindings);
    if (play.offline) return [];
    return (await play.listReviews(req.bindings.androidPackage))
      .filter((r) => r.lastModified >= req.since)
      .map((r) => ({ date: r.lastModified.slice(0, 10), territory: (r.language.split(/[_-]/)[1] ?? "ZZ").toUpperCase(), rating: rating(r.starRating) }));
  }

  async poll(job: ExternalJob): Promise<JobPoll> {
    const ref = job.externalRef;
    if (isDry(ref)) return dryPoll(job);
    const platform = (ref.platform ?? "ios") as StorePlatform;
    const bindings = this.bindingsFor(job);
    switch (job.op) {
      case "store.build":
        return this.pollBuild(bindings, ref);
      case "store.submit_build":
        return platform === "ios" ? this.pollIosProcessing(bindings, ref) : this.pollPlayUpload(bindings, ref);
      case "store.update_listing":
        return platform === "ios" ? this.pollScreenshots(bindings, ref) : { status: "succeeded", result: { editId: ref.editId ?? "" } };
      case "store.review":
        return platform === "ios" ? this.pollIosReview(bindings, ref) : this.pollPlayReview(ref);
      case "store.upsert_subscriptions":
        return platform === "ios" ? this.pollIosSubscriptions(bindings, ref) : this.pollPlaySubscriptions(bindings, ref);
      default:
        return { status: "failed", error: `store ports cannot poll ${job.op}` };
    }
  }

  // -- polling -----------------------------------------------------------------------

  private async pollBuild(bindings: VentureBindings, ref: Record<string, string>): Promise<JobPoll> {
    const build = await this.eas(bindings).buildStatus({ id: ref.easBuildId ?? "", projectDir: ref.projectDir ?? this.projectDir(bindings) });
    const result = {
      easBuildId: build.id,
      ...(build.artifactUrl ? { artifactUrl: build.artifactUrl } : {}),
      ...(build.appVersion ? { appVersion: build.appVersion } : {}),
      ...(build.appBuildVersion ? { appBuildVersion: build.appBuildVersion } : {}),
    };
    if (build.status === "FINISHED") return { status: "succeeded", result };
    if (build.status === "ERRORED" || build.status === "CANCELED") return { status: "failed", result, error: build.error ?? `EAS build ${build.status.toLowerCase()}` };
    return { status: "running", result, pollAfterSec: 120 };
  }

  private async easVersions(bindings: VentureBindings, ref: Record<string, string>): Promise<{ appVersion?: string; appBuildVersion?: string }> {
    const build = await this.eas(bindings).buildStatus({ id: ref.easBuildId ?? "", projectDir: ref.projectDir ?? this.projectDir(bindings) });
    return { ...(build.appVersion ? { appVersion: build.appVersion } : {}), ...(build.appBuildVersion ? { appBuildVersion: build.appBuildVersion } : {}) };
  }

  private async pollIosProcessing(bindings: VentureBindings, ref: Record<string, string>): Promise<JobPoll> {
    const { appVersion, appBuildVersion } = await this.easVersions(bindings, ref);
    if (!appBuildVersion) return { status: "running", error: "EAS build has no build number yet", pollAfterSec: 300 };
    const appId = ref.appId ?? (await this.iosAppId(bindings));
    const build = await this.asc(bindings).findBuild(appId, { version: appBuildVersion, ...(appVersion ? { shortVersion: appVersion } : {}) });
    if (!build) return { status: "running", result: { appBuildVersion }, pollAfterSec: 300 };
    const processingState = String(build.attributes.processingState ?? "");
    if (processingState === "VALID") return { status: "succeeded", result: { storeBuildId: build.id, processingState } };
    if (processingState === "FAILED" || processingState === "INVALID") return { status: "failed", result: { storeBuildId: build.id, processingState }, error: `App Store build processing ${processingState}` };
    return { status: "running", result: { storeBuildId: build.id, processingState }, pollAfterSec: 300 };
  }

  private async pollPlayUpload(bindings: VentureBindings, ref: Record<string, string>): Promise<JobPoll> {
    const { appBuildVersion } = await this.easVersions(bindings, ref);
    if (!appBuildVersion) return { status: "running", error: "EAS build has no version code yet", pollAfterSec: 300 };
    const play = this.play(bindings);
    const pkg = ref.appId ?? bindings.androidPackage;
    const tracks = await play.withReadEdit(pkg, (editId) => play.listTracks(pkg, editId));
    const found = tracks.some((t) => (t.releases ?? []).some((r) => (r.versionCodes ?? []).includes(appBuildVersion)));
    return found ? { status: "succeeded", result: { storeBuildId: appBuildVersion } } : { status: "running", result: { appBuildVersion }, pollAfterSec: 300 };
  }

  private async pollScreenshots(bindings: VentureBindings, ref: Record<string, string>): Promise<JobPoll> {
    const ids = (ref.screenshotIds ?? "").split(",").filter(Boolean);
    const asc = this.asc(bindings);
    const states: string[] = [];
    const errors: string[] = [];
    for (const id of ids) {
      const shot: AscResource | null = await asc.getScreenshot(id);
      const delivery = (shot?.attributes.assetDeliveryState ?? {}) as { state?: string; errors?: { code?: string; description?: string }[] };
      states.push(delivery.state ?? "MISSING");
      for (const e of delivery.errors ?? []) errors.push(`${id}: ${e.code ?? ""} ${e.description ?? ""}`.trim());
    }
    if (states.some((s) => s === "FAILED" || s === "MISSING")) return { status: "failed", result: { states }, error: errors.join("; ") || "screenshot upload failed" };
    if (states.every((s) => s === "COMPLETE")) return { status: "succeeded", result: { versionId: ref.versionId ?? "", screenshots: ids.length } };
    return { status: "running", result: { states }, pollAfterSec: 60 };
  }

  private async pollIosReview(bindings: VentureBindings, ref: Record<string, string>): Promise<JobPoll> {
    const asc = this.asc(bindings);
    const version = ref.versionId ? await asc.getVersion(ref.versionId) : null;
    const submission = ref.reviewSubmissionId ? await asc.getReviewSubmission(ref.reviewSubmissionId) : null;
    const versionState = (version?.attributes.appVersionState ?? version?.attributes.appStoreState) as string | undefined;
    const submissionState = submission?.attributes.state as string | undefined;
    return iosReviewPoll({ appId: ref.appId ?? "", ...(versionState ? { versionState } : {}), ...(submissionState ? { submissionState } : {}) });
  }

  /**
   * The Play API has no review state. A release that passed review shows up on the public
   * store page for its target country, so that page is the approval signal.
   */
  private async pollPlayReview(ref: Record<string, string>): Promise<JobPoll> {
    const url = `https://play.google.com/store/apps/details?id=${encodeURIComponent(ref.packageName ?? "")}&gl=${ref.geo ?? "US"}&hl=en`;
    try {
      await this.publicWeb.get(url);
      return { status: "succeeded", result: { reviewState: "approved", storeBuildId: ref.versionCode ?? "" } };
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return { status: "running", result: { reviewState: "in_review" }, pollAfterSec: 3_600 };
      throw err;
    }
  }

  private async pollIosSubscriptions(bindings: VentureBindings, ref: Record<string, string>): Promise<JobPoll> {
    const asc = this.asc(bindings);
    const states: Record<string, string> = {};
    for (const id of (ref.subscriptionIds ?? "").split(",").filter(Boolean)) {
      states[id] = String((await asc.getSubscription(id))?.attributes.state ?? "MISSING");
    }
    const values = Object.values(states);
    if (values.some((s) => s === "REJECTED" || s === "MISSING")) return { status: "failed", result: { states }, error: "subscription rejected or missing" };
    if (values.some((s) => s === "MISSING_METADATA" || s === "DEVELOPER_ACTION_NEEDED")) {
      return {
        status: "needs_human",
        result: { states },
        error: `Subscriptions need metadata App Store Connect cannot take from the API alone (usually the App Review screenshot): https://appstoreconnect.apple.com/apps/${ref.appId ?? ""}/distribution/subscriptions`,
      };
    }
    return { status: "succeeded", result: { states } };
  }

  private async pollPlaySubscriptions(bindings: VentureBindings, ref: Record<string, string>): Promise<JobPoll> {
    const play = this.play(bindings);
    const pkg = ref.packageName ?? bindings.androidPackage;
    const states: Record<string, string> = {};
    for (const productId of (ref.productIds ?? "").split(",").filter(Boolean)) {
      const sub = await play.getSubscription(pkg, productId);
      states[productId] = sub?.basePlans?.every((b) => b.state === "ACTIVE") ? "ACTIVE" : (sub?.basePlans?.[0]?.state ?? "MISSING");
    }
    const values = Object.values(states);
    if (values.every((s) => s === "ACTIVE")) return { status: "succeeded", result: { states } };
    if (values.includes("MISSING")) return { status: "failed", result: { states }, error: "subscription missing in Play Console" };
    return { status: "running", result: { states }, pollAfterSec: 120 };
  }

  // -- helpers -----------------------------------------------------------------------

  /** A JobRef; dry-run jobs are tagged so poll() never asks a store about them. */
  private job(op: JobRef["op"], externalRef: Record<string, string>, pollAfterSec: number): JobRef {
    return { op, externalRef: this.opts.dryRun ? { ...externalRef, dryRun: "dry_run" } : externalRef, pollAfterSec };
  }

  /**
   * Fetch the production track inside a fresh edit, let `change` rewrite its releases and
   * commit; returning null discards the edit.
   */
  private async editProduction(bindings: VentureBindings, change: (releases: PlayRelease[]) => PlayRelease[] | null): Promise<string | null> {
    const play = this.play(bindings);
    const pkg = bindings.androidPackage;
    const editId = await play.insertEdit(pkg);
    try {
      const track = await play.getTrack(pkg, editId, "production");
      const next = change(track?.releases ?? []);
      if (!next) {
        await play.deleteEdit(pkg, editId);
        return null;
      }
      await play.updateTrack(pkg, editId, "production", next);
      await play.commitEdit(pkg, editId);
      return editId;
    } catch (err) {
      await play.deleteEdit(pkg, editId).catch(() => undefined);
      throw err;
    }
  }

  private venture(bindings: VentureBindings): Venture | undefined {
    return this.opts.store.ventures.list((v) => v.bindings.bundleId === bindings.bundleId)[0];
  }

  private bindingsFor(job: ExternalJob): VentureBindings {
    const venture = job.ventureId ? this.opts.store.ventures.get(job.ventureId) : undefined;
    if (!venture) throw new Error(`job ${job.id}: venture ${job.ventureId ?? "(none)"} not found`);
    return venture.bindings;
  }

  private publisher(bindings: VentureBindings, platform: StorePlatform): PublisherAccount | undefined {
    const id = bindings.publisherAccountIds[platform];
    const publishers = this.opts.store.publishers;
    return (id ? publishers.get(id) : undefined) ?? publishers.list((p) => p.platform === platform && p.status === "active")[0];
  }

  private refs(bindings: VentureBindings, platform: StorePlatform): { key: string; refs: Record<string, string>; publisher?: PublisherAccount } {
    const publisher = this.publisher(bindings, platform);
    if (publisher && publisher.status !== "active") throw new Error(`Publisher account ${publisher.id} is ${publisher.status}`);
    return { key: publisher?.id ?? `default-${platform}`, refs: { ...DEFAULT_REFS[platform], ...publisher?.secretRefs }, ...(publisher ? { publisher } : {}) };
  }

  private asc(bindings: VentureBindings): AscClient {
    const { key, refs } = this.refs(bindings, "ios");
    let client = this.ascClients.get(key);
    if (!client) {
      client = new AscClient({ ...this.common(), secretRefs: refs });
      this.ascClients.set(key, client);
    }
    return client;
  }

  private play(bindings: VentureBindings): PlayClient {
    const { key, refs } = this.refs(bindings, "android");
    let client = this.playClients.get(key);
    if (!client) {
      client = new PlayClient({ ...this.common(), secretRefs: refs });
      this.playClients.set(key, client);
    }
    return client;
  }

  private eas(bindings: VentureBindings): EasCli {
    const platform = bindings.platforms[0] ?? "ios";
    const tokenVar = this.publisher(bindings, platform)?.secretRefs.expoToken ?? "EXPO_TOKEN";
    let client = this.easClients.get(tokenVar);
    if (!client) {
      client = new EasCli({
        config: this.opts.config,
        store: this.opts.store,
        env: this.opts.env,
        dryRun: this.opts.dryRun,
        secretRefs: { token: tokenVar },
        ...(this.opts.recorder ? { recorder: this.opts.recorder } : {}),
        ...(this.opts.runner ? { runner: this.opts.runner } : {}),
      });
      this.easClients.set(tokenVar, client);
    }
    return client;
  }

  private common() {
    const o = this.opts;
    return {
      config: o.config,
      store: o.store,
      env: o.env,
      dryRun: o.dryRun,
      ...(o.recorder ? { recorder: o.recorder } : {}),
      ...(o.fetch ? { fetch: o.fetch } : {}),
      ...(o.clock ? { clock: o.clock } : {}),
      ...(o.sleep ? { sleep: o.sleep } : {}),
    };
  }

  /** App Store Connect credentials for EAS Submit, which cannot prompt in CI. */
  private easEnv(bindings: VentureBindings, platform: StorePlatform): Record<string, string> {
    if (platform !== "ios") return {};
    const { refs, publisher } = this.refs(bindings, "ios");
    const env = this.opts.env;
    const out: Record<string, string> = {};
    const set = (name: string, value: string | undefined) => {
      if (value) out[name] = value;
    };
    set("EXPO_ASC_API_KEY_PATH", refs.privateKeyPath ? env[refs.privateKeyPath] : undefined);
    set("EXPO_ASC_KEY_ID", refs.keyId ? env[refs.keyId] : undefined);
    set("EXPO_ASC_ISSUER_ID", refs.issuerId ? env[refs.issuerId] : undefined);
    set("EXPO_APPLE_TEAM_ID", publisher?.externalTeamId);
    if (publisher) out.EXPO_APPLE_TEAM_TYPE = "COMPANY_OR_ORGANIZATION";
    return out;
  }

  private reviewContact(): { contactFirstName?: string; contactLastName?: string; contactPhone?: string } {
    const env = this.opts.env;
    return {
      ...(env.ASC_REVIEW_CONTACT_FIRST_NAME ? { contactFirstName: env.ASC_REVIEW_CONTACT_FIRST_NAME } : {}),
      ...(env.ASC_REVIEW_CONTACT_LAST_NAME ? { contactLastName: env.ASC_REVIEW_CONTACT_LAST_NAME } : {}),
      ...(env.ASC_REVIEW_CONTACT_PHONE ? { contactPhone: env.ASC_REVIEW_CONTACT_PHONE } : {}),
    };
  }

  private async iosAppId(bindings: VentureBindings): Promise<string> {
    const known = bindings.ascAppId ?? this.venture(bindings)?.stores.find((s) => s.platform === "ios")?.appId;
    if (known) return known;
    const asc = this.asc(bindings);
    const found = await asc.findAppByBundleId(bindings.bundleId);
    if (found) return found.id;
    if (asc.dryRun) return `dry_apps_${bindings.bundleId}`;
    throw new Error(`No App Store Connect app for ${bindings.bundleId}; complete the apple.create_app task first`);
  }

  private versionString(bindings: VentureBindings): string {
    const venture = this.venture(bindings);
    return venture?.build?.version ?? venture?.stores.find((s) => s.platform === "ios")?.versionString ?? "1.0.0";
  }

  private projectDir(bindings: VentureBindings): string {
    const dir = this.venture(bindings)?.build?.projectDir;
    if (dir) return dir;
    if (this.opts.dryRun) return ".";
    throw new Error(`No build project directory recorded for ${bindings.bundleId}`);
  }

  /** The venture's store territories, falling back to the configured test storefronts (never nationwide). */
  private territories(bindings: VentureBindings, platform: StorePlatform): string[] {
    const record = this.venture(bindings)?.stores.find((s) => s.platform === platform);
    return record && record.territories.length > 0 ? record.territories : this.opts.config.lab.testGeos;
  }
}

function dryPoll(job: ExternalJob): JobPoll {
  const ref = job.externalRef;
  switch (job.op) {
    case "store.build":
      return { status: "succeeded", result: { easBuildId: ref.easBuildId ?? "", dryRun: true } };
    case "store.submit_build":
      return { status: "succeeded", result: { storeBuildId: `dry_build_${ref.easBuildId ?? job.id}`, dryRun: true } };
    case "store.review":
      return { status: "succeeded", result: { reviewState: "approved", dryRun: true } };
    default:
      return { status: "succeeded", result: { dryRun: true } };
  }
}

/** Human task for the one App Store step with no API: creating the app record. */
export function appleCreateAppTask(req: { name: string; sku: string; primaryLocale: string; bundleId: string; ventureId?: string }): HumanTaskDraft {
  return {
    kind: "apple.create_app",
    ...(req.ventureId ? { ventureId: req.ventureId } : {}),
    title: `Create the App Store app "${req.name}"`,
    instructions: [
      "App Store Connect has no API for creating apps, so this one step is manual.",
      "",
      "1. Open [App Store Connect > Apps](https://appstoreconnect.apple.com/apps), click **+** and choose **New App**.",
      "2. Enter exactly:",
      "   - Platforms: **iOS**",
      `   - Name: \`${req.name}\``,
      `   - Primary Language: \`${req.primaryLocale}\``,
      `   - Bundle ID: \`${req.bundleId}\` (already registered by the studio)`,
      `   - SKU: \`${req.sku}\``,
      "   - User Access: **Full Access**",
      "3. Click **Create**, open **App Information** and copy the **Apple ID** (9-11 digits) into this task.",
    ].join("\n"),
    inputs: [{ key: "ascAppId", label: "Apple ID of the new app", pattern: "^\\d{9,11}$" }],
  };
}

/** Human task for creating the Play Console app (the Play Developer API cannot create apps). */
export function playCreateAppTask(req: { name: string; primaryLocale: string; packageName: string; ventureId?: string }): HumanTaskDraft {
  return {
    kind: "play.create_app",
    ...(req.ventureId ? { ventureId: req.ventureId } : {}),
    title: `Create the Google Play app "${req.name}"`,
    instructions: [
      "The Google Play Developer API cannot create apps, so this one step is manual.",
      "",
      "1. Open [Play Console](https://play.google.com/console/developers) and click **Create app**.",
      `2. App name: \`${req.name}\`; Default language: \`${req.primaryLocale}\`; App or game: **App**; Free or paid: **Free** (subscriptions are in-app products).`,
      "3. Accept the declarations and click **Create app**.",
      `4. Under **Users and permissions**, give the studio's service account access to this app.`,
      `5. The package name \`${req.packageName}\` is bound by the first upload; the studio's EAS submission to the internal track does that.`,
      `6. Paste the store URL below to confirm.`,
    ].join("\n"),
    inputs: [
      {
        key: "playUrl",
        label: "Play Store URL of the new app",
        pattern: `^https://play\\.google\\.com/store/apps/details\\?id=${escapeRegex(req.packageName)}$`,
      },
    ],
  };
}

/** Live store ports for the orchestrator (one object serves both sides). */
export function createLiveStorePorts(opts: LiveStorePortsOptions): { read: StoreRead; write: StoreWrite } {
  const stores = new LiveStores(opts);
  return { read: stores, write: stores };
}
