/**
 * Creator payout arithmetic. Amounts are computed here from platform-verified views
 * locked after the view-lock window, never taken from an LLM or a creator.
 */
import type { Cents } from "../core/types.ts";

export interface PayoutTerms {
  flatFeeCents: Cents;
  cpmCents: Cents;
  maxPayoutCents: Cents;
}

export interface PayoutBasisInput {
  viewsAtLock: number;
  campaignRemainingCents: Cents;
}

/** min(flat + floor(cpm x views / 1000), per-video cap, campaign remaining), never negative. */
export function computePayout(terms: PayoutTerms, input: PayoutBasisInput): Cents {
  const views = Math.max(0, Math.floor(input.viewsAtLock));
  const earned = terms.flatFeeCents + Math.floor((terms.cpmCents * views) / 1000);
  return Math.max(0, Math.min(earned, terms.maxPayoutCents, input.campaignRemainingCents));
}
