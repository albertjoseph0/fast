/**
 * Deterministic sensitivity backstop. The ideator labels its own idea and an independent
 * LLM classifier labels it again; these keyword lists catch what both miss. The effective
 * domain set is the union, so a label can only be added, never removed, by later steps.
 */
import type { AppSpec, Idea, SensitiveDomain } from "../core/types.ts";

const KEYWORDS: Record<SensitiveDomain, RegExp> = {
  astrology_fortune:
    /\b(astrolog\w*|horoscopes?|zodiac|birth chart|natal chart|star signs?|sun signs?|moon signs?|rising signs?|tarot|fortune[- ]?tell\w*|psychics?|numerolog\w*|palm[- ]?reading|palmistry|synastry)\b/i,
  dating_safety:
    /\b(online dating|speed dating|dating (apps?|profiles?|life|advice|coach\w*|scene|matches|messages|texts?|prospects?)|(back to|returning to|start(ing)?|out) dating|dating (again|after)|tinder|hinge|bumble|hook-?ups?|catfish\w*|first dates?|pick-?up lines?|rizz|flirt\w*|matches on|your match|crush(es)?)\b/i,
  health:
    /\b((?<!mental )health(care|y)?|calories?|calorie counting|diet(s|ing)?|nutrition\w*|macros|weight[- ]loss|lose weight|medical|symptoms?|doctors?|diseases?|medications?|pregnan\w*|fertility|period track\w*|glucose|blood pressure|bmi)\b/i,
  mental_health:
    /\b(mental health|anxiety|anxious|depress\w*|therap(y|ist|ists)|suicid\w*|self[- ]harm|adhd|ptsd|trauma|panic attacks?|eating disorders?|addiction|addicted|sobriety|sober|relapse|bipolar|ocd)\b/i,
  appearance_rating:
    /\b(looksmax\w*|attractiveness|hot[- ]or[- ]not|face (score|rating)|rate (my|your) (face|looks|selfie|outfit|body)|beauty score|jawline|facial symmetry|how (hot|attractive|ugly))\b/i,
  ai_companion:
    /\b(ai (girl|boy)friends?|(ai|virtual|digital) companions?|companion (chat|bot)s?|chatbot friends?|virtual (partners?|girlfriends?|boyfriends?|friends?)|ai friends?|role-?play\w*|character chat)\b/i,
  finance:
    /\b(invest\w*|stocks?|crypto\w*|bitcoin|forex|day[- ]?trad\w*|options trading|credit scores?|loans?|debts?|budget(ing| apps?| trackers?| planners?)|personal finance|money management|tax (returns?|filing)|retirement|financial advice)\b/i,
  minors:
    /\b(teens?|teenagers?|tweens?|kids?|children|child|minors?|middle[- ]school\w*|high[- ]school\w*|junior high|underage|under 1[38])\b/i,
  religion:
    /\b(bible|biblical|scriptures?|prayers?|pray(ing)?|church(es)?|faith|christian\w*|catholic\w*|muslims?|islam\w*|quran|koran|jewish|judaism|torah|hindu\w*|buddhis\w*|devotionals?|sermons?|god(?! mode)|jesus|allah)\b/i,
  gambling:
    /\b(gambl\w*|bet(s|ting)?|sportsbooks?|casinos?|poker|slot machines?|parlays?|lotter(y|ies)|wagers?|blackjack|roulette|sports picks)\b/i,
  biometric:
    /\b(biometric\w*|face scans?|facial (recognition|analysis|geometry|landmarks)|face id|fingerprints?|voice ?prints?|iris scans?|body scans?)\b/i,
  legal:
    /\b(lawyers?|attorneys?|legal (advice|help|documents?)|lawsuits?|sue|suing|contract review|immigration|visas?|divorce|custody|court (cases?|dates?|hearings?)|small claims|tenant rights|ticket appeals?)\b/i,
};

const DOMAINS = Object.keys(KEYWORDS) as SensitiveDomain[];

/** Domains whose keyword list matches the text, sorted. */
export function keywordDomains(text: string): SensitiveDomain[] {
  return DOMAINS.filter((d) => KEYWORDS[d].test(text)).sort();
}

/** Every free-text field of an idea, joined, for keyword classification. */
export function ideaText(idea: Idea): string {
  return [
    idea.title,
    idea.oneLiner,
    idea.wedge.name,
    idea.wedge.description,
    idea.wedge.creatorNiche,
    idea.verdictMoment,
    idea.aiCapability,
    ...idea.valueConditions,
    idea.shareArtifact,
    ...idea.hookExamples,
    idea.monetization.payFor,
    idea.differentiation,
  ].join("\n");
}

/** Sorted union of the ideator's labels, the classifier's labels and the keyword backstop. */
export function effectiveDomains(idea: Idea, classifier: SensitiveDomain[]): SensitiveDomain[] {
  return [...new Set([...idea.sensitiveDomains, ...classifier, ...keywordDomains(ideaText(idea))])].sort();
}

/** A photo input judged on how the person looks (face, body, outfit, style). */
const JUDGES_APPEARANCE =
  /\b(face|faces|facial|body|bodies|looks?|appearance|attractive\w*|beauty|outfits?|style|selfies?|skin|hair\w*|physique|jawline|smile)\b/i;

/** The spec's product text the AI and the user see: prompt, sections, input label and copy. */
export function specText(spec: AppSpec): string {
  return [
    spec.appName,
    spec.subtitle,
    spec.core.inputLabel,
    spec.core.aiSystemPrompt,
    ...spec.core.outputSections,
    ...spec.core.loadingMessages,
    ...spec.onboarding.flatMap((s) => [s.title, s.subtitle ?? "", ...s.options]),
    spec.paywall.headline,
    ...spec.paywall.bullets,
    spec.share.artifact,
    spec.share.cardHeadline,
    spec.share.caption,
    spec.aso.description,
    spec.aso.promotionalText,
    ...spec.aso.keywords,
    ...spec.aso.screenshotCaptions,
  ].join("\n");
}

/**
 * Domains for a spec version: the idea's effective domains plus keyword matches over the
 * spec's own text, biometric for a photo of a person judged on appearance, and minors
 * whenever the wedge admits users under 18. Re-run on every spec version.
 */
export function specDomains(spec: AppSpec, idea: Idea, classifier: SensitiveDomain[]): SensitiveDomain[] {
  const domains = new Set([...effectiveDomains(idea, classifier), ...keywordDomains(specText(spec))]);
  if (spec.core.inputKind === "photo" && (domains.has("appearance_rating") || JUDGES_APPEARANCE.test(spec.core.aiSystemPrompt))) domains.add("biometric");
  if (idea.wedge.minAge < 18) domains.add("minors");
  return [...domains].sort();
}

/** Domains that make an app adults-only regardless of the wedge (Apple 1.1.4, 5.3; state chatbot laws). */
const ADULT_ONLY: readonly SensitiveDomain[] = ["dating_safety", "appearance_rating", "ai_companion", "gambling", "finance"];

/** Store age rating: 18 for adult-only domains, else the wedge's youngest age rounded up to 13/16/18. */
export function minimumAgeFor(idea: Idea, domains: SensitiveDomain[]): 13 | 16 | 18 {
  if (domains.some((d) => ADULT_ONLY.includes(d))) return 18;
  const minAge = idea.wedge.minAge;
  if (minAge <= 13) return 13;
  if (minAge <= 16) return 16;
  return 18;
}
