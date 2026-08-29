import { describe, expect, it } from "bun:test";
import {
  applyContentVisibilityToPreview,
  applySourceFilterToPreview,
  compileSourceFilterRegex,
  hasDirtySourceFilter,
  normalizeSourceFilter,
  resolvePreservedGroupFilter,
  validateSourceFilterPattern,
} from "../src/lib/sourceFilter";
import type { CurrentSourceDescriptor, PlaylistPreview } from "../src/lib/types";

const fileSource: CurrentSourceDescriptor = {
  kind: "path",
  path: "/tmp/sample.m3u8",
};

const preview: PlaylistPreview = {
  file_path: "/tmp/sample.m3u8",
  file_name: "sample.m3u8",
  source_identity: "path:/tmp/sample.m3u8",
  saved_playlist_id: null,
  server_location: "SE",
  single_provider: true,
  xtream_max_connections: null,
  xtream_account_info: null,
  total_channels: 3,
  live_count: 2,
  movie_count: 1,
  series_count: 0,
  groups: ["Kids", "Sports", "Movies"],
  epg_sources: [],
  epg_sources_by_playlist: {},
  channels: [
    {
      index: 8,
      playlist: "sample.m3u8",
      name: "SE: Disney Junior [Multi-Audio]",
      group: "Kids",
      language: null,
      tvg_id: null,
      tvg_name: null,
      tvg_logo: null,
      tvg_chno: null,
      url: "http://example.com/disney.m3u8",
      content_type: "live",
      extinf_line: '#EXTINF:-1 group-title="Kids",SE: Disney Junior [Multi-Audio]',
      metadata_lines: [],
    },
    {
      index: 42,
      playlist: "sample.m3u8",
      name: "Friday Event",
      group: "Sports",
      language: null,
      tvg_id: null,
      tvg_name: null,
      tvg_logo: null,
      tvg_chno: null,
      url: "http://example.com/event.m3u8",
      content_type: "live",
      extinf_line: '#EXTINF:-1 group-title="Sports",Friday Event',
      metadata_lines: [],
    },
    {
      index: 107,
      playlist: "sample.m3u8",
      name: "Cinema One",
      group: "Movies",
      language: null,
      tvg_id: null,
      tvg_name: null,
      tvg_logo: null,
      tvg_chno: null,
      url: "http://example.com/movie.mp4",
      content_type: "movie",
      extinf_line: '#EXTINF:-1 group-title="Movies",Cinema One',
      metadata_lines: [],
    },
  ],
};

describe("sourceFilter helpers", () => {
  it("normalizes missing and padded values", () => {
    expect(normalizeSourceFilter(undefined)).toBe("");
    expect(normalizeSourceFilter(null)).toBe("");
    expect(normalizeSourceFilter("  test  ")).toBe("test");
  });

  it("only marks the filter dirty when a source is loaded", () => {
    expect(hasDirtySourceFilter("sports", "", null)).toBe(false);
    expect(hasDirtySourceFilter("sports", "", fileSource)).toBe(true);
    expect(hasDirtySourceFilter(" sports ", "sports", fileSource)).toBe(false);
  });

  it("preserves the group filter only when it still exists", () => {
    expect(resolvePreservedGroupFilter("all", ["Sports", "News"])).toBe("all");
    expect(resolvePreservedGroupFilter("sports", ["Sports", "News"])).toBe("sports");
    expect(resolvePreservedGroupFilter("Movies", ["Sports", "News"])).toBe("all");
  });

  it("validates source filters with the same case-insensitive prefix handling as apply", () => {
    expect(validateSourceFilterPattern("(?i)disney")).toBeNull();
    expect(validateSourceFilterPattern("^(?!.*(event|ppv))")).toBeNull();
  });

  it("compiles source filters as case-insensitive regexes", () => {
    const matcher = compileSourceFilterRegex("(?i)disney");
    expect(matcher?.test("SE: DISNEY JUNIOR")).toBe(true);
  });

  it("reapplies source filters to a cached preview while preserving source groups", () => {
    const filtered = applySourceFilterToPreview(preview, "^(?!.*(event|ppv)).*");

    expect(filtered.channels.map((channel) => channel.name)).toEqual([
      "SE: Disney Junior [Multi-Audio]",
      "Cinema One",
    ]);
    expect(filtered.total_channels).toBe(2);
    expect(filtered.live_count).toBe(1);
    expect(filtered.movie_count).toBe(1);
    expect(filtered.groups).toEqual(preview.groups);
    expect(filtered.channels.map((channel) => channel.index)).toEqual([8, 107]);
  });

  it("keeps only EPG sources for represented cached directory playlists", () => {
    const filtered = applySourceFilterToPreview(
      {
        ...preview,
        epg_sources: ["https://example.com/kids.xml", "https://example.com/sports.xml"],
        epg_sources_by_playlist: {
          "kids.m3u8": ["https://example.com/kids.xml"],
          "sports.m3u8": ["https://example.com/sports.xml"],
        },
        channels: [
          { ...preview.channels[0], playlist: "kids.m3u8" },
          { ...preview.channels[1], playlist: "sports.m3u8" },
        ],
      },
      "Disney",
    );

    expect(filtered.epg_sources).toEqual(["https://example.com/kids.xml"]);
    expect(filtered.epg_sources_by_playlist).toEqual({
      "kids.m3u8": ["https://example.com/kids.xml"],
    });
  });

  it("preserves EPG sources when a represented playlist has no source mapping", () => {
    const epgSources = ["https://example.com/kids.xml", "https://example.com/shared.xml"];
    const epgSourcesByPlaylist = {
      "kids.m3u8": ["https://example.com/kids.xml"],
      "removed.m3u8": ["https://example.com/shared.xml"],
    };
    const filtered = applySourceFilterToPreview(
      {
        ...preview,
        epg_sources: epgSources,
        epg_sources_by_playlist: epgSourcesByPlaylist,
        channels: [
          { ...preview.channels[0], playlist: "kids.m3u8" },
          { ...preview.channels[1], name: "Disney Sports", playlist: "unmapped.m3u8" },
        ],
      },
      "Disney",
    );

    expect(filtered.epg_sources).toEqual(epgSources);
    expect(filtered.epg_sources_by_playlist).toEqual(epgSourcesByPlaylist);
  });

  it("returns the preview unchanged when content visibility filtering is disabled", () => {
    const filtered = applyContentVisibilityToPreview(preview, false);

    expect(filtered).toBe(preview);
  });

  it("can hide VOD and series entries from the visible preview", () => {
    const filtered = applyContentVisibilityToPreview(
      {
        ...preview,
        total_channels: 4,
        series_count: 1,
        groups: ["Kids", "Sports", "Movies", "Series"],
        channels: [
          ...preview.channels,
          {
            index: 200,
            playlist: "sample.m3u8",
            name: "Series One",
            group: "Series",
            language: null,
            tvg_id: null,
            tvg_name: null,
            tvg_logo: null,
            tvg_chno: null,
            url: "http://example.com/series/one.mkv",
            content_type: "series",
            extinf_line: '#EXTINF:-1 group-title="Series",Series One',
            metadata_lines: [],
          },
        ],
      },
      true,
    );

    expect(filtered.channels.map((channel) => channel.name)).toEqual([
      "SE: Disney Junior [Multi-Audio]",
      "Friday Event",
    ]);
    expect(filtered.total_channels).toBe(2);
    expect(filtered.live_count).toBe(2);
    expect(filtered.movie_count).toBe(0);
    expect(filtered.series_count).toBe(0);
    expect(filtered.groups).toEqual(["Kids", "Sports"]);
  });
});
