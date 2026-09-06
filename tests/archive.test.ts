import { describe, expect, it } from "bun:test";
import {
  applyXtreamArchiveUpdates,
  archiveBadgeText,
  archivePickerDefault,
  archiveSortValue,
  archiveTitle,
  buildArchiveUrl,
  describeArchiveFailure,
  hasArchive,
  resolveArchivePlayback,
  substituteArchiveTemplate,
} from "../src/lib/archive";
import { archiveProbePoints } from "../src/lib/archiveProbe";

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

  it("clamps archive probes to the supported retention depth", () => {
    const nowEpochS = 1_800_000_000;

    expect(archiveProbePoints({ catchup_days: 0xffff_ffff }, nowEpochS)).toEqual([
      { label: "Archive −1 h", daysBack: 0, startEpochS: nowEpochS - 3600 },
      { label: "Archive −31 d", daysBack: 31, startEpochS: nowEpochS - 31 * 86_400 + 1800 },
    ]);
  });
});

// 2026-08-28 20:00:00 UTC
const START = 1_787_947_200;
const WINDOW = { startEpochS: START, durationS: 3600, nowEpochS: START + 8000 };

function urlFields(
  url: string,
  catchup: string | null,
  catchup_source: string | null = null,
  catchup_days: number | null = 7,
) {
  return { url, catchup, catchup_days, catchup_source };
}

describe("substituteArchiveTemplate", () => {
  it("fills dollar and brace placeholder forms", () => {
    expect(substituteArchiveTemplate("?utc=${start}&lutc=${now}", WINDOW)).toBe(
      `?utc=${START}&lutc=${START + 8000}`,
    );
    expect(substituteArchiveTemplate("/archive-{utc}-{duration}.m3u8", WINDOW)).toBe(
      `/archive-${START}-3600.m3u8`,
    );
    expect(substituteArchiveTemplate("?offset=${offset}&end=${utcend}", WINDOW)).toBe(
      `?offset=8000&end=${START + 3600}`,
    );
    expect(substituteArchiveTemplate("?utc=${start}&lutc=${timestamp}", WINDOW)).toBe(
      `?utc=${START}&lutc=${START + 8000}`,
    );
  });
});

