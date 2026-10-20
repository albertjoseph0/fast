import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { TEMPLATE_DIR } from "../builder/fixtures.ts";

const read = (rel: string) => readFileSync(join(TEMPLATE_DIR, rel), "utf8");

/** Loads an import-free template module (the template's own dependencies are not installed here). */
async function load<T>(rel: string): Promise<T> {
  const js = stripTypeScriptTypes(read(rel));
  return (await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`)) as T;
}

interface Attribution {
  sourceId?: string;
  channel?: string;
  inviter?: string;
}
interface Growth {
  parseAttribution(url: string | null): Attribution;
  surveyAttribution(answer: string): Attribution;
  cellIdFrom(variants: string[]): string | undefined;
  withParams(base: string, params: Record<string, string | null>): string;
  shareOutcome(platform: string, action: string | null): { counted: boolean; confirmed: boolean };
}
interface Routing {
  startRoute(s: { minimumAge: number; ageAnswer: "adult" | "under_age" | null; onboardingDone: boolean; hardPaywallFirst: boolean; entitled: boolean }): string;
  afterOnboardingRoute(placement: string, entitled: boolean): string;
}
interface Identity {
  randomId(random?: () => number): string;
  chooseUserId(stored: string | null, posthogId: string | null, random?: () => string): string;
}
interface Terms {
  offeredTrialDays(intro: { price: number; periodUnit: string; periodNumberOfUnits: number; cycles: number } | null, iosEligibility: number | null): number;
}

let growth: Growth;
let routing: Routing;
let identity: Identity;
let terms: Terms;

beforeAll(async () => {
  growth = await load<Growth>("src/growth.ts");
  routing = await load<Routing>("src/routing.ts");
  identity = await load<Identity>("src/identity.ts");
  terms = await load<Terms>("src/terms.ts");
});

const TRIAL_3D = { price: 0, periodUnit: "DAY", periodNumberOfUnits: 3, cycles: 1 };

describe("paywall trial eligibility", () => {
  it("shows a trial on iOS only when RevenueCat says the customer is eligible", () => {
    expect(terms.offeredTrialDays(TRIAL_3D, 2)).toBe(3);
    expect(terms.offeredTrialDays(TRIAL_3D, 1)).toBe(0); // used the trial already (same subscription group)
    expect(terms.offeredTrialDays(TRIAL_3D, 0)).toBe(0); // unknown: plain price, never a misleading trial
    expect(terms.offeredTrialDays(TRIAL_3D, 3)).toBe(0);
    expect(terms.offeredTrialDays(TRIAL_3D, null)).toBe(3); // Android: the default offer already reflects eligibility
  });

  it("checks eligibility when loading products and tracks trial_start only for a real trial", () => {
    const purchases = read("src/purchases.ts");
    expect(purchases).toContain("checkTrialOrIntroductoryPriceEligibility");
    expect(purchases).toContain("offeredTrialDays(pkg.product.introPrice");
    expect(purchases).toContain('periodType === "TRIAL"');
    const paywall = read("app/paywall.tsx");
    expect(paywall).toContain("if (trial && (await once(KEYS.trialStarted))) track(APP_EVENTS.trialStart");
  });
});

describe("age gate", () => {
  const base = { onboardingDone: false, hardPaywallFirst: false, entitled: false };

  it("asks adult-only apps for age confirmation before onboarding and keeps under-age users out", () => {
    expect(routing.startRoute({ ...base, minimumAge: 18, ageAnswer: null })).toBe("/age");
    expect(routing.startRoute({ ...base, minimumAge: 18, ageAnswer: "adult" })).toBe("/onboarding");
    expect(routing.startRoute({ ...base, minimumAge: 18, ageAnswer: "under_age", onboardingDone: true })).toBe("/age");
    expect(routing.startRoute({ ...base, minimumAge: 13, ageAnswer: null })).toBe("/onboarding");
    expect(routing.startRoute({ ...base, minimumAge: 16, ageAnswer: null, onboardingDone: true, hardPaywallFirst: true })).toBe("/paywall");
  });

  it("reads minimumAge from studio.json and sends analytics only a boolean", () => {
    expect((JSON.parse(read("studio.json")) as { minimumAge: number }).minimumAge).toBe(18);
    expect(read("src/types.ts")).toContain("minimumAge: 13 | 16 | 18;");
    const age = read("app/age.tsx");
    expect(age).toContain("setJson(KEYS.ageGate, value)");
    const tracked = age.match(/track\([^)]*\)/g) ?? [];
    expect(tracked).toEqual(['track(APP_EVENTS.onboardingStep, { step_id: "age_gate", kind: "age_gate", age_confirmed: adult })']);
    expect(read("app/index.tsx")).toContain("minimumAge: studio.minimumAge");
  });
});

describe("app user identity", () => {
  it("never falls back to a shared constant id", () => {
    const a = identity.chooseUserId(null, null);
    const b = identity.chooseUserId(null, null);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
    expect(identity.chooseUserId(null, "ph_1")).toBe("ph_1");
    expect(identity.chooseUserId("stored", "ph_2")).toBe("stored");
    for (const file of ["src/analytics.ts", "src/session.ts", "src/purchases.ts"]) expect(read(file), file).not.toContain('"anonymous"');
  });

  it("keeps the purchase identity and once-markers through Delete my data and relinks PostHog", () => {
    const storage = read("src/storage.ts");
    const kept = /KEPT_ON_DELETE[^=]*=\s*\[([^\]]*)\]/.exec(storage)?.[1] ?? "";
    for (const key of ["appUserId", "installToken", "installTracked", "trialStarted", "activated", "usesConsumed"]) expect(kept).toContain(`KEYS.${key}`);
    expect(kept).not.toContain("KEYS.profile");
    const settings = read("app/settings.tsx");
    expect(settings).toContain("await clearPersonalData();");
    expect(settings).toContain("await linkAnalyticsId(distinctId());");
    expect(settings).not.toContain("clearAll");
    expect(read("src/session.ts")).toContain("chooseUserId(await getJson<string | null>(KEYS.appUserId, null), distinctId())");
  });

  it("skips the paywall at the end of onboarding for subscribers", () => {
    expect(routing.afterOnboardingRoute("after_onboarding", true)).toBe("/home");
    expect(routing.afterOnboardingRoute("after_onboarding", false)).toBe("/paywall");
    expect(routing.afterOnboardingRoute("on_limit", false)).toBe("/home");
    expect(read("app/onboarding.tsx")).toContain("afterOnboardingRoute(spec.paywall.placement, await isEntitled())");
  });

  it("sends the server-issued install token with verdicts and deletion", () => {
    const api = read("src/api.ts");
    expect(api).toContain('post<{ installToken: string }>("/v1/install"');
    expect(api).toContain('postAsInstall("/v1/verdict"');
    expect(api).toContain('postAsInstall("/v1/delete"');
  });
});

describe("analytics person properties", () => {
  it("creates person profiles so set-once properties are stored", () => {
    expect(read("src/analytics.ts")).toContain('personProfiles: "always"');
  });

  it("attributes installs from link parameters, then from the survey", () => {
    expect(growth.parseAttribution("https://astra.example/chart?r=res_1&src=post_42&ch=creator_ugc")).toEqual({ sourceId: "post_42", channel: "creator_ugc" });
    expect(growth.parseAttribution("https://astra.example/chart?c=LUNA10")).toEqual({ sourceId: "code:luna10" });
    expect(growth.parseAttribution("https://astra.example/chart?i=019a-uuid&ch=share_loop")).toEqual({ sourceId: "share_loop:019a-uuid", channel: "share_loop", inviter: "019a-uuid" });
    expect(growth.parseAttribution("https://astra.example/chart?i=019a")).toEqual({ sourceId: "invite_loop:019a", channel: "invite_loop", inviter: "019a" });
    expect(growth.parseAttribution("https://astra.example/chart?ch=bogus&src=%3Cscript%3E")).toEqual({});
    expect(growth.parseAttribution(null)).toEqual({});
    expect(growth.surveyAttribution("TikTok")).toEqual({ sourceId: "survey:tiktok" });
    expect(growth.surveyAttribution("A friend")).toEqual({ sourceId: "survey:a_friend", channel: "invite_loop" });
    expect(growth.surveyAttribution("App Store search")).toEqual({ sourceId: "survey:app_store_search", channel: "app_store_search" });
    const analytics = read("src/analytics.ts");
    expect(analytics).toContain("source_id: a.sourceId");
    expect(analytics).toContain("channel: a.channel");
    expect(read("app/onboarding.tsx")).toContain("trackAttributionAnswer(answer)");
  });

  it("takes cell_id only from lab cell ids and experiment_id from studio.json", () => {
    expect(growth.cellIdFrom(["paywall_v2", "var_000003"])).toBeUndefined();
    expect(growth.cellIdFrom(["paywall_v2", "cell_000012"])).toBe("cell_000012");
    const session = read("src/session.ts");
    expect(session).toContain("cellIdFrom(flags.map((f) => f.variant))");
    expect(session).toContain("experimentId: studio.experimentId");
    expect(session).not.toContain("flags[0]?.variant;\n");
  });

  it("flags TestFlight builds as internal", () => {
    expect(read("src/analytics.ts")).toMatch(/getAppleStoreEnvironmentAsync\(\)[\s\S]{0,120}env === "sandbox"/);
  });
});

describe("share and invite loops", () => {
  it("counts a share only when iOS reports it completed", () => {
    expect(growth.shareOutcome("ios", "dismissedAction")).toEqual({ counted: false, confirmed: false });
    expect(growth.shareOutcome("ios", "sharedAction")).toEqual({ counted: true, confirmed: true });
    expect(growth.shareOutcome("android", null)).toEqual({ counted: true, confirmed: false });
    const result = read("app/result.tsx");
    expect(result).toContain("Share.share({ url: uri");
    expect(result.indexOf("if (!counted) return;")).toBeLessThan(result.indexOf("track(APP_EVENTS.share,"));
  });

  it("puts the sharer's distinct id in share and invite links and tracks invite_sent and the inviter on install", () => {
    expect(growth.withParams("https://a.example/chart", { r: "res 1", i: "ph_1", ch: null })).toBe("https://a.example/chart?r=res%201&i=ph_1");
    expect(growth.withParams("https://a.example/chart", { i: null })).toBe("https://a.example/chart");
    const links = read("src/links.ts");
    expect(links).toContain("{ r: resultId, i: sharerId");
    expect(links).toContain("{ i: inviterId");
    const result = read("app/result.tsx");
    expect(result).toContain("shareUrl(spec.share.deepLinkPath, result.id, distinctId())");
    expect(result).toContain("track(APP_EVENTS.inviteSent");
    expect(read("src/analytics.ts")).toContain("inviter_distinct_id: inviter");
    expect(read("src/session.ts")).toContain("parseAttribution(await Linking.getInitialURL()");
  });
});
