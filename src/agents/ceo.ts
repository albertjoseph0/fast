/**
 * CEO: the board memo over the deterministic daily summary. The memo reports and asks;
 * it never decides.
 */
import type { AgentContext } from "../core/context.ts";
import { SCHEMA, type BoardMemo, type SchemaInputs } from "./schemas.ts";
import { rolePrompt } from "./shared.ts";

const SYSTEM = rolePrompt(
  "You are the CEO of an autonomous app studio writing the memo the human board reads each week.",
  [
    "Lead with the one thing the board most needs to know. Be specific: name ventures, stages and the decisions waiting on humans.",
    "Report only facts in the input. Never invent numbers, users, revenue or outcomes; money in the input is in US cents.",
    "Wins are validated results, not activity. Concerns include cash runway, stalled ventures, blocked human tasks and policy risk.",
    "decisionsNeeded lists only things a human must approve or do, each in one sentence.",
  ],
  { playbook: true },
);

/** Board memo for the given day's summary. */
export async function writeBoardMemo(ctx: AgentContext, input: SchemaInputs["BoardMemo"]): Promise<BoardMemo> {
  return ctx.ports.llm.object({
    role: "ceo",
    schemaName: SCHEMA.boardMemo,
    system: SYSTEM,
    instructions: "Write the board memo for this summary.",
    input,
    purpose: "board_memo",
  });
}
