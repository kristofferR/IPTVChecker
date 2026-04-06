import { describe, expect, it } from "bun:test";
import {
  classifyStream,
  supportsNativeHlsPlayback,
  type StreamType,
} from "../src/hooks/useStreamPlayer";

function canPlayTypes(
  supportByMime: Record<string, "" | "maybe" | "probably">,
): Pick<HTMLMediaElement, "canPlayType"> {
  return {
    canPlayType: (mimeType: string) => supportByMime[mimeType] ?? "",
  };
}

describe("useStreamPlayer helpers", () => {
  it("classifies stream URLs with query strings and Xtream-style paths", () => {
    const cases = [
      ["https://example.com/live/index.m3u8?token=abc", "hls"],
      ["https://example.com/live/channel.ts?token=abc", "mpegts"],
      ["https://provider.example.com/live/user/pass/12345", "mpegts"],
      ["https://example.com/watch/opaque", "unknown"],
    ] satisfies Array<[string, StreamType]>;

    for (const [url, expected] of cases) {
      expect(classifyStream(url)).toBe(expected);
    }
  });

  it("detects native HLS support from browser media capabilities", () => {
    expect(
      supportsNativeHlsPlayback(
        canPlayTypes({
          "application/vnd.apple.mpegurl": "maybe",
        }),
      ),
    ).toBe(true);

    expect(
      supportsNativeHlsPlayback(
        canPlayTypes({
          "application/x-mpegurl": "probably",
        }),
      ),
    ).toBe(true);

    expect(supportsNativeHlsPlayback(canPlayTypes({}))).toBe(false);
  });
});
