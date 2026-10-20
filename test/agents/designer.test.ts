import { describe, expect, it } from "vitest";
import { allowedKindsFor, applyVariant, deliveryModeFor, designSpec, proposeVariant } from "../../src/agents/designer.ts";
import type { VariantChangeKind, VariantProposal } from "../../src/agents/schemas.ts";
import type { AppSpec } from "../../src/core/types.ts";
import { LlmError } from "../../src/llm/errors.ts";
import { lintSpec } from "../../src/principles/product.ts";
import { FakeLlm, agentContext, astra, astraSpec, deepFreeze } from "./fixtures.ts";

const SUBTITLE_40 = "Your birth chart read like your group chat";

describe("deliveryModeFor", () => {
  it("maps every change kind to how it reaches users", () => {
    const expected: Record<VariantChangeKind, string> = {
      hooks: "content_only",
      onboarding: "remote_config",
      paywall: "remote_config",
      share: "remote_config",
      core: "remote_config",
      positioning: "store_metadata",
    };
    for (const [kind, mode] of Object.entries(expected)) expect(deliveryModeFor(kind as VariantChangeKind)).toBe(mode);
  });
});

describe("allowedKindsFor", () => {
  it("maps each failed stage to the kinds that can move it", () => {
    expect(allowedKindsFor(["S0_attention"])).toEqual(["hooks"]);
    expect(allowedKindsFor(["S1_distribution"])).toEqual(["hooks", "positioning"]);
    expect(allowedKindsFor(["S1_activation"])).toEqual(["onboarding", "core"]);
    expect(allowedKindsFor(["S2_sharing"])).toEqual(["share"]);
    expect(allowedKindsFor(["S3_cross_cell"])).toEqual(["share", "core"]);
    expect(allowedKindsFor(["S4_monetization"])).toEqual(["paywall", "onboarding"]);
  });

  it("unions stages in order without duplicates", () => {
    expect(allowedKindsFor(["S1_activation", "S4_monetization"])).toEqual(["onboarding", "core", "paywall"]);
    expect(allowedKindsFor([])).toEqual([]);
  });
});

describe("applyVariant", () => {
  const spec = deepFreeze(astraSpec());

  it("never mutates the spec or the proposal", () => {
    const proposal = deepFreeze<VariantProposal>({
      variableUnderTest: "paywall",
      hypothesis: "h",
      change: { kind: "paywall", paywall: { ...astraSpec().paywall, headline: "See it all" } },
    });
    const next = applyVariant(spec, proposal);
    expect(next.paywall.headline).toBe("See it all");
    expect(spec.paywall.headline).toBe("Unlock your full chart");
    next.paywall.bullets.push("x");
    expect(proposal.change.kind === "paywall" && proposal.change.paywall.bullets).toHaveLength(3);
  });

  it("hooks change nothing in the spec", () => {
    const next = applyVariant(spec, { variableUnderTest: "hooks", hypothesis: "h", change: { kind: "hooks", hooks: ["New hook"] } });
    expect(next).toEqual(spec);
    expect(next).not.toBe(spec);
  });

  it("positioning changes only name, subtitle and name candidates", () => {
    const next = applyVariant(spec, {
      variableUnderTest: "positioning",
      hypothesis: "h",
      change: { kind: "positioning", appName: "Starchat", subtitle: "Your chart as a group chat", hooks: ["x"] },
    });
    expect(next.appName).toBe("Starchat");
    expect(next.subtitle).toBe("Your chart as a group chat");
    expect(next.nameCandidates[0]).toBe("Starchat");
    expect(next.nameCandidates).toContain("Astra");
    const { appName: _a, subtitle: _s, nameCandidates: _n, ...rest } = next;
    const { appName: _a2, subtitle: _s2, nameCandidates: _n2, ...before } = spec;
    expect(rest).toEqual(before);
  });

  it("replaces exactly the named section for other kinds", () => {
    const share = { ...astraSpec().share, cardHeadline: "Compare charts" };
    const next = applyVariant(spec, { variableUnderTest: "share", hypothesis: "h", change: { kind: "share", share } });
    expect(next.share).toEqual(share);
    expect(next.onboarding).toEqual(spec.onboarding);
    expect(next.paywall).toEqual(spec.paywall);
  });
});

