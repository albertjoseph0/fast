/**
 * Validation ladder assignment. Single-player verdict utilities (Vert archetype) run one
 * combined distribution + activation + monetization step; social ideas (tbh/Gas archetype)
 * climb the sequential sharing and cross-cell K ladder.
 */
import type { StudioConfig } from "../config/schema.ts";
import type { Idea, LadderKind, ValidationStage } from "../core/types.ts";

/** Social iff the idea lacks single-player value, needs friends, or grows by invites. */
export function ladderFor(idea: Idea): LadderKind {
  const social = !idea.singlePlayerValue || idea.minFriendsForValue > 0 || idea.primaryChannel === "invite_loop";
  return social ? "social" : "single_player";
}

/** The configured steps for a ladder; each step is one pre-registered experiment. Returns a copy. */
export function ladderSteps(kind: LadderKind, config: StudioConfig): ValidationStage[][] {
  return config.lab.ladders[kind].map((step) => [...step]);
}
