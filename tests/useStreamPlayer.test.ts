import { describe, expect, it } from "bun:test";
import {
  areStreamMetadataEqual,
  classifyStream,
  chooseLiveBufferPlaybackRate,
  decidePlaybackRecovery,
  findLiveBufferResyncTarget,
  findLiveLatencyCatchUpTarget,
  formatPlaybackRecoveryMessage,
  getHlsFatalRecoveryAction,
  getMpegtsPlaybackRoutes,
  getNextPlaybackRecoveryAttempt,
  PLAYBACK_RECOVERY_WINDOW_MS,
  prunePlaybackRecoveryHistory,
  recordPlaybackRecoveryAttempt,
  shouldResetPlaybackRecoveryAttempts,
  shouldSuspendPlaybackWatchdog,
  shouldTryXtreamHlsBeforeMpegts,
  supportsNativeHlsPlayback,
  tryConvertToXtreamHls,
  type StreamMetadata,
  type StreamType,
} from "../src/lib/playback";

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

  it("uses the compatible direct route before remux for initial live playback", () => {
    const routes = getMpegtsPlaybackRoutes(
      "https://example.com/live.ts",
      3210,
      true,
      false,
    );

    expect(routes).toHaveLength(2);
    expect(routes[0]?.kind).toBe("direct");
    expect(routes[0]?.url).toContain("reconnect=1");
    expect(routes[0]?.url).not.toContain("remux=1");
    expect(routes[1]?.kind).toBe("remux");
    expect(routes[1]?.url).toContain("remux=1");
  });

  it("prefers timestamp-normalizing remux when recovering live playback", () => {
    const routes = getMpegtsPlaybackRoutes(
      "https://example.com/live.ts",
      3210,
      true,
      true,
    );

    expect(routes.map((route) => route.kind)).toEqual(["remux", "direct"]);
  });

  it("tries Xtream HLS before MPEG-TS only during automatic recovery", () => {
    expect(shouldTryXtreamHlsBeforeMpegts("manual")).toBe(false);
    expect(shouldTryXtreamHlsBeforeMpegts("recovery")).toBe(true);
  });

  it("uses one non-remux URL for VOD and direct playback without a proxy", () => {
    const vodRoutes = getMpegtsPlaybackRoutes(
      "https://example.com/movie.ts",
      3210,
      false,
      false,
    );

    expect(vodRoutes).toHaveLength(1);
    expect(vodRoutes[0]?.url).not.toContain("remux=1");
    expect(getMpegtsPlaybackRoutes("https://example.com/live.ts", 0, true, false)).toEqual([
      { kind: "direct", url: "https://example.com/live.ts" },
    ]);
  });

  it("suspends playback watchdog recovery while the app is hidden", () => {
    expect(shouldSuspendPlaybackWatchdog("hidden")).toBe(true);
    expect(shouldSuspendPlaybackWatchdog("visible")).toBe(false);
  });

  it("converts common Xtream MPEG-TS URL forms to HLS", () => {
    expect(
      tryConvertToXtreamHls("http://provider.example/live/user/pass/12345.ts"),
    ).toBe("http://provider.example/live/user/pass/12345.m3u8");
    expect(
      tryConvertToXtreamHls("https://provider.example/user/pass/12345?token=abc"),
    ).toBe("https://provider.example/live/user/pass/12345.m3u8?token=abc");
    expect(
      tryConvertToXtreamHls("http://provider.example/live/user/pass/channel.ts"),
    ).toBeNull();
  });

  it("caps automatic clean reconnect attempts within a rolling window", () => {
    const now = 1_000_000;
    expect(getNextPlaybackRecoveryAttempt([], now)).toBe(1);
    expect(getNextPlaybackRecoveryAttempt([now - 5_000], now)).toBe(2);
    expect(
      getNextPlaybackRecoveryAttempt([now - 5_000, now - 10_000], now),
    ).toBe(3);
    expect(
      getNextPlaybackRecoveryAttempt(
        [now - 5_000, now - 10_000, now - 15_000, now - 20_000, now - 25_000],
        now,
      ),
    ).toBeNull();
  });

  it("ages old reconnect attempts out of the rolling window", () => {
    const now = 1_000_000;
    const stale = now - PLAYBACK_RECOVERY_WINDOW_MS - 1;
    const recent = now - 30_000;

    expect(prunePlaybackRecoveryHistory([stale, recent], now)).toEqual([recent]);
    expect(getNextPlaybackRecoveryAttempt([stale, recent], now)).toBe(2);
    expect(recordPlaybackRecoveryAttempt([stale, recent], now)).toEqual([recent, now]);
  });

  it("resets recovery attempts for manual retry or channel switches", () => {
    expect(shouldResetPlaybackRecoveryAttempts("manual", 12, 12)).toBe(true);
    expect(shouldResetPlaybackRecoveryAttempts("recovery", 12, 12)).toBe(false);
    expect(shouldResetPlaybackRecoveryAttempts("recovery", 12, 18)).toBe(true);
  });

  it("does not auto-recover while user-paused", () => {
    expect(
      decidePlaybackRecovery({
        issue: "watchdog_stall",
        recoveryTimestamps: [],
        now: 1_000_000,
        isPaused: true,
        contentType: "live",
      }),
    ).toEqual({ kind: "ignore" });
  });

  it("does not auto-recover when VOD reaches a natural end", () => {
    expect(
      decidePlaybackRecovery({
        issue: "ended",
        recoveryTimestamps: [],
        now: 1_000_000,
        isPaused: false,
        contentType: "movie",
      }),
    ).toEqual({ kind: "ignore" });

    expect(
      decidePlaybackRecovery({
        issue: "ended",
        recoveryTimestamps: [],
        now: 1_000_000,
        isPaused: false,
        contentType: "live",
      }),
    ).toEqual({ kind: "retry", nextAttempt: 1 });
  });

  it("formats reconnect status messaging for the player UI", () => {
    expect(formatPlaybackRecoveryMessage(1)).toBe(
      "Stream interrupted. Reconnecting (1/5)...",
    );
    expect(formatPlaybackRecoveryMessage(5)).toBe(
      "Stream interrupted. Reconnecting (5/5)...",
    );
  });

  it("uses hls.js recovery before rebuilding the whole player", () => {
    expect(getHlsFatalRecoveryAction("networkError")).toBe("restart_network");
    expect(getHlsFatalRecoveryAction("mediaError")).toBe("recover_media");
    expect(getHlsFatalRecoveryAction("otherError")).toBe("reconnect");
    expect(getHlsFatalRecoveryAction()).toBe("reconnect");
  });

  it("jumps across a small buffered live timestamp gap", () => {
    expect(
      findLiveBufferResyncTarget(10, [
        { start: 0, end: 10 },
        { start: 10.5, end: 20 },
      ]),
    ).toBeCloseTo(10.55);
    expect(
      findLiveBufferResyncTarget(10, [
        { start: 0, end: 10 },
        { start: 45, end: 55 },
      ]),
    ).toBeNull();
  });

  it("moves a stalled live decoder forward while retaining its network cushion", () => {
    expect(findLiveBufferResyncTarget(10, [{ start: 0, end: 20 }])).toBe(13);
    expect(findLiveBufferResyncTarget(10, [{ start: 0, end: 10.1 }])).toBeNull();
  });

  it("uses playback-rate hysteresis to rebuild a low live buffer", () => {
    expect(chooseLiveBufferPlaybackRate(1, 11.9)).toBe(0.97);
    expect(chooseLiveBufferPlaybackRate(0.97, 15)).toBe(0.97);
    expect(chooseLiveBufferPlaybackRate(0.97, 20)).toBe(1);
    expect(chooseLiveBufferPlaybackRate(1, 31)).toBe(1.08);
    expect(chooseLiveBufferPlaybackRate(1.08, 25)).toBe(1.08);
    expect(chooseLiveBufferPlaybackRate(1.08, 20)).toBe(1);
    expect(chooseLiveBufferPlaybackRate(1, 20)).toBe(1);
  });

  it("bounds accumulated live latency while retaining a playback cushion", () => {
    expect(findLiveLatencyCatchUpTarget(10, [{ start: 0, end: 69 }])).toBeNull();
    expect(findLiveLatencyCatchUpTarget(10, [{ start: 0, end: 71 }])).toBe(51);
    expect(findLiveLatencyCatchUpTarget(10, [{ start: 80, end: 180 }])).toBeNull();
  });

  it("deduplicates unchanged player metadata updates", () => {
    const metadata: StreamMetadata = {
      width: 1920,
      height: 1080,
      resolution: "1080p",
      codec: "H.264",
      fps: 50,
      videoBitrate: "8.0 Mbps",
      audioCodec: "AAC",
      audioBitrate: "192",
      audioOnly: false,
    };

    expect(areStreamMetadataEqual(metadata, { ...metadata })).toBe(true);
    expect(
      areStreamMetadataEqual(metadata, { ...metadata, videoBitrate: "8.1 Mbps" }),
    ).toBe(false);
    expect(areStreamMetadataEqual(metadata, null)).toBe(false);
  });
});