describe("designSpec", () => {
  it("passes defaults and company, and autoFixes a 40-char subtitle without a repair call", async () => {
    const llm = new FakeLlm({ AppSpec: () => ({ ...astraSpec(), subtitle: SUBTITLE_40 }) });
    const ctx = agentContext({ llm });
    const out = await designSpec(ctx, { idea: astra() });

    expect(SUBTITLE_40.length).toBeGreaterThan(30);
    expect(out.spec.subtitle.length).toBeLessThanOrEqual(30);
    expect(out.repaired).toBe(false);
    expect(out.findings.some((f) => f.severity === "block")).toBe(false);
    expect(llm.calls("AppSpecRepair")).toHaveLength(0);

    const req = llm.calls("AppSpec")[0];
    expect(req?.role).toBe("designer");
    expect(req?.input.defaults.onboardingSkeleton.length).toBeGreaterThan(5);
    expect(req?.input.defaults.priceLadderIds).toEqual(ctx.config.monetization.ladder.map((e) => e.id));
    expect(req?.input.defaults.pushSchedule.length).toBeGreaterThan(0);
    expect(req?.input.defaults.paywall.productIds.length).toBeGreaterThan(0);
    expect(req?.input.company).toEqual({ legalName: ctx.config.company.legalName, supportEmail: ctx.config.company.supportEmail });
    expect(req?.system).toContain("Studio playbook");
  });

  it("sends remaining blocks to one repair call, then autoFixes and re-lints the repair", async () => {
    const blocked = (): AppSpec => ({ ...astraSpec(), subtitle: SUBTITLE_40, paywall: { ...astraSpec().paywall, headline: "Join 2 million users" } });
    const llm = new FakeLlm({
      AppSpec: blocked,
      AppSpecRepair: () => ({ spec: { ...astraSpec(), subtitle: SUBTITLE_40 }, changes: ["removed the user count"] }),
    });
    const ctx = agentContext({ llm });
    const out = await designSpec(ctx, { idea: astra(), ventureId: "ven_000001" });

    expect(out.repaired).toBe(true);
    expect(out.spec.paywall.headline).toBe("Unlock your full chart");
    expect(out.spec.subtitle.length).toBeLessThanOrEqual(30);
    expect(out.findings.some((f) => f.severity === "block")).toBe(false);

    const repair = llm.calls("AppSpecRepair");
    expect(repair).toHaveLength(1);
    expect(repair[0]?.ventureId).toBe("ven_000001");
    const ids = repair[0]?.input.findings.map((f) => f.ruleId) ?? [];
    expect(ids).toContain("copy.unverified_count");
    expect(ids).not.toContain("spec.subtitle_length");
    expect(repair[0]?.input.spec.subtitle.length).toBeLessThanOrEqual(30);
  });

  it("returns the remaining blocks when the repair does not fix them", async () => {
    const bad = (): AppSpec => ({ ...astraSpec(), paywall: { ...astraSpec().paywall, headline: "The #1 astrology app" } });
    const llm = new FakeLlm({ AppSpec: bad, AppSpecRepair: () => ({ spec: bad(), changes: [] }) });
    const out = await designSpec(agentContext({ llm }), { idea: astra() });
    expect(out.repaired).toBe(true);
    expect(out.findings.some((f) => f.severity === "block" && f.ruleId === "copy.unverified_ranking")).toBe(true);
    expect(llm.calls("AppSpecRepair")).toHaveLength(1);
  });

  it("sends needs_human copy to the repair call and returns what is left for a human", async () => {
    const claim = (): AppSpec => ({ ...astraSpec(), paywall: { ...astraSpec().paywall, bullets: [...astraSpec().paywall.bullets, "Guaranteed accurate readings"] } });
    const llm = new FakeLlm({ AppSpec: claim, AppSpecRepair: () => ({ spec: claim(), changes: [] }) });
    const out = await designSpec(agentContext({ llm }), { idea: astra() });
    expect(llm.calls("AppSpecRepair")[0]?.input.findings.map((f) => f.ruleId)).toContain("copy.efficacy_claim");
    expect(out.repaired).toBe(true);
    expect(out.findings.find((f) => f.ruleId === "copy.efficacy_claim")?.severity).toBe("needs_human");
  });

  it("raises the minimum age when the spec itself puts the app in an adults-only domain", async () => {
    const spec = (): AppSpec => ({ ...astraSpec(), compliance: { ...astraSpec().compliance, minimumAge: "16" }, core: { ...astraSpec().core, aiSystemPrompt: "Pick tonight's sports picks and parlays." } });
    const teen = astra({ wedge: { ...astra().wedge, minAge: 16 } });
    const out = await designSpec(agentContext({ llm: new FakeLlm({ AppSpec: spec }) }), { idea: teen });
    expect(out.spec.compliance.minimumAge).toBe("18");
    expect(out.findings.filter((f) => f.ruleId === "spec.minimum_age")).toEqual([]);
  });

  it("propagates LLM budget exhaustion unchanged", async () => {
    const err = new LlmError("budget_exceeded", "llm budget spent");
    const llm = new FakeLlm({
      AppSpec: () => {
        throw err;
      },
    });
    await expect(designSpec(agentContext({ llm }), { idea: astra() })).rejects.toBe(err);
  });
});

