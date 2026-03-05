import { describe, expect, it } from "bun:test";
import { summarizeLanguageDistribution } from "../src/lib/languageDistribution";

describe("summarizeLanguageDistribution", () => {
  it("groups languages, computes percentages, and tracks unknown", () => {
    const summary = summarizeLanguageDistribution([
      { language: "fr" },
      { language: "FR" },
      { language: "en" },
      { language: "ar" },
      { language: null },
      { language: "" },
    ]);

    expect(summary.totalDetected).toBe(4);
    expect(summary.unknownCount).toBe(2);
    expect(summary.entries).toEqual([
      { language: "FR", count: 2, percentage: 50 },
      { language: "AR", count: 1, percentage: 25 },
      { language: "EN", count: 1, percentage: 25 },
    ]);
  });

  it("limits output to top N and places rest in other", () => {
    const summary = summarizeLanguageDistribution(
      [
        { language: "EN" },
        { language: "EN" },
        { language: "FR" },
        { language: "AR" },
        { language: "DE" },
      ],
      2,
    );

    expect(summary.entries).toEqual([
      { language: "EN", count: 2, percentage: 40 },
      { language: "AR", count: 1, percentage: 20 },
    ]);
    expect(summary.otherCount).toBe(2);
    expect(summary.otherPercentage).toBe(40);
  });
});
