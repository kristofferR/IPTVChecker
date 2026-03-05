import { describe, expect, it } from "bun:test";
import { summarizeEpgCoverage } from "../src/lib/epgCoverage";

describe("summarizeEpgCoverage", () => {
  it("computes coverage and unique tvg-id count", () => {
    const summary = summarizeEpgCoverage([
      { tvg_id: "epg-1" },
      { tvg_id: " epg-1 " },
      { tvg_id: "epg-2" },
      { tvg_id: null },
      { tvg_id: "" },
    ]);

    expect(summary.totalChannels).toBe(5);
    expect(summary.channelsWithEpg).toBe(3);
    expect(summary.coveragePercent).toBe(60);
    expect(summary.uniqueEpgSources).toBe(2);
  });

  it("handles empty input", () => {
    const summary = summarizeEpgCoverage([]);

    expect(summary.totalChannels).toBe(0);
    expect(summary.channelsWithEpg).toBe(0);
    expect(summary.coveragePercent).toBe(0);
    expect(summary.uniqueEpgSources).toBe(0);
  });
});
