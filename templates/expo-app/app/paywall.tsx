/**
 * Multi-page paywall over price-ladder products resolved from RevenueCat offerings.
 * The auto-renewal terms (price per period, trial length, renews until cancelled, how to
 * cancel) sit directly above the purchase button and are built from the store product at
 * runtime (Apple 3.1.2, ROSCA, Cal. Bus. & Prof. Code 17602). Restore, Manage
 * subscription, Terms and Privacy are always visible.
 */
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, Text, View } from "react-native";
import { track } from "../src/analytics";
import { APP_EVENTS } from "../src/events";
import { openPrivacy, openTerms } from "../src/links";
import { openManageSubscription, paywallProducts, purchase, restore, type PaywallProduct } from "../src/purchases";
import { useSpec } from "../src/spec";
import { KEYS, once } from "../src/storage";
import { Body, Button, Card, LinkText, Screen, styles, Title, useTheme } from "../src/ui";

const PERIOD_LABEL = { week: "Weekly", month: "Monthly", year: "Yearly" } as const;

export default function Paywall() {
  const spec = useSpec();
  const t = useTheme();
  const { placement } = useLocalSearchParams<{ placement?: string }>();
  const p = spec.paywall;
  const pages = Math.min(4, Math.max(1, p.pages));
  const [page, setPage] = useState(0);
  const [products, setProducts] = useState<PaywallProduct[] | null>(null);
  const [selected, setSelected] = useState<string>(p.highlightedProductId);
  const [busy, setBusy] = useState(false);
  const [canClose, setCanClose] = useState(p.showCloseAfterSeconds === 0);

  const load = useCallback(() => {
    setProducts(null);
    paywallProducts(p.productIds)
      .then(setProducts)
      .catch(() => setProducts([]));
  }, [p.productIds]);

  useEffect(() => {
    track(APP_EVENTS.paywallView, { placement: placement ?? p.placement, style: p.style, pages, products: p.productIds.join(",") });
    load();
    if (p.showCloseAfterSeconds !== null && p.showCloseAfterSeconds > 0) {
      const timer = setTimeout(() => setCanClose(true), p.showCloseAfterSeconds * 1000);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [load, p.placement, p.style, p.productIds, p.showCloseAfterSeconds, pages, placement]);

  const chosen = products?.find((x) => x.ladderId === selected) ?? products?.[0];
  const lastPage = page === pages - 1;
  const introPages = Math.max(1, pages - 1);
  const perPage = Math.ceil(p.bullets.length / introPages);
  const bullets = pages === 1 || lastPage ? p.bullets : p.bullets.slice(page * perPage, (page + 1) * perPage);

  async function buy() {
    if (!chosen) return;
    setBusy(true);
    const outcome = await purchase(chosen);
    setBusy(false);
    if (outcome === "purchased") {
      if (chosen.trialDays > 0 && (await once(KEYS.trialStarted))) track(APP_EVENTS.trialStart, { product: chosen.ladderId, trial_days: chosen.trialDays });
      router.replace("/home");
    } else if (outcome === "cancelled") {
      track(APP_EVENTS.transactionAbandon, { product: chosen.ladderId });
    } else {
      Alert.alert("Purchase not completed", "The purchase could not be completed. You have not been charged.");
    }
  }

  async function onRestore() {
    setBusy(true);
    const ok = await restore().catch(() => false);
    setBusy(false);
    if (ok) router.replace("/home");
    else Alert.alert("Nothing to restore", "No active subscription was found for this store account.");
  }

  const close = () => (router.canGoBack() ? router.back() : router.replace("/home"));

  const footer = lastPage ? (
    <>
      {chosen ? (
        <Text accessibilityRole="text" style={[styles.small, { color: t.text, textAlign: "center" }]}>
          {chosen.terms}
        </Text>
      ) : null}
      <Button label={chosen && chosen.trialDays > 0 ? "Start free trial" : "Subscribe"} onPress={() => void buy()} disabled={!chosen} busy={busy} />
      <View style={styles.row}>
        <LinkText label="Restore purchases" onPress={() => void onRestore()} />
        <LinkText label="Manage subscription" onPress={() => void openManageSubscription()} />
        <LinkText label="Terms" onPress={() => void openTerms()} />
        <LinkText label="Privacy" onPress={() => void openPrivacy()} />
      </View>
    </>
  ) : (
    <Button label="Continue" onPress={() => setPage(page + 1)} />
  );

  return (
    <Screen footer={footer}>
      <View style={{ flexDirection: "row", justifyContent: "flex-end", minHeight: 32 }}>
        {canClose ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={close} hitSlop={16}>
            <Text style={{ color: t.text, fontSize: 22, opacity: 0.6 }}>✕</Text>
          </Pressable>
        ) : null}
      </View>
      <Title>{p.headline}</Title>
      {bullets.map((b) => (
        <Body key={b}>✓ {b}</Body>
      ))}
      {lastPage ? (
        products === null ? (
          <Body muted>Loading plans…</Body>
        ) : products.length === 0 ? (
          <Card>
            <Body>Plans are unavailable right now.</Body>
            <Button label="Try again" kind="secondary" onPress={load} />
          </Card>
        ) : (
          products.map((x) => (
            <Pressable key={x.ladderId} accessibilityRole="radio" accessibilityState={{ selected: x.ladderId === chosen?.ladderId }} onPress={() => setSelected(x.ladderId)}>
              <Card style={{ borderWidth: 2, borderColor: x.ladderId === chosen?.ladderId ? t.accent : "transparent" }}>
                <Body>
                  {PERIOD_LABEL[x.period]}: {x.priceString}/{x.period}
                </Body>
                {x.trialDays > 0 ? <Body small>{x.trialDays}-day free trial</Body> : null}
              </Card>
            </Pressable>
          ))
        )
      ) : null}
    </Screen>
  );
}
