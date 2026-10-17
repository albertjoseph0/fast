# Architecture: an autonomous viral-app studio

> Status: design v1, the build plan for this repository. Research inputs are in `docs/research/`.

## 1. What we are building

A company that runs itself: it finds demand, invents apps, tests them cheaply, builds and ships
the winners, markets them through human creators and owned channels, monetizes with remote-configurable
paywalls, and moves capital across a portfolio, using Claude for judgment and deterministic code for
every decision that must be auditable.

It copies the operating model of **Vert** (vert.nyc, "a startup that makes startups"). Vert has 8 apps
across three LLCs, claims $25-30M+ ARR, has no outside funding, and is mostly creator-ops staff with a few
engineers. Its structure is:

* **Single-player AI "verdict" utilities** in core-need niches. Examples: Astra (astrology and compatibility),
  Plug AI (dating-text replies), Strum (song to chords), Eagle (golf swing). Each delivers value on the
  first use, so there is no cold start.
* **A long personalization onboarding followed by a hard paywall.** Typical pricing is about $6.99/week
  after a short trial, plus annual and monthly SKUs, and price testing runs constantly.
* **Distribution through human creators** (250+ influencer partnerships, SideShift batches of 400+
  TikToks), with formats scored on installs and losers culled each batch. Organic winners are later
  recycled as paid creative.
* **Many shots on goal.** Two or three winners carry the portfolio, and the rest are launched quickly and
  then abandoned.

Nikita Bier's principles provide the **test harness**: how to decide quickly and conclusively which shots
are winners.

## 2. Design principles of the system itself

1. **The harness is the product** (Bier P1). The scarce asset is a reproducible, pre-registered testing
   process. Apps are outputs of it.
2. **LLMs propose and code disposes.** Claude generates ideas, specs, copy, briefs and critiques. Typed,
   tested, deterministic code decides kill or scale, money movement and policy. Every LLM output is
   schema-validated.
3. **Every side effect is an Action.** Nothing touches the outside world except through the governed
   outbox. Each action passes policy, then either executes autonomously within its limits or waits in the
   human approval queue.
4. **Compliant by construction.** Real humans post on their own accounts, AI content is labelled,
   paid content is disclosed, and there are no fake reviews, engagement farming or account farms. These
   are system invariants, not guidelines.
5. **Simulate everything.** Every port has a simulator, so the whole company can run end-to-end, for
   example 90 simulated days, with no credentials. That is how the decision logic is tested before it
   spends real money.

## 3. Top-level shape

```
             ┌──────────────── Board (humans) ─────────────────┐
             │ approval queue · budgets · kill switch · memos   │
             └───────────────────────▲──────────────────────────┘
                                     │ approvals / digests
┌────────────────────────────────────┴──────────────────────────────────────┐
│ Studio loop  (orchestrator/studio.ts: one tick = one day)                 │
│  sync metrics → lab decisions → advance ventures → discovery → allocate   │
└──┬──────────┬──────────┬───────────┬───────────┬───────────┬─────────────┘
   │          │          │           │           │           │
Discovery   Product    Ship       Growth      Lab          Portfolio
scout       designer   builder    content     experiments  allocator
ideator     (spec)     brand/ASO  creatorOps  stats        decay/exit
critic                 store      paid amp    audiences
gates                                          
   │          │          │           │           │           │
   └──────────┴──────── Governance: policy · outbox · approvals · ledger ───┘
                                     │
                  Ports (core/ports.ts): llm · media · trends · store ·
                  monetization · metrics · creators · social · ads
                     │                                   │
               sim/ (world model)                integrations/ (live APIs,
                                                 dry-run by default)
```

## 4. Venture lifecycle

```
screened → concept_test → specced → building → in_review → live_test ⇄ iterating → scaling → harvest
     ↘ killed (gate fail · 3 valid failures · iterations exhausted · time box · guardrail breach)
```

