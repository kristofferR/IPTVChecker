import {
  hasScanStarted,
  languageCoverage,
  shouldAutoRevealReportPanel,
  shouldShowContentCounts,
  shouldShowLanguageDistribution,
} from "../src/lib/playlistReportVisibility";

describe("playlist report visibility rules", () => {
  test("health score is hidden before scanning begins", () => {
    expect(hasScanStarted("idle")).toBe(false);
    expect(hasScanStarted("scanning")).toBe(true);
    expect(hasScanStarted("complete")).toBe(true);
  });

  test("content counts are hidden for live-only playlists", () => {
    expect(shouldShowContentCounts(0, 0)).toBe(false);
    expect(shouldShowContentCounts(1, 0)).toBe(true);
    expect(shouldShowContentCounts(0, 2)).toBe(true);
  });

  test("language distribution requires majority metadata coverage", () => {
    const sparse = [
      { language: "en" },
      { language: null },
      { language: null },
      { language: " " },
    ];
    const rich = [
      { language: "en" },
      { language: "fr" },
      { language: "de" },
      { language: null },
    ];

    expect(languageCoverage(sparse)).toBe(0.25);
    expect(shouldShowLanguageDistribution(sparse)).toBe(false);
    expect(languageCoverage(rich)).toBe(0.75);
    expect(shouldShowLanguageDistribution(rich)).toBe(true);
  });

  test("report auto-reveal only triggers near completion on broad scans", () => {
    expect(shouldAutoRevealReportPanel(null, 100)).toBe(false);

    expect(
      shouldAutoRevealReportPanel(
        {
          completed: 90,
          total: 100,
        },
        100,
      ),
    ).toBe(true);

    expect(
      shouldAutoRevealReportPanel(
        {
          completed: 89,
          total: 100,
        },
        100,
      ),
    ).toBe(false);

    expect(
      shouldAutoRevealReportPanel(
        {
          completed: 45,
          total: 50,
        },
        100,
      ),
    ).toBe(false);

    expect(
      shouldAutoRevealReportPanel(
        {
          completed: 77,
          total: 85,
        },
        100,
      ),
    ).toBe(true);
  });
});
