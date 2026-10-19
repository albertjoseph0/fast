/** Shared, brand-coloured building blocks for every screen. */
import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useSpec } from "./spec";

export function useTheme() {
  const { brand } = useSpec();
  return { primary: brand.primaryColor, accent: brand.accentColor, background: brand.backgroundColor, text: brand.textColor };
}

export function Screen({ children, scroll = true, footer }: { children: ReactNode; scroll?: boolean; footer?: ReactNode }) {
  const t = useTheme();
  return (
    <SafeAreaView style={[styles.fill, { backgroundColor: t.background }]}>
      {scroll ? <ScrollView contentContainerStyle={styles.content}>{children}</ScrollView> : <View style={[styles.fill, styles.content]}>{children}</View>}
      {footer ? <View style={styles.footer}>{footer}</View> : null}
    </SafeAreaView>
  );
}

export function Title({ children }: { children: ReactNode }) {
  const t = useTheme();
  return <Text style={[styles.title, { color: t.text }]}>{children}</Text>;
}

export function Body({ children, muted = false, small = false }: { children: ReactNode; muted?: boolean; small?: boolean }) {
  const t = useTheme();
  return <Text style={[small ? styles.small : styles.body, { color: t.text, opacity: muted ? 0.7 : 1 }]}>{children}</Text>;
}

export function Button({ label, onPress, kind = "primary", disabled = false, busy = false }: { label: string; onPress: () => void; kind?: "primary" | "secondary"; disabled?: boolean; busy?: boolean }) {
  const t = useTheme();
  const primary = kind === "primary";
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [styles.button, { backgroundColor: primary ? t.accent : "transparent", borderColor: t.accent, opacity: disabled ? 0.4 : pressed ? 0.8 : 1 }]}
    >
      {busy ? <ActivityIndicator color={primary ? t.background : t.accent} /> : <Text style={[styles.buttonText, { color: primary ? t.background : t.accent }]}>{label}</Text>}
    </Pressable>
  );
}

export function Choice({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.choice, { borderColor: selected ? t.accent : `${t.text}33`, backgroundColor: selected ? `${t.accent}22` : "transparent" }]}
    >
      <Text style={[styles.body, { color: t.text }]}>{label}</Text>
    </Pressable>
  );
}

export function LinkText({ label, onPress }: { label: string; onPress: () => void }) {
  const t = useTheme();
  return (
    <Text accessibilityRole="link" onPress={onPress} style={[styles.link, { color: t.text }]}>
      {label}
    </Text>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  return <View style={[styles.card, { backgroundColor: `${t.text}10` }, style]}>{children}</View>;
}

export function Notice({ text }: { text: string }) {
  const t = useTheme();
  return (
    <View style={[styles.notice, { borderColor: `${t.text}40` }]}>
      <Text style={[styles.small, { color: t.text }]}>{text}</Text>
    </View>
  );
}

export const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { padding: 24, gap: 16, flexGrow: 1 },
  footer: { paddingHorizontal: 24, paddingBottom: 12, gap: 10 },
  title: { fontSize: 30, fontWeight: "800", lineHeight: 36 },
  body: { fontSize: 17, lineHeight: 24 },
  small: { fontSize: 12, lineHeight: 17 },
  button: { borderRadius: 28, borderWidth: 2, paddingVertical: 16, alignItems: "center" },
  buttonText: { fontSize: 17, fontWeight: "700" },
  choice: { borderRadius: 16, borderWidth: 2, padding: 16 },
  link: { fontSize: 13, textDecorationLine: "underline", opacity: 0.8 },
  card: { borderRadius: 20, padding: 18, gap: 8 },
  notice: { borderWidth: 1, borderRadius: 12, padding: 10 },
  row: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 16 },
  input: { borderRadius: 14, borderWidth: 1, padding: 14, fontSize: 17 },
});
