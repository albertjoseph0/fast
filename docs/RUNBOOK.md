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
4. **Initialize and dry-run:**
   ```bash
   npx factory init        # .factory/config.json: live mode, dry-run on
   npx factory tick        # runs a day; every write is recorded in .factory/dry-run/, nothing is sent
   ```
   Edit `company` in the config (legal name, bundle id prefix, support email, legal base URL), and
   review `budgets` and `autonomy` before going live.
5. **Go live** once the dry-run records look right: `npx factory go-live --confirm`.

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

<!-- env-vars -->

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
