import { Redirect, type Href } from "expo-router";
import { useEffect, useState } from "react";
import { isEntitled } from "../src/purchases";
import { startRoute, type AgeAnswer } from "../src/routing";
import { getSpec, studio } from "../src/spec";
import { getJson, KEYS } from "../src/storage";

/** Routes by the age gate (adult-only apps), stored onboarding state, then the hard paywall's placement. */
export default function Index() {
  const [target, setTarget] = useState<Href | null>(null);
  useEffect(() => {
    void (async () => {
      const onboardingDone = await getJson<boolean>(KEYS.onboardingDone, false);
      const { paywall } = getSpec();
      const hardPaywallFirst = paywall.style === "hard" && paywall.placement === "after_onboarding";
      setTarget(
        startRoute({
          minimumAge: studio.minimumAge,
          ageAnswer: await getJson<AgeAnswer>(KEYS.ageGate, null),
          onboardingDone,
          hardPaywallFirst,
          entitled: hardPaywallFirst && onboardingDone ? await isEntitled() : false,
        }),
      );
    })();
  }, []);
  return target ? <Redirect href={target} /> : null;
}
