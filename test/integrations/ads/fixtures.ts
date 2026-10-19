/** Campaign request fixtures shared by the ads integration tests. */
import type { CreateCampaignRequest } from "../../../src/integrations/ads/common.ts";
import type { VentureBindings } from "../../../src/core/types.ts";

export const bindings: VentureBindings = {
  platforms: ["ios"],
  publisherAccountIds: { ios: "pub_1" },
  bundleId: "com.fast.astra",
  androidPackage: "com.fast.astra",
  ascAppId: "6700000001",
  appStoreUrl: "https://apps.apple.com/app/id6700000001",
  ownedAccountIds: {},
  adAccountIds: { meta: "act_111", tiktok: "7000000000000000001", apple: "4200001" },
  metaAppId: "998877",
  products: [],
};

export function campaignRequest(overrides: Partial<CreateCampaignRequest> = {}): CreateCampaignRequest {
  return {
    bindings,
    network: "meta",
    adAccountId: "111",
    os: "ios",
    type: "creative",
    dailyBudgetCents: 2_500,
    startAt: "2026-10-20T00:00:00.000Z",
    endAt: "2026-10-23T00:00:00.000Z",
    geos: ["US", "CA"],
    creatives: [{ kind: "owned_post", contentId: "content_000001", platform: "instagram", externalId: "17900000000000001" }],
    keywords: [],
    name: "astra-creative-adc_000001",
    ...overrides,
  };
}
