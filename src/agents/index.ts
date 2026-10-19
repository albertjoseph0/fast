/**
 * The agent bundle the orchestrator depends on. Agents read state and call Claude through
 * ctx.ports.llm; they return data and never create actions. Tests inject fakes through
 * this interface.
 */
import { explainOutcome } from "./analyst.ts";
import { produceIcon } from "./brand.ts";
import { writeBoardMemo } from "./ceo.ts";
import { reviewCopy } from "./compliance.ts";
import { draftContent, renderDraft } from "./content.ts";
import { reviewSubmission, selectCreators, writeBrief } from "./creatorOps.ts";
import { classifySensitivity, critiqueIdea, screen } from "./critic.ts";
import { applyVariant, designSpec, proposeVariant } from "./designer.ts";
import { generateIdeas } from "./ideator.ts";
import { scanMarket } from "./scout.ts";

export interface Agents {
  scanMarket: typeof scanMarket;
  generateIdeas: typeof generateIdeas;
  critiqueIdea: typeof critiqueIdea;
  classifySensitivity: typeof classifySensitivity;
  screen: typeof screen;
  designSpec: typeof designSpec;
  proposeVariant: typeof proposeVariant;
  applyVariant: typeof applyVariant;
  produceIcon: typeof produceIcon;
  draftContent: typeof draftContent;
  renderDraft: typeof renderDraft;
  writeBrief: typeof writeBrief;
  selectCreators: typeof selectCreators;
  reviewSubmission: typeof reviewSubmission;
  reviewCopy: typeof reviewCopy;
  explainOutcome: typeof explainOutcome;
  writeBoardMemo: typeof writeBoardMemo;
}

/** The real implementations. */
export function createAgents(): Agents {
  return {
    scanMarket,
    generateIdeas,
    critiqueIdea,
    classifySensitivity,
    screen,
    designSpec,
    proposeVariant,
    applyVariant,
    produceIcon,
    draftContent,
    renderDraft,
    writeBrief,
    selectCreators,
    reviewSubmission,
    reviewCopy,
    explainOutcome,
    writeBoardMemo,
  };
}

export { allowedKindsFor, deliveryModeFor } from "./designer.ts";