| Stage | What happens | Exit rule |
|---|---|---|
| screened | Idea passed the deterministic principle gates and the critic panel | Concept-test slot free |
| concept_test (S0) | Hooks about the concept go out before anything is built: brand-account trial reels plus a small creator batch in one test geo. Measure views and intent (link clicks or waitlist joins per 1K views). | pass + replication → specced; kill → killed |
| specced | Claude writes the AppSpec, which is linted against P8/P9/P10 and policy and repaired once | Lint clean |
| building | The template renderer produces an Expo project, store metadata, legal pages and brand assets | Checks pass |
| in_review | Store actions: create app (human on iOS), upload, listing, **territories = test geos only** (P4), submit | Live |
| live_test | The validation ladder runs S1 → S2 → S4, each a pre-registered experiment over matched cells | All stages validated |
| iterating | After a valid failure, Claude proposes **one** variable to change (hooks, onboarding, paywall, share, core, positioning) and the stage is retested | Pass, or kill after N |
| scaling | The allocator funds creator campaigns, amplifies proven organic winners with paid ads, and expands territories | Payback breach, or decay → harvest |
| harvest | Price optimization, lower spend, decay tracking, exit flag | Sunset or exit |

## 5. The principles as code

`src/principles/` encodes each Bier principle as a gate, a lint or a decision rule. The 2026 review of
each principle is in `docs/PRINCIPLES.md`.

