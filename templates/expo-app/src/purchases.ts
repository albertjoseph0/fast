/**
 * RevenueCat: one app user per PostHog distinct id, so RevenueCat's PostHog integration
 * books conversions, renewals and refunds onto the same person. Paywall products are
 * resolved from offerings by store product id; price, period and trial are read from the
 * store product, never from the spec.
 */
import { Linking, Platform } from "react-native";
import Purchases, { type CustomerInfo, type PurchasesPackage } from "react-native-purchases";
import Constants from "expo-constants";
import { markInternal } from "./analytics";
import { studio } from "./spec";
import { periodFromIso, termsLine, trialDaysFromIntro } from "./terms";
import type { Period } from "./types";

let configured = false;

export interface PaywallProduct {
  ladderId: string;
  pkg: PurchasesPackage;
  priceString: string;
  period: Period;
  trialDays: number;
  terms: string;
}

function apiKey(): string {
  const keys = (Constants.expoConfig?.extra?.revenueCatKeys ?? {}) as { ios?: string; android?: string };
  return (Platform.OS === "ios" ? keys.ios : keys.android) ?? "";
}

export async function configurePurchases(appUserId: string): Promise<void> {
  const key = apiKey();
  if (!key || configured) return;
  Purchases.configure({ apiKey: key, appUserID: appUserId });
  configured = true;
  await Purchases.setAttributes({ $posthogUserId: appUserId });
  noteSandbox(await Purchases.getCustomerInfo().catch(() => null));
}

function noteSandbox(info: CustomerInfo | null): void {
  if (info && Object.values(info.entitlements.all).some((e) => e.isSandbox)) markInternal();
}

export async function storefront(): Promise<string | null> {
  if (!configured) return null;
  return (await Purchases.getStorefront().catch(() => null))?.countryCode ?? null;
}

export async function isEntitled(): Promise<boolean> {
  if (!configured) return false;
  const info = await Purchases.getCustomerInfo().catch(() => null);
  noteSandbox(info);
  return Boolean(info?.entitlements.active[studio.entitlementId]);
}

/** The paywall's products in spec order; ladder ids without a store product are skipped. */
export async function paywallProducts(ladderIds: string[]): Promise<PaywallProduct[]> {
  if (!configured) return [];
  const offerings = await Purchases.getOfferings();
  const packages = Object.values(offerings.all).flatMap((o) => o.availablePackages);
  return ladderIds.flatMap((ladderId) => {
    const product = studio.products.find((p) => p.ladderId === ladderId);
    if (!product) return [];
    // Android identifiers are "productId:basePlanId".
    const pkg = packages.find((p) => p.product.identifier === product.productId || p.product.identifier.startsWith(`${product.productId}:`));
    if (!pkg) return [];
    const period = periodFromIso(pkg.product.subscriptionPeriod) ?? product.period;
    const trialDays = trialDaysFromIntro(pkg.product.introPrice);
    return [{ ladderId, pkg, priceString: pkg.product.priceString, period, trialDays, terms: termsLine(pkg.product.priceString, period, trialDays) }];
  });
}

export type PurchaseOutcome = "purchased" | "cancelled" | "failed";

export async function purchase(product: PaywallProduct): Promise<PurchaseOutcome> {
  try {
    const { customerInfo } = await Purchases.purchasePackage(product.pkg);
    noteSandbox(customerInfo);
    return customerInfo.entitlements.active[studio.entitlementId] ? "purchased" : "failed";
  } catch (err) {
    return (err as { userCancelled?: boolean | null }).userCancelled ? "cancelled" : "failed";
  }
}

export async function restore(): Promise<boolean> {
  if (!configured) return false;
  const info = await Purchases.restorePurchases();
  return Boolean(info.entitlements.active[studio.entitlementId]);
}

/** Opens the store's subscription management page (online cancellation). */
export async function openManageSubscription(): Promise<void> {
  const info = configured ? await Purchases.getCustomerInfo().catch(() => null) : null;
  const fallback =
    Platform.OS === "ios"
      ? "https://apps.apple.com/account/subscriptions"
      : `https://play.google.com/store/account/subscriptions?package=${encodeURIComponent(studio.androidPackage)}`;
  await Linking.openURL(info?.managementURL ?? fallback);
}
