# Runbook: operating the studio

This is for the humans on the board: what to set up once, what the studio will ask of you, and what to
do when something goes wrong. The studio runs itself between those touchpoints.

## 1. One-time setup

1. **One legal entity** (a US LLC or C-corp), with a D-U-N-S number for Apple. The studio uses one
   Apple Developer organization account and one Google Play organization account for every app.
   Don't create extra entities or accounts per app: Apple 4.3 and Play's enforcement-evasion policy
   target exactly that pattern.
2. **Developer accounts.** Enroll in the Apple Developer Program as an organization and create an App
   Store Connect API key (Admin or App Manager role). Optionally create a Google Play developer account
   and service account (Android is off by default).
3. **Service accounts**, each with its own credential in an environment variable (§3):
   * Expo/EAS for builds
   * RevenueCat for subscriptions
   * PostHog for analytics and flags
   * SideShift for creators
   * Meta for Instagram and ads
   * TikTok for posting and ads
   * Apple Ads
   * a web host for legal pages and universal links
   * a Claude Console key or Vercel AI Gateway for the agents and the verdict backend
4. **Connect the data paths the lab depends on** (once per studio):
   * In RevenueCat, enable the **PostHog integration** with these event names:
     * `conversion`, `renewal`, `trial_cancel`, `billing_issue`, `refund` (`src/core/events.ts`, `SERVER_EVENTS`).
     * Report revenue as **gross**; the studio derives proceeds itself.
   * Create one PostHog project per venture. The app template reads feature flags named exactly
     `paywall`, `onboarding`, `share` and `core` in that project, and sets the person properties the
     lab attributes by: storefront, `source_id`, channel, and experiment and cell ids.
   * Set `APPLE_TEAM_ID`. The first live run records the studio's entity and Apple organization
     account with it, and universal links use it.
5. **Initialize and dry-run:**
   ```bash
   npx factory init        # .factory/config.json: live mode, dry-run on
   npx factory tick        # runs a day; every write is recorded in .factory/dry-run/, nothing is sent
   ```
   Edit `company` in the config (legal name, bundle id prefix, support email, legal base URL), and
   review `budgets` and `autonomy` before going live.
6. **Go live** once the dry-run records look right: `npx factory go-live --confirm`.

## 2. What the studio will ask you for

The studio opens **human tasks** for steps no API allows. List them with `factory tasks`, read one
with `factory task <id>`, and complete it with `factory complete <id> key=value ...`. Inputs are
validated, and venture-scoped outputs are written into the venture's bindings. Time a venture spends
waiting on you doesn't count against its validation time box.

| Task | Scope | When | You enter |
|---|---|---|---|
| `apple.paid_apps_agreement` | studio | first day | `confirmed=yes` |
| `backend.deploy` | studio | first day | `backendUrl` (the verdict backend from `templates/expo-app/server`) |
| `creators.fund_wallet` | studio | first day | `fundedCents` |
| `apple.create_app` | venture | after the bundle id is registered | `ascAppId` (App Store Connect has no create-app API) |
| `apple.privacy_labels` | venture | before the first submission | `confirmed=yes` |
| `social.connect_account` | venture | when owned content or the attention probe needs an account | `platform`, `handle`, `tokenSecretRef` |
| `legal.review` | venture | sensitive or under-18 ideas, App Review rejections, escalated experiments | `decision` (and `reviewer`) |
| `ads.billing_setup` | studio | before the first paid amplification | `network`, `adAccountId` |
| `tiktok.audit`, `tiktok.verify_domain`, `meta.business_verification` | studio | once, to unlock direct posting and ads | as prompted |
| `play.*` | venture | only with Android enabled | as prompted |

**Approvals.** Governance sends some actions to you. List them with `factory approvals`, then approve
with `factory approve <id>` or reject with `factory reject <id> --reason "..."`. An approval is bound to
the action's payload hash, so if the payload changes, you'll be asked again. Expect to be asked for:

* the first store submission of each app
* resubmissions after a rejection
* every submission of a red-category app
* any change to core behaviour, monetization, age rating or data flows
* scaling, sunsetting and removal from sale
* the first ad campaign on each network
* the first payout to each creator
* anything above the auto-approve limits in `autonomy.autoApproveBelowCentsByKind`

