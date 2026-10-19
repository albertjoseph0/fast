import { describe, expect, it } from "vitest";
import { explainOutcome, outcomeSummary } from "../../src/agents/analyst.ts";
import { writeBoardMemo } from "../../src/agents/ceo.ts";
import { LLM_OTHER, mergeFindings, reviewCopy } from "../../src/agents/compliance.ts";
import { classifySensitivity, critiqueIdea } from "../../src/agents/critic.ts";
import { createAgents } from "../../src/agents/index.ts";
import type { SchemaInputs } from "../../src/agents/schemas.ts";
import type { ExperimentOutcome, ExperimentPlan, MetricSpec, PolicyFinding, TestCell } from "../../src/core/types.ts";
import { LlmError } from "../../src/llm/errors.ts";
import { FakeLlm, agentContext, astra, critique } from "./fixtures.ts";

describe("reviewCopy", () => {
  it("keeps deterministic findings, escalates by rule id and maps unknown rules to llm_other", async () => {
    const llm = new FakeLlm({
      ComplianceReview: () => ({
        findings: [
          { ruleId: "copy.efficacy_claim", severity: "block", message: "Accuracy promise" },
          { ruleId: "copy.unverified_count", severity: "info", message: "fine actually" },
          { ruleId: "made.up", severity: "warn", message: "Dark pattern" },
          { ruleId: "also.made.up", severity: "needs_human", message: "Aimed at teens" },
        ],
      }),
    });
    const out = await reviewCopy(agentContext({ llm }), {
      kind: "paywall",
      text: "Join 2 million users. Guaranteed accurate readings.",
      appName: "Astra",
      domains: ["astrology_fortune"],
    });

    const byId = new Map(out.map((f) => [f.ruleId, f]));
    expect(byId.get("copy.unverified_count")?.severity).toBe("block");
    expect(byId.get("copy.efficacy_claim")?.severity).toBe("block");
    expect(byId.get("copy.efficacy_claim")?.message).toContain("escalated");
    expect(byId.get(LLM_OTHER)?.severity).toBe("needs_human");
    expect(out.filter((f) => f.ruleId === LLM_OTHER)).toHaveLength(1);
    expect(out.map((f) => f.ruleId)).toEqual(["copy.unverified_count", "copy.efficacy_claim", LLM_OTHER]);

    const req = llm.calls("ComplianceReview")[0];
    expect(req?.role).toBe("compliance");
    expect(req?.input).toEqual({
      kind: "paywall",
      text: "Join 2 million users. Guaranteed accurate readings.",
      context: { appName: "Astra", sensitiveDomains: ["astrology_fortune"] },
    });
  });

  it("uses the lint surface for the copy kind", async () => {
    const llm = new FakeLlm({ ComplianceReview: () => ({ findings: [] }) });
    const ctx = agentContext({ llm });
    expect((await reviewCopy(ctx, { kind: "listing", text: "Only $4.99", appName: "A", domains: [] })).map((f) => f.ruleId)).toEqual(["copy.currency_literal"]);
    expect(await reviewCopy(ctx, { kind: "support", text: "Refunded $4.99", appName: "A", domains: [] })).toEqual([]);
  });

  it("never downgrades a finding", () => {
    const base: PolicyFinding[] = [{ ruleId: "r", severity: "block", message: "m" }];
    expect(mergeFindings(base, [{ ruleId: "r", severity: "info", message: "ok" }])).toEqual(base);
  });
});

