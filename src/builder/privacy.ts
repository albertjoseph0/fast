/**
 * Privacy disclosures derived from the spec's data inventory: App Store privacy answers,
 * the Play Data safety sheet and the iOS privacy manifest (Apple 5.1.1, 5.1.2; Play User
 * Data policy). The template's SDKs always collect a baseline (PostHog analytics,
 * RevenueCat purchases), so that baseline is merged in even when the designer omitted it.
 */
import type { AppSpec, DataUse } from "../core/types.ts";

type DataType = DataUse["dataType"];
type Purpose = DataUse["purpose"];
type Recipient = DataUse["sentTo"][number];

/** What the template's SDKs collect regardless of the product. */
export const SDK_BASELINE: readonly DataUse[] = [
  { dataType: "device_id", purpose: "analytics", sentTo: ["posthog"], retentionDays: 365, linkedToUser: false, usedForTracking: false },
  { dataType: "usage", purpose: "analytics", sentTo: ["posthog"], retentionDays: 365, linkedToUser: false, usedForTracking: false },
  { dataType: "purchase", purpose: "core_feature", sentTo: ["revenuecat"], retentionDays: 730, linkedToUser: true, usedForTracking: false },
];

/** Recipient display names used by legal pages and the consent screen. */
export const RECIPIENTS: Record<Recipient, { name: string; role: string; ai: boolean }> = {
  anthropic: { name: "Anthropic, PBC", role: "AI model provider (Claude) that generates your results", ai: true },
  posthog: { name: "PostHog, Inc.", role: "product analytics", ai: false },
  revenuecat: { name: "RevenueCat, Inc.", role: "subscription and purchase management", ai: false },
  studio_backend: { name: "our own servers", role: "relays your request to the AI provider and enforces usage limits", ai: false },
};

/** Plain-language data type labels. */
export const DATA_LABELS: Record<DataType, string> = {
  photo: "Photos you choose to upload",
  screenshot: "Screenshots you choose to upload",
  text: "Text you type into the app",
  birth_data: "Birth date, time and place you enter",
  audio: "Audio files you choose to upload",
  contacts: "Contacts you choose to share",
  device_id: "A random app-install identifier",
  usage: "How you use the app (screens viewed, buttons tapped)",
  purchase: "Purchase and subscription history",
};

export const PURPOSE_LABELS: Record<Purpose, string> = {
  core_feature: "to provide the app's features",
  analytics: "to understand and improve the app",
  attribution: "to learn how people find the app",
};

const APPLE_TYPE: Record<DataType, { category: string; type: string; manifest: string }> = {
  photo: { category: "User Content", type: "Photos or Videos", manifest: "NSPrivacyCollectedDataTypePhotosorVideos" },
  screenshot: { category: "User Content", type: "Photos or Videos", manifest: "NSPrivacyCollectedDataTypePhotosorVideos" },
  text: { category: "User Content", type: "Other User Content", manifest: "NSPrivacyCollectedDataTypeOtherUserContent" },
  birth_data: { category: "User Content", type: "Other User Content", manifest: "NSPrivacyCollectedDataTypeOtherUserContent" },
  audio: { category: "User Content", type: "Audio Data", manifest: "NSPrivacyCollectedDataTypeAudioData" },
  contacts: { category: "Contacts", type: "Contacts", manifest: "NSPrivacyCollectedDataTypeContacts" },
  device_id: { category: "Identifiers", type: "Device ID", manifest: "NSPrivacyCollectedDataTypeDeviceID" },
  usage: { category: "Usage Data", type: "Product Interaction", manifest: "NSPrivacyCollectedDataTypeProductInteraction" },
  purchase: { category: "Purchases", type: "Purchase History", manifest: "NSPrivacyCollectedDataTypePurchaseHistory" },
};

const APPLE_PURPOSE: Record<Purpose, { label: string; manifest: string }> = {
  core_feature: { label: "App Functionality", manifest: "NSPrivacyCollectedDataTypePurposeAppFunctionality" },
  analytics: { label: "Analytics", manifest: "NSPrivacyCollectedDataTypePurposeAnalytics" },
  attribution: { label: "Developer's Advertising or Marketing", manifest: "NSPrivacyCollectedDataTypePurposeDeveloperAdvertising" },
};

