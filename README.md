# fast — an autonomous viral-app studio

`fast` is a company that runs itself. Every day it looks for demand, invents single-player AI apps for
the core needs (love, money, play), builds them, puts them in front of real creators' audiences in small
test storefronts, reads each test as a pre-registered yes/no decision, scales the winners within a
cash-flow limit and kills the rest.

It copies the operating model of **Vert** (vert.nyc), the studio behind Astra, Plug AI, Strum and Eagle:
many single-player "verdict" apps on one template (long personalization onboarding → hard paywall
around $6.99/week → one AI capability) with human creators as the growth engine. It enforces **Nikita
Bier's eleven consumer-app principles** as code. Research: [`docs/research/BRIEF.md`](docs/research/BRIEF.md).
Design: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Principle-by-principle review:
[`docs/PRINCIPLES.md`](docs/PRINCIPLES.md).

## How the company runs

One tick is one operating day (`src/orchestrator/studio.ts`):

1. **Jobs and data.** Poll builds, App Review and post publishing. Sync analytics, cohorts and ad
   stats, and book revenue, refunds, inference and spend in the ledger.
2. **Human tasks.** Fold in what operators completed: app records, connected brand accounts, backend
   URL, review decisions.
3. **Lifecycle.** Apply executed kill, sunset and scale decisions.
4. **Lab.** Observe every running experiment's cells and decide: pass, replicate, iterate, kill, fix
   the harness or escalate. Failed variants get one new variable from the designer, delivered by
   remote config, a new build or new hooks.
5. **Creators.** Review drafts (prompt-injection safe), verify posts on the platform of record, lock
   views after 7 days and pay out from platform facts only.
6. **Ventures.** Push each venture one step: spec → render → icon → site → bundle id → app record →
   price ladder → build → upload → listing → test territories → paywall products → App Review →
   release → experiments. Builds also run an optional attention probe on owned Instagram Trial Reels.
7. **Discovery.** Scan App Store charts and searches, generate ideas, screen them with three critic
   lenses, an independent sensitivity classifier and deterministic gates, then create ventures for the
   best ideas the bankroll can support.
8. **Allocation.** Plan spend across scaling ventures from cohort economics: p20 D60 revenue per
   install over marginal CAC, payback window, ramp limits, the share held back for testing, and the
   cash trough. Run weekly Thompson-sampled creator batches. Move decaying apps to harvest, sunset
   money losers and flag apps worth more sold.
9. **Governance.** Re-run policy on open actions, reconcile interrupted executions and execute what is
   approved. Then write the daily report (and a weekly board memo).

Claude writes ideas, critiques, specs, copy, briefs and memos. Typed, deterministic code makes every
decision that moves money, ships software or touches a platform. Every external side effect is an
`Action` that passes policy, may need a payload-bound human approval, and runs write-ahead through the
only module that holds write access.

## Quickstart

```bash
npm install
npx factory sim --days 120            # simulated market, deterministic stub LLM
npx factory sim --days 30 --llm gateway   # real Claude agents (Vercel AI Gateway) against the simulated market
npm test && npm run typecheck
```

A simulation writes its state, its event log and a daily report per day to `.factory-sim/seed-<n>/`
(`reports/latest.md`). Simulations use the same orchestrator, governance and lab code as live mode. The
simulated board approves queued actions and completes human tasks after a delay.

### What a simulated company does

Three 180-day runs (`npx factory sim --days 180 --seed <n>`, stub LLM, $50,000 starting cash, creators
as the only paid channel):

| Seed | Ideas → screened in → ventures → live → scaled | Cash after 180 days | Revenue | Creator spend |
|---|---|---|---|---|
| 42 | 42 → 25 → 10 → 9 → 4 | $333,343 | $936,715 | $63,039 |
| 7 | 78 → 30 → 13 → 10 → 1 | $105,175 | $306,200 | $40,825 |
| 3 | 48 → 29 → 12 → 10 → 2 | $95,701 | $199,661 | $45,826 |

Most ventures never validate. They spend their iterations or their time box, and the ones with paying
users are harvested without further growth spend. Each run's few winners pay for everything. Every
venture goes through the same pipeline: about 100 human tasks over the run (app records, privacy labels,
per-venture projects, tenant deploys, reviews), App Review, three-storefront creator tests read as
pre-registered decisions, and the allocator's ramp limits. Some runs lose a venture to App Review's
4.3 spam rejection.

