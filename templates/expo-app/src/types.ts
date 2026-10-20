/**
 * The subset of the studio's contracts the app reads: AppSpec (src/core/types.ts) and
 * studio.json (src/builder/studio.ts). The template cannot import from the studio, so
 * these mirror it; the builder's tests keep them in step.
 */
import type { Period } from "./terms";

export type { Period };

export type OnboardingStepKind =
  | "welcome"
  | "goal_picker"
  | "single_choice"
  | "multi_choice"
  | "text_input"
  | "date_input"
  | "time_input"
  | "place_input"
  | "slider"
  | "benefit"
  | "value_preview"
  | "ai_data_consent"
  | "attribution_survey"
  | "notification_preprompt"
  | "loading_personalization"
  | "result_teaser";

export interface OnboardingStep {
  id: string;
  kind: OnboardingStepKind;
  title: string;
  subtitle: string | null;
  options: string[];
  storeAs: string | null;
}

export interface PaywallConfig {
  placement: "after_onboarding" | "after_first_value" | "on_limit";
  style: "hard" | "soft";
  pages: number;
  headline: string;
  bullets: string[];
  productIds: string[];
  highlightedProductId: string;
  showCloseAfterSeconds: number | null;
}

export type InputKind = "photo" | "screenshot" | "text" | "date_time_place" | "audio_file" | "choices" | "none";

export interface DataUse {
  dataType: "photo" | "screenshot" | "text" | "birth_data" | "audio" | "contacts" | "device_id" | "usage" | "purchase";
  purpose: "core_feature" | "analytics" | "attribution";
  sentTo: ("anthropic" | "posthog" | "revenuecat" | "studio_backend")[];
  retentionDays: number;
  linkedToUser: boolean;
  usedForTracking: boolean;
}

export interface AppSpec {
  appName: string;
  subtitle: string;
  slug: string;
  locale: string;
  brand: { primaryColor: string; accentColor: string; backgroundColor: string; textColor: string };
  onboarding: OnboardingStep[];
  core: {
    inputKind: InputKind;
    inputLabel: string;
    outputSections: string[];
    loadingMessages: string[];
    freeUsesBeforePaywall: number;
  };
  paywall: PaywallConfig;
  share: { artifact: string; cardHeadline: string; caption: string; deepLinkPath: string; watermark: string };
  invite: { method: "system_share_sheet" | "contact_access_picker"; prefilledMessage: string } | null;
  retention: {
    pushSchedule: { dayOffset: number; hourLocal: number; kind: "transactional" | "promotional"; copy: string }[];
    dailyHook: string;
  };
  compliance: { aiDisclosure: string; dataInventory: DataUse[]; minimumAge: "13" | "16" | "18" };
}

export interface StudioProduct {
  ladderId: string;
  productId: string;
  period: Period;
  trialDays: number;
  terms: string;
}

export interface StudioJson {
  appName: string;
  slug: string;
  version: string;
  buildNumber: number;
  company: { legalName: string; supportEmail: string };
  bundleId: string;
  androidPackage: string;
  appleTeamId: string;
  deepLinkDomain: string;
  backendUrl: string;
  urls: { site: string; privacy: string; terms: string; support: string; appStore: string | null; play: string | null };
  easProjectId: string | null;
  env: { posthogApiKey: string; posthogHost: string; revenueCatIosKey: string; revenueCatAndroidKey: string };
  entitlementId: string;
  products: StudioProduct[];
  /** Youngest allowed user (spec.compliance.minimumAge); 18 turns on the in-app age gate. */
  minimumAge: 13 | 16 | 18;
  /** The lab experiment this build ships for, set once as the experiment_id person property. */
  experimentId?: string | null;
  aiProviders: { id: string; name: string; role: string }[];
  privacyManifest: {
    NSPrivacyTracking: boolean;
    NSPrivacyTrackingDomains: string[];
    NSPrivacyCollectedDataTypes: {
      NSPrivacyCollectedDataType: string;
      NSPrivacyCollectedDataTypeLinked: boolean;
      NSPrivacyCollectedDataTypeTracking: boolean;
      NSPrivacyCollectedDataTypePurposes: string[];
    }[];
    NSPrivacyAccessedAPITypes: { NSPrivacyAccessedAPIType: string; NSPrivacyAccessedAPITypeReasons: string[] }[];
  };
  testGeos: string[];
}

export interface VerdictSection {
  title: string;
  body: string;
}
