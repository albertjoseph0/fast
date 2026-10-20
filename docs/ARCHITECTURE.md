# Architecture: an autonomous viral-app studio

> Design v2 (2026-10-17). It folds in a six-lens adversarial design review covering experimental rigor,
> growth realism, compliance, API feasibility, contract completeness and unit economics. Research
> inputs: `docs/research/`.

## 1. What we are building

This is a company that runs itself. It:
* finds demand and invents single-player AI apps for core needs,
* builds and ships them in days,
* tests them in small storefronts with real human creators,
* reads each test as a pre-registered, binary decision,
* scales the winners within a cash-flow constraint, harvests decaying hits and kills the rest.

Claude supplies the judgment: ideas, specs, copy, briefs and critiques. Typed deterministic code makes
every decision that moves money, ships software or touches a platform.

The operating model is **Vert's** (vert.nyc, "a startup that makes startups"):

* **Single-player AI "verdict" utilities.** Eight apps share one template: personalization onboarding
  → hard paywall (about $6.99/week with a trial) → one AI capability. Astra does astrology, Plug AI dating
  texts, Strum song-to-chords, Eagle golf swings.
* **Human creators as the engine.** Vert runs 250+ influencer partnerships. SideShift ran 400+ TikToks
  for Astra in six weeks, and losing formats were culled each batch. The company is mostly creator-ops
  staff with a few AI-assisted engineers.
* **Many shots on goal.** Two or three winners carry the portfolio, and the rest are abandoned within weeks.

Nikita Bier's principles provide the **harness** that decides, conclusively and cheaply, which shot is a
winner (`docs/PRINCIPLES.md`).

## 2. System invariants

1. **The harness is the product** (P1). Throughput of validated tests is the company KPI.
2. **LLMs propose, code disposes.** Every LLM output is schema-validated and then linted. No LLM output
   ever sets a price, a payout amount, a disclosure flag, an approval or a policy decision.
3. **Every external side effect is an Action** (`core/types.ts`). Actions have typed payloads, a payload
   hash that approvals bind to, a content-derived idempotency key, a dedupe key and, for money, a
   commitment. Only `governance/executor.ts` holds `WritePorts`. The orchestrator and agents get
   `ReadPorts` plus `Outbox.propose()`.
4. **Write-ahead execution.** An action is committed as `executing` before its external call and as
   `executed` or `failed` after it. On restart, `executing` actions are reconciled, never re-run blindly.
5. **Compliant by construction.**
   * Real humans post on their own accounts.
   * Brand accounts are human-connected with standing consent.
   * AI content is labelled from derived disclosure (`labelsFor`).
   * Paid content is disclosed.
   * Copy contains no claims, prices or testimonials written by an LLM.
   * Payouts come only from platform-verified facts.
   * There are no engagement verbs (follow, like, comment, DM automation) anywhere.
6. **Deterministic simulation.** Every port has a simulator twin with the same failure surface as live
   (attribution loss, view leakage, review latency, rejections). `Rng.fork(label)` depends only on the
   seed and the label, so the same seed gives a byte-identical company history.
7. **Dry-run by default in live mode.** Actions execute as `dry_run`: the full request is recorded and
   nothing is sent. A human turns dry-run off through the CLI. The HTTP layer double-checks.

## 3. Shape

```
             ┌──────────────── Board (humans) ───────────────────────────┐
             │ approvals (payload-bound) · human tasks · kill switch ·    │
             │ budgets · daily memo                                       │
             └────────────────────────────▲───────────────────────────────┘
┌─────────────────────────────────────────┴──────────────────────────────────────┐
│ Studio tick (one day)                                                           │
│ poll jobs → sync metrics/ledger → lab → creative loop → advance ventures →     │
│ discovery → allocate → execute approved actions → memo → commit                 │
└───┬──────────┬───────────┬────────────┬─────────────┬────────────┬──────────────┘
 Discovery   Product      Ship        Growth        Lab          Portfolio
 scout       designer     builder     content       stats/power  allocator
 ideator     (spec+lint)  brand/ASO   creator ops   experiments  unit economics
 critics                  store jobs  creative loop decisions    harvest/exit
 gates                    web/legal   amplification audiences
     └──────────────── Governance: policy · outbox · executor · ledger · disclosure ┘
                                       │
           ReadPorts / WritePorts (core/ports.ts): llm · media · trends · store · metrics ·
           monetization · remoteConfig · creators · social · ads · web
                    │                                        │
              sim/ world model                     integrations/ (live; dry-run default)
```

