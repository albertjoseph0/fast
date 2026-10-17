/**
 * Canonical analytics event names, grouped by where each one originates. The app
 * template, PostHog, RevenueCat's PostHog integration, the simulator and the lab all
 * use these names, so they must never drift (a contract test checks coverage).
 *
 * Attribution: iOS installs carry no referrer, so app-level test cells are storefront
 * territories (the person property `$geoip_country_code` set once at install) or sticky
 * in-app flag variants. App events also carry `app_slug` and, when known, `cell_id`.
 */

/** Emitted by the app. */
export const APP_EVENTS = {
  install: "install", // first open
  session: "session",
  internalSession: "internal_session", // team/dev/test devices; excluded from cohorts
  onboardingStart: "onboarding_start",
  onboardingStep: "onboarding_step",
  onboardingComplete: "onboarding_complete",
  attributionAnswer: "attribution_answer",
  aiConsentGranted: "ai_consent_granted",
  aiConsentDeclined: "ai_consent_declined",
  activated: "activated", // reached the value preview or first verdict (unique per user)
  paywallView: "paywall_view",
  paywallVariantAssigned: "paywall_variant_assigned",
  transactionAbandon: "transaction_abandon",
  trialStart: "trial_start", // unique per user
  share: "share", // final send of the share artifact (can repeat)
  shareFirst: "share_first", // first share per user (the shareRate numerator)
  inviteSent: "invite_sent", // device-sent completion only
  promoPushOptIn: "promo_push_opt_in",
  cancelFlowView: "cancel_flow_view",
} as const;

/** Sent server-side by RevenueCat (via its PostHog integration), keyed to the same person. */
export const SERVER_EVENTS = {
  conversion: "conversion", // first paid period after trial, or direct purchase
  renewal: "renewal",
  trialCancel: "trial_cancel", // auto-renew turned off during the trial
  billingIssue: "billing_issue",
  refund: "refund",
} as const;

/** Computed from cohorts (HogQL in live, directly in the simulator). */
export const DERIVED_EVENTS = {
  trialMatured24h: "trial_matured_24h", // trials at least 24h old
  trialKept24h: "trial_kept_24h", // of those, still auto-renewing at 24h
  trialMatured: "trial_matured", // trials past their trial period
  inviteInstall: "invite_install",
  d1Eligible: "d1_eligible", // installs at least 48h old
  d1Retained: "d1_retained", // session in [24h, 48h) after install
} as const;

/** From platforms, marketplaces, the web host and the stores; no user identity. */
export const EXTERNAL_EVENTS = {
  view: "view", // content impression, in-geo where the platform reports geo
  postHit: "post_hit", // an owned post that reached the attention threshold
  post: "post", // an owned post counted as an S0 unit
  linkClick: "link_click",
  waitlistJoin: "waitlist_join",
  review: "review",
  oneStarReview: "one_star_review",
} as const;

export const EV = { ...APP_EVENTS, ...SERVER_EVENTS, ...DERIVED_EVENTS, ...EXTERNAL_EVENTS } as const;

export type EventName = (typeof EV)[keyof typeof EV];

export const ALL_EVENTS: readonly EventName[] = Object.values(EV);
