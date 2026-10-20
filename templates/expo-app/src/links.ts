/** External links shown in the paywall and settings, and the share and invite links. */
import * as WebBrowser from "expo-web-browser";
import { Linking } from "react-native";
import { withParams } from "./growth";
import { studio } from "./spec";

export const openPrivacy = () => WebBrowser.openBrowserAsync(studio.urls.privacy);
export const openTerms = () => WebBrowser.openBrowserAsync(studio.urls.terms);
export const openSupport = () => WebBrowser.openBrowserAsync(studio.urls.support);
export const emailSupport = () => Linking.openURL(`mailto:${studio.company.supportEmail}?subject=${encodeURIComponent(`${studio.appName} support`)}`);

function appLink(deepLinkPath: string): string {
  const path = deepLinkPath.startsWith("/") ? deepLinkPath : `/${deepLinkPath}`;
  return `https://${studio.deepLinkDomain}${path}`;
}

/**
 * The public URL printed on share cards; opens the app where installed (Universal / App
 * Links). `i` names the sharer so an install from it counts as theirs (invite_install).
 */
export function shareUrl(deepLinkPath: string, resultId: string, sharerId: string | null): string {
  return withParams(appLink(deepLinkPath), { r: resultId, i: sharerId, ch: sharerId ? "share_loop" : null });
}

/** The link in a one-to-one invite (spec.invite). */
export function inviteUrl(deepLinkPath: string, inviterId: string | null): string {
  return withParams(appLink(deepLinkPath), { i: inviterId, ch: inviterId ? "invite_loop" : null });
}
