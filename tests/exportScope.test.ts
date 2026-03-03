import { describe, expect, it } from "bun:test";
import {
  exportScopeFileSuffix,
  exportScopeLabel,
  resolveExportScopeResults,
  type ExportScope,
} from "../src/lib/exportScope";
import type { ChannelResult } from "../src/lib/types";

function makeResult(index: number): ChannelResult {
  return {
    index,
    playlist: "fixture.m3u8",
    name: `Channel ${index}`,
    group: "Group",
    url: `https://example.com/${index}.m3u8`,
    status: "alive",
    codec: null,
    resolution: null,
    width: null,
    height: null,
    fps: null,
    latency_ms: null,
    video_bitrate: null,
    audio_bitrate: null,
    audio_codec: null,
    screenshot_path: null,
    label_mismatches: [],
    low_framerate: false,
    error_message: null,
    channel_id: `id-${index}`,
    extinf_line: "#EXTINF:-1,Channel",
    metadata_lines: [],
    stream_url: null,
  };
}

describe("export scope resolution", () => {
  const all = [makeResult(0), makeResult(1), makeResult(2)];
  const filtered = [makeResult(1), makeResult(2)];
  const selected = [makeResult(2)];

  it("returns expected result slice for each scope", () => {
    const cases: ExportScope[] = ["all", "filtered", "selected"];
    const byScope = {
      all,
      filtered,
      selected,
    };

    for (const scope of cases) {
      expect(resolveExportScopeResults(scope, all, filtered, selected)).toEqual(
        byScope[scope],
      );
    }
  });

  it("maps scope labels and filename suffixes", () => {
    expect(exportScopeLabel("all")).toBe("All");
    expect(exportScopeLabel("filtered")).toBe("Filtered");
    expect(exportScopeLabel("selected")).toBe("Selected");

    expect(exportScopeFileSuffix("all")).toBe("all");
    expect(exportScopeFileSuffix("filtered")).toBe("filtered");
    expect(exportScopeFileSuffix("selected")).toBe("selected");
  });
});
