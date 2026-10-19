import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { boot } from "../src/session";
import { useSpec } from "../src/spec";

export default function RootLayout() {
  const spec = useSpec();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    boot()
      .catch(() => undefined)
      .finally(() => setReady(true));
  }, []);
  if (!ready) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: spec.brand.backgroundColor }}>
        <ActivityIndicator color={spec.brand.accentColor} />
      </View>
    );
  }
  return (
    <SafeAreaProvider>
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: spec.brand.backgroundColor } }}>
        <Stack.Screen name="paywall" options={{ presentation: "fullScreenModal", gestureEnabled: false }} />
        <Stack.Screen name="settings" options={{ presentation: "modal" }} />
      </Stack>
    </SafeAreaProvider>
  );
}
