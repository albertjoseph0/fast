/**
 * The Vert case (vert.nyc, "a startup that makes startups") and the comparable studios
 * and apps, as structured data from the research of 2026-10-17. Revenue and user numbers
 * are self-reported or third-party estimates; the confidence fields say how much to trust them.
 */

export type Confidence = "high" | "medium" | "low";

export interface VertEntity {
  name: string;
  role: string;
  jurisdiction: string;
  appleArtistId?: string;
  notes: string;
  source: string;
}

export interface VertApp {
  name: string;
  entity: string;
  category: string;
  /** App Store release date, YYYY-MM-DD. */
  launched: string;
  /** US App Store rating count on asOf. */
  usRatings: number;
  monetization: string;
  status: "winner" | "modest" | "testing" | "abandoned";
  notes: string;
  confidence: Confidence;
  source: string;
}

export interface SourcedMetric {
  metric: string;
  value: number;
  unit: string;
  asOf: string;
  source: string;
  note?: string;
}

export interface Comparable {
  name: string;
  kind: "app" | "studio";
  model: string;
  lesson: string;
  metrics: SourcedMetric[];
}

export const VERT_CASE: {
  asOf: string;
  summary: string;
  founders: string[];
  entities: VertEntity[];
  apps: VertApp[];
  operatingModel: string[];
  selfReported: SourcedMetric[];
  caveats: string[];
} = {
  asOf: "2026-10-17",
  summary:
    "Bootstrapped NYC app studio that builds and markets single-player AI 'verdict' apps in-house: personalization onboarding, " +
    "hard paywall around $6.99/week after a trial, one AI capability, and distribution through hundreds of paid creators.",
  founders: ["Alex Leiman", "Evan Dray", "Will Olson"],
  entities: [
    {
      name: "Vert Media Partners LLC",
      role: "Publisher of Plug AI on iOS; Google Play developer for Astra, Plug AI and Strum",
      jurisdiction: "California (Palo Alto)",
      appleArtistId: "1690446849",
      notes: "2023 Statement of Information lists Alex Leiman, Evan Dray and Blake Anderson as managers (search snippets only).",
      source: "https://play.google.com/store/apps/developer?id=Vert+Media+Partners&hl=en_US&gl=US",
    },
    {
      name: "Vert Ventures LLC",
      role: "Publisher of Astra; the brand behind vert.nyc",
      jurisdiction: "Wyoming (formed 2023-11-08), registered in New York 2024-06-11",
      appleArtistId: "1719671063",
      notes: "NY filing address 185 Wythe Ave, Brooklyn.",
      source: "https://www.bizprofile.net/ny/brooklyn/vert-ventures-llc",
    },
    {
      name: "W185 Holdings LLC",
      role: "Publisher of Strum and five smaller test apps",
      jurisdiction: "Wyoming",
      appleArtistId: "1761597813",
      notes: "Linked to Vert because Vert Media Partners publishes com.w185holdings.strum on Play; 'W185' likely stands for 185 Wythe (inference).",
      source: "https://itunes.apple.com/lookup?id=1761597813&entity=software",
    },
    {
      name: "E12 Holdings LLC",
      role: "Publisher of Haven (AI Bible study), per a secondary source",
      jurisdiction: "Wyoming",
      notes: "The filing reportedly lists the same founders; not confirmed against Apple's records.",
      source: "https://joshbensonthewriter.substack.com/p/tarot-cards-drugs-and-millions-in",
    },
  ],
  apps: [
    {
      name: "Plug AI: Texting Assistant",
      entity: "Vert Media Partners LLC",
      category: "Lifestyle (AI dating replies from chat screenshots)",
      launched: "2023-06-30",
      usRatings: 15_812,
      monetization: "3-day trial then weekly (about $6.99); annual $49.99-59.99",
      status: "winner",
      notes: "Formerly RizzGPT, then Wingman. 1.2M downloads in under 3 months; about $190K/month by Jan 2024. iOS build not updated since 2024-08-02, still #97 Lifestyle grossing.",
      confidence: "high",
      source: "https://apps.apple.com/us/app/id6449750416",
    },
    {
      name: "Astra - Life Advice",
      entity: "Vert Ventures LLC",
      category: "Lifestyle (AI astrology, compatibility, life-advice chat)",
      launched: "2024-01-09",
      usRatings: 39_299,
      monetization: "Hard paywall; free trial (3 days in 2025 terms, 7 days in 2026 reviews) then $6.99/week; many price-test SKUs $6.99-19.99",
      status: "winner",
      notes: "#23 US Top Grossing Lifestyle; ships a build about every 3 days; shareable 'Soulmate Sketch'. Third-party estimate about $400-450K/month.",
      confidence: "high",
      source: "https://apps.apple.com/us/app/astra-life-advice/id6473748536",
    },
    {
      name: "Berry - Wellness",
      entity: "W185 Holdings LLC",
      category: "Health & Fitness (cycle-syncing journal)",
      launched: "2024-08-20",
      usRatings: 1_302,
      monetization: "$6.99 subscription template plus $0.99 tier",
      status: "modest",
      notes: "Last updated 2025-02-14.",
      confidence: "high",
      source: "https://apps.apple.com/us/app/berry-wellness/id6615085632",
    },
    {
      name: "Saga - Stories",
      entity: "W185 Holdings LLC",
      category: "Books (AI stories)",
      launched: "2025-01-13",
      usRatings: 159,
      monetization: "$6.99 subscription template plus $0.99 tier",
      status: "abandoned",
      notes: "Last updated 2025-10-13.",
      confidence: "high",
      source: "https://apps.apple.com/us/app/saga-stories/id6740108033",
    },
    {
      name: "Sensa - ASMR",
      entity: "W185 Holdings LLC",
      category: "ASMR",
      launched: "2025-03-05",
      usRatings: 0,
      monetization: "$6.99 subscription template plus $0.99 tier",
      status: "abandoned",
      notes: "Listing copy pasted from Saga; dropped after about 3 weeks.",
      confidence: "high",
      source: "https://apps.apple.com/us/app/sensa-asmr/id6742751158",
    },
    {
      name: "Strum - Play Guitar",
      entity: "W185 Holdings LLC",
      category: "Music (AI chord recognition for any song)",
      launched: "2025-08-06",
      usRatings: 20_077,
      monetization: "Hard paywall; trial then $6.99/week, or $49.99/year with a 7-day trial",
      status: "winner",
      notes: "First called Autochord. #25 US Top Grossing Music; about 16-step onboarding; programmatic SEO chord pages. Third-party estimate about $250K/month.",
      confidence: "high",
      source: "https://apps.apple.com/us/app/strum-play-guitar/id6749384181",
    },
    {
      name: "Indigo - Scan & Collect",
      entity: "W185 Holdings LLC",
      category: "Reference (trading-card scanner)",
      launched: "2026-03-29",
      usRatings: 0,
      monetization: "No IAPs listed",
      status: "abandoned",
      notes: "Last updated 2026-04-13.",
      confidence: "high",
      source: "https://apps.apple.com/us/app/indigo-scan-collect/id6759916626",
    },
    {
      name: "Eagle - Swing Analysis",
      entity: "W185 Holdings LLC",
      category: "Sports (AI golf swing analysis)",
      launched: "2026-08-04",
      usRatings: 127,
      monetization: "$6.99 subscription",
      status: "testing",
      notes: "10 builds in its first 2 months; rating average 4.83.",
      confidence: "high",
      source: "https://apps.apple.com/us/app/eagle-swing-analysis/id6789633056",
    },
  ],
  operatingModel: [
    "One template: a single AI capability that turns one input into a verdict (screenshot to reply, birth data to reading, song to chords, swing to fix).",
    "Long personalization onboarding (about 9-16 steps) that builds intent, then a hard paywall with a weekly plan after a short free trial.",
    "Many SKUs per app for continuous price and paywall testing (Superwall).",
    "Distribution is human creators: 250+ active partnerships managed in-house, plus marketplaces such as SideShift (400+ TikToks for Astra in six weeks).",
    "Creator batches are judged on installs; losing formats stop being made and winners are recycled as paid ad creative.",
    "Owned brand accounts are small (Astra's TikTok had 30 videos); little sign of SDK-attributed paid acquisition.",
    "Ship fast: a build every 3-6 days on winners, 'if we aren't shipping bugs to production, we aren't moving fast enough'.",
    "Many shots on goal: 2-3 winners carry the portfolio; the rest are launched and abandoned within weeks.",
    "Disposable per-app infrastructure: free hosted legal pages, per-app support inboxes, separate LLCs (the studio deliberately does not copy this).",
    "Headcount weighted to marketing and creator operations, with a few AI-assisted engineers.",
  ],
  selfReported: [
    { metric: "Users", value: 15_000_000, unit: "count", asOf: "2026-10-17", source: "https://vert.nyc", note: "Homepage; probably stale" },
    { metric: "Annual revenue", value: 2_500_000_000, unit: "usd_cents", asOf: "2026-10-17", source: "https://vert.nyc", note: "'$25M+'" },
    { metric: "Apps", value: 8, unit: "count", asOf: "2026-10-17", source: "https://vert.nyc" },
    { metric: "Outside funding", value: 0, unit: "usd_cents", asOf: "2026-10-17", source: "https://vert.nyc" },
    { metric: "Team size", value: 23, unit: "count", asOf: "2026-10-17", source: "https://vert.nyc" },
    {
      metric: "ARR",
      value: 3_000_000_000,
      unit: "usd_cents",
      asOf: "2025-10",
      source: "https://www.linkedin.com/company/vert-ventures",
      note: "'$30M+ ARR' in a reposted recruiter post",
    },
    {
      metric: "Active creator partnerships",
      value: 250,
      unit: "count",
      asOf: "2026-01-16",
      source: "https://www.getonbrd.com/jobs/influencer-marketing-manager-vert-remote",
    },
    {
      metric: "Users",
      value: 4_000_000,
      unit: "count",
      asOf: "2024-09",
      source: "https://dribbble.com/jobs/265130-UI-UX-Designer-at-App-Studio",
      note: "Same post: $8M annual revenue, 8 FTE",
    },
    {
      metric: "Downloads from a single Astra creator video",
      value: 25_000,
      unit: "count",
      asOf: "2025-10-16",
      source: "https://sideshift.app/casestudies/astra",
    },
  ],
  caveats: [
    "Revenue figures disagree ($25M vs $30M+) and third-party estimates for the top 3 apps sum to only about $11M a year.",
    "Several founder and Plug AI sources are from 2023-2024.",
    "Review sentiment shows billing, cancellation and undisclosed-ad complaints: the failure modes this studio's compliance gates exist to avoid.",
  ],
};