Approved actions run on the next tick, or immediately with `factory execute`.

## 3. Credentials

Credentials never live in the state file. Accounts store the **names** of environment variables
(`PublisherAccount.secretRefs`, `OwnedAccount.tokenSecretRef`), and the integrations read the values at
call time. Keep them in your process manager or secret store, not in `.factory/`.

| Service | Variable | Required | Purpose |
|---|---|---|---|
| Studio | `APPLE_TEAM_ID` | yes | Apple Developer team id of the studio's organization account (universal links, publisher record) |
| Studio | `AI_GATEWAY_API_KEY` | no | Vercel AI Gateway key for Claude and media (or ANTHROPIC_API_KEY for the Anthropic API) |
| Studio | `ANTHROPIC_API_KEY` | no | Anthropic API key; when set, agents call the Anthropic API directly |
| App Store Connect | `ASC_KEY_ID` | yes | App Store Connect team API key id (default name of secretRefs.keyId) |
| App Store Connect | `ASC_ISSUER_ID` | yes | App Store Connect API issuer id (default name of secretRefs.issuerId) |
| App Store Connect | `ASC_PRIVATE_KEY_PATH` | yes | Path to the AuthKey_<id>.p8 file (default name of secretRefs.privateKeyPath) |
| App Store Connect | `ASC_PRIVATE_KEY` | no | PEM text of the .p8 key, an alternative to the path (secretRefs.privateKey) |
| Store ports | `ASC_REVIEW_CONTACT_FIRST_NAME` | no | App Review contact first name (required by Apple on the first submission) |
| Store ports | `ASC_REVIEW_CONTACT_LAST_NAME` | no | App Review contact last name |
| Store ports | `ASC_REVIEW_CONTACT_PHONE` | no | App Review contact phone, e.g. +1 415 555 0100 |
| Store ports | `EXPO_TOKEN` | yes | Expo token for EAS; a publisher can name another variable in secretRefs.expoToken |
| Google Play | `PLAY_SERVICE_ACCOUNT_JSON` | yes | Path to the Google service-account key JSON (default name of secretRefs.serviceAccountJsonPath) |
| Google Play | `PLAY_SERVICE_ACCOUNT_KEY` | no | Inline service-account key JSON, an alternative to the path (secretRefs.serviceAccountJson) |
| Expo EAS | `EAS_BIN` | no | eas-cli executable (default: eas on PATH) |
| RevenueCat | `RC_SECRET_KEY` | yes | RevenueCat REST API v2 secret key (project_configuration read_write, charts_metrics overview read) |
| PostHog | `POSTHOG_PERSONAL_API_KEY` | yes | PostHog personal API key with query:read and feature_flag:write on the venture projects |
| PostHog | `POSTHOG_HOST` | no | PostHog app host for the private API (default https://us.posthog.com; EU: https://eu.posthog.com) |
| SideShift | `SIDESHIFT_API_KEY` | yes | SideShift scoped Platform API key (Settings → Integrations): campaigns, jobs, contracts, applications, video-submissions, posts, messages, payouts, wallet, recruit scopes |
| SideShift | `SIDESHIFT_API_BASE` | no | Platform API base URL (default https://app.sideshift.app/api/oauth/v1) |
| SideShift | `SIDESHIFT_ACT_AS_COMPANY` | no | Company id sent as X-Act-As-Company when the key can act for several companies |
| SideShift | `SIDESHIFT_JOB_IMAGE_URL` | no | HTTPS cover image for marketplace job posts; without it campaigns are created but not posted to the marketplace (creators join by invite) |
| SideShift | `INSTAGRAM_OEMBED_TOKEN` | no | Meta app access token for Instagram oEmbed author checks (TikTok and YouTube oEmbed need none) |
| Instagram | `<OwnedAccount.tokenSecretRef>` | yes | Instagram (Facebook Login) user or system-user access token with instagram_basic, instagram_content_publish and instagram_manage_insights, one env var per connected account |
| TikTok | `<OwnedAccount.tokenSecretRef>_REFRESH_TOKEN` | no | TikTok refresh token; with the client key/secret, access tokens are refreshed automatically |
| TikTok | `TIKTOK_CLIENT_KEY` | no | TikTok developer app client key (token refresh) |
| TikTok | `TIKTOK_CLIENT_SECRET` | no | TikTok developer app client secret (token refresh) |
| YouTube | `YOUTUBE_CLIENT_ID` | no | Google OAuth client id of the studio's single YouTube API project (token refresh) |
| YouTube | `YOUTUBE_CLIENT_SECRET` | no | Google OAuth client secret (token refresh) |
| Meta Ads | `META_ADS_TOKEN` | yes | System-user access token with ads_management and ads_read on the venture ad accounts |
| Meta Ads | `META_ADS_PAGE_ID` | yes | Facebook Page that fronts the ads (object_id of every creative) |
| Meta Ads | `META_ADS_INSTAGRAM_USER_ID` | no | Brand Instagram user id: sponsor of partnership ads and identity of owned-post ads when the post's account is unknown |
| TikTok Ads | `TIKTOK_ADS_TOKEN` | yes | TikTok API for Business advertiser access token (Access-Token header) |
| TikTok Ads | `TIKTOK_ADS_APP_ID` | no | TikTok app-management id of the promoted app; looked up via app/list when unset |
| TikTok Ads | `TIKTOK_ADS_IDENTITY_ID` | no | Identity id of the brand's linked TikTok account (TT_USER) for boosting owned posts |
| Apple Ads | `APPLE_ADS_CLIENT_ID` | yes | Apple Ads API client id (from uploading the public key in Apple Ads account settings) |
| Apple Ads | `APPLE_ADS_TEAM_ID` | yes | Apple Ads API team id (client secret issuer) |
| Apple Ads | `APPLE_ADS_KEY_ID` | yes | Apple Ads API key id (client secret kid) |
| Apple Ads | `APPLE_ADS_PRIVATE_KEY_PATH` | yes | Path to the EC P-256 private key PEM that signs the client secret |
| Apple Ads | `APPLE_ADS_PRIVATE_KEY` | no | Inline private key PEM, an alternative to the path |
| Apple Ads | `APPLE_ADS_API_BASE` | no | Override of the Platform API base URL (default https://api.ads.apple.com/v1) |
| Web host (static) | `WEB_BASE_URL` | yes | Public URL where <dataDir>/web is deployed, e.g. https://apps.example.com (no trailing slash) |
| Web media (Vercel Blob, optional) | `BLOB_READ_WRITE_TOKEN` | yes | Vercel Blob read-write token (vercel_blob_rw_<storeId>_…) for a public store |
| Web media (Vercel Blob, optional) | `VERCEL_BLOB_API_URL` | no | Blob API base override (default https://vercel.com/api/blob) |

`<OwnedAccount.tokenSecretRef>` means the variable named when a brand account was connected
(`social.connect_account`), one per account. Run `npx factory env` to see which variables are set.

## 4. Daily operations

* `factory tick` once a day (cron or a scheduled job). A second run on the same date does nothing.
* `factory report` prints the latest daily report: portfolio, allocation, experiment decisions, open
  approvals and tasks, and per-phase status. A weekly board memo is appended every seventh day.
* `factory status` gives a one-screen summary.

## 5. When something goes wrong

| Situation | Do this |
|---|---|
| Anything looks wrong and you need everything to stop | `factory stop` (kill switch file). Nothing external runs until `factory resume`. |
| A platform warns or strikes an account | `factory freeze platform:<tiktok\|instagram\|...> --reason "..."`. Actions on that platform are blocked until you `factory unfreeze` it. |
| Ad spend misbehaves on a network | `factory freeze network:<meta\|tiktok\|apple> --reason "..."` |
| One app needs to pause | `factory freeze venture:<ven_…> --reason "..."` |
| A tick reports `interrupted during execution` | The process died mid-call. Check the external system for the action's effect, then cancel or re-approve it. Interrupted actions are never retried blindly. |
| App Review rejects an app | Spam or duplicate rejections (4.3, 5.6) propose a kill. Others open a `legal.review` task: complete it with `decision=resubmit` after fixing, or `decision=abandon`. |
| An experiment escalates | Its diagnostics are in the task. Complete it with `decision=rerun` or `decision=kill`. |
| The LLM budget runs out | The tick skips discovery and building for the day; everything else continues. Raise `llm.maxDailyCents` if needed. |
