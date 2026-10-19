/** The core action: one input per spec.core.inputKind → POST /v1/verdict → result. */
import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Image, Pressable, Text, TextInput, View } from "react-native";
import { ApiError, requestVerdict, type VerdictInput } from "../src/api";
import { appUserId, hasAiConsent, markActivated, usesLeft } from "../src/session";
import { useSpec } from "../src/spec";
import { getJson, KEYS, setJson, type Profile, type StoredResult } from "../src/storage";
import { Body, Button, Card, Screen, styles, Title, useTheme } from "../src/ui";

export default function Home() {
  const spec = useSpec();
  const t = useTheme();
  const kind = spec.core.inputKind;
  const [text, setText] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({ date: "", time: "", place: "" });
  const [image, setImage] = useState<{ uri: string; base64: string; mediaType: "image/jpeg" | "image/png" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(0);
  const [consent, setConsent] = useState(true);

  useEffect(() => {
    void hasAiConsent().then(setConsent);
  }, []);

  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => setMessage((m) => m + 1), 1_800);
    return () => clearInterval(timer);
  }, [busy]);

  async function pick() {
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], base64: true, quality: 0.6, allowsEditing: false });
    const asset = res.canceled ? undefined : res.assets[0];
    if (asset?.base64) setImage({ uri: asset.uri, base64: asset.base64, mediaType: asset.mimeType === "image/png" ? "image/png" : "image/jpeg" });
  }

  const ready =
    kind === "photo" || kind === "screenshot"
      ? image !== null
      : kind === "date_time_place"
        ? Boolean(fields.date?.trim() && fields.place?.trim())
        : kind === "text" || kind === "audio_file"
          ? text.trim().length > 0
          : true;

  async function submit() {
    if (!(await hasAiConsent())) {
      setConsent(false);
      return;
    }
    if ((await usesLeft()) <= 0) {
      router.push({ pathname: "/paywall", params: { placement: "on_limit" } });
      return;
    }
    const profile = await getJson<Profile>(KEYS.profile, {});
    const input: VerdictInput = { kind, profile };
    if (image) Object.assign(input, { imageBase64: image.base64, mediaType: image.mediaType });
    if (kind === "date_time_place") input.fields = fields;
    if (text.trim()) input.text = text.trim();
    setBusy(true);
    try {
      const verdict = await requestVerdict(appUserId(), input, true);
      const stored: StoredResult = { id: verdict.id, sections: verdict.sections, createdAt: new Date().toISOString() };
      await setJson(KEYS.lastResult, stored);
      await setJson(KEYS.usesConsumed, (await getJson<number>(KEYS.usesConsumed, 0)) + 1);
      await markActivated("first_verdict");
      router.push("/result");
    } catch (err) {
      if (err instanceof ApiError && err.status === 402) router.push({ pathname: "/paywall", params: { placement: "on_limit" } });
      else Alert.alert("Couldn't get your result", err instanceof Error ? err.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const loading = spec.core.loadingMessages[message % Math.max(1, spec.core.loadingMessages.length)] ?? "Working on it…";
  const input = (value: string, onChange: (v: string) => void, placeholder: string, multiline = false) => (
    <TextInput value={value} onChangeText={onChange} placeholder={placeholder} placeholderTextColor={`${t.text}80`} multiline={multiline} style={[styles.input, { color: t.text, borderColor: `${t.text}40`, minHeight: multiline ? 120 : undefined }]} />
  );

  return (
    <Screen footer={<Button label={busy ? loading : "Get my result"} onPress={() => void submit()} disabled={!ready} busy={busy} />}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text style={{ color: t.accent, fontWeight: "700", fontSize: 18 }}>{spec.appName}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Settings" onPress={() => router.push("/settings")} hitSlop={12}>
          <Text style={{ color: t.text, fontSize: 22 }}>⚙︎</Text>
        </Pressable>
      </View>
      <Title>{spec.core.inputLabel}</Title>
      {!consent ? (
        <Card>
          <Body>To create results, the app needs your permission to send what you enter to its AI provider.</Body>
          <Button label="Review AI consent" kind="secondary" onPress={() => router.push("/settings")} />
        </Card>
      ) : null}
      {kind === "photo" || kind === "screenshot" ? (
        <Pressable accessibilityRole="button" onPress={() => void pick()}>
          <Card style={{ alignItems: "center", minHeight: 240, justifyContent: "center" }}>
            {image ? <Image source={{ uri: image.uri }} style={{ width: "100%", height: 320, borderRadius: 16 }} resizeMode="contain" /> : <Body>{kind === "photo" ? "Choose a photo" : "Choose a screenshot"}</Body>}
          </Card>
        </Pressable>
      ) : null}
      {kind === "text" || kind === "audio_file" ? input(text, setText, kind === "audio_file" ? "Describe or name the audio" : "Type here", true) : null}
      {kind === "date_time_place" ? (
        <>
          {input(fields.date ?? "", (v) => setFields({ ...fields, date: v }), "Date (YYYY-MM-DD)")}
          {input(fields.time ?? "", (v) => setFields({ ...fields, time: v }), "Time (HH:MM, optional)")}
          {input(fields.place ?? "", (v) => setFields({ ...fields, place: v }), "Place (city, country)")}
        </>
      ) : null}
      {kind === "choices" || kind === "none" ? <Body muted>We'll use the answers you gave during setup.</Body> : null}
      <Body small muted>
        Results are generated by AI.
      </Body>
    </Screen>
  );
}
