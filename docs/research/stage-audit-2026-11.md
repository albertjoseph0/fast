# Stage audit, November 2026

One research pass per stage of the studio loop: how the repo does it, where it breaks, what strong
operators do, which data sources exist and on what terms, and what to change. Claims about outside
services and benchmarks come from the sources named; figures from the simulator are from this repo's
own runs and only show how the rules behave against its world model.

Legend: **Done** = changed on this branch. **Next** = code change, not yet made. **Owner** = needs an
account, an application, terms or money, so it waits for you.

## 1. Find ideas

What was wrong: ideas came from an LLM summarising App Store charts and search; nothing tied an idea to
measured demand, survivors' screening scores bunched at 85–90 so ranking among them was noise, the
60-signal prompt cap let pattern summaries crowd out the measured rows, and nothing learned from how
past ventures did.

- **Done:** trend sources behind one port: YouTube Data API (views per day of recent top videos), Instagram
  hashtag search (top-post engagement) and the Meta Ad Library (advertisers whose ads have run 30+ days,
  ads linking to app stores). Momentum against earlier scans (ratings per day, rank movement, new chart
  entries).
- **Done:** ideas must cite their signals; an `evidence.demand` gate scores store demand, attention and
  money, caps attention-without-money as possible hype, and rejects ideas with no measured evidence.
- **Done:** ranking by evidence × a family prior (core need × wedge kind) that is shrunk toward the
  studio's base rate, discounted 10% a month and Thompson-sampled so untested families still get tried.
- **Done:** the ideator's 60 signals are shared across sources round-robin.
- **Done:** each idea names 1–3 search phrases; before screening, those phrases are searched in the App
  Store and scanned on YouTube, Instagram and the Meta Ad Library (20 phrases a cycle at most), and
  that, not whatever the ideator cited, is the idea's evidence. Without this the evidence score
  mostly reflected which chart leaders the ideator happened to cite.
- **Next:** pass the evidence to the critics; require two independent sources; fad, seasonal and bot
  filters; check creator supply with `CreatorRead.searchCreators` before screening passes.
- **Owner:** YouTube API key; Instagram professional account plus a Meta app with hashtag access;
  Meta developer app plus Ad Library identity confirmation; Apple Ads account for search popularity;
  Google Trends API (alpha, by application). TikTok has no usable trend API outside the EU research
  programme and Creative Center forbids scraping, so TikTok stays a manual input.
- Limits: Meta returns commercial ads for EU delivery only, so ad money is an EU cross-check. YouTube
  search costs 100 quota units a call and Instagram allows 30 hashtags a week, so both suit a shortlist,
  not broad discovery.

## 2. Build

- **Next:** compile and smoke-run the app before submission (nothing does today); real screenshots
  instead of mocks; an AI safety eval on the verdict prompt; refuse to ship the AASA file with a
  placeholder team id.
- **Next:** guideline 4.3 (spam) risk is account-wide: throttle submissions per account and stop after
  rejections. The verdict backend's 2,000-a-day cap returns 503 to paying users and keeps state in
  memory. Measure inference cost per verdict; a smaller model with prompt caching is far cheaper.
- **Owner:** Stripe Tax and a Vercel plan that allows commercial use (Hobby does not), before web-lane
  revenue.

## 3. Launch small

- **Done:** Canada prices exclude sales tax (Apple adds it on top in the US and Canada); the config was
  deducting 13% and understating Canadian proceeds.
- **Next:** a capped US probe before full US scaling; `usProbeBudgetCents` exists but nothing uses it.
- **Next:** set store territories to the current experiment's cells only; widen the geo pool (GB, IE,
  SE, NL, DK once EU/UK privacy is on; SG) and check creator supply per geo before registering a cell.
- **Next:** a technical smoke gate (backend errors, one completed purchase, crash reports) before creator
  money flows.
- **Owner:** Apple Analytics Reports access to drop App Store search and browse installs from cell
  counts; for the web lane, an edge geofence, server-side checkout and Stripe Tax.

## 4. Get traffic

