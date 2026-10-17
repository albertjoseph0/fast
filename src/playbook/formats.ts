/**
 * Short-form content formats and hook patterns that sold single-player AI apps in
 * 2023-2026 (Plug AI slideshows, SideShift's Astra batches, Cal AI and Quittr creators).
 *
 * Formats are the arms of the creative loop (`${formatId}:${hookId}`) and the menu the
 * content and creator-brief agents choose from. Owned brand accounts never use the
 * creator first-person voice: an account may not pose as a person who does not exist.
 */
import type { ContentDraft, CoreNeed, Platform } from "../core/types.ts";
import type { ContentFormatSummary } from "../agents/schemas.ts";

type Voice = ContentDraft["voice"];

export interface ContentFormat {
  id: string;
  name: string;
  platforms: Platform[];
  structure: string;
  slideRange?: [number, number];
  /** 1-based slide range where the app is revealed. */
  revealAtSlide?: [number, number];
  durationSeconds?: [number, number];
  /** The app (name and result screen) must be on screen by this second. */
  revealWithinSeconds: number;
  voices: Voice[];
  bestFor: CoreNeed[];
  whyItWorks: string;
  example: string;
  /** Usable on disclosed brand accounts. */
  ownedOk: boolean;
  /** Usable in creator briefs. */
  creatorOk: boolean;
}

