/**
 * Renders every onboarding step kind generically from spec.onboarding. AI-data consent
 * names the providers that receive the user's input before any is collected (Apple
 * 5.1.2(i)); the notification pre-prompt asks the OS only after the user taps Yes.
 */
import { router } from "expo-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Switch, TextInput, View } from "react-native";
import { track, trackAttributionAnswer } from "../src/analytics";
import { APP_EVENTS } from "../src/events";
import { requestPermission, scheduleReminders } from "../src/notifications";
import { isEntitled } from "../src/purchases";
import { afterOnboardingRoute } from "../src/routing";
import { markActivated } from "../src/session";
import { studio, useSpec } from "../src/spec";
import { getJson, KEYS, setJson, type Profile } from "../src/storage";
import type { OnboardingStep } from "../src/types";
import { Body, Button, Card, Choice, Notice, Screen, styles, Title, useTheme } from "../src/ui";

const NEEDS_ANSWER = new Set(["goal_picker", "single_choice", "multi_choice", "text_input", "date_input", "time_input", "place_input", "slider", "attribution_survey"]);
const PLACEHOLDER: Partial<Record<OnboardingStep["kind"], string>> = {
  date_input: "YYYY-MM-DD",
  time_input: "HH:MM (or leave blank if unknown)",
  place_input: "City, country",
  text_input: "Type here",
};