## 4. Venture lifecycle

```
screened → building ─→ in_review → live_test ⇄ iterating → scaling → harvest → sunsetting → killed
    (S0 attention probe runs alongside building; it can only kill)
stop testing (iterations exhausted · time box · test-spend cap · futility · human decision):
    paying users + positive organic contribution → harvest (no growth spend)
    paying users otherwise                       → venture.sunset (human gate)
    no paying users                              → venture.kill
```

A variant that ships as a new build sends a live venture back through `building` and `in_review`; it can
still be harvested or sunset from there. A venture that has completed its ladder is outside the time box
while its `venture.scale` decision is pending.

Stop decisions record their cause (`evidence`, `timebox`, `spend_cap`, `scale_declined`, `app_review`,
`human`). While one is with the board, the venture registers no new experiment and replicates nothing.
A time-box or spend-cap stop is withdrawn if the venture validates before the board decides. The time box
pauses while the venture waits on a human, and while its experiment's creator campaigns are held by the
reserve because the studio is funding other ventures. The test-spend cap counts booked spend plus what
the venture's campaigns can still spend, and a test that would cross it is not registered.

**Build first, test with creators.** Vert ships builds every ~3 days. A pre-build "concept test" can't
be measured: TikTok and Reels have no clickable links, and creators would be endorsing a product that
doesn't exist. So the deciding test runs on the live app. The optional **S0 attention probe** runs owned
Instagram Trial Reels during the build and kills concepts whose hooks get no attention.

**Ladders** (config `lab.ladders`). Each step is one pre-registered experiment covering its stages:

| Ladder | Steps |
|---|---|
| single-player (Vert archetype) | **[S1_distribution + S1_activation + S4_monetization]** in one experiment over the same cells |
| social (tbh/Gas archetype, human-gated) | [S1_distribution + S1_activation] → [S2_sharing] → [S3_cross_cell, K ≥ 1.0] → [S4_monetization] |

`principles/ladder.ts` assigns the ladder: an idea is social when it lacks single-player value, needs
friends, or its primary channel is invites.

## 5. Principles as code

| # | Principle | Where | Rule |
|---|---|---|---|
| P1 | Reproducible testing > any idea | lab | No spend without a registered plan: hypothesis, one variable, metrics with floor/target/futility, power-based sample, validity checks, budget. The plan is frozen by `registrationHash`. |
| P2 | Most ideas are DOA | principles/gates | Reject if there are > 4 value conditions, a partnership dependency, or ≥ 7 friends needed without single-player value. |
| P3 | Narrow wedges | gates | Six-factor wedge score. Single-player ideas need a discoverable creator niche with ≥ 20 in-wedge creators. |
| P4 | No nationwide tests | lab/audiences, governance | Store territories = the active test-cell storefronts (CA, AU, NZ) and never the scale market until `venture.scale`. Exposure registry keyed `wedge\|channel\|platform\|unit` with an 8-week cooldown. |
| P5 | Works in one → all; fails in three → all | lab/decide | Three matched cells. All valid cells pass → pass. Zero pass → the variant failed. Mixed → diagnostics: a flagged confound → `fix_harness` on those cells only; otherwise the variant failed. Never scale on a mixed result. |
| P6 | Inconclusive tests are the biggest slowdown | lab/stats + decide | Binary read at the deadline: pass iff P(p ≥ floor) ≥ confidence, otherwise a valid failure. Early stops are futility-only. Invalid cells are harness bugs. Sample sizes come from an exact power search at the target value. |
| P7 | Distribution first | gates | An organic primary channel, a share artifact, ≥ 3 hooks and a creator niche are required. Paid-only ideas are rejected. |
| P8 | Long signup is fine if activation rises | principles/onboarding | 8-16 steps. AI-data consent before any data is collected. A value preview before the paywall. Paywall terms are rendered from store prices, never LLM copy. |
| P9 | Exposure on other networks | principles/product | A share artifact with watermark and deep link. Creators supply most external exposure for utilities. |
| P10 | Toilet test | gates | ≤ 5 taps and ≤ 15s to first value (3s target). Sustained attention is a hard fail. |
| P11 | Love, money, play | gates | Classified into one of the three. `self_improvement` is penalized unless it maps to one of them. Meetup apps are rejected. |

