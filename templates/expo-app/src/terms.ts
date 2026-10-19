/**
 * Subscription terms shown next to the purchase button (Apple 3.1.2, ROSCA, California
 * automatic renewal law). Same wording as the studio's termsTemplate, but the price,
 * period and trial come from the store product at runtime, never from the spec.
 */
/** Billing period of a ladder product. */
export type Period = "week" | "month" | "year";

const UNIT: Record<Period, string> = { week: "week", month: "month", year: "year" };
const RENEWAL = "Renews automatically until cancelled. Cancel anytime in Settings at least 24 hours before renewal.";

export function termsLine(priceString: string, period: Period, trialDays: number): string {
  const unit = UNIT[period];
  if (trialDays > 0) return `${trialDays}-day free trial, then ${priceString}/${unit}. ${RENEWAL}`;
  return `${priceString}/${unit}. ${RENEWAL}`;
}

/** ISO-8601 subscription period (P1W, P7D, P1M, P1Y, P12M) to a ladder period. */
export function periodFromIso(iso: string | null | undefined): Period | null {
  const m = /^P(\d+)([DWMY])$/.exec(iso ?? "");
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
  if ((unit === "W" && n === 1) || (unit === "D" && n === 7)) return "week";
  if ((unit === "M" && n === 1) || (unit === "W" && n === 4)) return "month";
  if ((unit === "Y" && n === 1) || (unit === "M" && n === 12)) return "year";
  return null;
}

/** Free-trial length in days from a store intro offer; paid intro offers are not trials. */
export function trialDaysFromIntro(intro: { price: number; periodUnit: string; periodNumberOfUnits: number; cycles: number } | null | undefined): number {
  if (!intro || intro.price !== 0) return 0;
  const perUnit: Record<string, number> = { DAY: 1, WEEK: 7, MONTH: 30, YEAR: 365 };
  return (perUnit[intro.periodUnit] ?? 0) * intro.periodNumberOfUnits * Math.max(1, intro.cycles);
}