export const CONTENT_FORMATS: readonly ContentFormat[] = [
  {
    id: "slideshow_story",
    name: "TikTok photo slideshow story",
    platforms: ["tiktok"],
    structure:
      "Story told one caption per slide over still images. Slides 1-2 hook with a relatable problem, the middle builds the story, " +
      "the app's result screen appears as one slide mid-carousel, the story resolves after it. Typically 18-34 slides; the API allows up to 35.",
    slideRange: [10, 35],
    revealAtSlide: [8, 10],
    revealWithinSeconds: 20,
    voices: ["creator_first_person", "brand_third_person"],
    bestFor: ["love", "play", "self_improvement"],
    whyItWorks:
      "Swipes count as engagement and the reveal lands after the viewer is invested, so the app reads as part of the story rather than an ad. " +
      "Plug AI's slideshows showed the app around slides 8-10; one passed 800K views.",
    example: "Slide 1: 'my crush left me on read for 3 days'. Slide 9: the app's suggested reply. Slide 14: 'we're getting coffee friday'.",
    ownedOk: true,
    creatorOk: true,
  },
  {
    id: "carousel_verdict",
    name: "Short carousel verdict",
    platforms: ["instagram", "tiktok", "threads"],
    structure:
      "A 5-10 slide carousel: the question on slide 1, the user's input on slide 2, the app's verdict as a share card on slides 3-5, " +
      "then one reflection slide. Fits Instagram's 10-item carousel limit.",
    slideRange: [5, 10],
    revealAtSlide: [3, 5],
    revealWithinSeconds: 10,
    voices: ["brand_third_person", "creator_first_person"],
    bestFor: ["love", "play", "self_improvement"],
    whyItWorks: "The share card is the content, so the post doubles as the share-loop artifact and stays readable without sound.",
    example: "Slide 1: 'what your rising sign says about your texting style'. Slides 3-5: three sign cards from the app.",
    ownedOk: true,
    creatorOk: true,
  },
  {
    id: "compatibility_check",
    name: "Compatibility check",
    platforms: ["tiktok", "instagram", "youtube"],
    structure:
      "Creator enters two people (signs, names or birthdays) on camera, pauses for suspense, reveals the app's compatibility verdict, " +
      "then reacts or reads the funniest line aloud. Often filmed with the partner or friend in frame.",
    durationSeconds: [15, 45],
    revealWithinSeconds: 8,
    voices: ["creator_first_person"],
    bestFor: ["love"],
    whyItWorks:
      "Two-person stakes plus a binary verdict make viewers want to try their own pair; SideShift's Astra batches kept compatibility videos as a winning format.",
    example: "'Putting me and my boyfriend in the compatibility app... why did it say THAT about our arguments'",
    ownedOk: false,
    creatorOk: true,
  },
  {
    id: "friendship_test",
    name: "Friendship test",
    platforms: ["tiktok", "instagram"],
    structure:
      "Creator tests a friend (or the group chat) with the app, each person's result is shown in turn, and the group reacts. Ends by tagging friends.",
    durationSeconds: [15, 60],
    revealWithinSeconds: 8,
    voices: ["creator_first_person"],
    bestFor: ["love", "play"],
    whyItWorks: "Viewers tag their own friends in the comments, which spreads the video without any invite mechanics in the app.",
    example: "'Testing which of my friends is the most toxic according to AI'",
    ownedOk: false,
    creatorOk: true,
  },
  {
    id: "what_x_says",
    name: "What your X says about you",
    platforms: ["tiktok", "instagram", "youtube"],
    structure:
      "Green-screen or talking head over a list: one category per beat (sign, music taste, handwriting, golf swing), " +
      "each with the app's one-line read. The app screen shows the source of each read.",
    durationSeconds: [20, 60],
    revealWithinSeconds: 6,
    voices: ["creator_first_person", "brand_third_person"],
    bestFor: ["love", "play", "self_improvement"],
    whyItWorks: "Identity content invites 'do mine' comments, and every viewer can find their own category, so it repeats as a series.",
    example: "'What your Venus sign says about how you flirt'",
    ownedOk: true,
    creatorOk: true,
  },
  {
    id: "green_screen_reaction",
    name: "Green-screen reaction to a result",
    platforms: ["tiktok", "instagram"],
    structure:
      "Creator stands in front of a screenshot of their own result (green-screen effect), points at lines and reacts honestly: agree, disagree, called out.",
    durationSeconds: [10, 40],
    revealWithinSeconds: 3,
    voices: ["creator_first_person"],
    bestFor: ["love", "play", "self_improvement"],
    whyItWorks: "The result is on screen from the first frame, which passes the 3-second rule, and genuine reactions read as recommendations, not ads.",
    example: "'I wasn't ready for what this app said about my attachment style'",
    ownedOk: false,
    creatorOk: true,
  },
  {
    id: "pov_hook",
    name: "POV hook",
    platforms: ["tiktok", "instagram", "youtube"],
    structure:
      "On-screen 'POV:' text sets a relatable situation in the first second, a short skit plays it out, and the app resolves it on screen.",
    durationSeconds: [7, 25],
    revealWithinSeconds: 6,
    voices: ["creator_first_person", "brand_third_person"],
    bestFor: ["love", "play", "money", "self_improvement"],
    whyItWorks: "The viewer is cast as the protagonist instantly; short skits loop and rewatch well.",
    example: "'POV: you let AI reply to your situationship for a week'",
    ownedOk: true,
    creatorOk: true,
  },
  {
    id: "tier_list",
    name: "Tier list",
    platforms: ["tiktok", "youtube", "instagram"],
    structure:
      "Creator ranks a set of items from S to F using the app's verdict for each one, arguing with the placements along the way.",
    durationSeconds: [30, 90],
    revealWithinSeconds: 10,
    voices: ["creator_first_person"],
    bestFor: ["play", "love"],
    whyItWorks: "Disagreement drives comments, and every placement is another look at the app's output.",
    example: "'Ranking every zodiac sign as a roommate (the AI was brutal)'",
    ownedOk: false,
    creatorOk: true,
  },
  {
    id: "before_after_verdict",
    name: "Before/after verdict",
    platforms: ["tiktok", "instagram", "youtube"],
    structure:
      "Creator shows a 'before' input (swing, outfit, chord attempt), the app's specific feedback, then an 'after' attempt applying it. " +
      "Shows one person's own experience only, never a promised result.",
    durationSeconds: [15, 45],
    revealWithinSeconds: 6,
    voices: ["creator_first_person"],
    bestFor: ["self_improvement", "play"],
    whyItWorks: "A visible change is the most persuasive demo of a coaching verdict; keeping it to one honest attempt avoids efficacy claims.",
    example: "'Asked AI what was wrong with my golf swing, tried its one fix'",
    ownedOk: false,
    creatorOk: true,
  },
  {
    id: "i_asked_ai",
    name: "I asked AI to...",
    platforms: ["tiktok", "instagram", "youtube", "x"],
    structure:
      "Opens with 'I asked AI to [do something personal]', shows the input going in, then the answer on screen, then a one-line reaction.",
    durationSeconds: [10, 40],
    revealWithinSeconds: 5,
    voices: ["creator_first_person"],
    bestFor: ["love", "play", "money", "self_improvement"],
    whyItWorks: "Curiosity about what AI will say is the hook, and the answer itself is the product demo.",
    example: "'I asked AI to read my birth chart and tell me why I keep dating the same guy'",
    ownedOk: false,
    creatorOk: true,
  },
  {
    id: "dream_meaning_series",
    name: "Dream-meaning series",
    platforms: ["tiktok", "instagram"],
    structure:
      "Numbered series: the creator retells a dream (often a commenter's), runs it through the app, and reads the interpretation. " +
      "Each part ends by asking for the next dream in the comments.",
    durationSeconds: [20, 60],
    revealWithinSeconds: 10,
    voices: ["creator_first_person"],
    bestFor: ["play", "love"],
    whyItWorks: "Comment-driven series create a reason to follow and return; SideShift's 'what my dream meant' series was a kept Astra format.",
    example: "'Part 7: you told me your dream about losing teeth, here's what it means'",
    ownedOk: false,
    creatorOk: true,
  },
  {
    id: "product_demo",
    name: "Tutorial / product demo",
    platforms: ["tiktok", "instagram", "youtube", "x", "threads", "pinterest"],
    structure:
      "Screen recording of the real app: input, loading, result, share card, with captions naming each step. No faces, no actors, no claims.",
    durationSeconds: [10, 30],
    revealWithinSeconds: 2,
    voices: ["product_demo", "brand_third_person"],
    bestFor: ["love", "money", "play", "self_improvement"],
    whyItWorks: "The honest default for owned accounts; Locket's growth started from a viral tutorial. It also becomes Spark or partnership ad creative.",
    example: "'How to turn any song into chords in 5 seconds' over a screen capture",
    ownedOk: true,
    creatorOk: true,
  },
  {
    id: "trial_reel_hook_test",
    name: "Trial-reel hook test",
    platforms: ["instagram"],
    structure:
      "A 5-10 second reel: one hook line on screen over a product shot, one beat of the result, end card with the app name. " +
      "Posted as an Instagram Trial Reel to non-followers to rank hooks before creators film them.",
    durationSeconds: [5, 10],
    revealWithinSeconds: 3,
    voices: ["brand_third_person", "product_demo"],
    bestFor: ["love", "money", "play", "self_improvement"],
    whyItWorks: "Trial Reels reach cold, non-follower audiences, so they measure hook attention cheaply without burning the main feed (the S0 probe).",
    example: "'Your texting style, judged by AI' over a three-second result reveal",
    ownedOk: true,
    creatorOk: false,
  },
  {
    id: "text_thread_broll",
    name: "Text thread over gameplay B-roll",
    platforms: ["tiktok", "youtube", "instagram"],
    structure:
      "A chat conversation appears message by message over satisfying gameplay or B-roll; the app's suggested reply lands at the turning point.",
    durationSeconds: [20, 60],
    revealWithinSeconds: 12,
    voices: ["brand_third_person", "creator_first_person"],
    bestFor: ["love"],
    whyItWorks: "B-roll keeps eyes on screen while the viewer reads; a competing rizz app ran this format to 550M+ views across many accounts.",
    example: "Chat: 'so what are you doing this weekend?' then the app's reply, then 'ok that worked'",
    ownedOk: true,
    creatorOk: true,
  },
  {
    id: "storytime",
    name: "Storytime",
    platforms: ["tiktok", "youtube", "instagram"],
    structure: "Creator talks to camera about a real moment the app was part of, cutting to the result screen at the key line.",
    durationSeconds: [30, 90],
    revealWithinSeconds: 15,
    voices: ["creator_first_person"],
    bestFor: ["love", "self_improvement", "play"],
    whyItWorks: "Long watch time and trust: the creator's real story carries the product, which is why briefs require the app on screen by 15s.",
    example: "'Storytime: the app told me to text him first and I actually did'",
    ownedOk: false,
    creatorOk: true,
  },
];