export const COMPARABLES: readonly Comparable[] = [
  {
    name: "Cal AI",
    kind: "app",
    model: "Photo-to-calories verdict app; about 250 creators on monthly retainers, then paid social; 3-day trial and annual plan.",
    lesson: "Creator retainers find product-market fit; industrial paywall testing compounds it; creator growth plateaus and paid social takes over.",
    metrics: [
      { metric: "First-session trial or purchase", value: 0.2, unit: "ratio", asOf: "2025-05-15", source: "https://getlatka.com/interviews/cal-ai-zach-yadegari-2025", note: "20-25%" },
      { metric: "Paywall experiments", value: 123, unit: "count", asOf: "2026-04-15", source: "https://superwall.com/case-studies/cal-ai", note: "Trial-to-paid +31%" },
      { metric: "Trailing-12-month sales at acquisition", value: 4_000_000_000, unit: "usd_cents", asOf: "2026-03-02", source: "https://insider.fitt.co/myfitnesspal-acquires-rival-food-tracker-cal-ai/", note: "Acquired by MyFitnessPal" },
      { metric: "Downloads at acquisition", value: 15_000_000, unit: "count", asOf: "2026-03-02", source: "https://insider.fitt.co/myfitnesspal-acquires-rival-food-tracker-cal-ai/" },
    ],
  },
  {
    name: "Quittr",
    kind: "app",
    model: "Addiction-quitting app; 12-page commitment quiz, hard paywall, creator deals with view guarantees, then Meta ads.",
    lesson: "A long quiz with near-total completion plus a hard paywall works; one breakout creator video can make a month.",
    metrics: [
      { metric: "Quiz completion", value: 0.99, unit: "ratio", asOf: "2025-03-01", source: "https://startupspells.com/p/porn-addiction-app-quittr-250k-mrr-4-months" },
      { metric: "MRR four months after launch", value: 25_000_000, unit: "usd_cents", asOf: "2025-03-01", source: "https://startupspells.com/p/porn-addiction-app-quittr-250k-mrr-4-months" },
      { metric: "Creator CPM", value: 250, unit: "usd_cents_per_1k_views", asOf: "2025-03-01", source: "https://startupspells.com/p/porn-addiction-app-quittr-250k-mrr-4-months", note: "$2-3" },
    ],
  },
  {
    name: "Umax",
    kind: "app",
    model: "AI looks rating; exclusive upfront creator deals at launch.",
    lesson: "Exclusive creator deals can launch a verdict app within weeks; appearance rating is a sensitive domain.",
    metrics: [
      { metric: "MRR about six weeks after launch", value: 50_000_000, unit: "usd_cents", asOf: "2024-01", source: "https://whop.com/blog/looksmaxxing-blake-anderson/" },
      { metric: "Upfront exclusive creator deals", value: 5_000_000, unit: "usd_cents", asOf: "2023-12", source: "https://whop.com/blog/looksmaxxing-blake-anderson/" },
    ],
  },
  {
    name: "Plug AI / RizzGPT",
    kind: "app",
    model: "Screenshot-to-reply dating assistant; two $50 faceless-account promos and long TikTok slideshows; weekly plan.",
    lesson: "Cheap seeding with the right format can validate demand in days; RPM per 1K views must exceed CPM.",
    metrics: [
      { metric: "MRR in the first month", value: 8_000_000, unit: "usd_cents", asOf: "2023-08", source: "https://kickstartsidehustle.com/how-to-make-80k-mrr-within-the-first-month-on-your-app-3-times-demo/" },
      { metric: "Paid per seeding promo", value: 5_000, unit: "usd_cents", asOf: "2023-07", source: "https://scalenuggets.beehiiv.com/p/23yearold-whos-making-11myear-ai-apps" },
    ],
  },
  {
    name: "tbh",
    kind: "app",
    model: "Positive-only anonymous polls for teens; seeded one school at a time, geofenced state rollout.",
    lesson: "Remove the density confound when testing; a working product is obvious; social apps decay after the spike.",
    metrics: [
      { metric: "First school installing on day one", value: 0.4, unit: "ratio", asOf: "2017-09-22", source: "https://techcrunch.com/2017/09/22/tbh-app/" },
      { metric: "Downloads in about nine weeks", value: 5_000_000, unit: "count", asOf: "2017-10-16", source: "https://techcrunch.com/2017/10/16/facebook-acquires-anonymous-teen-compliment-app-tbh-will-let-it-run/" },
    ],
  },
  {
    name: "Gas",
    kind: "app",
    model: "tbh rebuilt for device-sent invites; paid 'God Mode' reveal hints.",
    lesson: "Growth systems must be revalidated stage by stage (about 9 launches); naming and icon move invite rates.",
    metrics: [
      { metric: "Peak daily downloads", value: 300_000, unit: "count", asOf: "2022-10", source: "https://en.wikipedia.org/wiki/Gas_(app)" },
      { metric: "Lifetime sales (Bier)", value: 1_100_000_000, unit: "usd_cents", asOf: "2024-08-25", source: "https://www.lennysnewsletter.com/p/how-to-consistently-go-viral-nikita-bier" },
    ],
  },
  {
    name: "Locket",
    kind: "app",
    model: "Photo widget for close friends (capped at 20); grew from a viral TikTok tutorial.",
    lesson: "A home-screen widget supplies the recurring exposure that habit needs.",
    metrics: [
      { metric: "Downloads", value: 90_000_000, unit: "count", asOf: "2025-10", source: "https://e.vnexpress.net/news/tech/personalities/how-a-gift-for-his-girlfriend-changes-locket-founder-matt-moss-s-life-5106478.html" },
      { metric: "Daily active users", value: 9_000_000, unit: "count", asOf: "2025-10", source: "https://e.vnexpress.net/news/tech/personalities/how-a-gift-for-his-girlfriend-changes-locket-founder-matt-moss-s-life-5106478.html" },
      { metric: "Team size", value: 14, unit: "count", asOf: "2025-10", source: "https://e.vnexpress.net/news/tech/personalities/how-a-gift-for-his-girlfriend-changes-locket-founder-matt-moss-s-life-5106478.html" },
    ],
  },
  {
    name: "Codeway",
    kind: "studio",
    model: "Paid-UA app factory: ads from day zero, 200-500 creatives per account per month, one paywall template, weekly-only pricing.",
    lesson: "Scale comes from creative volume; hits decay fast (Ask AI fell from $3-5M to about $700K a month).",
    metrics: [
      { metric: "ARR", value: 40_000_000_000, unit: "usd_cents", asOf: "2026-04", source: "https://builtin.com/job/director-finance/8619077", note: "'$400M+ ARR'" },
      { metric: "Employees", value: 356, unit: "count", asOf: "2026-04", source: "https://builtin.com/job/director-finance/8619077" },
    ],
  },
  {
    name: "HubX",
    kind: "studio",
    model: "Hub-to-studio AI app factory with 40+ products that also acquires apps.",
    lesson: "The factory model reaches unicorn scale; buying apps sits alongside building them.",
    metrics: [
      { metric: "Pre-money valuation", value: 120_000_000_000, unit: "usd_cents", asOf: "2026-08-31", source: "https://www.newsfilecorp.com/release/312135" },
      { metric: "Downloads", value: 600_000_000, unit: "count", asOf: "2026-08-31", source: "https://www.newsfilecorp.com/release/312135" },
    ],
  },
  {
    name: "Bending Spoons",
    kind: "studio",
    model: "Buys aging apps, cuts costs, raises prices and runs them as a portfolio for cash.",
    lesson: "Decaying hits still have an exit: harvest or sell to a portfolio operator.",
    metrics: [
      { metric: "2025 revenue", value: 131_000_000_000, unit: "usd_cents", asOf: "2026-06-08", source: "https://www.fortune.com/2026/06/08/bending-spoons-italian-aol-evernote-wetransfer-files-us-ipo/" },
      { metric: "2025 operating profit", value: 27_800_000_000, unit: "usd_cents", asOf: "2026-06-08", source: "https://www.fortune.com/2026/06/08/bending-spoons-italian-aol-evernote-wetransfer-files-us-ipo/" },
    ],
  },
];
