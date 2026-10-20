/** Restore, manage subscription, AI consent, promotional pushes, data deletion, legal and support. */
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Switch, View } from "react-native";
import { deleteServerData } from "../src/api";
import { distinctId, resetAnalytics, track } from "../src/analytics";
import { APP_EVENTS } from "../src/events";
import { emailSupport, openPrivacy, openSupport, openTerms } from "../src/links";
import { requestPermission, scheduleReminders } from "../src/notifications";
import { linkAnalyticsId, openManageSubscription, restore } from "../src/purchases";
import { appUserId } from "../src/session";
import { studio, useSpec } from "../src/spec";
import { clearPersonalData, getJson, KEYS, setJson } from "../src/storage";
import { Body, Button, Card, Screen, Title } from "../src/ui";

export default function Settings() {
  const spec = useSpec();
  const [consent, setConsent] = useState(false);
  const [promo, setPromo] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void getJson<boolean | null>(KEYS.aiConsent, null).then((v) => setConsent(v === true));
    void getJson<boolean>(KEYS.promoOptIn, false).then(setPromo);
  }, []);

  async function changeConsent(granted: boolean) {
    setConsent(granted);
    await setJson(KEYS.aiConsent, granted);
    track(granted ? APP_EVENTS.aiConsentGranted : APP_EVENTS.aiConsentDeclined, { source: "settings" });
  }

  async function changePromo(enabled: boolean) {
    if (enabled && !(await requestPermission())) return;
    setPromo(enabled);
    await setJson(KEYS.promoOptIn, enabled);
    if (enabled) track(APP_EVENTS.promoPushOptIn, { source: "settings" });
    await scheduleReminders().catch(() => 0);
  }

  async function onRestore() {
    setBusy(true);
    const ok = await restore().catch(() => false);
    setBusy(false);
    Alert.alert(ok ? "Restored" : "Nothing to restore", ok ? "Your subscription is active." : "No active subscription was found for this store account.");
  }

  function onManage() {
    track(APP_EVENTS.cancelFlowView, {});
    void openManageSubscription();
  }

  function onDelete() {
    Alert.alert("Delete my data", "This deletes your answers and results from this device and our servers. Your subscription is managed by the store and is not cancelled.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          void (async () => {
            await deleteServerData(appUserId()).catch(() => undefined);
            await clearPersonalData();
            resetAnalytics();
            // The purchase identity is kept (the subscription stays); only its PostHog link moves.
            await linkAnalyticsId(distinctId());
            router.replace("/");
          })();
        },
      },
    ]);
  }

  return (
    <Screen>
      <Title>Settings</Title>
      <Card>
        <Button label="Restore purchases" kind="secondary" onPress={() => void onRestore()} busy={busy} />
        <Button label="Manage subscription" kind="secondary" onPress={onManage} />
      </Card>
      <Card>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <Switch value={consent} onValueChange={(v) => void changeConsent(v)} />
          <View style={{ flex: 1 }}>
            <Body>Allow AI processing</Body>
            <Body small muted>
              Sends what you enter to {studio.aiProviders.map((p) => p.name).join(" and ")} to create your result.
            </Body>
          </View>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <Switch value={promo} onValueChange={(v) => void changePromo(v)} />
          <View style={{ flex: 1 }}>
            <Body>Tips and offers notifications</Body>
          </View>
        </View>
      </Card>
      <Card>
        <Button label="Privacy policy" kind="secondary" onPress={() => void openPrivacy()} />
        <Button label="Terms of use" kind="secondary" onPress={() => void openTerms()} />
        <Button label="Help" kind="secondary" onPress={() => void openSupport()} />
        <Button label={`Email ${studio.company.supportEmail}`} kind="secondary" onPress={() => void emailSupport()} />
      </Card>
      <Button label="Delete my data" kind="secondary" onPress={onDelete} />
      <Body small muted>
        {spec.appName} {studio.version} · {studio.company.legalName}
      </Body>
    </Screen>
  );
}