- **Next:** the hook bandit cannot learn as built (about 5 posts per batch, stats read once, hooks taken
  in store order); simulator attribution is too optimistic; the S0 probe kills too eagerly.
- **Next:** paid ads are not deployable as written (no user_os or campaign attribution, no SDK, too short
  a lag) and budget steps exceed Meta and TikTok guidance. Disclosure accepts `#ad` alone.
- **Owner:** check SideShift plan limits against the planned creator volume.

## 5. Decide

What was wrong: every metric had to pass in every one of three geo cells. At planned samples a metric
halfway between floor and target passed all three cells about 16–29% of the time, and joint power at
target was about 0.65, not the planned 0.8. In one simulator run a true winner was harvested
unvalidated. Planted instrumentation bugs were caught 0 of 2 times because futility returned before
diagnostics ran.

- **Done:** pooled read across valid cells (`lab.decisionRule: "pooled"`): pass when the pooled
  posterior clears every floor, still clears it without the best cell, and no cell is conclusively below
  a floor. On this repo's operating-characteristics harness (activation, 300 runs each):

  | Rule | Pass at floor | Pass halfway | Pass at target |
  |---|---|---|---|
  | All cells (old) | 0% | 16% | 83% |
  | Pooled (new) | 1% | 57% | 98% |

- **Done:** a cell far below its peers (< 0.6× their median or z < −3) is re-run as a harness problem
  before anything is called futile or failed.
- **Done:** `trialCancelWithin24hShare` 0.65 (RevenueCat's 84% covers Day 0 and Day 1; Day 0 alone is
  55.4%), weekly first renewal 0.59 (Adapty 2026). Both make the money gate stricter.
- **Next:** re-run only the flagged cells and charge harness re-runs to an ops budget; CAC on attributed
  installs only, with the pre-exposure organic baseline subtracted; a sample-ratio check and whole-week
  read windows; a concurrent A/B lane for in-app variables.
- **Your call:** the $4,000 test cap and 42-day time box allow about two $1,700 experiments, so the
  four-iteration limit is never reached and the social ladder ($6,519) can never validate. Either raise
  the cap to about $5,000 and 56 days (single-player) and $12,000 and 90 days (social), or cut iterations
  to one and add a cheap activation-only read before the paywall test.

## 6. Scale and harvest

- **Done:** refund tripwire: a scaling venture refunding more than 12% of revenue gets no spend, and
  observed refunds raise the refund haircut in its economics.
- **Next:** one-star tripwire (needs review data); sunset handling per store; settlement lag in the cash
  trough; a lane cut to zero can never recover; LTV from observed renewals rather than priors; rollout
  beyond the US; harvest levers and exit rules.

## Simulator check

150 simulated days, seeds 1–8, same economics in both arms (old ranking by screening score vs. the new
evidence ranking with demand verification). Averages per seed:

| | Validated ventures | True demand of ideas built | True demand of validated ones | Net cash |
|---|---|---|---|---|
| Old ranking | 1.75 | 1.16 | 1.08 | +$41,000 |
| New ranking | 2.38 | 1.27 | 1.61 | +$14,000 |

The new ranking builds and validates more ideas with real demand. Net cash fell on average, but that
gap comes from two seeds where the old ranking happened to land one large hit (one seed earned $1.15M
of revenue against $342k); money in this simulator is driven by one hit per run, so eight seeds
cannot settle it. Within a run, the evidence score barely tracks the simulator's hidden demand
(correlation about 0), because the simulator ties demand to incidental words anywhere in an idea's
description. The pooled decide rule changed almost nothing in this round. Treat these as a check that
the rules behave sensibly, not as a forecast; the real test is the live sources once the keys exist.

## Sources

RevenueCat State of Subscription Apps 2026; Adapty State of In-App Subscriptions 2026; Apple developer
documentation (phased release, custom product pages, Analytics Reports, App Store availability);
Meta Ad Library API documentation; YouTube Data API quota documentation; Instagram Graph API hashtag
search documentation; a16z on soft launches; Google research on geo experiments; Stucchio on Bayesian
A/B testing; Johari et al. on always-valid p-values; Fader and Hardie on shifted-beta-geometric
retention.
