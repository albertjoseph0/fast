/**
 * Copy of the studio's canonical event names (src/core/events.ts). The template cannot
 * import from the studio; the builder's tests fail if this copy drifts.
 */
export const APP_EVENTS = {
  install: "install",
  session: "session",
  internalSession: "internal_session",
  onboardingStart: "onboarding_start",
  onboardingStep: "onboarding_step",
  onboardingComplete: "onboarding_complete",
  attributionAnswer: "attribution_answer",
  aiConsentGranted: "ai_consent_granted",
  aiConsentDeclined: "ai_consent_declined",
  activated: "activated",
  paywallView: "paywall_view",
  paywallVariantAssigned: "paywall_variant_assigned",
  transactionAbandon: "transaction_abandon",
  trialStart: "trial_start",
  share: "share",
  shareFirst: "share_first",
  inviteSent: "invite_sent",
  promoPushOptIn: "promo_push_opt_in",
  cancelFlowView: "cancel_flow_view",
} as const;

export const SERVER_EVENTS = {
  conversion: "conversion",
  renewal: "renewal",
  trialCancel: "trial_cancel",
  billingIssue: "billing_issue",
  refund: "refund",
} as const;

export const DERIVED_EVENTS = {
  trialMatured24h: "trial_matured_24h",
  trialKept24h: "trial_kept_24h",
  trialMatured: "trial_matured",
  inviteInstall: "invite_install",
  d1Eligible: "d1_eligible",
  d1Retained: "d1_retained",
} as const;

export const EXTERNAL_EVENTS = {
  view: "view",
  postHit: "post_hit",
  post: "post",
  linkClick: "link_click",
  waitlistJoin: "waitlist_join",
  review: "review",
  oneStarReview: "one_star_review",
} as const;

export const EV = { ...APP_EVENTS, ...SERVER_EVENTS, ...DERIVED_EVENTS, ...EXTERNAL_EVENTS } as const;

/** Events this app may emit. */
export type AppEventName = (typeof APP_EVENTS)[keyof typeof APP_EVENTS];
