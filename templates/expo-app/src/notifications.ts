/**
 * Local push schedule from spec.retention.pushSchedule. Transactional reminders need OS
 * permission only; promotional ones also need the explicit in-app opt-in (Apple 4.5.4).
 * Permission is requested only after the user taps Yes on the pre-prompt.
 */
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { getSpec } from "./spec";
import { getJson, KEYS, setJson } from "./storage";

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
});

export async function requestPermission(): Promise<boolean> {
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", { name: "Reminders", importance: Notifications.AndroidImportance.DEFAULT });
  }
  const current = await Notifications.getPermissionsAsync();
  const granted = current.granted || (await Notifications.requestPermissionsAsync()).granted;
  await setJson(KEYS.notificationsEnabled, granted);
  return granted;
}

/** Replace every scheduled reminder with the future entries of the schedule. */
export async function scheduleReminders(): Promise<number> {
  await Notifications.cancelAllScheduledNotificationsAsync();
  const enabled = await getJson<boolean>(KEYS.notificationsEnabled, false);
  if (!enabled || !(await Notifications.getPermissionsAsync()).granted) return 0;
  const promo = await getJson<boolean>(KEYS.promoOptIn, false);
  const installedAt = new Date(await getJson<string>(KEYS.installedAt, new Date().toISOString()));
  const spec = getSpec();
  let count = 0;
  for (const entry of spec.retention.pushSchedule) {
    if (entry.kind === "promotional" && !promo) continue;
    const when = new Date(installedAt);
    when.setDate(when.getDate() + entry.dayOffset);
    when.setHours(entry.hourLocal, 0, 0, 0);
    if (when.getTime() <= Date.now()) continue;
    await Notifications.scheduleNotificationAsync({
      content: { title: spec.appName, body: entry.copy },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: when },
    });
    count++;
  }
  return count;
}