describe("explainOutcome", () => {
  const metric: MetricSpec = {
    key: "installsPer1kViews",
    label: "Installs per 1K views",
    kind: "rate",
    numerator: "install" as MetricSpec["numerator"],
    denominator: "view" as MetricSpec["denominator"],
    unit: "post",
    maturityHours: 24,
    role: "required",
    displayScale: 1000,
    floor: 0.0015,
    target: 0.003,
    futility: 0.0008,
  };
  const cell = { id: "cell_000001", phase: 1, role: "primary", geo: "CA" } as TestCell;
  const plan = {
    id: "exp_000001",
    ventureId: "ven_000001",
    stages: ["S1_distribution"],
    hypothesis: "Creators drive installs",
    variableUnderTest: "hooks",
    metrics: [metric],
    cells: [cell],
  } as unknown as ExperimentPlan;
  const outcome: ExperimentOutcome = {
    experimentId: "exp_000001",
    decision: "iterate",
    rationale: "Installs per view below floor.",
    cells: [
      {
        cellId: "cell_000001",
        decision: "fail",
        perMetric: { installsPer1kViews: { decision: "fail", estimate: 0.0009, interval: [0.0006, 0.0012], pAtLeastFloor: 0.01, nEffective: 41_234.4 } },
        validity: [
          { id: "min_sample", passed: true, detail: "ok" },
          { id: "cold_traffic", passed: false, detail: "40% from one post" },
        ],
      },
    ],
    decidedAt: "2026-10-17T00:00:00.000Z",
  };

  it("writes the facts deterministically", () => {
    const s = outcomeSummary(plan, outcome);
    expect(s).toContain("ITERATE");
    expect(s).toContain("Installs per view below floor.");
    expect(s).toContain("Cell cell_000001 (CA, primary): fail");
    expect(s).toContain("Installs per 1K views: 0.9 per 1K vs floor 1.5 per 1K");
    expect(s).toContain("validity failed: cold_traffic (40% from one post)");
    expect(s).not.toContain("min_sample");
  });

  it("appends one short low-effort analyst note", async () => {
    const llm = new FakeLlm({}, "The hooks did not show the verdict early enough.");
    const text = await explainOutcome(agentContext({ llm }), { plan, outcome });
    expect(text.startsWith(outcomeSummary(plan, outcome))).toBe(true);
    expect(text).toContain("Analyst note: The hooks did not show the verdict early enough.");
    expect(llm.textCalls).toHaveLength(1);
    expect(llm.textCalls[0]).toMatchObject({ role: "analyst", effort: "low", ventureId: "ven_000001" });
  });

  it("returns the bare summary for an empty note", async () => {
    const text = await explainOutcome(agentContext({ llm: new FakeLlm({}, "  ") }), { plan, outcome });
    expect(text).toBe(outcomeSummary(plan, outcome));
  });
});

describe("writeBoardMemo", () => {
  it("passes the summary through as the input", async () => {
    const input: SchemaInputs["BoardMemo"] = {
      date: "2026-10-17",
      cashCents: 500_000,
      freeCashCents: 300_000,
      ventures: [{ id: "ven_000001", name: "Astra", stage: "lab", detail: "S1 running" }],
      decisions: ["iterate Astra"],
      pendingApprovals: 2,
      openHumanTasks: 1,
    };
    const memo = { headline: "Astra in S1", summary: "s", wins: [], concerns: [], decisionsNeeded: ["Create the iOS app record"] };
    const llm = new FakeLlm({ BoardMemo: () => memo });
    expect(await writeBoardMemo(agentContext({ llm }), input)).toEqual(memo);
    const req = llm.calls("BoardMemo")[0];
    expect(req?.role).toBe("ceo");
    expect(req?.input).toEqual(input);
  });
});

describe("budget exhaustion", () => {
  it("propagates unchanged through parallel critics and the classifier", async () => {
    const err = new LlmError("budget_exceeded", "spent");
    const llm = new FakeLlm({
      Critique: (req) => {
        if (req.input.lens === "growth_realist") throw err;
        return critique({ lens: req.input.lens });
      },
      SensitivityReview: () => {
        throw err;
      },
    });
    const ctx = agentContext({ llm });
    await expect(critiqueIdea(ctx, astra())).rejects.toBe(err);
    await expect(classifySensitivity(ctx, astra())).rejects.toBe(err);
  });
});

describe("createAgents", () => {
  it("exposes every role function", () => {
    const agents = createAgents();
    const names = [
      "scanMarket",
      "generateIdeas",
      "critiqueIdea",
      "classifySensitivity",
      "screen",
      "designSpec",
      "proposeVariant",
      "applyVariant",
      "produceIcon",
      "draftContent",
      "renderDraft",
      "writeBrief",
      "selectCreators",
      "reviewSubmission",
      "reviewCopy",
      "explainOutcome",
      "writeBoardMemo",
    ];
    expect(Object.keys(agents).sort()).toEqual([...names].sort());
    for (const n of names) expect(typeof (agents as unknown as Record<string, unknown>)[n]).toBe("function");
  });
});