describe("buildArchiveUrl", () => {
  it("returns null without advertised catch-up", () => {
    expect(buildArchiveUrl(urlFields("http://h/s.m3u8", null, null, null), WINDOW)).toBeNull();
  });

  it("prefers an explicit catchup-source template", () => {
    expect(
      buildArchiveUrl(
        urlFields("http://h/live/s.m3u8", "default", "http://h/replay/${start}-${duration}.m3u8"),
        WINDOW,
      ),
    ).toBe(`http://h/replay/${START}-3600.m3u8`);
    expect(
      buildArchiveUrl(
        urlFields("http://h/live/s.m3u8", "default", "HTTPS://h/replay/${start}.m3u8"),
        WINDOW,
      ),
    ).toBe(`HTTPS://h/replay/${START}.m3u8`);
    expect(
      buildArchiveUrl(
        urlFields(
          "http://h/live/s.m3u8",
          "default",
          "http://h/replay?start=${start}&amp;duration=${duration}",
        ),
        WINDOW,
      ),
    ).toBe(`http://h/replay?start=${START}&duration=3600`);
    // Query templates attach to the stream URL, respecting existing queries.
    expect(
      buildArchiveUrl(urlFields("http://h/s.m3u8?token=x", "shift", "?utc=${start}"), WINDOW),
    ).toBe(`http://h/s.m3u8?token=x&utc=${START}`);
    // A leading & normalizes to ? when the URL has no query yet.
    expect(buildArchiveUrl(urlFields("http://h/s.m3u8", "append", "&start=${start}"), WINDOW)).toBe(
      `http://h/s.m3u8?start=${START}`,
    );
    expect(
      buildArchiveUrl(urlFields("http://h/s.m3u8", "append", "&amp;start=${start}"), WINDOW),
    ).toBe(`http://h/s.m3u8?start=${START}`);
    expect(
      buildArchiveUrl(
        urlFields("http://h/s.m3u8?token=x#player", "shift", "?utc=${start}"),
        WINDOW,
      ),
    ).toBe(`http://h/s.m3u8?token=x&utc=${START}#player`);
    // Non-query relative templates concatenate verbatim.
    expect(
      buildArchiveUrl(urlFields("http://h/video", "append", "-${start}-${duration}.m3u8"), WINDOW),
    ).toBe(`http://h/video-${START}-3600.m3u8`);
    expect(
      buildArchiveUrl(
        urlFields("http://h/video#player", "append", "-${start}-${duration}.m3u8"),
        WINDOW,
      ),
    ).toBe(`http://h/video-${START}-3600.m3u8#player`);
    expect(
      buildArchiveUrl(
        urlFields("http://h/video?token=x#player", "append", "-${start}-${duration}.m3u8"),
        WINDOW,
      ),
    ).toBe(`http://h/video-${START}-3600.m3u8?token=x#player`);
  });

  it("builds xtream timeshift URLs from live stream URLs", () => {
    expect(
      buildArchiveUrl(urlFields("http://host:8080/live/alice/secret/42.ts", "xc"), WINDOW),
    ).toBe("http://host:8080/timeshift/alice/secret/60/2026-08-28:20-00/42.m3u8");
    // Extension-less live URLs match too.
    expect(buildArchiveUrl(urlFields("http://host/alice/secret/42", "xc"), WINDOW)).toBe(
      "http://host/timeshift/alice/secret/60/2026-08-28:20-00/42.m3u8",
    );
    expect(
      buildArchiveUrl(
        urlFields("https://host/live/alice/secret/42.ts?token=x#playback", "xc"),
        WINDOW,
      ),
    ).toBe("https://host/timeshift/alice/secret/60/2026-08-28:20-00/42.m3u8?token=x#playback");
    expect(
      buildArchiveUrl(urlFields("https://host/provider/live/alice/secret/42.ts", "xc"), WINDOW),
    ).toBe("https://host/provider/timeshift/alice/secret/60/2026-08-28:20-00/42.m3u8");
    expect(buildArchiveUrl(urlFields("HTTPS://host/live/alice/secret/42.ts", "xc"), WINDOW)).toBe(
      "HTTPS://host/timeshift/alice/secret/60/2026-08-28:20-00/42.m3u8",
    );
    expect(
      buildArchiveUrl(urlFields("https://host/provider/alice/secret/42.ts", "xc"), {
        ...WINDOW,
        durationS: 3629,
      }),
    ).toBe("https://host/provider/timeshift/alice/secret/61/2026-08-28:20-00/42.m3u8");
    // Non-xtream shapes fall back to the utc query convention.
    expect(buildArchiveUrl(urlFields("http://host/odd/path.m3u8", "xc"), WINDOW)).toBe(
      `http://host/odd/path.m3u8?utc=${START}&lutc=${START + 8000}`,
    );
  });

  it("builds flussonic archive URLs", () => {
    expect(buildArchiveUrl(urlFields("http://host/channel/index.m3u8", "flussonic"), WINDOW)).toBe(
      `http://host/channel/archive-${START}-3600.m3u8`,
    );
    expect(
      buildArchiveUrl(urlFields("http://host/channel/mono.ts?tok=1", "flussonic"), WINDOW),
    ).toBe(`http://host/channel/archive-${START}-3600.ts?tok=1`);
    expect(
      buildArchiveUrl(urlFields("http://host/channel/index.m3u8#player", "flussonic"), WINDOW),
    ).toBe(`http://host/channel/archive-${START}-3600.m3u8#player`);
    expect(
      buildArchiveUrl(urlFields("http://host/channel/mono.ts#player", "flussonic"), WINDOW),
    ).toBe(`http://host/channel/archive-${START}-3600.ts#player`);
  });

  it("uses the utc query convention for default and shift types", () => {
    expect(buildArchiveUrl(urlFields("http://h/s.m3u8", "default"), WINDOW)).toBe(
      `http://h/s.m3u8?utc=${START}&lutc=${START + 8000}`,
    );
    expect(buildArchiveUrl(urlFields("http://h/s.m3u8?a=1", "shift"), WINDOW)).toBe(
      `http://h/s.m3u8?a=1&utc=${START}&lutc=${START + 8000}`,
    );
    expect(buildArchiveUrl(urlFields("http://h/s.m3u8#player", "default"), WINDOW)).toBe(
      `http://h/s.m3u8?utc=${START}&lutc=${START + 8000}#player`,
    );
  });
});

