/** External links shown in the paywall and settings. */
import * as WebBrowser from "expo-web-browser";
import { Linking } from "react-native";
import { studio } from "./spec";

export const openPrivacy = () => WebBrowser.openBrowserAsync(studio.urls.privacy);
export const openTerms = () => WebBrowser.openBrowserAsync(studio.urls.terms);
export const openSupport = () => WebBrowser.openBrowserAsync(studio.urls.support);
export const emailSupport = () => Linking.openURL(`mailto:${studio.company.supportEmail}?subject=${encodeURIComponent(`${studio.appName} support`)}`);

/** The public URL printed on share cards; opens the app where installed (Universal / App Links). */
export function shareUrl(deepLinkPath: string, resultId: string): string {
  const path = deepLinkPath.startsWith("/") ? deepLinkPath : `/${deepLinkPath}`;
  return `https://${studio.deepLinkDomain}${path}?r=${encodeURIComponent(resultId)}`;
}
