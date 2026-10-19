import { Redirect, type Href } from "expo-router";
import { useEffect, useState } from "react";
import { isEntitled } from "../src/purchases";
import { getSpec } from "../src/spec";
import { getJson, KEYS } from "../src/storage";

/** Routes by stored onboarding state, then by the hard paywall's placement. */
export default function Index() {
  const [target, setTarget] = useState<Href | null>(null);
  useEffect(() => {
    void (async () => {
      if (!(await getJson<boolean>(KEYS.onboardingDone, false))) return setTarget("/onboarding");
      const { paywall } = getSpec();
      if (paywall.style === "hard" && paywall.placement === "after_onboarding" && !(await isEntitled())) return setTarget("/paywall");
      setTarget("/home");
    })();
  }, []);
  return target ? <Redirect href={target} /> : null;
}