export default function Onboarding() {
  const spec = useSpec();
  const t = useTheme();
  const steps = spec.onboarding;
  const [index, setIndex] = useState(0);
  const [profile, setProfile] = useState<Profile>({});
  const [promo, setPromo] = useState(false);
  const [busy, setBusy] = useState(false);
  const started = useRef(false);
  const step = steps[index];

  useEffect(() => {
    void getJson<Profile>(KEYS.profile, {}).then(setProfile);
    if (!started.current) {
      started.current = true;
      track(APP_EVENTS.onboardingStart, { steps: steps.length });
    }
  }, [steps.length]);

  useEffect(() => {
    if (!step) return;
    track(APP_EVENTS.onboardingStep, { step_id: step.id, kind: step.kind, index });
    if (step.kind === "value_preview") void markActivated("value_preview");
    if (step.kind === "loading_personalization") {
      const timer = setTimeout(() => void next(), 2_500);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [index]);

  if (!step) return null;
  const key = step.storeAs ?? step.id;
  const answer = profile[key];
  const answered = Array.isArray(answer) ? answer.length > 0 : Boolean(answer?.trim());
  const optional = step.kind === "time_input";

  async function save(value: string | string[]) {
    const nextProfile = { ...profile, [key]: value };
    setProfile(nextProfile);
    if (step?.storeAs) await setJson(KEYS.profile, nextProfile);
  }

  async function next() {
    if (step?.kind === "attribution_survey" && typeof answer === "string") trackAttributionAnswer(answer);
    if (index + 1 < steps.length) return setIndex(index + 1);
    await setJson(KEYS.onboardingDone, true);
    track(APP_EVENTS.onboardingComplete, { steps: steps.length });
    router.replace(afterOnboardingRoute(spec.paywall.placement, await isEntitled()));
  }

  async function consent(granted: boolean) {
    await setJson(KEYS.aiConsent, granted);
    track(granted ? APP_EVENTS.aiConsentGranted : APP_EVENTS.aiConsentDeclined, {});
    await next();
  }

  async function notifyYes() {
    setBusy(true);
    const granted = await requestPermission();
    if (granted && promo) {
      await setJson(KEYS.promoOptIn, true);
      track(APP_EVENTS.promoPushOptIn, { source: "onboarding" });
    }
    await scheduleReminders().catch(() => 0);
    setBusy(false);
    await next();
  }

  const toggle = (option: string) => {
    const current = Array.isArray(answer) ? answer : [];
    void save(current.includes(option) ? current.filter((o) => o !== option) : [...current, option]);
  };

  const sliderOptions = step.options.length ? step.options : ["1", "2", "3", "4", "5"];
  let body: ReactNode = null;
  let footer: ReactNode = <Button label="Continue" onPress={() => void next()} disabled={NEEDS_ANSWER.has(step.kind) && !answered && !optional} />;

  switch (step.kind) {
    case "goal_picker":
    case "single_choice":
    case "attribution_survey":
      body = step.options.map((o) => <Choice key={o} label={o} selected={answer === o} onPress={() => void save(o)} />);
      break;
    case "multi_choice":
      body = step.options.map((o) => <Choice key={o} label={o} selected={Array.isArray(answer) && answer.includes(o)} onPress={() => toggle(o)} />);
      break;
    case "slider":
      body = (
        <View style={styles.row}>
          {sliderOptions.map((o) => (
            <Choice key={o} label={o} selected={answer === o} onPress={() => void save(o)} />
          ))}
        </View>
      );
      break;
    case "text_input":
    case "date_input":
    case "time_input":
    case "place_input":
      body = (
        <TextInput
          value={typeof answer === "string" ? answer : ""}
          onChangeText={(v) => void save(v)}
          placeholder={PLACEHOLDER[step.kind]}
          placeholderTextColor={`${t.text}80`}
          keyboardType={step.kind === "date_input" || step.kind === "time_input" ? "numbers-and-punctuation" : "default"}
          multiline={step.kind === "text_input"}
          style={[styles.input, { color: t.text, borderColor: `${t.text}40` }]}
        />
      );
      break;
    case "ai_data_consent":
      body = (
        <Card>
          <Body>{spec.compliance.aiDisclosure}</Body>
          <Body small>
            When you ask for a result, what you enter is sent to:{"\n"}
            {studio.aiProviders.map((p) => `• ${p.name}: ${p.role}`).join("\n")}
          </Body>
          <Body small muted>
            You can withdraw consent at any time in Settings.
          </Body>
        </Card>
      );
      footer = (
        <>
          <Button label="I agree" onPress={() => void consent(true)} />
          <Button label="Not now" kind="secondary" onPress={() => void consent(false)} />
        </>
      );
      break;
    case "notification_preprompt":
      body = (
        <Card>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <Switch value={promo} onValueChange={setPromo} />
            <View style={{ flex: 1 }}>
              <Body small>Also send me occasional tips and offers</Body>
            </View>
          </View>
        </Card>
      );
      footer = (
        <>
          <Button label="Yes, notify me" onPress={() => void notifyYes()} busy={busy} />
          <Button label="Not now" kind="secondary" onPress={() => void next()} />
        </>
      );
      break;
    case "loading_personalization":
      body = spec.core.loadingMessages.map((m) => <Body key={m} muted>{m}</Body>);
      footer = null;
      break;
    case "value_preview":
      body = (
        <Card style={{ backgroundColor: t.primary }}>
          <Title>{spec.share.cardHeadline}</Title>
          {spec.core.outputSections.slice(0, 1).map((s) => (
            <Body key={s}>{s}</Body>
          ))}
          <Notice text="Generated by AI" />
        </Card>
      );
      break;
    case "result_teaser":
      body = spec.core.outputSections.map((s, i) => (
        <Card key={s}>
          <Body>{i === 0 ? s : `${s} 🔒`}</Body>
        </Card>
      ));
      break;
    case "welcome":
    case "benefit":
      break;
  }

  return (
    <Screen footer={footer}>
      <View style={{ height: 4, borderRadius: 2, backgroundColor: `${t.text}20` }}>
        <View style={{ height: 4, borderRadius: 2, width: `${((index + 1) / steps.length) * 100}%`, backgroundColor: t.accent }} />
      </View>
      <Title>{step.title}</Title>
      {step.subtitle ? <Body muted>{step.subtitle}</Body> : null}
      {body}
    </Screen>
  );
}
