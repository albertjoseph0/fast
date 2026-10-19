/**
 * A static catalog of fictional App Store apps for the simulated TrendPort: chart
 * positions per storefront that drift week to week, and keyword search.
 */
import type { AppLookup, ChartApp } from "../core/ports.ts";
import { hashString } from "../core/rng.ts";

const h32 = (text: string) => hashString(text) >>> 0;

interface CatalogApp {
  name: string;
  seller: string;
  genre: string;
  description: string;
  priceCents: number;
  /** Relative popularity; drives chart rank and rating counts. */
  pull: number;
  releaseDate: string;
}

const RAW: [string, string, string, string, number, number, string][] = [
  ["Starlit: Daily Horoscope", "Northlight Labs", "Lifestyle", "zodiac astrology birth chart compatibility daily horoscope", 0, 9, "2024-03-11"],
  ["Moonmatch", "Tidal Apps", "Lifestyle", "astrology compatibility love match signs synastry", 0, 6, "2025-01-20"],
  ["Tarotly", "Arcana Co", "Entertainment", "tarot card reading daily pull fortune", 0, 4, "2024-09-02"],
  ["Rizzwise", "Wingmate Inc", "Social Networking", "dating texts reply suggestions flirt pick up lines", 0, 8, "2024-06-18"],
  ["Opener AI", "Spark Social", "Lifestyle", "dating opener lines profile review bio", 0, 5, "2025-04-07"],
  ["Glowscore", "Mirror Labs", "Photo & Video", "face rating looks score selfie glow up", 0, 7, "2024-11-30"],
  ["Jawline Coach", "Mirror Labs", "Health & Fitness", "looksmax jawline face exercises routine", 0, 3, "2025-02-14"],
  ["Platecount", "Forkful", "Health & Fitness", "calorie counter photo food scan macros diet", 0, 10, "2024-04-22"],
  ["Macro Snap", "Forkful", "Health & Fitness", "snap meal macros nutrition tracker", 0, 5, "2025-05-01"],
  ["Liftlog", "Ironclad", "Health & Fitness", "workout tracker gym lifting program", 0, 6, "2023-10-10"],
  ["Stillwater", "Calm Harbor", "Health & Fitness", "meditation sleep breathing anxiety relief", 0, 9, "2022-08-19"],
  ["Quitstreak", "Fresh Start", "Health & Fitness", "quit habit streak sobriety counter", 0, 4, "2025-03-03"],
  ["Prayerful", "Grace Digital", "Lifestyle", "bible verse daily prayer devotional study", 0, 7, "2024-01-08"],
  ["Versebox", "Grace Digital", "Books", "bible study chat scripture questions", 0, 3, "2025-06-21"],
  ["Pennywise Budget", "Ledgerly", "Finance", "budget tracker spending savings bills", 0, 8, "2023-05-15"],
  ["Flipcheck", "Resell Labs", "Shopping", "resale price check thrift flip value scan", 0, 5, "2025-07-09"],
  ["Thriftscan", "Resell Labs", "Shopping", "thrift find value scanner vintage price", 0, 3, "2025-08-28"],
  ["Coinlens", "Mint Valley", "Finance", "coin value scanner collectible worth", 0, 4, "2024-12-02"],
  ["Sidegig AI", "Hustle Co", "Business", "side hustle ideas money making plan", 0, 3, "2025-09-12"],
  ["Receipt Ninja", "Ledgerly", "Finance", "receipt scanner expense tax deduction", 0, 2, "2024-02-26"],
  ["Plantwise", "Greenleaf", "Education", "plant identifier care watering disease", 0, 7, "2023-09-01"],
  ["Birdsong ID", "Field Notes", "Education", "bird song identifier sound recognition", 0, 5, "2024-05-05"],
  ["Rockhound", "Field Notes", "Education", "rock mineral identifier crystal scan", 0, 3, "2025-04-30"],
  ["Mushroom Lens", "Field Notes", "Education", "mushroom identifier foraging", 0, 2, "2025-10-01"],
  ["Chordify Pro", "Fretboard", "Music", "song to chords guitar tabs learn", 499, 6, "2023-07-17"],
  ["Tuneup", "Fretboard", "Music", "guitar tuner chords practice", 0, 5, "2022-11-11"],
  ["Swingcoach", "Fairway AI", "Sports", "golf swing analysis video coach", 0, 4, "2024-08-08"],
  ["Hoopform", "Courtside", "Sports", "basketball shot form analysis", 0, 2, "2025-05-19"],
  ["Fitcheck", "Closet Club", "Lifestyle", "outfit rating style advice wardrobe", 0, 6, "2024-10-14"],
  ["Hairmatch", "Closet Club", "Lifestyle", "hairstyle try on face shape", 0, 4, "2025-01-27"],
  ["Roomify", "Nest Studio", "Lifestyle", "room redesign interior ai decor photo", 0, 5, "2024-07-01"],
  ["Petmood", "Pawsome", "Lifestyle", "pet translator dog cat mood", 0, 4, "2024-03-30"],
  ["Dogbreed ID", "Pawsome", "Reference", "dog breed identifier photo", 0, 3, "2023-12-12"],
  ["Homework Helper", "Brightside Learning", "Education", "homework solver math photo explain", 0, 9, "2023-08-21"],
  ["Essaybot", "Brightside Learning", "Education", "essay writing helper outline", 0, 5, "2024-09-18"],
  ["Lingo Drops", "Polyglot", "Education", "language learning daily lessons vocabulary", 0, 8, "2022-06-06"],
  ["Ask Anything AI", "Cortex Apps", "Productivity", "ai chat assistant questions answers", 0, 10, "2023-03-03"],
  ["Notewise", "Cortex Apps", "Productivity", "ai notes summarize meetings voice", 0, 6, "2024-04-04"],
  ["Scan Pro PDF", "Docu", "Business", "document scanner pdf ocr", 399, 7, "2021-09-09"],
  ["Dreamlog", "Night Owl", "Lifestyle", "dream journal interpretation meaning", 0, 3, "2025-02-02"],
  ["Namegen Baby", "Little Ones", "Lifestyle", "baby name ideas generator meaning", 0, 3, "2024-06-30"],
  ["Petname Pro", "Little Ones", "Lifestyle", "pet name generator", 199, 1, "2024-11-11"],
  ["Trivia Clash", "Quizbox", "Games", "trivia quiz friends compete", 0, 7, "2023-04-14"],
  ["Wordly Daily", "Quizbox", "Games", "daily word puzzle streak", 0, 8, "2022-02-22"],
  ["Pocket Golf", "Arcadia", "Games", "golf game casual", 299, 4, "2021-05-05"],
  ["Sudoku Calm", "Arcadia", "Games", "sudoku puzzle relaxing", 0, 6, "2020-10-10"],
  ["Polls with Pals", "Circle Social", "Social Networking", "anonymous polls friends compliments school", 0, 6, "2024-09-01"],
  ["Hangtime", "Circle Social", "Social Networking", "friends meetup plans group chat", 0, 2, "2025-03-15"],
  ["Widgetpals", "Circle Social", "Social Networking", "friends photo widget home screen", 0, 7, "2023-01-01"],
  ["Voicey", "Echo Labs", "Photo & Video", "ai voice changer funny voices", 0, 5, "2024-05-25"],
  ["Clipcut AI", "Echo Labs", "Photo & Video", "video editor captions auto cut", 0, 8, "2023-06-12"],
  ["Headshot Studio", "Portrait AI", "Photo & Video", "ai headshots professional photos", 999, 5, "2024-02-10"],
  ["Avatarize", "Portrait AI", "Photo & Video", "ai avatar anime portrait", 0, 6, "2023-11-20"],
  ["Rentcheck", "Homebase", "Lifestyle", "rent price check neighborhood", 0, 2, "2025-07-20"],
  ["Parking Pal", "Citywise", "Navigation", "parking finder meter timer", 0, 3, "2022-09-09"],
  ["Sleepcast", "Calm Harbor", "Health & Fitness", "sleep stories sounds", 0, 6, "2022-01-15"],
  ["Skin Scan", "Derma AI", "Health & Fitness", "skin analysis acne routine", 0, 5, "2024-08-30"],
  ["Mood Mirror", "Calm Harbor", "Health & Fitness", "mood journal check in feelings", 0, 4, "2024-10-05"],
  ["Pro Weather Radar", "Skyline", "Weather", "weather radar storm alerts", 299, 6, "2020-04-04"],
  ["Ticket Fighter", "Civic Tools", "Utilities", "parking ticket appeal letter", 0, 2, "2025-08-01"],
];

