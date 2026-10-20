/**
 * Age confirmation for adult-only apps (spec.compliance.minimumAge 18), shown before
 * onboarding. The answer stays on the device; analytics gets only whether it was confirmed.
 * Under-age users get a polite stop and are not shown the app.
 */
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { track } from "../src/analytics";
import { APP_EVENTS } from "../src/events";
import { openPrivacy } from "../src/links";
import type { AgeAnswer } from "../src/routing";
import { studio, useSpec } from "../src/spec";
import { getJson, KEYS, setJson } from "../src/storage";
import { Body, Button, LinkText, Screen, Title } from "../src/ui";

export default function Age() {
  const spec = useSpec();
  const [answer, setAnswer] = useState<AgeAnswer | undefined>(undefined);
  const age = studio.minimumAge;

  useEffect(() => {
    void getJson<AgeAnswer>(KEYS.ageGate, null).then(setAnswer);
  }, []);

  async function choose(adult: boolean) {
    const value: AgeAnswer = adult ? "adult" : "under_age";
    await setJson(KEYS.ageGate, value);
    track(APP_EVENTS.onboardingStep, { step_id: "age_gate", kind: "age_gate", age_confirmed: adult });
    if (adult) router.replace("/onboarding");
    else setAnswer(value);
  }

  if (answer === undefined) return null;
  if (answer === "under_age") {
    return (
      <Screen>
        <Title>Thanks for stopping by</Title>
        <Body>
          {spec.appName} is only for people aged {age} and over, so we can't offer it to you. You haven't been charged and nothing you entered was sent anywhere.
        </Body>
        <LinkText label="Privacy" onPress={() => void openPrivacy()} />
      </Screen>
    );
  }
  return (
    <Screen
      footer={
        <>
          <Button label={`I'm ${age} or older`} kind="secondary" onPress={() => void choose(true)} />
          <Button label={`I'm under ${age}`} kind="secondary" onPress={() => void choose(false)} />
        </>
      }
    >
      <Title>Before we start</Title>
      <Body>
        {spec.appName} is for adults aged {age} and over. Please confirm your age.
      </Body>
    </Screen>
  );
}