## 6. Lab

* **Metrics** (`MetricKey`) are proportions with Beta posteriors, or rates (kFactor) with Gamma
  posteriors, both under skeptical priors centred on the floor (`lab/stats.ts`). Thresholds are in raw
  units with `{floor, target, futility}`.
* **Maturity.** `MetricsPort.cellMetric` counts only denominator units at least `maturityHours` old.
  For example, `trialKeep24h` uses trials ≥ 24h old, and true trial-to-paid is a scaling tripwire on
  matured cohorts.
* **Clustering.** Installs arrive from a few posts, so counts come `bySource`. Each source is weighted
  by `1/(1 + (n_i−1)ρ)` (rates: `1/(1 + n_i·φ)`, with φ the overdispersion), and `nEff = Σ n_i w_i`, so
  one viral post adds at most about 1/ρ units of information. The ICC floor is 0.01 for user metrics and
  the planning `viewRho` (0.0003) for per-view metrics. Validity `source_concentration` requires ≥ 5
  sources.
* **Cells and attribution.** iOS has no install referrer.
  * Acquisition-side variables (hooks, creators, positioning) use **storefront-geo cells**, with
    territories = cell geos and creators recruited with ≥ 50% audience in the cell geo.
  * Product-side variables (onboarding, paywall, share, core prompt) use **user-randomized sticky flag
    variants** inside one storefront.
  * The app sets `source_id` and `channel` once, from the opening link (`?src=`, `?c=` creator code,
    `?ch=`) or else the attribution survey. PostHog spreads users with no source over 20 stable
    `unattributed:N` buckets, so they read as independent traffic, not one cluster. Shares and invites
    the app could not confirm (Android's share sheet never reports completion) don't count.
* **Decision table** (`lab/decide.ts`): continue / pass / replicate (sequential phase 2 is pre-registered)
  / iterate / kill / fix_harness / escalate. Iterations are capped per step, harness fixes are capped
  and then escalate to a human, and a test-spend cap per venture applies.
* **Read timing.** The exposure SLA runs from when a cell's creator campaign goes live, not from
  registration, so approvals and marketplace setup don't count against it. A campaign whose create ended
  without running (rejected, failed, withdrawn) starts the SLA when it ended, so the cell goes invalid
  instead of waiting forever. A creator cell's exposure clock, and the start of its metric reads, is its
  first creator post: organic storefront users and the previous step's tail never start it. Every
  creator-led read covers the posting window plus the longest metric maturity, and early reads wait for
  the posting window, so the first few posts don't decide the test.
* **Cost at read.** A cell's spend prices each approved post at its locked views or, before the lock, at
  its views as of the latest sync (refreshed daily), so CAC covers the same views the installs came from.
* **Robust reads.** Viral concentration is normal: one post often brings most of a cell's traffic. A
  cell is invalid for concentration only when its pass/fail verdict changes after dropping the top source
  (leave-one-out). A cell short of its planned sample at the deadline still decides when the posterior
  is conclusive. A fail can be conclusive at any sample; a pass needs at least half the planned sample.
  Only an open answer is a harness failure. The leave-one-out read uses the full cell's clustering.
* **S4 unit economics.** The 20th percentile of predicted net D60 revenue per install (`lab/ltv.ts`:
  install → trial → keep-proxy → renewal survival, net of store fee and VAT) divided by the cell's CAC
  must reach `s4MinRoasD60P20`.

## 7. Growth engine

1. **Creator UGC (primary).** Creators are sourced by niche and audience geo. Deals are per-video, CPM,
   retainer or guarantee, with views locked after 7 days. Claude writes briefs. The flow is pre-post
   draft approval, then post-post verification fetched from the platform (public, author match,
   disclosure label, views). A post whose live caption differs from the approved draft is reviewed again,
   and every caption passes the copy lint (counts, rankings, prices, efficacy claims) whatever the
   reviewer says. Views lock once, 7 days after posting. Payouts are computed in code and capped per
   creator per 30 days. The first payout to a new creator needs a human, and so does any post or payout
   for an 18+ app whose creator's under-18 audience share is unknown. An 18+ app recruits adult
   audiences: its brief asks for them, the campaign carries the under-18 ceiling for marketplaces that
   filter on it, and a draft or post from a mostly-young audience is turned down. A payout the marketplace refuses is
   retried daily under a fresh idempotency key and goes to a human (`creators.payout_failed`) after three
   refusals. A payout whose call may have reached the marketplace is held as paid until a human checks
   (`creators.verify_payout`): sent books it, not sent releases it to be paid again.
2. **Always-on creative loop** (`lab/creative.ts`), separate from the ladder. Weekly batches of
   `format × hook` arms are sampled with Thompson sampling on post-level installs per 1K views. An arm
   is culled at ≥ 6 posts with P(best) < 0.05, and 20% of traffic goes to exploration. Creator and owned
   content are separate arm families.
3. **Owned brand accounts (secondary).** One disclosed account per venture per platform, connected by a
   human. Instagram Trial Reels are the hook-testing surface. TikTok posts go as **inbox drafts** a human
   finishes, because the audit rejects uploaders for your own accounts. Posting caps sit well under
   platform limits, and near-duplicates are capped.
4. **Paid amplification (winners only; designed, not yet built: the allocator funds creator batches only).** Step 1, eligibility: the post's predicted net RPM_D60 is at
   least 1.5× its effective creator CPM, with ≥ 50 attributed installs. Step 2: a capped 3-day probe.
   The creative scales only if the probe's p20 ROAS_D60 ≥ 1. A fatigue rule pauses it. Apple Ads
   brand-defense search is exempt but capped.
5. **Share loop and SEO.** Result cards carry a watermark and deep link. Programmatic pages run through
   `WebPort`.

## 8. Portfolio and money

* **Ledger.** `governance/ledger.ts` is the only writer, and entries are idempotent on `sourceKey`.
  Revenue is booked as proceeds after store fee and VAT, with `settlesAt` reflecting store settlement
  lag. Cash counts settled proceeds only.
* **Free cash** = cash − outstanding commitments − accrued creator liabilities − refund reserve. Every
  spend policy check uses free cash. The refund reserve is the haircut on the refund window's gross
  revenue less the refunds already booked in it. A closed creator campaign keeps what its in-flight posts
  may still earn. The reserve never holds back a payout of money already owed: paying an accrued
  liability leaves free cash unchanged.
* **Allocator** (`orchestrator/allocator.ts`). Each scaling venture is one lane today. Its unit economics
  come from cohorts at least one trial period old over the last 28 days. Predicted D60 net revenue per
  install is computed at the 20th percentile of the conversion posterior. Marginal CAC is the average CAC
  × 1.25, a deliberately conservative stand-in for a fitted response curve. Budget moves +25% at most
  every 3 days when marginal ROAS(D60, p20) ≥ 1 and payback fits the window (30 days, or 60 when free cash
  is high). It is cut by 25% below the S4 bar and set to zero below half of it. The pool is the daily cap
  minus the 35% held back for validation. Spend committed until payback must fit in the free cash
  validation does not hold (the same 35%), so scaling batches cannot lock up the cash new experiments
  need. Each venture's last budget and when it changed live on the venture, so cuts and ramp cool-downs
  survive a process per tick. The scaling budget funds weekly Thompson-sampled creator batches.
* **Harvest, sunset and exit.**
  * Scaling → harvest when the lane is cut to zero and weekly proceeds fall more than 30% below peak.
  * Harvest → sunset after the configured number of consecutive months of negative *organic*
    contribution, i.e. revenue, refunds, inference and infrastructure. Trailing creator payouts from the
    test phase are sunk costs and don't count.
  * Sunset removes the app and its subscriptions from sale at once, so there are no new sales or
    renewals. The backend serves users until their paid periods lapse, and the venture is killed when no
    subscribers remain.
  * An exit flag is raised when trailing-year proceeds are material and declining, and a sale is worth
    more than holding.

## 9. Governance

* **Policy** (`governance/policy.ts`) applies predicates with citations. The checks are:
  * kill switch, hard cap, daily cap on free cash, reserve
  * always-approve kinds; first store submission, resubmission after rejection, territory expansion
  * first ad campaign per network; new creator payouts
  * price changes outside the grid or affecting subscribers
  * minors (< 18) and sensitive domains
  * posting caps and TikTok audit status
  * disclosure labels present
  * payouts only for post-approved, platform-verified, view-locked submissions with amounts recomputed
  * ads only for proven creatives
* **Human tasks** cover steps no API allows:
  * iOS app creation (App Store Connect returns 403 on create), App Privacy labels, the age rating and
    primary category (`apple.app_info`), the Paid Apps Agreement
  * Play app creation and content rating
  * TikTok audit and domain verification
  * Meta business verification, ad billing, creator wallet funding
  * connecting social accounts, deploying the web host and backend
  * per venture: the PostHog, RevenueCat and EAS projects (`integrations.bind_projects`), the backend
    tenant (`backend.add_tenant`, re-opened whenever the tenant file's content changes), and spec copy
    the linter cannot clear alone (`legal.review` before submission)
  * console steps an adapter reports it cannot do, repeated build or upload failures, and failed
    subscription setup (`store.manual_step`)
  * posting a TikTok inbox draft with its labels (`social.finish_draft`), creator payouts the marketplace
    refused or whose outcome is unknown

  Each task has typed inputs (e.g. `ascAppId`) written back into `VentureBindings`, and opens as soon as
  its inputs exist so people work while the API steps run. Time a venture spends blocked on a required
  task doesn't count against its time box.
* **Dry run.** One flag drives the live ports, the executor and the outbox. A write port's dry-run answer
  is recorded as `dry_run`, never `executed`, and holds its dedupe key while dry-run is on. Lifecycle
  decisions (`venture.*`) have no external effect and run even in dry-run. After go-live, dry runs count
  for nothing, so the first real submission still meets its gates.
* **Accounts.** The studio uses **one legal entity, one Apple organization account and one Google Play
  organization account.** We deliberately do *not* copy Vert's multi-LLC structure. Spreading
  template-built apps across shell accounts is the signature Apple 4.3 and Play's "evading enforcement"
  rules target, and it gives no real isolation. Extra entities exist only for spin-outs and sales,
  created by humans.
* **Regions.** EU and UK storefronts stay off until GDPR consent flows, an Art. 27 representative and DSA
  trader verification are configured (`privacy.euUkEnabled`).

## 10. Modules

| Path | Responsibility |
|---|---|
| `src/core/` | types, ports, events, store (commit protocol, lock, migration), clock, rng, context |
| `src/config/` | `StudioConfig` |
| `src/principles/` | Bier registry, idea gates, ladder, sensitivity classifier, spec and onboarding lint, copy lint |
| `src/lab/` | stats (Beta/Gamma, power, clustering), metrics registry, experiment design, decide, audiences, creative bandit, LTV |
| `src/playbook/` | sourced benchmarks, content formats, product defaults, safety preambles, Vert case data, setup checklist |
| `src/llm/` | Claude adapter (Anthropic API or Vercel AI Gateway, custom JSON schema), deterministic stub, media via AI Gateway |
| `src/agents/` | scout, ideator, critics, sensitivity, designer, brand, content, creator ops, analyst, compliance, CEO memo |
| `src/governance/` | policy, outbox, executor, approvals, human tasks, ledger and cost meter, disclosure, payouts |
| `src/builder/` + `templates/expo-app/` | spec → Expo project + store metadata + legal pages + screenshots; multi-tenant verdict backend |
| `src/sim/` | world model and simulated ports |
| `src/integrations/` | Apple (App Store Connect, charts), Google Play, EAS, RevenueCat, PostHog (metrics + flags), SideShift, Instagram, TikTok, YouTube, Meta Ads, Apple Ads, web host |
| `src/orchestrator/` | tick phases, lifecycle state machine, metrics assembly, allocator, harvest and exit, reports, sim runner |
| `src/cli/` | `factory` command |

**The app and its backend** (`templates/expo-app/`). An 18+ app asks for age before onboarding and stops
under-18 users. A trial is offered only when StoreKit reports the user eligible. The app's user id is
stored per install (never a shared fallback), and the backend authenticates requests with an
HMAC-signed install token it mints per install, so a reinstalled or rotated id gets no extra free uses
and deleting data does not reset limits. User input is JSON-encoded inside its prompt tags. Each tenant
file sets the app's rate limits, daily verdict cap and a token budget with room for every output
section; the backend re-reads changed tenant files without a restart.

## 11. Design-review decisions

**Adopted:**
* Binary reads with futility-only stops (the two-threshold rule almost never decided).
* Power-based sample sizes and plan feasibility checks.
* Cohort maturity and the 24h trial-keep proxy.
* Clustering corrections.
* Storefront and flag attribution.
* Ladders by app type, with S0 moved off the critical path.
* Read/write port split, typed payloads, payload-bound approvals, write-ahead execution.
* Human tasks and async jobs.
* `WebPort`.
* Price ladder with remote-config paywalls.
* Creator and deal entities with platform-verified payouts.
* Creative bandit, unit economics, allocator cash-trough constraint, harvest and exit.
* Claim-free copy lint, derived disclosure, age and sensitivity classifier.
* Single publisher account, EU/UK gating.
* Deterministic RNG forks, escaped prompt blocks, custom JSON Schema for structured outputs (the SDK
  helper drops `enum`/`const`).

**Simplified:**
* Webhook intake (polling only, for now).
* Full Apple Ads Platform API coverage (search and creative campaign create, budget and pause only).
* Google Ads (deferred).

**Rejected:** copying Vert's multi-LLC account structure.

## 12. What end-to-end runs changed

Simulated company runs (`factory sim`) exercise every phase against the simulated market, and real
Claude agents can run against it too (`--llm gateway`). They exposed problems no unit test caught:

* **Harness false alarms killed good apps.** Four causes:
  * the exposure clock started on organic installs;
  * a per-view metric was flagged "impossible" when installs outran counted views;
  * reads closed before most posts had matured;
  * any viral post invalidated a cell.

  Each one sent ventures through `fix_harness`, escalation and the time box.
* **Money leaks.**
  * Payouts proposed in the same tick each saw the full remaining campaign budget.
  * Sunsetting apps stayed on sale and kept acquiring users.
  * Discovery stalled because sunsetting apps held portfolio slots.
* **Deadlocks.**
  * Policy demanded approved subscriptions before RevenueCat setup, but Apple approves them with the
    first build.
  * A validated venture was harvested by the time box while its scale approval was pending.
* **Throughput.** The write-ahead executor persisted the full state twice per action, and the ledger
  recomputed balances on every policy check. Simulations now checkpoint weekly. The ledger caches its
  figures per store revision.
* **Gateway.** Long, high-effort structured calls (idea batches) were dropped as 502s when sent
  non-streaming. Gateway calls now always stream.

An adversarial review of the whole system then confirmed 87 findings, fixed module by module with a
regression test each. The ones that changed behaviour most:

* **Money.** Lifetime campaign commitments, payout retries, unknown-outcome payouts and the test-spend
  cap all undercounted what the studio had promised. Scaling batches could take every cent of free
  cash, so validation starved and the time box killed ventures that were only waiting for money.
* **Lab.** One viral post collapsed a cell's effective sample. Reads started the clock on organic users
  and priced posts at day-0 views, which biased per-view conversion down and CAC down by about 1.4×.
* **Lifecycle.** A pending time-box sunset could wind down a winner that validated the next day. A
  failed designer call re-tested the failed baseline. A failed campaign create left an experiment that
  never decided.
* **Operations.** The allocator forgot its plan between live ticks, a simulation could overwrite a live
  data directory, and the executor could record a dry-run response as executed.

