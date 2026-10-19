/**
 * Expo config driven by spec.json (the product) and studio.json (identity, URLs, keys).
 * Public client keys are read at build time from the EAS environment variables whose
 * names studio.json lists; secrets never live in this project.
 */
import type { ConfigContext, ExpoConfig } from "expo/config";
import specJson from "./spec.json";
import studioJson from "./studio.json";
import type { AppSpec, StudioJson } from "./src/types";

const spec = specJson as unknown as AppSpec;
const studio = studioJson as unknown as StudioJson;

const env = (name: string): string => process.env[name] ?? "";
const usesPhotos = spec.core.inputKind === "photo" || spec.core.inputKind === "screenshot";

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: spec.appName,
  slug: studio.slug,
  scheme: studio.slug,
  version: studio.version,
  platforms: ["ios", "android"],
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "automatic",
  backgroundColor: spec.brand.backgroundColor,
  ios: {
    bundleIdentifier: studio.bundleId,
    buildNumber: String(studio.buildNumber),
    supportsTablet: false,
    config: { usesNonExemptEncryption: false },
    associatedDomains: [`applinks:${studio.deepLinkDomain}`],
    privacyManifests: studio.privacyManifest,
  },
  android: {
    package: studio.androidPackage,
    versionCode: studio.buildNumber,
    adaptiveIcon: { foregroundImage: "./assets/icon.png", backgroundColor: spec.brand.backgroundColor },
    // No AD_ID permission: the app never reads the advertising id.
    blockedPermissions: ["com.google.android.gms.permission.AD_ID"],
    intentFilters: [
      {
        action: "VIEW",
        autoVerify: true,
        data: [{ scheme: "https", host: studio.deepLinkDomain, pathPrefix: spec.share.deepLinkPath }],
        category: ["BROWSABLE", "DEFAULT"],
      },
    ],
  },
  plugins: [
    "expo-router",
    ["expo-notifications", { color: spec.brand.primaryColor }],
    ...(usesPhotos
      ? [["expo-image-picker", { photosPermission: `${spec.appName} uses the photo you pick to create your result.`, cameraPermission: false, microphonePermission: false }] as [string, Record<string, unknown>]]
      : []),
  ],
  experiments: { typedRoutes: false },
  runtimeVersion: { policy: "fingerprint" },
  ...(studio.easProjectId ? { updates: { url: `https://u.expo.dev/${studio.easProjectId}` } } : {}),
  extra: {
    ...(studio.easProjectId ? { eas: { projectId: studio.easProjectId } } : {}),
    backendUrl: studio.backendUrl,
    posthogApiKeyEnv: studio.env.posthogApiKey,
    revenueCatKeyEnv: { ios: studio.env.revenueCatIosKey, android: studio.env.revenueCatAndroidKey },
    posthogApiKey: env(studio.env.posthogApiKey),
    posthogHost: env(studio.env.posthogHost) || "https://us.i.posthog.com",
    revenueCatKeys: { ios: env(studio.env.revenueCatIosKey), android: env(studio.env.revenueCatAndroidKey) },
  },
});
