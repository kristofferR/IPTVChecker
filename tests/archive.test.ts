import { describe, expect, it } from "bun:test";
import {
  applyXtreamArchiveUpdates,
  archiveBadgeText,
  archiveSortValue,
  archiveTitle,
  hasArchive,
} from "../src/lib/archive";

function fields(
  catchup: string | null,
  catchup_days: number | null,
  catchup_source: string | null = null,
) {
  return { catchup, catchup_days, catchup_source };
}

describe("archive helpers", () => {
  it("detects advertised catch-up from either field", () => {
    expect(hasArchive(fields(null, null))).toBe(false);
    expect(hasArchive(fields("xc", null))).toBe(true);
    expect(hasArchive(fields(null, 7))).toBe(true);
  });

  it("renders depth as the badge, falling back to the type", () => {
    expect(archiveBadgeText(fields(null, null))).toBeNull();
    expect(archiveBadgeText(fields("xc", 7))).toBe("7d");
    expect(archiveBadgeText(fields("flussonic", null))).toBe("flussonic");
    expect(archiveBadgeText(fields("default", null))).toBe("yes");
  });

  it("describes type and depth in the tooltip", () => {
    expect(archiveTitle(fields("xc", 7))).toBe("Catch-up: xc · 7 days");
    expect(archiveTitle(fields(null, 1))).toBe("Catch-up: default · 1 day");
    expect(archiveTitle(fields("shift", null))).toBe("Catch-up: shift · unknown depth");
    expect(archiveTitle(fields("xc", 7, "https://example.com/${start}"))).toBe(
      "Catch-up: xc · 7 days · Source: https://example.com/${start}",
    );
    expect(archiveTitle(fields(null, null))).toBeNull();
  });

  it("sorts by depth with depth-less catch-up below dated entries", () => {
    expect(archiveSortValue(fields(null, null))).toBeNull();
    expect(archiveSortValue(fields("xc", null))).toBe(0);
    expect(archiveSortValue(fields("xc", 7))).toBe(7);
  });

  it("applies late Xtream archive metadata without replacing unrelated fields", () => {
    const items = [
      {
        index: 42,
        name: "News",
        catchup: null,
        catchup_days: null,
        extinf_line: "#EXTINF:-1,News",
      },
    ];

    const updated = applyXtreamArchiveUpdates(items, [
      {
        index: 42,
        catchup: "xc",
        catchup_days: 7,
        extinf_line: '#EXTINF:-1 catchup="xc" catchup-days="7",News',
      },
    ]);

    expect(updated).toEqual([
      {
        index: 42,
        name: "News",
        catchup: "xc",
        catchup_days: 7,
        extinf_line: '#EXTINF:-1 catchup="xc" catchup-days="7",News',
      },
    ]);
    expect(applyXtreamArchiveUpdates(updated, [])).toBe(updated);
  });
});
