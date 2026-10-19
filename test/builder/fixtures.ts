/** Builder fixtures: the Astra idea and spec from the principles tests, plus a bound venture. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfig } from "../../src/config/schema.ts";
import type { AppSpec, Venture } from "../../src/core/types.ts";
import { astra, astraSpec } from "../principles/fixtures.ts";

export const TEMPLATE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "templates", "expo-app");
export const config = defaultConfig({ company: { legalName: "Fast Studio LLC", supportEmail: "help@faststudio.example", legalBaseUrl: "https://faststudio.example" } });
export { astra, astraSpec };

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "builder-"));
}

export function venture(spec: AppSpec = astraSpec(), patch: Partial<Venture> = {}): Venture {
  return {
    id: "venture_1",
    ideaId: "idea_1",
    screeningId: "screening_1",
    name: spec.appName,
    slug: spec.slug,
    wedge: "zodiac TikTok",
    stage: "building",
    ladder: {
      kind: "single_player",
      steps: [["S1_distribution", "S1_activation", "S4_monetization"]],
      stepIndex: 0,
      validated: [],
      currentExperimentId: null,
      experimentIds: [],
      iteration: 0,
      harnessFixes: 0,
      stepStartedAt: null,
    },
    spec,
    specVersion: 1,
    specHistory: [],
    baseline: { specVersion: 1, hookIds: [], paywallVariantId: null, onboardingVariantId: null },
    stores: [],
    bindings: {
      platforms: ["ios"],
      publisherAccountIds: {},
      bundleId: `com.faststudio.${spec.slug.replace(/-/g, "")}`,
      androidPackage: `com.faststudio.${spec.slug.replace(/-/g, "")}`,
      backendUrl: "https://verdict.faststudio.example",
      deepLinkDomain: `${spec.slug}.faststudio.example`,
      ownedAccountIds: {},
      adAccountIds: {},
      products: [],
    },
    blockedOn: [],
    blockedMs: 0,
    timeboxStartedAt: null,
    history: [],
    createdAt: "2026-10-17T12:00:00.000Z",
    updatedAt: "2026-10-18T09:30:00.000Z",
    ...patch,
  };
}
