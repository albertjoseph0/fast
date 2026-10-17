/**
 * Canonical analytics event names. The app template emits them, PostHog stores them,
 * the simulator produces them and the lab counts them, so they must never drift.
 *
 * Every app event carries `app_slug`, and when the user arrived through a test cell,
 * `experiment_id` and `cell_id` (from the deep link / referrer parameter `c`).
 */
export const EV = {
  view: "view", // content impression (from platform stats, not the app)
  linkClick: "link_click", // tapped through to the store / waitlist from content
  waitlistJoin: "waitlist_join",
  install: "install", // first open
  session: "session",
  internalSession: "internal_session", // team/dev/test devices; excluded from cohorts
  onboardingStart: "onboarding_start",
  onboardingComplete: "onboarding_complete",
  activated: "activated", // reached first value (the verdict moment)
  paywallView: "paywall_view",
  trialStart: "trial_start",
  conversion: "conversion", // first paid period after trial, or direct purchase
  renewal: "renewal",
  refund: "refund",
  share: "share", // exported the share artifact (final send, not attempt)
  inviteSent: "invite_sent",
  inviteInstall: "invite_install",
  d1Retained: "d1_retained",
  d1Eligible: "d1_eligible", // installs at least 24h old
  review: "review",
  oneStarReview: "one_star_review",
} as const;

export type EventName = (typeof EV)[keyof typeof EV];

export const ALL_EVENTS: readonly EventName[] = Object.values(EV);
