/** Builder: spec → Expo project, store assets, legal pages, site and verdict-backend tenant. */
export { BUNDLE_ID, renderApp, type RenderInput } from "./render.ts";
export { APP_ENV, buildStudioJson, buildTenantJson, ventureUrls, versionFor, type StudioJson, type StudioProduct, type TenantJson, type VentureUrls } from "./studio.ts";
export { joinKeywords, METADATA_LIMITS, metadataProblems, storeMetadata } from "./metadata.ts";
export { applePrivacyAnswers, collectedData, dataSafetyCsv, privacyManifest, privacyManifestPlist, SDK_BASELINE, type ApplePrivacyAnswers, type PrivacyManifest } from "./privacy.ts";
export { legalHtmlBody, legalMarkdown, privacyPolicy, subscriptionLines, termsOfUse, type LegalDoc } from "./legal.ts";
export { appleAppSiteAssociation, assetLinks, deepLinkBase, siteFiles, type SiteFile } from "./site.ts";
export { encodeRgbPng, pngInfo, rasterize, SCREENSHOT_SIZE, screenshotSvgs } from "./screenshots.ts";