describe("proposeVariant", () => {
  const venture = { id: "ven_000001", name: "Astra" };
  const base = { venture, idea: astra(), spec: astraSpec(), outcomeSummary: "Activation failed." };

  it("accepts an allowed, untried proposal and computes its delivery mode", async () => {
    const core = { ...astraSpec().core, outputSections: ["Verdict", "Sun", "Moon"] };
    const llm = new FakeLlm({ VariantProposal: () => ({ variableUnderTest: "core", hypothesis: "Verdict first lifts activation", change: { kind: "core", core } }) });
    const out = await proposeVariant(agentContext({ llm }), { ...base, failedStages: ["S1_activation"], triedVariables: [] });
    expect(out.proposal.change).toEqual({ kind: "core", core });
    expect(out.deliveryMode).toBe("remote_config");
    const req = llm.calls("VariantProposal")[0];
    expect(req?.input.allowedKinds).toEqual(["onboarding", "core"]);
    expect(req?.role).toBe("designer");
    expect(req?.ventureId).toBe("ven_000001");
  });

  it("replaces a disallowed kind with a deterministic change of the first allowed untried kind", async () => {
    const llm = new FakeLlm({ VariantProposal: () => ({ variableUnderTest: "hooks", hypothesis: "h", change: { kind: "hooks", hooks: ["A new hook"] } }) });
    const ctx = agentContext({ llm });
    const a = await proposeVariant(ctx, { ...base, failedStages: ["S4_monetization"], triedVariables: [] });
    const b = await proposeVariant(ctx, { ...base, failedStages: ["S4_monetization"], triedVariables: [] });
    expect(a.proposal.change.kind).toBe("paywall");
    expect(a.deliveryMode).toBe("remote_config");
    expect(a.proposal).toEqual(b.proposal);
    expect(a.proposal.change.kind === "paywall" && a.proposal.change.paywall.headline).not.toBe(astraSpec().paywall.headline);
    const blocks = lintSpec(applyVariant(astraSpec(), a.proposal), astra(), ctx.config).filter((f) => f.severity === "block");
    expect(blocks).toEqual([]);
  });

  it("rejects an already-tried kind and skips tried kinds in the fallback", async () => {
    const llm = new FakeLlm({
      VariantProposal: () => ({ variableUnderTest: "hooks", hypothesis: "h", change: { kind: "hooks", hooks: ["Another hook"] } }),
    });
    const out = await proposeVariant(agentContext({ llm }), { ...base, failedStages: ["S1_distribution"], triedVariables: ["hooks"] });
    expect(out.proposal.change.kind).toBe("positioning");
    expect(out.deliveryMode).toBe("store_metadata");
    expect(llm.calls("VariantProposal")[0]?.input.allowedKinds).toEqual(["positioning"]);
    if (out.proposal.change.kind === "positioning") {
      expect(out.proposal.change.subtitle.length).toBeLessThanOrEqual(30);
      expect(out.proposal.change.appName).not.toBe("Astra");
    }
  });

  it("rejects a remote-config variant that adds needs_human copy and falls back", async () => {
    const paywall = { ...astraSpec().paywall, headline: "Guaranteed accurate readings", bullets: [...astraSpec().paywall.bullets.slice(0, 2), "Clinically proven to calm your love life"] };
    const llm = new FakeLlm({ VariantProposal: () => ({ variableUnderTest: "paywall", hypothesis: "Claims lift conversion", change: { kind: "paywall", paywall } }) });
    const ctx = agentContext({ llm });
    const out = await proposeVariant(ctx, { ...base, failedStages: ["S4_monetization"], triedVariables: [] });
    expect(out.proposal.change.kind).toBe("paywall");
    expect(out.proposal.change.kind === "paywall" && out.proposal.change.paywall.headline).not.toBe(paywall.headline);
    const findings = lintSpec(applyVariant(astraSpec(), out.proposal), astra(), ctx.config);
    expect(findings.filter((f) => f.severity === "needs_human" || f.severity === "block")).toEqual([]);
  });

  it("rejects a value-first paywall variant when the spec gives no free use", async () => {
    const paywall = { ...astraSpec().paywall, placement: "after_first_value" as const };
    const spec = { ...astraSpec(), core: { ...astraSpec().core, freeUsesBeforePaywall: 0 } };
    const llm = new FakeLlm({ VariantProposal: () => ({ variableUnderTest: "paywall", hypothesis: "Value first", change: { kind: "paywall", paywall } }) });
    const out = await proposeVariant(agentContext({ llm }), { ...base, spec, failedStages: ["S4_monetization"], triedVariables: [] });
    expect(out.proposal.change.kind === "paywall" && out.proposal.change.paywall.placement).toBe(spec.paywall.placement);
  });

  it("falls back when the proposal's hooks are all blocked by copy lint", async () => {
    const llm = new FakeLlm({
      VariantProposal: () => ({ variableUnderTest: "hooks", hypothesis: "h", change: { kind: "hooks", hooks: ["Join 2 million users", "Rated 5 stars"] } }),
    });
    const out = await proposeVariant(agentContext({ llm }), { ...base, failedStages: ["S0_attention"], triedVariables: [] });
    expect(out.proposal.change.kind).toBe("hooks");
    if (out.proposal.change.kind === "hooks") {
      expect(out.proposal.change.hooks.length).toBeGreaterThan(0);
      expect(out.proposal.change.hooks.join(" ")).not.toMatch(/million|stars/);
    }
    expect(out.deliveryMode).toBe("content_only");
  });
});