/** Hook templates. `{placeholders}` are filled per venture; the result is linted as content copy. */
export const HOOK_PATTERNS: readonly { id: string; template: string; bestFor: CoreNeed[] }[] = [
  { id: "asked_ai_read", template: "I asked AI to read my {input} and it called me out", bestFor: ["love", "play", "self_improvement"] },
  { id: "pov_let_ai", template: "POV: you let AI {action} for a week", bestFor: ["love", "play", "money"] },
  { id: "what_x_says", template: "What your {trait} says about {topic}", bestFor: ["love", "play"] },
  { id: "not_ready", template: "I wasn't ready for what it said about my {topic}", bestFor: ["love", "self_improvement"] },
  { id: "testing_friends", template: "Testing which of my friends is the most {trait} according to AI", bestFor: ["play", "love"] },
  { id: "compatibility_pair", template: "Putting me and my {person} into the compatibility check", bestFor: ["love"] },
  { id: "tier_list", template: "Ranking every {category} as a {role} (the AI was brutal)", bestFor: ["play"] },
  { id: "send_to_friend", template: "Send this to the friend who {behavior}", bestFor: ["love", "play"] },
  { id: "can_ai_guess", template: "Can AI guess my {trait} from just my {input}?", bestFor: ["play", "self_improvement"] },
  { id: "why_nobody_told", template: "Why did nobody tell me you could {action}", bestFor: ["money", "play", "self_improvement"] },
  { id: "dream_series", template: "Part {part}: you told me your dream about {dream}, here's what it means", bestFor: ["play", "love"] },
  { id: "one_fix", template: "Asked AI what's wrong with my {skill}, tried its one fix", bestFor: ["self_improvement", "play"] },
  { id: "reply_rescue", template: "They left me on read, so I let AI write the reply", bestFor: ["love"] },
  { id: "signs_as", template: "The signs as {category}, according to AI", bestFor: ["play", "love"] },
  { id: "honest_verdict", template: "I asked for an honest verdict on my {thing} and got one", bestFor: ["self_improvement", "love"] },
  { id: "is_it_just_me", template: "Is it just me or does every {group} {behavior}?", bestFor: ["play", "love"] },
  { id: "before_you", template: "Before you {decision}, check what your {input} says", bestFor: ["love", "money"] },
  { id: "screenshot_to", template: "Turning a screenshot of my {input} into {output} in seconds", bestFor: ["love", "play", "money"] },
];

const BY_ID = new Map(CONTENT_FORMATS.map((f) => [f.id, f]));

export function formatById(id: string): ContentFormat | undefined {
  return BY_ID.get(id);
}

/** The compact format menu passed to the content and creator-brief agents. */
export function formatSummaries(opts: { platform?: Platform; channel?: "owned" | "creator" } = {}): ContentFormatSummary[] {
  return CONTENT_FORMATS.filter((f) => {
    if (opts.platform && !f.platforms.includes(opts.platform)) return false;
    if (opts.channel === "owned" && !f.ownedOk) return false;
    if (opts.channel === "creator" && !f.creatorOk) return false;
    return true;
  }).map((f) => ({ id: f.id, name: f.name, structure: f.structure, platforms: [...f.platforms] }));
}
