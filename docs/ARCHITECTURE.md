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
screened → building ─→ in_review → live_test ⇄ iterating → scaling → harvest → sunsetting
    (S0 attention probe runs alongside building; it can only kill)
any stage → killed (gate fail · iterations exhausted · time box · test-spend cap · guardrail breach)
```

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

* **Metrics** (`MetricKey`) are proportions with Beta(1,1) posteriors, or rates (kFactor) with
  Gamma(0.5 + events, exposure) posteriors. Thresholds are in raw units with `{floor, target, futility}`.
* **Maturity.** `MetricsPort.cellMetric` counts only denominator units at least `maturityHours` old.
  For example, `trialKeep24h` uses trials ≥ 24h old, and true trial-to-paid is a scaling tripwire on
  matured cohorts.
* **Clustering.** Installs arrive from a few posts, so counts come `bySource`. The posterior uses
  `nEff = n / (1 + (m̄−1)ρ)` with a method-of-moments ICC (floor 0.01). Validity `source_concentration`
  requires ≥ 5 sources and none above 50% of the denominator.
* **Cells and attribution.** iOS has no install referrer.
  * Acquisition-side variables (hooks, creators, positioning) use **storefront-geo cells**, with
    territories = cell geos and creators recruited with ≥ 50% audience in the cell geo.
  * Product-side variables (onboarding, paywall, share, core prompt) use **user-randomized sticky flag
    variants** inside one storefront.
* **Decision table** (`lab/decide.ts`): continue / pass / replicate (sequential phase 2 is pre-registered)
  / iterate / kill / fix_harness / escalate. Iterations are capped per step, harness fixes are capped
  and then escalate to a human, and a test-spend cap per venture applies.
* **S4 unit economics.** The 20th percentile of predicted net D60 revenue per install (`lab/ltv.ts`:
  install → trial → keep-proxy → renewal survival, net of store fee and VAT) divided by the cell's CAC
  must reach `s4MinRoasD60P20`.

## 7. Growth engine

1. **Creator UGC (primary).** Creators are sourced by niche and audience geo. Deals are per-video, CPM,
   retainer or guarantee, with views locked after 7 days. Claude writes briefs. The flow is pre-post
   draft approval, then post-post verification fetched from the platform (public, author match,
   disclosure label, views). Payouts are computed in code and capped per creator per 30 days. The first
   payout to a new creator needs a human.
2. **Always-on creative loop** (`lab/creative.ts`), separate from the ladder. Weekly batches of
   `format × hook` arms are sampled with Thompson sampling on post-level installs per 1K views. An arm
   is culled at ≥ 6 posts with P(best) < 0.05, and 20% of traffic goes to exploration. Creator and owned
   content are separate arm families.
3. **Owned brand accounts (secondary).** One disclosed account per venture per platform, connected by a
   human. Instagram Trial Reels are the hook-testing surface. TikTok posts go as **inbox drafts** a human
   finishes, because the audit rejects uploaders for your own accounts. Posting caps sit well under
   platform limits, and near-duplicates are capped.
4. **Paid amplification (winners only).** Step 1, eligibility: the post's predicted net RPM_D60 is at
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
  spend policy check uses free cash.
* **Allocator.** Lanes are `venture|channel|geo|source`. Each lane gets a power-law response curve, and
  budget goes greedily to the highest marginal ROAS_D60 (p20) in $50 steps, ramping at most 25% every 3
  days. A projected 120-day cash trough must stay above the reserve. 35% of spend is held back for testing.
* **Harvest and exit.** Decay half-life and NPV-versus-sale estimates drive the stage moves: scaling →
  harvest, harvest → exit flag, and two months of negative contribution → sunset. Killing an app with
  paying users routes to `venture.sunset` (a human gate). The backend keeps serving users until their
  paid period ends.

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
  * iOS app creation (App Store Connect returns 403 on create), App Privacy labels, the Paid Apps Agreement
  * Play app creation and content rating
  * TikTok audit and domain verification
  * Meta business verification, ad billing, creator wallet funding
  * connecting social accounts, deploying the web host and backend

  Each task has typed inputs (e.g. `ascAppId`) written back into `VentureBindings`. Time a venture
  spends blocked on a human doesn't count against its time box.
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
