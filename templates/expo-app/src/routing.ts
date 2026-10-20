/** Start-up routing, import-free so the studio's tests can load it. */

/** The stored age answer: only whether the user said they meet the app's minimum age. */
export type AgeAnswer = "adult" | "under_age" | null;

export type StartRoute = "/age" | "/onboarding" | "/paywall" | "/home";

/** Apps for adults only ask for age confirmation before onboarding. */
export function needsAgeGate(minimumAge: number): boolean {
  return minimumAge >= 18;
}

export function startRoute(s: { minimumAge: number; ageAnswer: AgeAnswer; onboardingDone: boolean; hardPaywallFirst: boolean; entitled: boolean }): StartRoute {
  if (needsAgeGate(s.minimumAge) && s.ageAnswer !== "adult") return "/age";
  if (!s.onboardingDone) return "/onboarding";
  if (s.hardPaywallFirst && !s.entitled) return "/paywall";
  return "/home";
}

/** Subscribers (for example after Delete my data) skip the paywall at the end of onboarding. */
export function afterOnboardingRoute(placement: string, entitled: boolean): "/paywall" | "/home" {
  return placement === "after_onboarding" && !entitled ? "/paywall" : "/home";
}
