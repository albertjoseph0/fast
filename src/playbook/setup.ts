/**
 * The steps no API allows, as human-task templates. Entity-scoped tasks run once for the
 * studio; venture-scoped tasks run per venture and their input keys are VentureBindings
 * fields (or `confirmed` for attestations), which governance writes back on completion.
 */
import type { HumanTaskDraft, HumanTaskKind } from "../core/types.ts";

export interface SetupStep {
  kind: HumanTaskKind;
  scope: "entity" | "venture";
  title: string;
  /** Markdown with links to the exact console page. */
  instructions: string;
  inputs: { key: string; label: string; pattern?: string }[];
}

const CONFIRM = { key: "confirmed", label: "Type 'yes' once done", pattern: "^yes$" };
const HTTPS_URL = "^https://[^\\s/$.?#].[^\\s]*$";
const HOSTNAME = "^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,}$";
const ENV_VAR = "^[A-Z][A-Z0-9_]*$";

export const SETUP_CHECKLIST: readonly SetupStep[] = [
  {
    kind: "apple.create_app",
    scope: "venture",
    title: "Create the iOS app record in App Store Connect",
    instructions: [
      "App Store Connect's API cannot create apps (POST /v1/apps returns 403), so a human creates the record.",
      "1. Open [App Store Connect → Apps](https://appstoreconnect.apple.com/apps) and choose **+ → New App**.",
      "2. Platform iOS; use the name, primary language, bundle ID and SKU from the venture's `store.create_app` action payload.",
      "3. Do not set pricing or availability: the studio sets territories to the test storefronts only.",
      "4. Copy the numeric **Apple ID** from App Information.",
    ].join("\n"),
    inputs: [{ key: "ascAppId", label: "Apple ID of the app (App Information → Apple ID)", pattern: "^\\d{9,11}$" }],
  },
  {
    kind: "apple.privacy_labels",
    scope: "venture",
    title: "Publish the App Privacy labels",
    instructions: [
      "Privacy nutrition labels cannot be set through the API.",
      "1. Open [App Store Connect → Apps](https://appstoreconnect.apple.com/apps) → the app → **App Privacy**.",
      "2. Answer from the spec's `compliance.dataInventory`: each data type, its purposes, whether it is linked to the user and whether it is used for tracking.",
      "3. Name third-party AI processing (Anthropic) where user content is sent.",
      "4. Set the privacy policy URL to the venture's `privacyUrl` and **Publish**.",
    ].join("\n"),
    inputs: [CONFIRM],
  },
  {
    kind: "apple.paid_apps_agreement",
    scope: "entity",
    title: "Accept the Paid Apps Agreement and set up banking and tax",
    instructions: [
      "Subscriptions cannot be sold until the Account Holder accepts the agreement.",
      "1. Open [App Store Connect → Business](https://appstoreconnect.apple.com/business) as the Account Holder.",
      "2. Accept the **Paid Apps Agreement**, then add bank account and tax forms (W-9 for a US entity).",
      "3. Confirm the Small Business Program enrollment status so the store-fee rate in config matches.",
    ].join("\n"),
    inputs: [CONFIRM],
  },
  {
    kind: "play.create_app",
    scope: "venture",
    title: "Create the app in Google Play Console",
    instructions: [
      "The Play Developer API cannot create apps.",
      "1. Open [Play Console](https://play.google.com/console) → **Create app**.",
      "2. Use the venture's name and default language; choose **App**, **Free** (subscriptions are in-app).",
      "3. Accept the declarations, then upload the first AAB from the EAS build to the internal testing track so the package name is claimed.",
    ].join("\n"),
    inputs: [
      { key: "androidPackage", label: "Package name", pattern: "^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$" },
      { key: "playUrl", label: "Store listing URL", pattern: "^https://play\\.google\\.com/store/apps/details\\?id=.+$" },
    ],
  },
  {
    kind: "play.content_rating",
    scope: "venture",
    title: "Complete the IARC content rating questionnaire",
    instructions: [
      "1. Open [Play Console](https://play.google.com/console) → the app → **Policy → App content → Content rating**.",
      "2. Answer for an AI app with user-generated prompts: no sexual content, no gambling unless the venture is in that domain, AI-generated responses present.",
      "3. Set **Target audience** to match the spec's `compliance.minimumAge`; never include under-13s.",
    ].join("\n"),
    inputs: [CONFIRM],
  },
  {
    kind: "play.data_safety_review",
    scope: "venture",
    title: "Submit the Data safety form",
    instructions: [
      "1. Open [Play Console](https://play.google.com/console) → the app → **Policy → App content → Data safety**.",
      "2. Declare each entry of the spec's `compliance.dataInventory` (collected vs shared, purpose, encryption in transit, deletion request path).",
      "3. Link the venture's `privacyUrl` and submit for review.",
    ].join("\n"),
    inputs: [CONFIRM],
  },
  {
    kind: "play.production_access",
    scope: "venture",
    title: "Get production access on Google Play",
    instructions: [
      "Organization accounts usually publish directly; personal accounts must run a closed test first.",
      "1. Open [Play Console](https://play.google.com/console) → the app → **Test and release → Production**.",
      "2. If Play asks for a closed test, run it with the required number of opted-in testers for the required days, then **Apply for production**.",
      "3. Restrict countries to the venture's current test storefronts.",
    ].join("\n"),
    inputs: [CONFIRM],
  },
  {
    kind: "social.connect_account",
    scope: "venture",
    title: "Create and connect the venture's disclosed brand account",
    instructions: [
      "The studio never creates social accounts. One account per venture per platform, run by a human.",
      "1. Create the account by hand; the bio must name it as the official account of the app.",
      "2. Switch it to a professional/business account ([Instagram](https://www.instagram.com/accounts/convert_to_professional_account/), [TikTok Business Center](https://business.tiktok.com/)).",
      "3. Authorize the studio's developer app with only the publishing scopes, and store the token in the environment variable named below (never paste the token here).",
      "4. Grant standing consent for posting within the configured caps.",
    ].join("\n"),
    inputs: [
      { key: "platform", label: "Platform", pattern: "^(tiktok|instagram|youtube|x|pinterest|snapchat|threads)$" },
      { key: "handle", label: "Account handle", pattern: "^@?[A-Za-z0-9._]{2,30}$" },
      { key: "tokenSecretRef", label: "Environment variable holding the access token", pattern: ENV_VAR },
    ],
  },
  {
    kind: "tiktok.audit",
    scope: "entity",
    title: "Pass the TikTok Content Posting API audit",
    instructions: [
      "Unaudited clients can only post privately (SELF_ONLY). The audit rejects internal uploaders for your own accounts, so owned TikTok posts stay inbox drafts.",
      "1. Open [TikTok for Developers → Manage apps](https://developers.tiktok.com/apps).",
      "2. Submit the app for review with a demo video showing the full consent flow, disclosure toggles and creator-chosen privacy.",
      "3. Record the outcome; set `distribution.tiktokAudited` only if it passed.",
    ].join("\n"),
    inputs: [{ key: "auditStatus", label: "Audit outcome", pattern: "^(approved|rejected)$" }],
  },
  {
    kind: "tiktok.verify_domain",
    scope: "entity",
    title: "Verify the media domain for TikTok photo posts",
    instructions: [
      "Photo (slideshow) posts pull images by URL only from verified domains.",
      "1. Open [TikTok for Developers → Manage apps](https://developers.tiktok.com/apps) → the app → **URL properties**.",
      "2. Add the studio's asset host domain and complete DNS TXT or file verification.",
    ].join("\n"),
    inputs: [{ key: "verifiedDomain", label: "Verified domain", pattern: HOSTNAME }],
  },
  {
    kind: "meta.business_verification",
    scope: "entity",
    title: "Complete Meta business verification",
    instructions: [
      "Advanced Access for Instagram publishing and the Marketing API requires a verified business.",
      "1. Open [Meta Business Settings → Security Center](https://business.facebook.com/settings/security).",
      "2. Start **Business verification** with the legal entity's documents.",
      "3. Then request App Review for the publishing and ads permissions in the [Meta App Dashboard](https://developers.facebook.com/apps/).",
    ].join("\n"),
    inputs: [{ key: "metaBusinessId", label: "Business Manager ID", pattern: "^\\d{6,20}$" }],
  },
  {
    kind: "ads.billing_setup",
    scope: "entity",
    title: "Set up an ad account with billing",
    instructions: [
      "Payment methods are never handled by the studio.",
      "- Apple Ads: [ads.apple.com](https://ads.apple.com) → Account Settings → Billing.",
      "- Meta: [Billing & payments](https://business.facebook.com/billing_hub/payment_settings).",
      "- TikTok: [TikTok Ads Manager](https://ads.tiktok.com/) → Payment.",
      "Set an account spending limit no higher than the configured daily spend cap times 30.",
    ].join("\n"),
    inputs: [
      { key: "network", label: "Ad network", pattern: "^(meta|tiktok|apple|google)$" },
      { key: "adAccountId", label: "Ad account ID" },
    ],
  },
  {
    kind: "creators.fund_wallet",
    scope: "entity",
    title: "Fund the creator marketplace wallet",
    instructions: [
      "Payouts run from a prepaid marketplace balance; the studio never stores card details.",
      "- SideShift: [SideShift dashboard](https://app.sideshift.app/) → Billing.",
      "- Whop Content Rewards: [Whop dashboard](https://whop.com/dashboard/) → Balance.",
      "Fund no more than the approved creator budget; enter the amount added in cents.",
    ].join("\n"),
    inputs: [{ key: "fundedCents", label: "Amount added (US cents)", pattern: "^\\d+$" }],
  },
  {
    kind: "web.deploy_site",
    scope: "venture",
    title: "Point the venture's domain at the web host",
    instructions: [
      "Legal pages, support page, share-card landing pages and the universal-link files live on the venture's domain.",
      "1. Register the domain and point DNS at the studio's web host.",
      "2. Confirm `https://<domain>/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json` are served with HTTPS.",
      "3. Check them against [Apple's associated-domains guide](https://developer.apple.com/documentation/xcode/supporting-associated-domains) and [Android App Links verification](https://developer.android.com/training/app-links/verify-android-applinks).",
      "4. Enter the base URL and the deep-link domain.",
    ].join("\n"),
    inputs: [
      { key: "webBaseUrl", label: "Base URL", pattern: HTTPS_URL },
      { key: "deepLinkDomain", label: "Deep-link domain", pattern: HOSTNAME },
    ],
  },
  {
    kind: "backend.deploy",
    scope: "entity",
    title: "Deploy the multi-tenant verdict backend",
    instructions: [
      "The backend holds the model API key and composes each venture's system prompt from the playbook safety preamble.",
      "1. Create a dedicated key in the [Claude Console](https://console.anthropic.com/settings/keys) with a monthly spend limit.",
      "2. Deploy the verdict backend produced by the builder to the studio's host, with that key as a server secret (never in the app binary).",
      "3. Set INSTALL_TOKEN_SECRET to a random string of 32+ bytes (without it install tokens reset on every restart), and TRUST_PROXY=1 when it runs behind a load balancer that sets X-Forwarded-For. Rate limits and the daily verdict cap come from each tenant file.",
      "4. Enter the public HTTPS URL.",
    ].join("\n"),
    inputs: [{ key: "backendUrl", label: "Backend base URL", pattern: HTTPS_URL }],
  },
  {
    kind: "integrations.bind_projects",
    scope: "venture",
    title: "Create the venture's analytics, subscription and build projects",
    instructions: [
      "Each venture gets its own projects so data, flags and builds never mix between apps.",
      "1. [PostHog](https://us.posthog.com/project/settings): create a project named after the app; copy its numeric project id and its public project API key (the key goes into the venture's EAS environment as EXPO_PUBLIC_POSTHOG_API_KEY).",
      "2. [RevenueCat](https://app.revenuecat.com/projects): create a project; copy its project id (proj...) and add the app's public SDK key to the EAS environment as EXPO_PUBLIC_REVENUECAT_IOS_KEY. Enable the PostHog integration with the event names in the runbook.",
      "3. [Expo](https://expo.dev/accounts): create a project for the app's slug (or run `eas init` in the rendered app folder); copy the EAS project id (a UUID).",
    ].join("\n"),
    inputs: [
      { key: "posthogProjectId", label: "PostHog project id", pattern: "^\\d+$" },
      { key: "revenueCatProjectId", label: "RevenueCat project id", pattern: "^proj[A-Za-z0-9]+$" },
      { key: "easProjectId", label: "EAS project id (UUID)", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" },
    ],
  },
  {
    kind: "backend.add_tenant",
    scope: "venture",
    title: "Add the venture to the verdict backend",
    instructions: [
      "The verdict backend serves one tenant file per app; the studio renders it but never holds deploy credentials.",
      "1. Copy `<data dir>/ventures/<slug>/app/server/tenants/<slug>.json` into the deployed backend's `tenants/` directory (or its tenant store).",
      "2. Set the server secret named in the file's `revenueCatSecretEnv` to the venture's RevenueCat secret key ([RevenueCat API keys](https://app.revenuecat.com/projects)).",
      "3. Check `GET <backendUrl>/v1/config?slug=<slug>` returns 200 (a 404 and an `unknown_app` log line naming the tenants directory means the file is not where the server reads it; no restart is needed once it is), then confirm here.",
    ].join("\n"),
    inputs: [CONFIRM],
  },
  {
    kind: "apple.app_info",
    scope: "venture",
    title: "Complete the App Store information Apple requires before the first submission",
    instructions: [
      "Set these in [App Store Connect](https://appstoreconnect.apple.com/apps) → the app, using the context below. The studio sets copyright, content rights and the Free price through the API at submission; a content-rights answer you give here is kept.",
      "1. **Age Rating**: answer the questionnaire so the rating is at least the minimum age in the context, and answer for the sensitive domains it lists (gambling, mature or suggestive themes, medical information, unrestricted web access, AI-generated and user-generated content as applicable).",
      "2. **App Information**: the primary category in the context.",
      "Do not change pricing or availability: the studio manages price and territories.",
    ].join("\n"),
    inputs: [CONFIRM],
  },
  {
    kind: "social.finish_draft",
    scope: "venture",
    title: "Post a brand-account draft with its disclosure labels",
    instructions: [
      "Until the TikTok Content Posting API audit passes, owned posts arrive as drafts in the account's TikTok inbox, and the API cannot set their labels.",
      "1. Open the [TikTok app](https://www.tiktok.com/) on the brand account and find the draft named in the context.",
      "2. Turn on exactly the labels listed in the context (AI-generated content; 'Your brand' or 'Branded content') before posting. Do not edit the caption.",
      "3. Post it, then confirm here.",
    ].join("\n"),
    inputs: [CONFIRM],
  },
  {
    kind: "store.manual_step",
    scope: "venture",
    title: "Finish a store step the API cannot do",
    instructions: [
      "A store adapter reported a step that only the console allows, most often the App Review screenshot a new subscription needs.",
      "1. Open the console link in the context below ([App Store Connect](https://appstoreconnect.apple.com/apps) or [Play Console](https://play.google.com/console)).",
      "2. Complete the missing item exactly as the console asks; do not change prices, territories or copy.",
      "3. Confirm here; the studio re-checks the store and continues.",
    ].join("\n"),
    inputs: [CONFIRM],
  },
  {
    kind: "creators.payout_failed",
    scope: "venture",
    title: "Resolve a creator payout the marketplace refused",
    instructions: [
      "The studio owes this creator for an approved post, but the marketplace refused the payout on every retry (most often the creator has not finished their payout setup).",
      "1. Open the campaign in the [SideShift dashboard](https://app.sideshift.app/) and read the payout error named in the context.",
      "2. Ask the creator to finish their payout setup, or fix the wallet if it is the studio's side. Do not pay outside the marketplace.",
      "3. Complete with decision \"retry\" once it is fixed (the studio pays the same locked amount), or \"void\" if the creator will not be paid (the liability is released).",
    ].join("\n"),
    inputs: [{ key: "decision", label: "retry or void", pattern: "^(retry|void)$" }],
  },
  {
    kind: "creators.verify_payout",
    scope: "venture",
    title: "Check whether a creator payout went out",
    instructions: [
      "A payout call failed or was interrupted after it may have reached the marketplace. Until you check, the studio counts it as paid and will not pay that post again.",
      "1. Open the campaign in the [SideShift dashboard](https://app.sideshift.app/) and look for a payout to the creator named in the context, for the amount shown.",
      "2. Complete with decision \"sent\" if it is there (the studio records it as paid), or \"not_sent\" if it is not (the hold is released and the studio pays the same locked amount again).",
    ].join("\n"),
    inputs: [{ key: "decision", label: "sent or not_sent", pattern: "^(sent|not_sent)$" }],
  },
  {
    kind: "creators.verify_post",
    scope: "venture",
    title: "Find the public URL of a creator's post",
    instructions: [
      "The marketplace reported a creator's post without a link, so the studio cannot check it on the platform (public, author, paid-partnership label, views) or pay for it.",
      "1. Open the campaign in the [SideShift dashboard](https://app.sideshift.app/) and find the post by the creator and platform in the context.",
      "2. Open it on the platform and copy its public URL (not a share or tracking link).",
      "3. Enter it here; the studio verifies the post on its next sync.",
    ].join("\n"),
    inputs: [{ key: "postUrl", label: "Public URL of the post", pattern: HTTPS_URL }],
  },
  {
    kind: "legal.review",
    scope: "venture",
    title: "Legal review of a sensitive venture",
    instructions: [
      "Required for sensitive domains, minors and anything the compliance agent escalates.",
      "1. Review the spec, the composed system prompt, the onboarding and paywall copy, and the store listing against the [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/) and the [FTC endorsement guides](https://www.ftc.gov/business-guidance/advertising-marketing/endorsements-influencers-reviews).",
      "2. Check the privacy policy and terms on the venture's site against the data inventory.",
      "3. Record the decision; changes requested blocks the venture until a new spec version passes.",
    ].join("\n"),
    inputs: [
      { key: "decision", label: "Decision", pattern: "^(approved|changes_requested)$" },
      { key: "reviewer", label: "Reviewer name" },
    ],
  },
];

const BY_KIND = new Map(SETUP_CHECKLIST.map((s) => [s.kind, s]));

/** A human-task draft for `kind`. Venture-scoped kinds require a ventureId; `extra` adds task-specific context. */
export function taskDraft(kind: HumanTaskKind, ventureId?: string, extra?: string): HumanTaskDraft {
  const step = BY_KIND.get(kind);
  if (!step) throw new Error(`no setup step for human task kind: ${kind}`);
  if (step.scope === "venture" && !ventureId) throw new Error(`human task ${kind} is venture-scoped and needs a ventureId`);
  const instructions = extra ? `${step.instructions}\n\n**Context:** ${extra}` : step.instructions;
  return {
    kind,
    ...(ventureId ? { ventureId } : {}),
    title: ventureId ? `${step.title} (${ventureId})` : step.title,
    instructions,
    inputs: step.inputs.map((i) => ({ ...i })),
  };
}