const PLAY_TYPE: Record<DataType, { category: string; type: string }> = {
  photo: { category: "Photos and videos", type: "Photos" },
  screenshot: { category: "Photos and videos", type: "Photos" },
  text: { category: "App activity", type: "Other user-generated content" },
  birth_data: { category: "Personal info", type: "Other info" },
  audio: { category: "Audio files", type: "Other audio files" },
  contacts: { category: "Contacts", type: "Contacts" },
  device_id: { category: "Device or other IDs", type: "Device or other IDs" },
  usage: { category: "App activity", type: "App interactions" },
  purchase: { category: "Financial info", type: "Purchase history" },
};

const PLAY_PURPOSE: Record<Purpose, string> = { core_feature: "App functionality", analytics: "Analytics", attribution: "Analytics" };

/**
 * Required-reason APIs used by React Native, Expo modules, AsyncStorage and the SDKs in the
 * template (Apple TN3183). Reasons: app-own defaults, app-container timestamps, elapsed
 * time, free-space checks before writing files.
 */
const ACCESSED_APIS: readonly { type: string; reasons: string[] }[] = [
  { type: "NSPrivacyAccessedAPICategoryUserDefaults", reasons: ["CA92.1"] },
  { type: "NSPrivacyAccessedAPICategoryFileTimestamp", reasons: ["C617.1"] },
  { type: "NSPrivacyAccessedAPICategorySystemBootTime", reasons: ["35F9.1"] },
  { type: "NSPrivacyAccessedAPICategoryDiskSpace", reasons: ["E174.1"] },
];

/** The spec inventory plus the SDK baseline entries it does not already cover. */
export function collectedData(spec: AppSpec): DataUse[] {
  const inventory = spec.compliance.dataInventory;
  const covered = new Set(inventory.map((d) => `${d.dataType}|${d.purpose}`));
  return [...inventory, ...SDK_BASELINE.filter((d) => !covered.has(`${d.dataType}|${d.purpose}`))];
}

/** Every recipient named by the collected data, in a stable order. */
export function recipients(spec: AppSpec): Recipient[] {
  const named = new Set(collectedData(spec).flatMap((d) => d.sentTo));
  return (Object.keys(RECIPIENTS) as Recipient[]).filter((r) => named.has(r));
}

/** Recipients of the AI feature's input, as named on the consent screen (Apple 5.1.2(i)). */
export function aiRecipients(spec: AppSpec): Recipient[] {
  const named = new Set(spec.compliance.dataInventory.filter((d) => d.purpose === "core_feature").flatMap((d) => d.sentTo));
  return (Object.keys(RECIPIENTS) as Recipient[]).filter((r) => named.has(r) && r !== "revenuecat");
}

export interface ApplePrivacyAnswers {
  collectsData: boolean;
  /** Apple's "Data Used to Track You" section; the template never tracks (no ATT, no IDFA). */
  tracking: boolean;
  trackingDomains: string[];
  dataTypes: { category: string; type: string; purposes: string[]; linkedToUser: boolean; usedForTracking: boolean }[];
}

/** App Store Connect App Privacy answers, one row per Apple data type with merged purposes. */
export function applePrivacyAnswers(spec: AppSpec): ApplePrivacyAnswers {
  const rows = new Map<string, ApplePrivacyAnswers["dataTypes"][number]>();
  for (const d of collectedData(spec)) {
    const t = APPLE_TYPE[d.dataType];
    const key = `${t.category}|${t.type}`;
    const row = rows.get(key) ?? { category: t.category, type: t.type, purposes: [], linkedToUser: false, usedForTracking: false };
    const purpose = APPLE_PURPOSE[d.purpose].label;
    if (!row.purposes.includes(purpose)) row.purposes.push(purpose);
    row.linkedToUser ||= d.linkedToUser;
    row.usedForTracking ||= d.usedForTracking;
    rows.set(key, row);
  }
  const dataTypes = [...rows.values()];
  return { collectsData: dataTypes.length > 0, tracking: dataTypes.some((r) => r.usedForTracking), trackingDomains: [], dataTypes };
}