The simulated market is a model, not evidence: its parameters come from the sourced benchmarks in
`src/playbook/benchmarks.ts`, and its job is to exercise every decision path and failure mode the live
studio will meet. An adversarial review of the whole system confirmed 87 defects, all fixed with
regression tests (`docs/ARCHITECTURE.md` §12).

## Going live

Live mode talks to real APIs through `src/integrations/`, and is **dry-run until you turn it off**:
every write is recorded under `.factory/dry-run/` and nothing is sent.

```bash
npx factory init                 # writes .factory/config.json (live, dry-run)
npx factory tick                 # run today's operating day
npx factory approvals            # what governance routed to you
npx factory approve <id> | reject <id> --reason "..."
npx factory tasks | task <id>    # steps no API allows, with console links
npx factory complete <id> key=value ...
npx factory stop | resume        # kill switch for every external action
npx factory go-live --confirm    # real writes; limits, approvals and the kill switch still apply
```

See [`docs/RUNBOOK.md`](docs/RUNBOOK.md) for the accounts, credentials and one-time human steps.

### What still needs a human, and why

Some steps can't be automated, by design or by platform rule:

* **App Store Connect has no create-app API.** A human creates each app record and enters its Apple ID.
* **App Privacy labels, the Paid Apps Agreement, Play content rating and data safety** are console-only.
* **Social accounts are created and connected by people.** TikTok posts from owned accounts arrive as
  inbox drafts until the Content Posting API audit passes.
* **Money setup:** ad billing and the creator-marketplace wallet.
* **Approvals:** first store submission, resubmission after rejection, every submission for red-category
  apps (astrology, dating, companions, health, finance and similar), new apps for anyone under 18,
  scaling, sunsetting, removal from sale, first ad campaign per network, first payout to each creator,
  and any spend above the auto-approve limits.

## Safety model

* **No fake people.** Real creators post on their own accounts with platform paid-partnership labels.
  Brand accounts say they are the brand. There is no follow, like, comment or DM automation anywhere.
* **No invented claims.** Copy lint blocks user counts, rankings, ratings, testimonials, prices and
  efficacy claims written by an LLM. Paywall terms come from store prices at runtime.
* **Disclosures are derived, not written:** AI-generated and paid-partnership labels come from content
  provenance.
* **Untrusted text stays data.** Creator captions and other external text are escaped and fenced. An
  LLM can veto a submission but never approve one on its own.
* **One entity, one developer account per store.** Vert's multi-LLC structure is not copied: spreading
  template apps across shells is what Apple 4.3 and Play's enforcement-evasion rules target.
* **EU/UK storefronts stay off** until GDPR consent, an Art. 27 representative and DSA trader
  verification are configured.

## Repository layout

| Path | What |
|---|---|
| `src/core/` | domain contracts, ports, event names, persistent store, clock, deterministic RNG |
| `src/config/` | the studio's constitution: budgets, thresholds, autonomy limits |
| `src/principles/` | Bier principles as gates, ladders, sensitivity classifier, spec/onboarding/copy lint |
| `src/lab/` | Bayesian stats, power, clustering, experiment design and decisions, LTV, creative bandit |
| `src/playbook/` | sourced benchmarks, content formats, product defaults, safety preambles, setup checklist |
| `src/llm/` | Claude adapter (Anthropic API or Vercel AI Gateway), deterministic stub, media generation |
| `src/agents/` | scout, ideator, critics, designer, brand, content, creator ops, compliance, analyst, CEO |
| `src/governance/` | policy, outbox, approvals, human tasks, write-ahead executor, ledger, disclosure, payouts |
| `src/builder/`, `templates/expo-app/` | spec → Expo app, store metadata, legal pages, screenshots; verdict backend |
| `src/sim/` | simulated market with the live failure surface |
| `src/integrations/` | App Store Connect, Google Play, EAS, RevenueCat, PostHog, SideShift, Instagram, TikTok, YouTube, Meta/TikTok/Apple Ads, web host |
| `src/orchestrator/` | the daily tick, venture pipeline, lab phase, growth, discovery, allocator, reports, sim runner |
| `src/cli/` | the `factory` command |