| # | Principle | Where it lives | Rule |
|---|---|---|---|
| P1 | Reproducible testing > any idea | lab/experiments.ts | No experiment runs without a pre-registered hypothesis, one variable, metric, thresholds, sample size, validity checks and budget. Throughput (validated tests/month) is a tracked KPI. |
| P2 | Most ideas are DOA (value conditions can't be orchestrated) | principles/gates.ts | Reject if there are more than 4 must-be-true value conditions, any partnership dependency, or 7+ friends needed without single-player value. Warn on 1-6 friends (needs density seeding). |
| P3 | Narrow wedges | gates.ts (wedge score) | Six-factor wedge score. Social ideas need ≥ 4/6 (Bier). Single-player ideas need a discoverable creator niche with ≥ 20 reachable creators. Broad age ranges get a warning. |
| P4 | No nationwide tests | lab/audiences.ts | Test cells run only in small test geos (CA, AU, NZ, IE, GB, …), never in the scale market. A burned-audience registry allows one concept test per wedge×geo×channel per 8 weeks. |
| P5 | Works in one → works in all; fails in three → fails everywhere | lab/experiments.ts | Three matched cells per stage. All pass → pass. Pass in one and kill in another → a confound, so fix the harness and do not scale. Three valid failures → kill. |
| P6 | Inconclusive tests are the biggest slowdown | lab/stats.ts + experiments.ts | Sample size comes from a power calculation before launch. Validity preconditions are checked (min sample, instrumentation, cold traffic, budget, audience overlap). A result that is still unclear by the read deadline is an *iterate*, never a scale ("if there's any uncertainty, it's not working"). An invalid cell is a harness bug, never "maybe we needed more downloads". |
| P7 | People and content beat design; filter by distribution | gates.ts | Every idea must declare an organic channel, a share artifact, hooks and a creator niche. Paid-only ideas are rejected. |
| P8 | Long signup is fine if activation rises | principles/onboarding.ts | Onboarding is 8-16 steps, with a value preview before the paywall (no paywall before the aha), a multi-page paywall, and clear terms. It is optimized for activation and trial start, not per-screen drop-off. |
| P9 | Habits need recurring exposure on other networks | principles/product.ts | Every spec has a 1-2 tap share artifact with watermark and deep link. Share rate is the primary metric of S2. |
| P10 | The toilet test | gates.ts | Core action ≤ 5 taps and ≤ 15s to first value (≤ 3s ideal). No sustained attention required. Audio or voice requirements and two-handed use get a warning. |
| P11 | Core needs: love, money, play | gates.ts | Ideas are classified into one of the three. `self_improvement` is allowed with a penalty because 2024-26 winners (Cal AI, Umax, Quittr) show it works. |

## 6. Lab: experiments that end in a decision

* **Metrics are proportions** with Beta(1,1) priors: activation/installs, trials/installs,
  shares/activated, clicks/views (stored per 1K). Each has a `pass` and a `kill` threshold from config,
  seeded from 2025-26 benchmarks (RevenueCat SOSA 2026, Adapty 2026, Superwall, Cal AI and Quittr disclosures).
* **Cell verdict:** `pass` if P(p ≥ pass) ≥ confidence; `kill` if P(p < kill) ≥ confidence; otherwise
  `inconclusive`. A cell is `invalid` if any validity precondition fails.
* **Sample size:** the minimum n at which the posterior can separate the kill and pass thresholds at the
  configured confidence, with the configured floor. It is registered before launch.
* **Experiment decision** (P5/P6): `pass`, `replicate` (sequential mode), `iterate`, `kill`,
  `fix_harness`, `continue`.
* **Guardrails** (refund share, one-star share) can veto a pass.

## 7. Growth engine

1. **Creator UGC (primary)** runs through a creator marketplace (SideShift Platform API/MCP; Whop Content
   Rewards for clipping). Claude writes briefs from the best-performing hooks and formats and reviews
   submissions. Creator text is untrusted input, wrapped and never obeyed. Payouts are a flat fee plus CPM,
   capped, idempotent, and only for approved, disclosed posts.
2. **Owned brand accounts (secondary, low volume).** Each venture gets one disclosed brand account per
   platform. AI-generated slideshows and shorts are labelled (`is_aigc`, `is_ai_generated`,
   `containsSyntheticMedia`). Instagram Trial Reels serve as the hook-testing surface. Posting is capped
   below the platform limits. There is no account farm, no automated engagement and no follows or likes.
3. **Paid amplification (winners only).** Only content whose organic revenue per 1K views beats its cost
   per 1K views is promoted, through Spark/Partnership ads, Meta APP_PROMOTION (Advantage+) or the Apple Ads
   Platform API. Budget is set by the allocator with a payback guardrail.
4. **Share loop.** In-app result cards carry a watermark and deep link back to the app (P9).

## 8. Governance

* **Policy rules** (governance/policy.ts) run on every Action: kill switch; hard per-action cap; daily
  spend cap; cash reserve floor; always-approve kinds (`account.create`, `store.create_app`,
  `venture.scale`); first store submission; auto-approve threshold; disclosure flags on content; minors
  and sensitive domains; per-platform posting caps; payouts only for approved, disclosed submissions;
  ads only for proven creatives.
* **Compliance review** (agents/compliance.ts) runs deterministic text rules (banned claims, fake
  testimonials, missing price/renewal/cancel terms, missing #ad) plus an LLM reviewer on store listings,
  paywall copy, briefs and content.
* **Human gates:** iOS app creation (the App Store Connect API cannot create apps), developer accounts,
  legal entities, first submission per venture, scale decisions, minors, sensitive domains, spend above the
  threshold.
* **Ledger:** all money is in integer cents, and every spend or revenue entry is tied to a venture. The
  audit trail is the append-only `events.jsonl`.

## 9. Modules and ownership

| Path | Responsibility |
|---|---|
| `src/core/` | types, ports, store (JSON + event log), clock, seeded RNG |
| `src/config/` | `StudioConfig` (budgets, autonomy, thresholds, geos) |
| `src/principles/` | Bier registry, idea gates, onboarding/product lint |
| `src/lab/` | Beta stats, power, experiment design, evaluation, decisions, audience registry |
| `src/playbook/` | Benchmarks (sourced), content formats, product template defaults, Vert case data |
| `src/llm/` | Claude adapter (Anthropic API or Vercel AI Gateway), deterministic stub, media (AI Gateway image/video) |
| `src/agents/` | Role functions: scout, ideator, critic, designer, brand, content, creatorOps, analyst, compliance, ceo |
| `src/governance/` | Policy engine, outbox/approvals, budget |
| `src/builder/` + `templates/expo-app/` | Spec → Expo project + store metadata + legal pages |
| `src/sim/` | World model and simulated implementations of every port |
| `src/integrations/` | Live adapters: Apple (App Store Connect, charts), Google Play, EAS, RevenueCat, PostHog, SideShift, Instagram, TikTok, YouTube, Meta Ads, Apple Ads |
| `src/orchestrator/` | Lifecycle state machine, studio tick loop, allocator, reports |
| `src/cli/` | `factory` command |

## 10. Running modes

* `factory sim --days 90 --seed 7` runs the whole company in the simulator with the stub LLM (free and
  deterministic), or with `--llm live` for Claude-written ideas and specs.
* `factory scout` / `factory ideate` / `factory spec` call real Apple charts and real Claude.
* `factory tick` runs one live day with **dry-run on by default**: every external write is recorded to the
  outbox for review. Turning dry-run off and connecting credentials is a human decision.