describe("resolveArchivePlayback", () => {
  it("clamps future programme windows to the current time", () => {
    const nowEpochS = START + 8000;
    expect(
      resolveArchivePlayback(
        urlFields("http://h/s.m3u8", "default"),
        { startEpochS: nowEpochS + 3600, endEpochS: nowEpochS + 7200 },
        nowEpochS,
      ),
    ).toEqual({
      url: `http://h/s.m3u8?utc=${nowEpochS - 60}&lutc=${nowEpochS}`,
      startEpochS: nowEpochS - 60,
      windowEndEpochS: nowEpochS,
    });
  });

  it("moves short archive windows earlier without extending duration-bearing URLs", () => {
    const nowEpochS = START + 8000;
    const range = { startEpochS: nowEpochS - 1, endEpochS: nowEpochS + 3600 };

    expect(
      resolveArchivePlayback(
        urlFields(
          "http://h/live/s.m3u8",
          "default",
          "http://h/replay/${start}-${duration}-${end}-${utcend}.m3u8",
        ),
        range,
        nowEpochS,
      ),
    ).toEqual({
      url: `http://h/replay/${nowEpochS - 60}-60-${nowEpochS}-${nowEpochS}.m3u8`,
      startEpochS: nowEpochS - 60,
      windowEndEpochS: nowEpochS,
    });
    expect(
      resolveArchivePlayback(
        urlFields("http://host/channel/index.m3u8", "flussonic"),
        range,
        nowEpochS,
      )?.url,
    ).toBe(`http://host/channel/archive-${nowEpochS - 60}-60.m3u8`);
    expect(
      resolveArchivePlayback(
        urlFields("http://host/live/alice/secret/42.ts", "xc"),
        range,
        nowEpochS,
      )?.url,
    ).toBe("http://host/timeshift/alice/secret/1/2026-08-28:22-12/42.m3u8");
  });
});

describe("archivePickerDefault", () => {
  it("starts 59:30 before now on the same day", () => {
    const now = new Date(2026, 7, 29, 14, 7, 0);
    expect(archivePickerDefault(now)).toEqual({ daysBack: 0, time: "13:07" });
  });

  it("rolls to yesterday when 59:30 back crosses midnight", () => {
    const now = new Date(2026, 7, 29, 0, 20, 0);
    expect(archivePickerDefault(now)).toEqual({ daysBack: 1, time: "23:20" });
  });
});

describe("xtream timeshift start timezone", () => {
  it("formats the start in the panel timezone when known", () => {
    // 2026-08-28 20:00 UTC is 22:00 in Europe/Ljubljana (CEST)
    expect(
      buildArchiveUrl(urlFields("http://host/live/alice/secret/42.ts", "xc"), {
        ...WINDOW,
        timezone: "Europe/Ljubljana",
      }),
    ).toBe("http://host/timeshift/alice/secret/60/2026-08-28:22-00/42.m3u8");
  });

  it("falls back to UTC for unknown zones and when none is registered", () => {
    expect(
      buildArchiveUrl(urlFields("http://host/live/alice/secret/42.ts", "xc"), {
        ...WINDOW,
        timezone: "Not/AZone",
      }),
    ).toBe("http://host/timeshift/alice/secret/60/2026-08-28:20-00/42.m3u8");
    expect(
      buildArchiveUrl(urlFields("http://host/live/alice/secret/42.ts", "xc"), {
        ...WINDOW,
        timezone: null,
      }),
    ).toBe("http://host/timeshift/alice/secret/60/2026-08-28:20-00/42.m3u8");
  });
});

describe("describeArchiveFailure", () => {
  it("explains an empty archive instead of surfacing hls.js internals", () => {
    expect(describeArchiveFailure("networkError: manifestParsingError")).toMatch(/no archive/);
    expect(describeArchiveFailure("HLS playback timed out")).toMatch(/no archive/);
    expect(describeArchiveFailure("mediaError: bufferStalled")).toBe(
      "Archive playback failed: mediaError: bufferStalled",
    );
  });
});
