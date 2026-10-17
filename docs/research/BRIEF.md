# Autonomous Viral-App Company: Research Brief

**Topics:** Vert (vert.nyc), comparable studios, Nikita Bier's principles, the automation landscape, and compliance
**Research date:** 2026-10-17. Sources were fetched on that date unless another date is given.

---

## How to read this brief

- **Confidence labels.** **[Confirmed]** means a fact-check re-verified the claim against a primary source on 2026-10-17. **[Self-reported]** means a company or founder marketing claim that is not audited. **[Estimate]** means a third-party modeled figure (ScreensDesign, MWM, Sensor Tower, Appfigures). **[Unverified]** means the claim could not be checked against a primary source. **[Outdated]** means the source is more than 18 months old or has been superseded; the correction follows it. **[Inference]** means our reasoning, not a sourced fact.
- **Fact-check corrections applied.** Where a correction replaced a claim, that is noted inline. One refuted claim was dropped: that RevenueCat Growth Tools cost an extra 1% on top of Pro. The other corrections, such as Eagle's rating count and the Meta v26.0 ship date, are shown in place. Appendix A lists all of them.
- **Figure attribution.** Every number carries its source and date. Revenue figures for private studios are never audited.

---

## Executive summary

1. **Vert is a bootstrapped NYC app studio.** It says it has 8 apps, 15M+ users, $25M+ annual revenue, $0 funding, a 23-person team and 2 years of operation ([vert.nyc](https://vert.nyc), [site bundle](https://vert.nyc/_next/static/chunks/app/page-01cb73719934107d.js)) **[Confirmed as the site's claims; Self-reported as facts]**. Three apps make nearly all the money: Astra (AI astrology and life advice), Strum (AI guitar chords) and Plug AI (AI dating-reply assistant). The other five look like cheap experiments, launched and then left alone.
2. **Vert's speed comes from a repeatable machine, not a product breakthrough.** The pattern for each app:
   - A single-player AI utility with one input and a "wow" output.
   - A long personalization onboarding that ends in a hard paywall at about $6.99/week after a trial.
   - Distribution bought from a large creator and influencer network (250+ active partnerships per a Jan 2026 job post), with installs used to cull losing formats.
   - Very fast releases (Astra ships a build about every 3 days).
   - Disposable per-app infrastructure.
3. **Comparable studios run the same playbook at larger scale.** Cal AI: about $40M trailing sales at acquisition. Codeway: $400M+ ARR, self-reported. HubX: $1.2B pre-money valuation, Aug 2026. 2026 benchmarks favor hard paywalls (RevenueCat SOSA 2026: 10.7% vs 2.1% Day-35 conversion) and weekly plans (Adapty 2026: 55.5% of subscription revenue).
4. **Bier's principles hold best as testing discipline**: reproducible tests, binary PMF reads, sequencing, dense seeding, kill fast. They hold worst as social-graph growth mechanics. Contact-sync consent fell sharply after iOS 18. Server-sent invites are illegal or banned. Teen targeting now meets the Texas SB 2420 age-assurance law, the NGL and Sendit precedents, and Apple's stricter guideline 1.2. For single-player AI utilities, "K must reach 1.0" is the wrong test; the right one is revenue per 1K views against cost per 1K views.
5. **Automation is feasible for most of the pipeline, with hard human chokepoints:**
   - Apple: creating the app record and the App Privacy label (no API); developer enrollment, agreements, tax and banking; API key creation.
   - Google Play: creating the app and the App Content declarations.
   - TikTok: the posting audit explicitly rejects "a utility tool to help upload contents to the account(s) you or your team manages."
   - Every platform: account and entity creation.
   - Anything legally sensitive: creator contracts, likeness consent, paywall templates, red-category apps, responses to strikes.
6. **The biggest risk is that the default growth levers of a naive autonomous system are exactly what gets accounts and companies terminated.** Those levers are account farms, duplicate content, fabricated testimonials, undisclosed AI or ads, near-duplicate apps across developer accounts, and dark-pattern subscriptions. In 2025 Apple terminated 193K developer accounts and rejected 371K submissions for spam, copying or misleading users ([Apple Newsroom, May 20, 2026](https://www.apple.com/newsroom/2026/05/the-app-store-stopped-over-2-point-2-billion-usd-in-fraudulent-transactions-in-2025/)). The FTC's June 2026 Genesis Tech action froze the assets of a multi-brand subscription portfolio built almost exactly like an app factory. These levers must be hard-blocked in code, not tuned.

---

## 1. Vert (vert.nyc)

### 1.1 What it is

Vert calls itself "a startup that makes startups" and says "We make and market apps entirely in-house." The homepage, read from its JS bundle on 2026-10-17, claims **$25M+ annual revenue, 15M+ users, 8 apps, $0 funding, 2 years old, 23-person team**. A gallery caption reads "20m ARR but ramen still hits." The contact is will@vertventures.io, and vertventures.io returns a 301 redirect to vert.nyc ([vert.nyc](https://vert.nyc), [bundle](https://vert.nyc/_next/static/chunks/app/page-01cb73719934107d.js)) **[Confirmed; figures Self-reported]**.

Other self-reports run higher and do not fully agree:
- Vert's LinkedIn page claims "$30M+ ARR" and shows 39 employees ([LinkedIn](https://www.linkedin.com/company/vert-ventures)) **[Self-reported]**.
- A September 2024 Dribbble job post, now 404 and known only from a search summary, said 4M users, $8M annual revenue and 8 FTEs ([Dribbble](https://dribbble.com/jobs/265130-UI-UX-Designer-at-App-Studio)) **[Unverified, Outdated]**.

### 1.2 Corporate and account structure

Vert spreads its apps across three publishing entities and three App Store developer accounts:

| Entity | Apple artist ID | Evidence |
|---|---|---|
| Vert Ventures LLC (Wyoming; NY foreign registration DOS 7367252, filed 2024-06-11, formed 2023-11-08, 185 Wythe Ave, Brooklyn) | 1719671063 | [iTunes lookup](https://itunes.apple.com/lookup?id=6473748536&country=us); [bizprofile.net](https://www.bizprofile.net/ny/brooklyn/vert-ventures-llc) (aggregator, not NY DOS) **[Confirmed]** |
| Vert Media Partners LLC (California; Palo Alto, per search snippets of CA SOS records) | 1690446849 | [iTunes lookup](https://itunes.apple.com/lookup?id=6449750416&country=us) **[Confirmed]**; CA SOS manager list (Leiman, Dray, Anderson, 12/13/2023) **[Unverified; PDF not retrievable]** |
| W185 Holdings LLC (Wyoming) | 1761597813 | [iTunes lookup](https://itunes.apple.com/lookup?id=1761597813&entity=software&country=us); [Strum terms](https://strum-app.github.io/strum/terms) **[Confirmed]** |

**W185 belongs to Vert.** The Google Play developer "Vert Media Partners" publishes exactly three packages: com.vertmedia.astra, com.vertmedia.wingman (Plug AI) and com.w185holdings.strum. All three listings show contact@vertmedia.io ([Play developer page](https://play.google.com/store/apps/developer?id=Vert+Media+Partners&hl=en_US&gl=US)) **[Confirmed]**. That shows one party controls all three Play listings. Legal common ownership is a strong **[Inference]**. "W185" probably refers to 185 Wythe Ave **[Inference]**.

A separate stream reports a Vert-linked Bible app, Haven, published by "E12 Holdings LLC," whose Wyoming filing reportedly lists the same founders ([Substack, May 20, 2026](https://joshbensonthewriter.substack.com/p/tarot-cards-drugs-and-millions-in)) **[Unverified]**. If true, Vert has more than the 8 apps found under the three accounts above, or "8 apps" counts differently.

### 1.3 App portfolio

Ratings are US App Store counts as of 2026-10-17 unless noted.

| App | Entity | Category / product | Launched | Status | Monetization | Scale evidence | Confidence |
|---|---|---|---|---|---|---|---|
| **Astra - Life Advice** (id 6473748536, bundle com.vertventures.stella) | Vert Ventures LLC | Lifestyle. AI astrology and life-advice chat, compatibility reports, "Soulmate Sketch" | 2024-01-09 | Active; v3.12.69 on 2026-10-12, ~25 builds Jul 29–Oct 12, 2026 | Hard paywall after ~9-step onboarding; free trial (3-day per Jun 2025 terms, 7-day per 2026 reviews) then ~$6.99/wk; "Astra - Unlimited" SKUs $6.99–$19.99 | 39,321 US ratings **[Confirmed]**; Android 500K+ **[Confirmed]**; ~$400–450K/mo **[Estimate]** ([ScreensDesign](https://screensdesign.com/apps/astra-life-advice/)); 2.5M+ downloads by Jul 2025 **[Estimate]** ([MWM](https://mwm.ai/apps/astra-life-advice/6473748536)); #23 US Top Grossing Lifestyle on 2026-10-17 ([Apple RSS](https://itunes.apple.com/us/rss/topgrossingapplications/limit=200/genre=6012/json)) | High (store data), medium (revenue) |
| **Strum - Play Guitar** (id 6749384181; formerly "Autochord") | W185 Holdings LLC | Music. AI chord recognition for any song | 2025-08-06 | Active; v1.9.4 on 2026-10-15; release roughly every 6 days ([Bitrise](https://bitrise.io/resources/tools/app-navigator/apps/ios/com.w185holdings.guitar)) | Hard paywall after ~16-step onboarding; trial then $6.99/wk or "$49.99/year w/ 7d trial" | ~20,077–20,079 US ratings **[Confirmed]**; Android 500K+ **[Confirmed]**; ~$250K/mo **[Estimate, not re-verified]** ([ScreensDesign](https://screensdesign.com/apps/strum-play-guitar/)); #25 Top Grossing / #53 Top Free Music (RSS stream finding; **#53 not re-verified by fact-check**) | High (store), medium (rank/revenue) |
| **Plug AI: Texting Assistant** (id 6449750416, bundle com.vert.rizzgpt; formerly RizzGPT, then Wingman) | Vert Media Partners LLC | Lifestyle. Screenshot of a chat in, dating replies and openers out | 2023-06-30 | iOS dormant since v6.3 on 2024-08-02 **[Confirmed]**; Android updated Oct 3, 2026 | Subscription: weekly $4.99–$6.99, annual $49.99–$59.99, "25 Replies" $5.99 | 15,808 US ratings **[Confirmed]**; Android 1M+ **[Confirmed]**; $190K/mo and listed for sale at $3.5M in Jan 2024 **[Self-reported, Outdated]**: about 33 months old, not a current revenue figure ([Brick by Brick podcast, Jan 19, 2024](https://creators.spotify.com/pod/profile/ollie-allman/episodes/019-Alex-Leiman--23-Year-Old-Makes-190k--Month-With-AI-Dating-Assistant-App-e2lvpki)); still #97 Top Grossing Lifestyle | High |
| **Berry - Wellness** | W185 | Health & Fitness. Cycle-syncing journal | 2024-08-20 | Last update 2025-02-14 | $6.99 / $79.99 / $19.99 / $0.99 | 1,302 ratings **[Confirmed]** | High |
| **Saga - Stories** | W185 | Books. AI personalized stories | 2025-01-13 | Last update 2025-10-13 | $6.99 / $0.99 | 159 ratings **[Confirmed]** | High |
| **Sensa - ASMR** (bundle com.w185holdings.asmrai) | W185 | ASMR (description copied from Saga) | 2025-03-05 | Last update 2025-03-26 (abandoned) | $6.99 / $0.99 | 0 ratings **[Confirmed]** | High |
| **Indigo - Scan & Collect** (bundle com.w185holdings.pokemonapp) | W185 | Reference. Trading-card scanner with market value | 2026-03-29 | Last update 2026-04-13 | No IAPs listed | 0 ratings **[Confirmed]** | High |
| **Eagle - Swing Analysis** | W185 | Sports. AI golf swing analysis | 2026-08-04 | Active; v1.0.10 on 2026-09-30 | $6.99 | **121 ratings** (corrected from 127) **[Confirmed]** ([Eagle terms](https://eagle-golf.github.io/eagle/terms.html)) | High |

**Reading the portfolio.**
- Two or three big winners, one modest app (Berry), and four tests that were launched and dropped or are still early.
- Only the winners (Astra, Plug AI, Strum) were ported to Android. The other five are iOS-only. The pattern is: test on iOS, port winners.
- Third-party estimates for the top three apps add up to roughly $0.9M/month, or about $11M/year. That is well short of the claimed $25–30M ARR. Possible explanations are non-US revenue, Android, a gross-vs-net difference, apps we did not find (such as Haven), or self-report inflation. **Treat every Vert revenue number as unverified.**

### 1.4 Team and founders

- **Alex Leiman.** A Brick by Brick podcast episode (Jan 19, 2024) identifies him as co-founder of Plug AI. His earlier campus business, SexyCakes, reportedly made about $700K **[Confirmed for the Plug AI co-founder role]**.
- **Evan Dray and Will Olson as Vert co-founders.** This rests on RocketReach, LinkedIn headline snippets and search summaries. The fact-check could not find a primary source **[Unverified, low confidence]**. Will Olson's LinkedIn post (about early 2026, via search snippet) says he joined at about $250/week, became a co-founder after 6 months, and cites "12M downloads and >$30M ARR" **[Unverified]**. will@vertventures.io is presumably Will Olson **[Inference]**.
- **Blake Anderson** is named as the original RizzGPT builder and as a Vert Media Partners manager in a 12/13/2023 CA filing, seen only as a search snippet. He later built Umax and Cal AI. His current relationship with Vert is unknown **[Unverified]**.
- **Staff mix.** RocketReach and SignalHire listings show staff weighted heavily toward marketing, influencer, growth and partnerships roles, with few engineers **[Unverified aggregation]**. A Jan 2026 remote Influencer Marketing Manager role covered creator messages, script and draft review, and logging video performance ([Get on Board](https://www.getonbrd.com/jobs/advertising-media/influencer-marketing-manager-vert-remote)).

### 1.5 Culture: the job copy

From vert.nyc job listings (2026-10-17) **[Confirmed as site text]**:
- Full Stack Engineer ($120K–$250K + equity): "if we aren't shipping bugs to production, we aren't moving fast enough." The stack is Python, JS, React/React Native and Swift. "We rely heavily on AI for development, but are not dependent on it."
- Product Designer ($100K–$250K): "iterate based on A/B test results… bias for action (read: testing and iteration) over analysis (read: case studies and user research)."
- Marketing Associate ($80K–$200K + equity): "Know how to make people care (no experience necessary)… understands culture and knows how to get attention."
- Instrumentation reaches even the careers site: Mixpanel tracks events such as `snake_game_started` and job clicks. The contact email is revealed only after scoring 15 in a snake game.

### 1.6 How Vert grows so fast: a reasoned explanation

Vert has no proprietary technology, funding or network effect. Its speed comes from five reinforcing parts.

**(a) Operating model: a portfolio of cheap bets with fast exits.**
- Each app is a narrow AI utility built quickly with AI-assisted code on a shared monetization template.
- Most fail. Sensa had 0 ratings and copy-pasted metadata and was dropped after about 3 weeks. Indigo has 0 ratings. Saga stalled.
- Winners get Android ports, constant iteration and more creator spend. Losers are abandoned at almost no cost because each app's infrastructure is disposable: free GitHub Pages legal pages under throwaway per-app accounts, per-app Gmail support inboxes, and a minimal landing page ([Astra terms](https://consequentlyjubilant.github.io/astraapp/terms.html), [Strum privacy](https://strum-app.github.io/strum/privacy)).
- Separate LLCs and developer accounts keep the winners apart from experiments. **[Inference]**: Apple and Google both link related accounts for enforcement (see Section 5), so this separation gives less protection than it seems.

**(b) Product selection: single-player AI with one magic input.**
- The apps: screenshot to dating reply (Plug AI), birth data to astrology advice (Astra), song to chords (Strum), swing video to coaching (Eagle), card photo to market value (Indigo).
- Each meets a Bier "core need" (love, self-understanding, play, money) without needing friends on the app. That avoids the cold-start problem entirely.
- Each output is visual and easy to film, so it suits short-form video.

**(c) The content machine: rented distribution, culled by installs.** This is the real moat.
- Vert runs **250+ active creator partnerships across apps** (Get on Board, Jan 16, 2026) **[Self-reported]**. Astra's own TikTok, @getastraapp, has only about 19.7K followers and 30 videos, so most reach comes from other people's accounts.
- **Astra / SideShift case study** (Oct 16, 2025) ([SideShift](https://sideshift.app/casestudies/astra)) **[Vendor-reported]**:
  - 400+ TikToks in six weeks, 5M+ organic views, 25K downloads from a single video.
  - Formats: friendship tests, compatibility, and "what my dream meant."
  - "Every batch judged on installs and engagement. Formats that lost stopped getting made."
  - The winners became a UGC bank "now running as paid ad creative."
  - Macro creators such as @laurenjnicole (3.3M followers) posted with #astrapartner.
- **Plug AI's origin playbook** ([ventureradar, Jul 12, 2025](https://ventureradar.substack.com/p/this-23-year-olds-ai-app-makes-200kmonth); [Scale Nuggets, Aug 27, 2024](https://scalenuggets.beehiiv.com/p/23yearold-whos-making-11myear-ai-apps)) **[Secondary, partly Outdated]**:
  - About $50 per post on faceless TikTok and YouTube accounts.
  - 18–34-slide TikTok slideshows that reveal the app around slides 8–10. One got 800K+ views.
  - Reported results: about 200K downloads in 5 days and about $80K MRR.
- **Little sign of SDK-attributed paid UA.** Exodus static scans find only Firebase Analytics and Crashlytics in Astra (Apr 2026), and no trackers in Strum (Jun 2026) or Plug AI (Nov 2024). No iOS app declares "Data Used to Track You" ([Exodus](https://reports.exodus-privacy.eu.org/en/reports/com.vertmedia.astra/latest/)). Paid ads do run, using creator content, but attribution appears to be aggregate rather than SDK-based **[Inference]**.
- **Secondary surfaces:**
  - Programmatic SEO song-chord pages on strumguitarapp.com (about 125 sitemap URLs).
  - An email-capture page offering a "2-week free trial" on astralifeadvice.com.
  - An AI-crawler-friendly Astra info site whose ownership is unconfirmed.

**(d) Paywall and monetization template.**
- Flow: long personalization onboarding (goal, identity data, notification pre-prompt, "personalizing…" interstitial, social proof), then a hard paywall.
- Price: about $6.99/week after a trial, with a monthly plan around $19.99 and an annual anchor of $49.99–$79.99.
- Duplicate SKUs (Astra lists six "Unlimited" price points) point to ongoing price testing.
- Superwall was used for paywall testing in Jan 2024 (Brick by Brick) **[Confirmed as stated then; current stack unknown]**.
- The cost shows in reviews. MWM counts 886 of 1,536 written Astra reviews and 721 of 1,188 Strum reviews as 1-star, while star-only ratings average about 4.7. Typical complaints: "Bait and switch," "made me take a whole personality test… before it told me I gotta pay" ([MWM Astra](https://mwm.ai/apps/astra-life-advice/6473748536)).

**(e) Testing and shipping velocity.**
- Astra shipped about 25 builds in about 75 days. Strum ships about every 6 days. Eagle shipped 10 builds in its first 2 months. Release notes are boilerplate.
- Design runs on A/B results, not research. Engineering is AI-assisted.

**Net assessment [Inference].** Vert's edge is operational throughput: concepts per month, creator posts per week, paywall variants per app and builds per week, combined with ruthless culling. That makes the model unusually suited to automation. It also makes it a compliance minefield. The billing complaints, undisclosed-creator-ad complaints and copied metadata in Vert's own record would multiply under an autonomous system unless it is gated.

### 1.7 Open questions on Vert

- What is the real revenue split, and why do the estimates fall so far short of the claimed ARR?
- What does "15M users" mean: cumulative downloads or registered users?
- Is Haven / E12 Holdings part of Vert?
- What is the paid vs creator spend mix, and what is the current paywall vendor?
- Is Plug AI iOS in harvest mode or being sold?
- What is Blake Anderson's role now?
- Which owned social accounts belong to Vert? @strumapp has 57.5K followers and 0 videos, and was created in 2022.

---

## 2. Comparable studios and the 2023–2026 consumer-app growth playbook

### 2.1 Comparables

| Studio / app | Model | Key numbers (source, date) | Confidence |
|---|---|---|---|
| **Cal AI** (Viral Development LLC; Zach Yadegari, Blake Anderson) | AI calorie photo app; influencer retainers, then paid social | About 250 influencers on monthly retainers, "mid six figures"/mo spend, 17 staff with about half in marketing, 20–30K downloads/day, 20–25% first-session conversion to trial or paid ([Latka, May 15, 2025](https://getlatka.com/interviews/cal-ai-zach-yadegari-2025)). 123 experiments, 424 variants, 46 placements, +31% trial-to-paid ([Superwall, Apr 15, 2026](https://superwall.com/case-studies/cal-ai)). Influencer channel plateaued around $2M/mo; paid social above $1M/mo against $5.7M monthly revenue by Jan 2026 ([blog summary, Mar 7, 2026](https://yuanchang.org/en/posts/zach-yadegari-cal-ai-50m-exit/)). MyFitnessPal acquisition (closed Dec 2025, announced Mar 2, 2026): more than $40M trailing-12-month sales, 15M+ downloads, price undisclosed ([Fitt Insider](https://insider.fitt.co/myfitnesspal-acquires-rival-food-tracker-cal-ai/)) | High (acquisition), medium (internals) |
| **RizzGPT / Umax** (Anderson) | $50 faceless-account promos, then exclusive creator deals | RizzGPT $80K MRR in its first month (Aug 2023); Umax about $500K MRR within about 6 weeks after $50K upfront exclusive deals ([Kickstart](https://kickstartsidehustle.com/how-to-make-80k-mrr-within-the-first-month-on-your-app-3-times-demo/), [Whop](https://whop.com/blog/looksmaxxing-blake-anderson/)) | Medium; **Outdated** (2023–24) |
| **Quittr** | 12-page quiz, hard paywall, CPM creator deals | 99% quiz completion; $2–3 CPM with view guarantees and 20% upfront; about $40K/mo Meta at a claimed 3–4x; about $250K MRR in 4 months; one 9.9M-view video made about $100K in 65 h ([Startup Spells, Mar 1, 2025](https://startupspells.com/p/porn-addiction-app-quittr-250k-mrr-4-months)) | Medium; ~19 months old |
| **Codeway** (Istanbul) | Paid-UA factory from day 0 | $400M+ ARR, profitable, self-funded, 356 staff (job post removed Apr 2026, [Built In](https://builtin.com/job/director-finance/8619077)); 200–500 creatives per ad account per month across about 10 accounts; Ask AI fell from $3–5M/mo to about $700K/mo ([Sparrow, Apr 8, 2026](https://blog.sparrowapps.io/p/how-codeway-built-a-25m-month-app-empire)) | Medium (self-reported) |
| **HubX** (Izmir) | Hub-to-studio, plus acquisitions | $50M + $25M option from Point72 at $1.2B pre-money; 40+ products; 600M+ downloads; 370+ staff; profitable ([press release, Aug 31, 2026](https://www.newsfilecorp.com/release/312135)) | High |
| **Bending Spoons** | Buy decaying apps, raise prices, cut costs | 2025 revenue $1.31B (+95%), $278M operating profit (S-1, Jun 2026; [Fortune](https://www.fortune.com/2026/06/08/bending-spoons-italian-aol-evernote-wetransfer-files-us-ipo/)) | Medium |
| **Locket** | Widget-based retention | 2M users in 2 weeks from a TikTok tutorial; 90M+ downloads, 9M DAU, 14 staff, profitable by Oct 2025 ([VnExpress, Aug 22, 2026](https://e.vnexpress.net/news/tech/personalities/how-a-gift-for-his-girlfriend-changes-locket-founder-matt-moss-s-life-5106478.html)) | Medium |
| **tbh / Gas** (Bier) | School-seeded social polling | Covered in Section 3; both sold within months and shut down within about 10 months of sale | High |
| **BeReal** (2022) | Paid campus ambassadors | $30 per referral, $50 per download plus review ([Sacra](https://sacra.com/q/how-did-bereal-get-so-popular/)) | Medium; **Outdated** |

### 2.2 The playbook, step by step, with benchmarks

**Step 1: Pick a narrow AI "verdict" product tied to a core need.**
- Looks, weight, dating, addiction, faith, astrology, hobby mastery. The camera-in, answer-out moment should read on screen in under 3 seconds.
- AI apps have about 41% higher year-1 LTV ($30.16 vs $21.37) but churn faster ([RevenueCat SOSA 2026](https://www.revenuecat.com/state-of-subscription-apps)).
- AI apps' install-to-trial is lower: 5.31% vs 10.92% ([Adapty 2026](https://adapty.io/state-of-in-app-subscriptions-report/)).

**Step 2: Long onboarding quiz ending in a hard paywall.**

| Benchmark | Value | Source (date) |
|---|---|---|
| Hard paywall vs freemium, Day-35 conversion | 10.7% vs 2.1%. Write-ups disagree on whether this is download-to-paid or trial-to-paid; confirm before using as a threshold | [RevenueCat SOSA 2026](https://www.revenuecat.com/blog/growth/subscription-app-trends-benchmarks-2026) (Mar 19, 2026) |
| Day-60 revenue per install, hard vs freemium | $3.09 vs $0.38 | same |
| Year-1 retention, hard vs freemium | 27% vs 28% | same |
| Median weekly / yearly price | $5.99 / $34.80 | same |
| 3-day-trial cancellations on Day 0 | 55.4% (84% by Day 1) | same |
| Weekly plans' share of revenue | 55.5% (up from 43.3%) | [Adapty 2026](https://adapty.io/state-of-in-app-subscriptions-report/) (2025 data) |
| Year-1 LTV, weekly with trial vs without | $54.50 vs $7.40 | same |
| Install-to-trial / trial-to-paid | 11.2% / 27.8% | same |
| Multi-page vs single-page onboarding paywall | 12.41% vs 9.07% (+37%) | [Superwall](https://superwall.com/blog/new-postmulti-page-onboarding-paywalls-convert-37-better-than-single-page-heres-why) (40M opens, Feb–May 2026) |
| New apps earning under $1K in year 1 | 58%; 7.9% reach $100K; top 10% take 94.5% of revenue | Adapty 2026 |

**Step 3: Distribution bought by the view, then amplified with paid ads.**

| Benchmark | Value | Source (date) |
|---|---|---|
| UGC creator market rates | Median $16/video, $500/mo base, $1 CPM | [viral.app](https://viral.app/ugc-rates) (Oct 2026) |
| Clipping CPM (Whop) | Median $1.00–1.30, plus a 10% fee | [Foundry](https://www.builtbyfoundry.io/blog/what-is-clipping-1-dollar-per-1000-views-50-campaigns) (Sep–Oct 2026) |
| SideShift CPMs for app customers | $0.13 (GPTZero) to $2.16 (Picsart); median $7–9/video | [SideShift](https://www.sideshift.app/) (self-reported, Sep 2026) |
| Proven-creator premium | Quittr $2–3 CPM; Cal AI targeted about $5 CPM | see above |
| Apple Ads US | $1.58 CPT, $2.51 CPA, 62.7% tap-to-install | [Adapty](https://adapty.io/blog/apple-ads-benchmarks-2026/) (Jul 13, 2026) |
| Views-to-install | **No reliable benchmark.** Anecdotes vary 100x or more: the "Larry" agent got about 8M views for about $700 MRR; one Quittr video got 9.9M views for about $100K | [Larry](https://www.luminarylane.app/blog/from-larry-to-lane/), Quittr |

Governing rule (Anderson): **revenue per 1K views must exceed cost per 1K views**, tracked per creator, per hook and per account.

**Step 4: Remote paywall experimentation at volume.** Cal AI ran about 5 experiments a month. Standard tactics include trial toggles, transaction-abandon discounts, spin-the-wheel offers, localized paywalls and web checkout. Localization gave the largest LTV uplift in Adapty's data. US web paywalls convert lower on install-to-paid (1.10% vs 1.60%, Adapty).

**Step 5: Plan for decay and exit.** Ask AI fell about 80% from its peak. Cal AI's influencer channel plateaued before paid ads took over. tbh sold within weeks and Gas within about 5 months. The end state is a Bending Spoons or HubX-style portfolio run on price increases and cost cuts.

**Org benchmark.** In this cohort, marketing and creator ops are the main headcount: Cal AI had about half of 17 staff on marketing; Vert has 23 people for 8 apps; Locket has 14 people for 9M DAU; Gas had 4 people at its peak. The headcount is mostly in repetitive creator operations, which are the most automatable roles.

---

## 3. Nikita Bier's principles: critical review and operational rules

Sources: the full 25-tweet thread of Jan 12, 2022 ([Thread Reader](https://threadreaderapp.com/thread/1481118406749220868.html)); Lenny's Podcast, aired 2024-08-25 ([transcript](https://github.com/ChatPRD/lennys-podcast-transcripts)); about 57 X posts from 2018–2026; the 2017 tbh memo as quoted by [BuzzFeed](https://www.buzzfeednews.com/article/ryanmac/facebooks-teens-tbh-psychological-trick-memo). **Most of Bier's tactical record is from 2017–2024 [Outdated in parts].**

Bier's status: he announced joining X as Head of Product on Jun 30, 2025, stepped back to adviser on Aug 5, 2026, and his bio now reads "unemployed. former head of product @x." Wikipedia's Oct 2, 2026 end date is **[Unverified]**.

His own 2026 framing ("I really quit the viral app business just in time," Feb 2026, quoting "build an app in 3 minutes") supports the main thesis here. Building is now commoditized, so the edge moves to the test harness, the distribution channel and the decision rules.

For each principle: **Holds** = where it still applies; **2026 caveat** = what has changed; **Rule** = the operational rule for an autonomous factory. Numbers marked *proposed* are our defaults, to be recalibrated on the factory's own data.

**P1. A reproducible testing process beats any idea (thread #1).**
- **Holds.** This matters even more when AI makes builds nearly free. Bier's build time fell from about a year to about 2 weeks. Vert and Codeway are test-throughput machines.
- **2026 caveat.** Cheap builds invite spam. Apple's similarity analysis and guideline 4.3 punish volume without differentiation. "Test everything" must become "test distinct concepts."
- **Rule.** The factory's core product is the test harness. Each test pre-registers its hypothesis, the single variable under test, the cell definition, its validity preconditions, and its pass/kill thresholds before launch, or launch is blocked. Track validated tests per month. Target idea to live test in 7 days or less (*proposed*) and result read in 48 hours or less (Bier, Out of Office podcast Feb 2026, from auto-captions **[Unverified]**).

**P2. The dead-on-arrival filter: list every condition required for value (thread #2; fragmentation thread, Jan 2023).**
- **Holds.** It works fully for social apps. Each fragmentation layer adds about 50% failure risk (his heuristic).
- **2026 caveat.** For single-player AI utilities the conditions are few: model quality, an input the user has on hand, and a payable need. That is why the Vert and Cal AI style dominates. The filter shifts from "N friends present" to "can a stranger get value in 60 seconds alone?"
- **Rule.** Score "conditions to value." Reject if more than 4 must-be-true conditions apply, if a partnership is required (thread #22), or if adult friend co-adoption is needed without a deterministic seeding plan. Auto-generate a fully populated prototype and kill concepts whose second session shows nothing new (his Ants lesson).

**P3. Pick an obsessive wedge at a life inflection point, named "obnoxiously relevant" (threads #3, #14–17).**
- **Holds.** Gen Z astrology, beginner guitarists, golfers and card collectors are Vert's wedges.
- **2026 caveat.** Bier's strongest wedges were teens (invites peak at 13 and fall about 20% per year of age to 18, per Lenny's reading of a Bier post **[Unverified original]**). Teen targeting is now heavily regulated (Section 5). Hobbyist and identity wedges for adults are the safe replacement.
- **Rule.** Score candidate communities 0–1 on six factors: co-presence, bounded discoverability, inflection point, obsessiveness, urgency, and a reachable owned or rented channel. Require at least 4 of 6 (*proposed*). Under-18 wedges are **red-category and human-gated** by default. The community's identity must appear in the ad, the first screen and any share or invite copy.

**P4. Test in one dense, small cell, never nationwide (thread #4; Maltalk: #1 in Malta in 48 hours on $500 of ads, 2014).**
- **Holds.** This is the foundation of conclusive, cheap tests. Vert's creator batches are the content equivalent.
- **2026 caveat.** The 2017 tactic of mass-following students via a private Instagram account is now a ToS and teen-safety violation risk: platform automation bans and Instagram teen-account defaults (the latter not verified this session). Small-country App Store tests remain viable.
- **Rule.** A test cell is either one bounded community (500–3,000 people, *proposed*) reached by compliant paid geo-targeting and human-run creators, or one small storefront via App Store territory selection. Keep a "burned audience" registry: at most 1 concept test per cell per 8 weeks (*proposed*). **Never automate mass-follow, scraping or account-based seeding.**

**P5. If it works in one community it works in all; if it fails in three it fails everywhere (thread #6).**
- **Holds** as a replication discipline.
- **2026 caveat.** For creator-led AI utilities the unit of replication is the **creator or format batch**, not the school.
- **Rule.** Scale after 1 pass plus 2 matched replication passes. Kill after 3 valid failures. A pass that fails to replicate triggers an instrumentation audit, not scaling.

**P6. Remove confounds; product-market fit is binary ("if there's any uncertainty, it's not working").**
- **Holds.** This is the most durable principle. It matches pre-registered kill thresholds.
- **2026 caveat.** "Binary" reads of noisy small samples are statistically dangerous. A simulated A/A test with daily peeks stopping on 95%/5% chance-to-win gave **about a 40% false-positive rate** (monetization-analytics stream computation). A paywall test at 15% baseline needs about 2,402 users per arm to detect a 20% lift.
- **Rule.** A test counts only if: density is met (10 or more friends per tester for social apps); seeding saturation is met (30–40% of the cell within 48 hours for social; a fixed creator batch for utilities); the instrumentation audit passes (dev sessions excluded, final-send events rather than attempts); support is monitored live; and cohorts are cold traffic, not self-selected. Ambiguous means iterate or kill, never scale. Use fixed-horizon or always-valid sequential tests, not naive Bayesian peeking.

**P7. Growth comes only from one-to-one invites or one-to-many sharing; K must reach 1.0 (thread #8; Out of Office 2026 **[Unverified captions]**).**
- **Holds** for social products, where the gap between 0.99 and 1.01 is often one invite button (Bier, Aug 2022).
- **2026 caveat.** Largely **outdated for AI utilities**. Vert, Cal AI and Quittr grow on paid and earned creator reach with K well below 1, and the economics work because revenue per 1K views exceeds cost per 1K views. Bier calls a viral TikTok "a press bump," but for this cohort, repeated paid press bumps are the business. Rented channels are fragile too: Snap removed Gas from SnapKit, breaking growth for 7 days.
- **Rule.** Every concept declares its primary channel and a modeled economic loop. For social apps, the loop is K = invites per user × conversion per invite. For utilities, it is revenue per 1K views against cost per 1K views per creator, hook and format. Require at least 2 independent share surfaces before scaling, and downgrade concepts that depend on a single rented API.

**P8. Long signup flows are fine if activation rises (thread #9).**
- **Holds strongly.** Cal AI found extra quiz questions raised conversion. Quittr's 12-page quiz had 99% completion. Multi-page onboarding paywalls convert 37% better (Superwall 2026).
- **2026 caveat.** This is now a **compliance edge**. Quiz funnels that collect a lot of time and data before price disclosure were central to the FTC's Genesis Tech complaint (Jun 2026). "Bait and switch" is the top complaint theme in Astra and Strum reviews.
- **Rule.** Optimize onboarding for a defined activation milestone. Disclose "subscription required" before heavy data collection (in creator scripts and on an early screen). Value must appear within about 3 seconds of the first value screen (Bier). Use one auth method on the same protocol as distribution.

**P9. Habit through recurring exposure on other networks, not one-off "Wrapped" moments (thread #10; Dec 2023).**
- **Holds.** Shareable core outputs (compatibility scores, soulmate sketches, chord charts) and Locket-style widgets fit well.
- **2026 caveat.** TikTok marks reused or unoriginal content as not eligible for the For You feed. YouTube demonetizes templated AI slideshows ("inauthentic content," Jul 15, 2025 and Jul 16, 2026). Shareable outputs must be genuinely varied.
- **Rule.** The core content unit from every session is shareable in 1–2 taps in the destination's native format, with attribution and AI labels. Measure shares per WAU per week and share-to-install conversion. One-off spikes do not count as PMF evidence.

**P10. The toilet test: most installs happen in bed or on the toilet; sound or voice at signup is a "60% tax" (May 2025; his estimate, no data published).**
- **Holds** as a design constraint.
- **2026 caveat.** Some AI products need voice or camera (golf swing, chords). Use asynchronous capture and keep onboarding silent.
- **Rule.** The core action takes 5 taps or fewer and 15 seconds or less (*proposed*), works one-handed, sound-off and interruptible. Auto-test the prototype muted with random interruptions.

**P11. Target core needs: love, money, play (thread #12); never build a "meetup with friends" app (#13).**
- **Holds.** All of Vert's winners map to love or play.
- **2026 caveat.** The love and fortune categories sit squarely in Apple 4.3(b)'s named saturated list ("dating… fortune telling"). Core-need targeting raises spam-rejection risk unless the app is meaningfully different.
- **Rule.** Tag every idea by core need, hard-reject meetup apps, and route dating, astrology and fortune concepts through a differentiation review (Section 5).

**P12. Monetize the most frequent "can I pay to…" support request (God Mode came from tbh's top request).**
- **Holds** as a demand-discovery method.
- **2026 caveat.** God Mode-style reveals targeting teen insecurity drew criticism (Education Week, Dec 2022), and the NGL and Sendit FTC actions targeted near-identical "reveal" subscriptions. Bier himself labels apps whose business model is "people forgetting to cancel" as "Paywall-Ad Arbitrage Apps."
- **Rule.** Mine support requests for monetization ideas, but never sell reveals of data that isn't true, never paywall before the aha moment, and never target minors with insecurity-driven upsells.

**P13. The App Store chart is the scoreboard ("if it's not ranked… I change it until it is").**
- **Holds** as a directional signal.
- **2026 caveat.** US #1 historically needed 80–100K installs/day, up to about 300K on some days (Bier 2024 **[Outdated]**). Only first-time downloads count (Bier, Sep 2025). Chart manipulation is banned (Apple 5.6.3).
- **Rule.** Use category rank and small-storefront rank as intermediate gates. Never buy or incentivize installs or ratings, and use only SKStoreReviewController.

**P14. Time-box and run a portfolio (4-month disband rule; 14 of 15 apps failed).**
- **Holds.** Bier's hit rate matches Adapty's distribution (58% of new apps earn under $1K in year 1).
- **2026 caveat.** With AI, 4 months compresses to 4–6 weeks (*proposed*). Apple 4.3(b) explicitly allows removal of apps "not updated, improved, or [that] do not attract customers," which affects abandoned tests like Sensa and dormant iOS builds like Plug AI.
- **Rule.** Fixed budget and time box per concept, and reusable components. Apps that are killed are actively removed or consolidated, never left to rot under an account.

**P15. Contact sync and the invite mechanics (70% consent floor in 2021, about 65% average in 2024; "LLMs might be the new Contact Sync," Sep 2024).**
- **2026 caveat: largely outdated.** iOS 18 limited access "nose-dived" consent. Apple 5.1.2(v) bans Select All and contact-based messaging without individualized user initiative. Server-sent invite SMS is "egregiously illegal" (Bier's own words).
- **Rule.** Use the out-of-process picker, ContactAccessButton or Android 17 ACTION_PICK_CONTACTS only. Every invite is user-selected and user-sent with a preview. Enabling any contacts or SMS loop requires human approval.

**P16. Sequencing: validate about 4 conditions in strict order, at 100% execution on the stage under test (Jun 2024).**
- **Holds** and translates directly. For utilities the stages are: S1 hook (views and installs per 1K views), S2 activation (onboarding completion), S3 monetization (paywall-view to trial, trial-to-paid), S4 scalability (RPM above CPM across more than one creator).
- **Tension.** His Nov 2024 anti-MVP stance ("sufficient quality so there are no confounding factors") conflicts with "half-ass the rest." Resolve it by holding a quality floor on everything users touch.
- **Rule.** Kill on S1 failing twice under valid conditions, and allow 4–6 iterations on later stages.

**P17. Breakout operations and hoax response.**
- Geofence and throttle so the app can pause and relaunch. tbh's AWS bill reached $120K against $150K in the bank.
- During the Gas hoax, deletions peaked at 3% per day. A counter-message on the deletion screen, retractions from schools and police, and press work cut that to 0.1%.
- **Rule.** Keep pre-staged counter-messaging and monitor rumors. Press, school, police and platform escalations go to a **human**.

**Bier's own guardrails worth inheriting.** Invites user-initiated and visible. Positive-only, pre-authored content. Boosting under-voted users. His AI guardrail at X: "a machine should not be talking to a human unprompted" (second-hand captions **[Unverified]**), which rules out AI-initiated outreach to non-users.

---

## 4. The automation landscape

**Legend.**
- **FULL**: automatable end to end with no human beyond normal monitoring.
- **SETUP**: automatable after a one-time human setup (identity, keys, audits, agreements).
- **HUMAN**: a human must act each time, or the platform forbids automating it.
- **BLOCK**: technically possible but prohibited; must be hard-blocked.

### 4.1 Build and ship: iOS

| Step | Status | Notes and sources |
|---|---|---|
| Apple Developer Program enrollment (organization needs D-U-N-S) | HUMAN (one-time per entity) | Identity verification |
| Paid Apps Agreement, tax, banking | HUMAN (one-time) | No API exists: spec 4.5.1 has no agreement, tax or bank paths ([ASC OpenAPI 4.5.1](https://developer.apple.com/sample-code/app-store-connect/app-store-connect-openapi-specification.zip)) **[Confirmed]** |
| Team API key (.p8) and In-App Purchase key | HUMAN (one-time) | Admin only, in the UI; the private key downloads once ([Apple](https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api)) **[Confirmed]** |
| **Create the app record** | **HUMAN per app** | `/v1/apps` has GET only; Apple: "create new apps on the App Store Connect website" **[Confirmed]**. Workarounds such as fastlane produce, EAS app creation, and the Rork, Vibecode and Expo Launch flows use an unofficial Apple ID web session with 2FA that lasts "anything between 1 day and 1 month" ([fastlane](https://docs.fastlane.tools/getting-started/ios/authentication/)) |
| **App Privacy ("nutrition label")** | **HUMAN per app** | No public API **[Confirmed]**; fastlane needs an Apple ID |
| Bundle IDs, capabilities, certificates, profiles | SETUP | POST endpoints exist; a Team key is required, since Individual keys cannot use Provisioning **[Confirmed]** |
| Code generation | SETUP | Claude Agent SDK / `claude -p --bare --max-budget-usd` or `codex exec`, with API-key auth only (Anthropic bars claude.ai login for third-party products, [Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)). Agents still fail at .pbxproj edits, code signing and visual debugging ([practitioner guide, Jun 2026](https://www.blakecrosley.com/guides/ios-agent-development)); keep these in deterministic scripts. Modeled cost about $10–40 per MVP session **[Estimate, low]** |
| Cloud build | SETUP | EAS Build with EXPO_TOKEN (robot user) and Workflows REST API ([Expo](https://docs.expo.dev/eas/workflows/rest-api/)); Free 15+15 builds, Starter $19/mo, Production $199/mo ([pricing](https://expo.dev/pricing)) |
| Binary upload | SETUP | Build Uploads API (added in 4.1) plus BUILD_UPLOAD_STATE_UPDATED webhook **[Confirmed]**. EAS non-interactive submit needs `ascAppId` and cannot set up keys ([Expo, updated Oct 12, 2026](https://docs.expo.dev/submit/ios/)) **[Confirmed]** |
| Metadata, category, age rating (incl. social-media questions, required from Sep 2026), encryption, pricing, availability | SETUP | Writable via the API once the record exists |
| Screenshots and previews | SETUP | The App Asset Library replaces the deprecated set-based resources in 4.5.1, and IPHONE_DUO was added; old endpoints still work for now because the spec has no deprecated flag yet **[Confirmed]**. Content must be real app captures (Guidelines 2.3.3/2.3.4) |
| TestFlight groups, public links, external review | SETUP | Up to 10,000 external testers |
| IAP and subscriptions | SETUP | v2 inAppPurchases, subscriptions, offers; the first IAP of each type must ship with a new app version |
| Review submission | SETUP, but **human gate required** (Section 5) | reviewSubmissions plus items; appStoreVersionSubmissions removed in 4.0 **[Confirmed]**. Notes for Review must be specific (2.3.1(a)) |
| Rejection responses and appeals | HUMAN | Judgment and account risk |
| Release, phased release, webhooks | SETUP | Fully API-driven |
| Review queue latency | n/a | Anecdotal reports of 7–16 days for new apps in Oct 2026 ([forums](https://developer.apple.com/forums/thread/850476)) |

### 4.2 Build and ship: Android

| Step | Status | Notes |
|---|---|---|
| Play account, identity, device verification (personal), D-U-N-S (organization, up to 30 days) | HUMAN (one-time) | [Play Help](https://support.google.com/googleplay/android-developer/answer/13628312) |
| Payments / merchant profile | HUMAN (one-time) | Required for subscriptions |
| Android developer verification | HUMAN (one-time) | Enforced from 2026-09-30 in BR, ID, SG and TH; global from 2027 |
| **Create the app** | **HUMAN per app** | No public create method; `applications` has only dataSafety; Custom App Publishing apps "can never be made public" ([REST ref](https://developers.google.com/android-publisher/api-ref/rest), [Custom App](https://developers.google.com/android/work/play/custom-app-api/publish)) **[Confirmed]** |
| App Content declarations (content rating, target audience, ads, access) | HUMAN per app | Data safety is writable via API (SETUP) |
| Closed testing, 12 testers × 14 days | HUMAN-heavy, avoidable | Applies to personal accounts created after Nov 13, 2023. The article does **not** explicitly exempt organization accounts; it only scopes the rule to personal accounts **[Confirmed]**, which points to using organization accounts. Testers can only be assigned via Google Groups ([edits.testers](https://developers.google.com/android-publisher/api-ref/rest/v3/edits.testers)) **[Confirmed]** |
| Listing, graphics, AAB, tracks, staged rollout | SETUP | Edits workflow; whether the **first AAB can go through the API is disputed** (Expo says yes, Codemagic says no), so test it |
| Subscriptions and base plans | SETUP | monetization.subscriptions; Play Billing v8 required since Aug 31, 2026 |
| Target API 36 | SETUP (CI check) | From Aug 31, 2026 |

### 4.3 Distribution: organic

| Step | Status | Notes and sources |
|---|---|---|
| **TikTok posting to own brand accounts via Content Posting API** | **HUMAN / effectively blocked** | Guidelines (updated Aug 4, 2026): "Not acceptable: A utility tool to help upload contents to the account(s) you or your team manages" ([TikTok](https://developers.tiktok.com/doc/content-sharing-guidelines)) **[Confirmed]**. Unaudited clients: 5 posting users per 24 h, private accounts only, SELF_ONLY posts **[Confirmed]** |
| TikTok upload-to-inbox drafts | HUMAN (per post) | The creator finishes in-app; at most 5 pending shares per 24 h ([upload ref](https://developers.tiktok.com/doc/content-posting-api-reference-upload-video)) **[Confirmed]** |
| TikTok via an already-audited third-party scheduler for a few business accounts | SETUP | Limits: about 15 posts per day per creator ("typically around 15"), 6 init requests/min per token **[Confirmed]**. Carousels up to 35 photos, `auto_add_music` (direct post only), `is_aigc` **[Confirmed]** |
| Instagram Reels, carousels, Stories, Trial Reels | SETUP | App Review plus Business Verification. Docs state both 100 and 50 posts per 24 h; **plan for 50** **[Confirmed]**. Carousels max 10; `is_ai_generated` on the parent only; JPEG only; `trial_params` MANUAL or SS_PERFORMANCE ([Meta](https://developers.facebook.com/docs/instagram-platform/content-publishing)) |
| Threads | SETUP | 250 posts per 24 h |
| YouTube Shorts | SETUP | videos.insert has its own bucket of 100 calls/day at 1 unit each since Jun 1, 2026 ([quota](https://developers.google.com/youtube/v3/determine_quota_cost)) **[Confirmed]**. The docs say unverified projects are *not* restricted to private, but the revision history has no reversal of the 2020 rule; **test before relying on it** **[Confirmed conflict]**. OAuth unverified cap is 100 users; Developer Policies require express user consent for uploads |
| X | SETUP | Pay-per-use: $0.015/post, $0.20 with URL, $0.01 summoned reply, $0.005/read; 3M read cap ([pricing](https://docs.x.com/x-api/getting-started/pricing)) **[Confirmed]**. Follow, like and quote writes removed from self-serve (Apr 2026) |
| Pinterest | SETUP | Standard access needs a demo video; "automate the creation of content" is acceptable |
| Snapchat Spotlight | HUMAN (allowlist) | Public Profile API is allowlist-only |
| Trend sensing | SETUP | TikTok Discovery (API for Business), YouTube reads, X reads, SideShift Scraper. The Research API is academic-only (unusable) |
| Programmatic SEO pages, landing pages, AASA/assetlinks hosting | FULL | Per-app static sites |
| Creating new social accounts | HUMAN | Plus a registry entry; one authentic identity per app per platform |
| Engagement automation (likes, follows, comments on others), account farms, warm-up farms | **BLOCK** | TikTok: "Using automation to run many accounts"; "Using AI or bot accounts to drive traffic" ([Community Guidelines, effective Sep 24, 2026](https://www.tiktok.com/community-guidelines/en/integrity-authenticity)); TikTok ToS bans "operating spam or impersonation accounts" |

### 4.4 Distribution: creators and paid acquisition

| Step | Status | Notes |
|---|---|---|
| Creator sourcing, briefs, script generation, draft review, messaging | SETUP | SideShift Platform API and MCP (`create_campaign`, `review_video_submission`, `send_message`) ([docs](https://docs.sideshift.app/mcp-server.md)). Treat creator messages as untrusted input (prompt-injection risk) |
| Creator payouts | SETUP, **human-gated at first** | SideShift `execute_payouts` with `dry_run`, Idempotency-Key, MCP_SAFE_MODE; per-app budget ceilings |
| Creator contracts and terms | HUMAN | Disclosure obligations, usage rights, no sentiment-conditioned pay |
| Whop Content Rewards (CPM clipping) | HUMAN/UI | No public Content Rewards API confirmed |
| Spark Ads / Partnership Ads codes | HUMAN (creator side) | The creator generates the code |
| Meta Advantage+ app campaigns | SETUP | The legacy ASC/AAC path is dead: no creation from v25.0 (Feb 18, 2026), blocked in all versions after May 19, 2026; **v26.0 shipped Jul 29, 2026** (the blog estimated September) and pauses remaining legacy campaigns ([Meta blog](https://developers.facebook.com/blog/post/2026/02/13/asc-and-aac-deprecation-mapi-v25/), [changelog](https://developers.facebook.com/docs/graph-api/changelog)) **[Confirmed]**. Use APP_PROMOTION with all three Advantage+ levers. Full access needs App Review, at least 500 calls in 15 days and under 15% errors. Official Ads MCP at mcp.facebook.com/ads |
| TikTok ads | SETUP | Official Ads MCP announced at TikTok World May 2026; agents can "plan, launch and optimize campaigns without manual intervention" ([Digiday, May 13, 2026](https://digiday.com/media/tiktok-launches-mcp-server-to-let-ai-agents-run-campaigns/)) **[Confirmed]**. Endpoint, tool count (~400) and 30-day authorization are **[Unverified, low]** |
| Google Ads App campaigns | SETUP | MULTI_CHANNEL with app_campaign_setting; developer token Basic needs brand verification; **official MCP is read-only**, so mutations need the API directly ([repo](https://github.com/googleads/google-ads-mcp)) **[Confirmed]** |
| Apple Ads | SETUP | Build on the Platform API; Campaign Management v5 sunsets Jan 26, 2027 |
| Budget increases above threshold, new ad accounts | HUMAN gate | Spend caps and kill switches |

### 4.5 Monetization, analytics and experiments

| Step | Status | Notes |
|---|---|---|
| RevenueCat project, apps, products, entitlements, offerings, paywalls | SETUP | REST v2: POST /projects (60 req/min), `create_in_store` pushes products to ASC with a duration enum and `subscription_group_name` ([product.md](https://www.revenuecat.com/docs/api-v2/product.md)) **[Confirmed]** |
| RevenueCat experiments | SETUP | Not a REST resource; done through the hosted MCP (`create-experiment`, `start-experiment`, `get-experiment-results`). 2–4 variants, Pro/Enterprise plans only, 400-day maturation ([MCP tools](https://www.revenuecat.com/docs/tools/mcp/tools-reference.md)) **[Confirmed]**. REST-created customers are reportedly not enrolled **[not re-checked]** |
| RevenueCat pricing | n/a | Free to $2,500 MTR, then 1% of MTR; Pro includes all features. **Corrected:** Growth Tools is *not* an extra 1% on top; a RevenueCat-native stack pays about 1% total ([pricing](https://www.revenuecat.com/pricing/)) |
| Superwall campaigns, A/B tests, bandits | SETUP | REST v2, 202 paths; `variant_optimization` none or `ucb1_bandit`; RevenueCat-compatible read endpoints ([OpenAPI](https://api.superwall.com/openapi.json)) **[Confirmed]**. Pricing page contradicts itself: infrastructure free and "1% paywall-attributed," but plan cards show Indie $0 to $10K MAR then 1% of *total* MAR, Startup $49/mo + 1%, Scale $199/mo + 1%. **Budget for $49–199/mo and confirm with sales** ([pricing](https://superwall.com/pricing)) |
| New paywall templates, price points, trial or cancel-flow changes | HUMAN gate | Agent tests only within approved templates |
| Event analytics | SETUP | PostHog (HogQL 240/min, hosted MCP with experiment tools, Bayesian or sequential frequentist); Amplitude MCP; Mixpanel MCP (600 req/hr) |
| Experiment decision rule | FULL (if pre-registered) | Fixed-horizon or always-valid sequential (about 1.55x wider intervals at the tuning point); minimum detectable effect of 30% or more at small scale; at least 7 days runtime |
| Attribution | SETUP | AdAttributionKit conversion values (postbacks 24–144 h delayed); AdServices token (24 h TTL); Play Install Referrer; no fingerprinting (Apple DPLA) |
| Deep links | FULL | Self-hosted AASA/assetlinks (Firebase Dynamic Links has returned 404 since Aug 25, 2025); App Clip as invite landing (up to 100 MB on iOS 17+ digital invocations) |
| MMP access (AppsFlyer OneLink v2) | HUMAN (one-time) | CSM-gated; v1 sunset Jun 1, 2026 |
| Push and Live Activities | SETUP | APNs/FCM keys set up once; promotional push needs explicit opt-in (4.5.4) |
| Refunds and chargebacks | SETUP plus human escalation | App Store Server API refund history; Play `orders.reviewrefund` |
| Revenue truth | SETUP | Use store proceeds or RevenueCat, never tracker estimates |

### 4.6 AI generation

Snapshot as of 2026-10-17.

| Step | Status | Notes and prices |
|---|---|---|
| Model registry and routing | FULL | Vercel AI Gateway public `/v1/models` lists 474 models with video capabilities and prices; no token markup ([pricing doc](https://vercel.com/docs/ai-gateway/pricing)). Poll daily: Sora 2 and the Videos API were shut down 2026-09-24 ([OpenAI](https://developers.openai.com/api/docs/guides/video-generation)), and Imagen 4 and Nano Banana 2.5 were retired |
| Images | SETUP (keys; OpenAI organization verification is a HUMAN one-time step) | Nano Banana 2.1 $0.0336/1K image ($0.0168 batch, SynthID); Meta Muse $0.01; gpt-image-2 $0.005–0.211 ([AA leaderboard](https://artificialanalysis.ai/image/leaderboard/text-to-image)) |
| Video | SETUP | Blind-vote leaders: Wan 3.0, Seedance 2.5, MiniMax H3 (about $0.08/s at 768p, #1 for image-to-video); Veo 3.1 ranks #19 for text-to-video with audio ([AA](https://artificialanalysis.ai/video/leaderboard/text-to-video)). Run as async jobs with webhooks and idempotency keys |
| Voice and music | SETUP | ElevenLabs $0.04–0.08 per 1K chars; Eleven Music $0.15/min (commercial use on Starter+); Lyria 3.5 $0.08/song. TikTok business accounts must use the Commercial Music Library in-app, so bake licensed music into the file |
| Avatars | SETUP; **real-person likeness = HUMAN consent** | HeyGen (about $0.0167–0.0667/s **[Unverified]**; photo avatars have no consent check), Mirage $0.15/s, Creatify |
| Rendering | FULL | Remotion ($0.01/render with $100/mo minimum above 3 people), Lambda about $0.001–0.02/render |
| Disclosure flags and C2PA re-signing | FULL | `is_aigc`, `is_ai_generated`, YouTube `containsSyntheticMedia`; re-sign the final file because rendering strips C2PA |
| QA judging | FULL, plus sampled human review | Vision-model judges cost under $0.01 per slideshow |
| Cost at 100 assets/day | n/a | Modeled: lean about $66/day, balanced about $156/day, avatar-heavy about $275/day, all-premium Veo about $1,000/day **[Estimate]** |

### 4.7 Bottom line on automation

About 80–90% of the action count in the pipeline is SETUP or FULL **[Inference]**. The irreducible human work clusters in three places:
1. **Identity and contracts**: entities, developer accounts, agreements, API keys, ad-account verification, creator contracts.
2. **Per-app store creation**: the Apple app record and App Privacy label; the Play app and its content declarations.
3. **Judgment calls with legal or account-level consequences**: covered in Section 5.

**Organic TikTok posting to owned accounts is the biggest strategic constraint.** It cannot be automated legitimately at scale. That pushes the design toward a creator marketplace in which real humans post on their own accounts, which happens to be Vert's own model.

---

## 5. Risks, compliance, guardrails and mandatory human approval gates

### 5.1 Risk register

| Risk | Trigger in an automated factory | Rule / precedent | Severity |
|---|---|---|---|
| **App spam / similarity termination** | Many template apps, near-duplicates, saturated categories | Apple 4.3(a)/(b), updated Jun 8, 2026: "dating… fortune telling"; "Repeated submissions… may lead to removal from the Apple Developer Program"; apps not updated may be removed ([guidelines](https://developer.apple.com/app-store/review/guidelines/), [news](https://developer.apple.com/news/?id=a233fmpw)) **[Confirmed]**. Apple uses AI to "analyze app similarity" (May 2026). Matching against terminated accounts by "binary, metadata, and/or concept" is **[Unverified]**, from a Jun 2024 forum post, but consistent. Google bans highly similar multi-app portfolios and terminates "related" accounts | Existential |
| **Template / app-generation service rule** | Submitting apps on behalf of others | Apple 4.2.6 **[Confirmed]** | High for B2B variants |
| **Bait-and-switch / hidden features** | Remote config adds features or IAPs after review | Apple 2.5.19 (Oct 16, 2026): "grounds for removal… and termination of your developer account" **[Confirmed]**; about 59K bait-and-switch removals in 2025 | Existential |
| **Subscription dark patterns** | Quiz-before-price funnels, buried renewal price, hard-to-cancel flows | FTC ROSCA enforcement (Amazon $2.5B Sep 2025; Shutterstock $35M May 2026); **Genesis Tech** TRO plus asset freeze (Jun 2026) against a multi-brand portfolio using quiz funnels and shell entities; California ARL (Jul 2025); NYC rule from 2026-10-01; Apple 3.1.2 | Existential (personal liability) |
| **Fake social proof** | AI testimonials, seeded reviews, bot engagement, bought followers | FTC 16 CFR 465 (Oct 2024; up to $53,088 per violation; first warning letters Dec 22, 2025); Apple 5.6.3; TikTok bans | High |
| **Undisclosed AI / ads** | Unlabeled synthetic humans; creator posts without #ad | TikTok AIGC labels and commercial disclosure (repeat failure leads to ban); FTC Endorsement Guides; NY GBL 396-b (synthetic performers in ads, from 2026-06-09); EU AI Act Art. 50 (from 2026-08-02) | High |
| **Account-farm automation** | Multi-account posting tools, warm-up farms, ban evasion | TikTok Content Sharing Guidelines plus Community Guidelines; YouTube spam policy ("automated tools or AI to churn out high volumes of similar content"); Meta inauthentic behavior | High (platform-wide ban) |
| **Minors** | Teen social or polling apps, anonymous chat, reveal paywalls | NGL (2024 ban on serving minors), Sendit (2025 complaint); Apple 1.2 (anonymous chat, Feb 2026); COPPA amended (full compliance from 2026-04-22); Texas SB 2420 enforceable since 2026-06-04; Australia under-16 ban; UK OSA; EU DSA addictive-design findings | Existential for teen products |
| **AI companions / mental health** | Persona chat, "AI therapist" | CA SB 243 (2026-01-01; $1,000 per violation private action); CA SB 1119 (operative 2027-07-01); about 12 state chatbot laws; Illinois and Nevada AI-therapy bans | High |
| **Third-party AI data sharing** | Sending photos or chats to LLM vendors without consent | Apple 5.1.2(i) explicit permission; Google user-data policy covers third-party AI (Jul 2026) | Medium–High |
| **Contacts / invites** | Address-book upload, server SMS | Apple 5.1.1/5.1.2(v); Path (FTC 2013); Twoo (Belgian DPA); TCPA | Medium–High |
| **Trademark / copycat** | "pokemonapp"-style bundle IDs, borrowed brands | Apple 4.1(c) (Nov 2025) | Medium |
| **Dormant apps and dead legal URLs** | Abandoned tests, broken privacy links | Apple 4.3(b) removal of unimproved apps; Vert's own dead vertventures.io/terms links | Medium |
| **Platform dependency** | One rented channel or API | SnapKit cutoff of Gas; TikTok audit constraints | Medium |
| **Prompt injection via creator inputs** | Agent-controlled payouts and ads | Meta's MCP guidance; SideShift safe mode | Medium–High |
| **Hit decay** | Over-investment in a peaking app | Ask AI -80%; tbh and Gas shutdowns | Business |

### 5.2 Hard blocks: never automate, enforced in code

1. Buying followers, views, likes or reviews; engagement bots or pods; automated follows, likes or comments on others. Enforce with an outbound-action allowlist.
2. Account farms, purchased or aged accounts, persona networks, and any replacement account after a ban or restriction.
3. Identical cross-posting across accounts. Template-variant volume above caps, checked with perceptual-hash and semantic deduplication.
4. AI-generated "customer" testimonials, fake before/after results, AI personas giving health, finance or legal advice, or any real likeness without stored written consent.
5. Fake in-app social proof: fake friend messages, fake notifications, and unlabeled bot participants (the NGL and Sendit pattern).
6. Near-duplicate apps under multiple bundle IDs, or spread across developer accounts or shell entities to dodge enforcement.
7. Behavior changes after review without resubmission.
8. Device fingerprinting; tracking before ATT consent.
9. Address-book uploads; server-sent invites; "Select All."
10. Stripping C2PA or watermarks from AI output.

### 5.3 Automated compliance linters (block deploy on failure)

- **Paywall linter.** Before billing details are collected, the screen shows price, billing period, auto-renewal, the trial-to-paid date and how to cancel, with the renewal price as prominent as the trial price. It also checks:
  - a separate, unticked auto-renew consent control (California);
  - a confirmation email plus trial-end and annual reminders;
  - same-medium online cancellation;
  - save offers only with click-to-cancel alongside;
  - no unconsented upsell subscriptions;
  - consent logs stored for at least 3 years;
  - subscription period of at least 7 days (Apple 3.1.2(a)).
- **Privacy linter.** Store labels, Play Data safety and the privacy policy are generated from an SDK and traffic inventory, and any mismatch blocks release. It also requires an in-app privacy link, in-app account deletion, and a consent screen before any third-party AI call.
- **Content linter.** AI flags set on every post; commercial disclosure toggles set; "#ad" at the start of captions and on screen for creator posts; claim-substantiation registry hits for superlatives and AI-capability claims (Apple 2.3.14 bans unverifiable claims in creative assets); real UI only in screenshots and previews.
- **Metadata linter.** Uniqueness against the factory's own portfolio and top competitors; trademark screening; legal-URL health checks; specific Notes for Review.
- **Moderation baseline** for any UGC or generative feature (Apple 1.2, including "AI content creation apps"): filtering, report, block, published contact, CSAM/NCII hash-matching, and nudification blocks.
- **Age-assurance integration.** Declared Age Range, PermissionKit Significant Change, Play Age Signals. Geo-block Texas (later Utah, Louisiana, California) if these are not integrated.

### 5.4 Quality tripwires that trigger an automatic pause and human escalation

Each threshold is set per app and pauses paid UA and paywall experiments when crossed:
- Refund rate above threshold, or chargeback spike.
- 1-star share of written reviews above threshold. High star averages can hide it: Astra has about 4.7 stars with a majority of 1-star written reviews.
- Support complaints citing "bait and switch" or "can't cancel."
- Any platform strike, rejection citing 4.3, 2.5.19 or 5.6, or a regulator or attorney-general letter. These freeze **all** automation on that platform.

Apple 5.6.4 names excessive refunds and negative reviews as Code of Conduct signals. Genesis Tech shows that being on notice of harm increases liability.

### 5.5 Mandatory human approval gates

| # | Gate | Why it cannot be delegated |
|---|---|---|
| 1 | Creating or changing any legal entity, developer account, store listing ownership or social account | Identity, contracts, enforcement linkage |
| 2 | Each new app submission, and any update changing core function, monetization, data flows or age rating | 4.3, 2.5.19, SB 2420 "significant change" |
| 3 | Any red-category app: minors or teens, anonymous chat, companion or persona chat, mental health, dating, astrology or psychic, health or finance, gambling-like mechanics | Precedent-heavy legal risk |
| 4 | New paywall templates, price points, trial structures, cancellation-flow changes | ROSCA and auto-renewal laws |
| 5 | Creator contracts, payouts above a threshold, ad budgets above a threshold, new ad accounts | Money movement, disclosure liability |
| 6 | Any real-person likeness or voice | Consent and right of publicity |
| 7 | Enabling contacts, SMS or email invite loops | Apple 5.1.2(v), TCPA, ePrivacy |
| 8 | Adding third-party data or AI vendors | 5.1.2(i), DPAs |
| 9 | Responses to platform strikes, rejections, regulator letters, legal threats, appeals | Account-level consequences |
| 10 | Incident response: CSAM, self-harm events, data breaches, hoaxes | Legal reporting duties |
| 11 | Launching in new countries or US states | EU AI Act, DSA trader status, UK OSA, Australia, state laws |
| 12 | Resuming marketing after a tripwire fires | Notice-of-harm liability |

### 5.6 Audit and kill switch

Keep an immutable log of every agent action (post, submission, paywall change, message, payout) with the model and version, prompt, and approver. Provide global and per-app, per-account and per-channel kill switches that a human or a tripwire can trigger instantly.

---

## 6. Key design implications for an autonomous AI viral-app company

1. **Make the test harness, not the app, the core product.** Throughput should be measured in validated tests per month, and every test must be conclusive. That requires pre-registered hypotheses, validity preconditions and kill/scale thresholds, plus statistics that survive peeking (fixed horizon or always-valid sequential, minimum detectable effect of 30% or more, upstream proxy metrics). Bier's "if there's any uncertainty, it's not working" becomes a default-kill rule.

2. **Default to single-player AI utilities that meet a core need, not social-graph apps.** Vert, Cal AI and Quittr show the 2023–2026 money is in "one input, one magic output" products that work alone on first use and produce shareable, filmable artifacts. Treat Bier-style social launches as a separate, human-gated module, never the default, and exclude minors.

3. **Screen ideas for differentiation before building.** Apple and Google penalize volume without distinctness, so the ideation module must score:
   - core need;
   - aha moment within 60 seconds;
   - visual demonstrability;
   - price tolerance of about $6.99/week;
   - a reachable creator niche;
   - **meaningful difference** against store competitors and the factory's own portfolio.

   Saturated categories (dating, astrology, fortune telling) need explicit differentiation and human approval.

4. **Distribution is a creator marketplace run by agents, with humans as the faces.** Official APIs will not support an AI-run fleet of owned TikTok accounts. The legitimate scalable channel is real creators and clippers posting on their own accounts. Agents run sourcing, briefs, hooks, draft review against a rubric, performance logging, culling and dry-run payouts (SideShift API/MCP; Whop via UI). Owned brand accounts stay few, authentic and lower volume (Instagram 50/24 h, YouTube 100 uploads/day per project, TikTok via an audited scheduler or drafts).

5. **Run the economics on revenue per 1K views against cost per 1K views per creator, hook and format.**
   - Attribute without heavy SDKs: correlate post timestamps and view curves with hourly installs and trials, and use promo codes, deep links, custom product pages (up to 70) and AdAttributionKit.
   - Promote organic winners into a UGC bank and paid amplification (Meta APP_PROMOTION Advantage+, TikTok Ads MCP or Smart+, Apple Ads Platform API) with automated spend caps.
   - Expect the creator channel to plateau (Cal AI around $2M/mo) and plan the switch to paid.

6. **Use one config-driven monetization template, varied per app.**
   - Template: 8–16-step personalization onboarding, an early "subscription required" disclosure, then a multi-page hard paywall. Defaults: weekly $5.99–$6.99 with a 3-day trial, an annual anchor around $35–50, localized.
   - Run it on RevenueCat (about 1% of MTR total) or Superwall (bandit allocation; budget possible $49–199/mo platform fees), behind a vendor abstraction layer.
   - Optimize **refund-adjusted** revenue per install, not conversion. Vert's 1-star "bait and switch" reviews are the warning.

7. **Ship fast, but treat each reviewed binary as a contract.** A release every 3–6 days per app is achievable with EAS and the Build Uploads API. Behavioral changes must go out as reviewed binaries, never as OTA or remote-config surprises (2.5.19). Keep signing, .pbxproj changes and submission in deterministic scripts, not agent improvisation.

8. **Design human chokepoints into the schedule.** Each new app needs about 3 short human tasks: Apple app record, App Privacy, Play app plus content declarations. Each entity needs one-time onboarding: enrollment, agreements, tax and banking, keys, Meta Business Verification, Google Ads brand verification, OpenAI organization verification, Android developer verification. Use organization Play accounts to avoid the 12-tester rule. Budget for 7–16-day review queues (Oct 2026 anecdotes) by pipelining submissions.

9. **Use few, honest entities, not shell sprawl.** Vert's multi-LLC structure looks like risk isolation, but Apple and Google link related accounts, and the FTC treated spreading activity across entities as aggravating in Genesis Tech. Use a small number of truthful legal entities with accurate DSA trader details, carefully run, plus an entity and account registry mapping every app to its LLC, developer account, support inbox, legal host and payment rails.

10. **Kill and clean up, not just kill.** Abandoned apps create 4.3(b) removal risk, dead legal URLs and reputational debt. Automate removal or consolidation of failed tests and dormant builds. Run legal-URL health checks and metadata-uniqueness checks across the whole portfolio.

11. **Make generated content cheap, varied, labeled and real where it counts.**
   - Default to AI-image slideshows and carousels ($0.15–0.37 per asset, modeled) and save generated video for proven formats.
   - Use only real app captures for UI.
   - Set every AI flag, re-sign C2PA after rendering, and bake in licensed music.
   - Cap near-duplicate variants per channel.
   - Never present AI avatars as real customers.

12. **Plan for decay and exit from day one.** Forecast peaks, then shift winners to paid UA and price optimization. Flag sale windows (tbh within weeks, Gas in about 5 months, Cal AI in about 20 months), or move apps to portfolio-ops mode (Bending Spoons and HubX).

13. **Automate the org Vert staffs with people.** The bulk of headcount in Vert, Cal AI and Codeway is creator ops and growth marketing: messaging, script feedback, performance logging, payouts and ad creative churn. These are the highest-ROI automation targets. Engineering is already AI-assisted and is the smaller share.

14. **Write compliance as code, with humans as approvers.** The levers that make a naive agent grow fast are the same ones that end companies. Hard blocks (5.2), linters (5.3), tripwires (5.4), twelve approval gates (5.5) and an immutable audit log with kill switches (5.6) are not overhead. They are what keeps the portfolio's developer accounts and revenue alive.

---

## Appendix A: Fact-check corrections applied

| Original claim | Verdict | How it is handled in this brief |
|---|---|---|
| Vert site metrics and in-house claim; vertventures.io redirects | Confirmed | Presented as self-reported marketing numbers |
| Astra under Vert Ventures LLC, about 39.3K ratings | Confirmed (39,321 on 2026-10-17) | Updated count |
| Play "Vert Media Partners" publishes Astra, Plug AI and Strum | Confirmed; W185 = Vert legally is an inference | Labeled as strong inference |
| Plug AI iOS dormant since 2024-08-02 | Confirmed (15,808 ratings) | Updated |
| Strum / W185 / Autochord | Confirmed; #53 Music rank and revenue estimates not re-verified | Rank and revenue labeled |
| W185's 5 smaller apps | Confirmed; **Eagle has 121 ratings, not 127** | Corrected |
| Vert Ventures NY registration at 185 Wythe | Confirmed via aggregator; W185 = 185 Wythe is an inference | Labeled |
| Co-founders Dray, Leiman, Olson; Plug AI co-founded by Anderson and Leiman | **Unverifiable**, except Leiman as Plug AI co-founder | Labeled unverified and low confidence |
| Plug AI podcast metrics ($190K/mo, 1.2M downloads, $3.5M listing, Superwall) | Confirmed but about 33 months old | Marked outdated as a current revenue figure |
| TikTok internal-upload-tool ban; unaudited limits; about 15 posts/day; inbox 5 pending; photo carousel 35 | Confirmed | Used; WebP/JPEG/1080p/20 MB detail omitted as unverified |
| Instagram 100 vs 50 posts | Confirmed conflict | Plan for 50 |
| YouTube videos.insert bucket; unverified-project conflict | Confirmed | Conflict flagged; test before relying on it |
| ASC: no app creation; Build Uploads; no App Privacy API; Asset Library deprecation; Team key | Confirmed | Used; old screenshot endpoints noted as still working |
| EAS ascAppId / non-interactive limits | Confirmed (page updated Oct 12, not Oct 13) | Date corrected |
| Apple 4.3, 4.2.6, Oct 16 2026 update, 2025 enforcement figures | Confirmed | Used |
| 4.3(a) matching against terminated accounts by "binary, metadata, and/or concept" | **Unverifiable** (Jun 2024 forum post) | Labeled unverified but directionally consistent |
| Play: no public app creation; 12 testers × 14 days; testers via Google Groups only | Confirmed; organization accounts not explicitly exempt | Wording adjusted |
| RevenueCat API v2 and MCP experiments | Confirmed | Used |
| **RevenueCat Growth Tools as a separate +1% add-on** | **Refuted** | **Dropped**; stated as about 1% total |
| Superwall API v2 / bandit | Confirmed | Used |
| Superwall pricing | Partly right, incomplete, internally contradictory | Budget $49–199/mo platform fees; confirm with sales |
| Meta ASC/AAC deprecation | Confirmed; blog misprints 2025; **v26.0 shipped Jul 29, 2026**, not September | Corrected |
| X pay-per-use pricing; engagement writes removed | Confirmed | Used |
| TikTok Ads MCP | Confirmed; endpoint, tool count and 30-day authorization low confidence | Labeled |
| Google Ads MCP read-only | Confirmed | Used |

## Appendix B: Highest-value open questions

1. Is RevenueCat's 10.7% hard-paywall figure download-to-paid or trial-to-paid? Confirm before using it as a kill threshold.
2. What are real views-to-install and views-to-paid ratios by format (creator UGC vs faceless slideshow vs AI video) in 2026? No credible dataset exists.
3. Does the TikTok API for Business Organic "Accounts" publishing path carry the same "accounts your team manages" restriction?
4. Can a new Play app's first AAB be uploaded through the API? Sources conflict, so test empirically.
5. What threshold does Apple's similarity analysis apply to one account submitting many distinct apps that share a codebase?
6. What is Vert's true revenue split, its paid vs creator mix, and is Haven / E12 Holdings part of the portfolio?
7. What is the status of the Texas SB 2420 merits appeal and the final Utah and Louisiana effective dates? Both determine whether any teen-adjacent wedge is viable.
8. What is measured, not modeled, agent spend for an end-to-end Expo MVP with paywall and analytics? This needs an instrumented pilot.