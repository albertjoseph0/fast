import { describe, expect, it } from "vitest";
import { lintCopy, type CopySurface } from "../../src/principles/copy.ts";

const rules = (text: string, surface: CopySurface = "paywall") => lintCopy({ text, surface }).map((f) => f.ruleId);

describe("lintCopy invented claims", () => {
  it.each<[string, string]>([
    ["Join 10,000+ stargazers", "copy.unverified_count"],
    ["Loved by millions", "copy.unverified_count"],
    ["10k+ readings shared", "copy.unverified_count"],
    ["Comparing you with 2 million users", "copy.unverified_count"],
    ["4.8 out of 5 on the App Store", "copy.unverified_rating"],
    ["Rated 4.9/5", "copy.unverified_rating"],
    ['"Scarily accurate!" - Jess, 22', "copy.testimonial"],
    ['"Changed my mornings" — Sarah K.', "copy.testimonial"],
    ["Just 6.99/week after your trial", "copy.currency_literal"],
    ["Only 39.99 a year", "copy.currency_literal"],
    ["Free for 7 days", "copy.trial_length"],
    ["Start your 3-day free trial", "copy.trial_length"],
    ["Try it 7 days free", "copy.trial_length"],
  ])("flags %s", (text, ruleId) => {
    expect(rules(text)).toContain(ruleId);
  });

  it.each(["See your full result", "Cancel anytime in Settings", "Your 2026 horoscope", "For ages 18+", "The 12 houses of your chart", "Day 3 of your streak"])(
    "leaves %s alone",
    (text) => {
      expect(rules(text)).toEqual([]);
    },
  );

  it("checks prices and trial lengths only on user-facing surfaces", () => {
    expect(rules("Free for 7 days", "system_prompt")).toEqual([]);
    expect(rules("Free for 7 days", "share")).toEqual(["copy.trial_length"]);
  });
});