/** Expo `ios.privacyManifests` object; also serialized as PrivacyInfo.xcprivacy. */
export interface PrivacyManifest {
  NSPrivacyTracking: boolean;
  NSPrivacyTrackingDomains: string[];
  NSPrivacyCollectedDataTypes: {
    NSPrivacyCollectedDataType: string;
    NSPrivacyCollectedDataTypeLinked: boolean;
    NSPrivacyCollectedDataTypeTracking: boolean;
    NSPrivacyCollectedDataTypePurposes: string[];
  }[];
  NSPrivacyAccessedAPITypes: { NSPrivacyAccessedAPIType: string; NSPrivacyAccessedAPITypeReasons: string[] }[];
}

export function privacyManifest(spec: AppSpec): PrivacyManifest {
  const rows = new Map<string, PrivacyManifest["NSPrivacyCollectedDataTypes"][number]>();
  for (const d of collectedData(spec)) {
    const type = APPLE_TYPE[d.dataType].manifest;
    const row = rows.get(type) ?? {
      NSPrivacyCollectedDataType: type,
      NSPrivacyCollectedDataTypeLinked: false,
      NSPrivacyCollectedDataTypeTracking: false,
      NSPrivacyCollectedDataTypePurposes: [],
    };
    const purpose = APPLE_PURPOSE[d.purpose].manifest;
    if (!row.NSPrivacyCollectedDataTypePurposes.includes(purpose)) row.NSPrivacyCollectedDataTypePurposes.push(purpose);
    row.NSPrivacyCollectedDataTypeLinked ||= d.linkedToUser;
    row.NSPrivacyCollectedDataTypeTracking ||= d.usedForTracking;
    rows.set(type, row);
  }
  const types = [...rows.values()];
  return {
    NSPrivacyTracking: types.some((t) => t.NSPrivacyCollectedDataTypeTracking),
    NSPrivacyTrackingDomains: [],
    NSPrivacyCollectedDataTypes: types,
    NSPrivacyAccessedAPITypes: ACCESSED_APIS.map((a) => ({ NSPrivacyAccessedAPIType: a.type, NSPrivacyAccessedAPITypeReasons: [...a.reasons] })),
  };
}

function plistValue(value: unknown, indent: string): string {
  if (typeof value === "boolean") return `${indent}<${value}/>`;
  if (typeof value === "number") return `${indent}<integer>${value}</integer>`;
  if (typeof value === "string") return `${indent}<string>${escapeXml(value)}</string>`;
  if (Array.isArray(value)) {
    if (value.length === 0) return `${indent}<array/>`;
    return [`${indent}<array>`, ...value.map((v) => plistValue(v, `${indent}\t`)), `${indent}</array>`].join("\n");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  return [`${indent}<dict>`, ...entries.flatMap(([k, v]) => [`${indent}\t<key>${escapeXml(k)}</key>`, plistValue(v, `${indent}\t`)]), `${indent}</dict>`].join("\n");
}

/** PrivacyInfo.xcprivacy (XML property list). */
export function privacyManifestPlist(manifest: PrivacyManifest): string {
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    plistValue(manifest, ""),
    `</plist>`,
    "",
  ].join("\n");
}

const CSV_HEADER = [
  "data_category",
  "data_type",
  "collected",
  "shared",
  "processed_ephemerally",
  "required",
  "purposes",
  "encrypted_in_transit",
  "users_can_request_deletion",
];

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Play Console Data safety answers, one row per Play data type. Every recipient is a
 * service provider acting for the studio, which Play does not count as sharing.
 */
export function dataSafetyCsv(spec: AppSpec): string {
  const rows = new Map<string, { category: string; type: string; purposes: Set<string>; ephemeral: boolean }>();
  for (const d of collectedData(spec)) {
    const t = PLAY_TYPE[d.dataType];
    const key = `${t.category}|${t.type}`;
    const row = rows.get(key) ?? { category: t.category, type: t.type, purposes: new Set<string>(), ephemeral: true };
    row.purposes.add(PLAY_PURPOSE[d.purpose]);
    row.ephemeral &&= d.retentionDays === 0;
    rows.set(key, row);
  }
  const lines = [...rows.values()].map((r) =>
    [r.category, r.type, "yes", "no", r.ephemeral ? "yes" : "no", "yes", [...r.purposes].join("; "), "yes", "yes"].map(csvCell).join(","),
  );
  return [CSV_HEADER.join(","), ...lines, ""].join("\n");
}

export function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