const CATALOG: CatalogApp[] = RAW.map(([name, seller, genre, description, priceCents, pull, releaseDate]) => ({ name, seller, genre, description, priceCents, pull, releaseDate }));

function appId(app: CatalogApp): string {
  return String(1_000_000_000 + (h32(`app:${app.name}`) % 900_000_000));
}

function appSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function url(app: CatalogApp, country: string): string {
  return `https://apps.apple.com/${country.toLowerCase()}/app/${appSlug(app.name)}/id${appId(app)}`;
}

/** Popularity in a storefront for an ISO week: the catalog's pull times a per-week drift. */
function score(app: CatalogApp, country: string, week: string): number {
  const drift = (h32(`${app.name}:${country}:${week}`) % 1000) / 1000;
  return app.pull * (0.6 + 0.8 * drift);
}

function isoWeek(date: string): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

export function chart(country: string, kind: "top-free" | "top-paid", limit: number, today: string): ChartApp[] {
  const week = isoWeek(today);
  return CATALOG.filter((a) => (kind === "top-paid" ? a.priceCents > 0 : a.priceCents === 0))
    .map((a) => ({ a, s: score(a, country, week) }))
    .sort((x, y) => y.s - x.s || (x.a.name < y.a.name ? -1 : 1))
    .slice(0, limit)
    .map(({ a }, i) => ({ id: appId(a), name: a.name, artist: a.seller, genre: a.genre, rank: i + 1, url: url(a, country) }));
}

export function search(term: string, country: string, limit: number): AppLookup[] {
  const tokens = term.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
  if (!tokens.length) return [];
  return CATALOG.map((a) => {
    const text = `${a.name} ${a.genre} ${a.description}`.toLowerCase();
    return { a, hits: tokens.filter((t) => text.includes(t)).length };
  })
    .filter((x) => x.hits > 0)
    .sort((x, y) => y.hits - x.hits || y.a.pull - x.a.pull || (x.a.name < y.a.name ? -1 : 1))
    .slice(0, limit)
    .map(({ a }) => {
      const h = h32(`ratings:${a.name}:${country}`);
      return {
        id: appId(a),
        name: a.name,
        seller: a.seller,
        genre: a.genre,
        ratingCount: Math.round(a.pull ** 2.2 * 400 * (0.5 + (h % 1000) / 1000)),
        rating: Math.round((3.9 + ((h >>> 10) % 10) / 10) * 10) / 10,
        priceCents: a.priceCents,
        releaseDate: a.releaseDate,
        description: `${a.name}: ${a.description}.`,
        url: url(a, country),
      };
    });
}
