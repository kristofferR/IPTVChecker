import { describe, expect, it } from "bun:test";
import {
  classifyStream,
  decidePlaybackRecovery,
  formatPlaybackRecoveryMessage,
  getNextPlaybackRecoveryAttempt,
  PLAYBACK_RECOVERY_WINDOW_MS,
  prunePlaybackRecoveryHistory,
  recordPlaybackRecoveryAttempt,
  shouldResetPlaybackRecoveryAttempts,
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

  it("caps automatic clean reconnect attempts within a rolling window", () => {
    const now = 1_000_000;
    expect(getNextPlaybackRecoveryAttempt([], now)).toBe(1);
    expect(getNextPlaybackRecoveryAttempt([now - 5_000], now)).toBe(2);
    expect(
      getNextPlaybackRecoveryAttempt([now - 5_000, now - 10_000], now),
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
      "Stream interrupted. Reconnecting (1/2)...",
    );
    expect(formatPlaybackRecoveryMessage(2)).toBe(
      "Stream interrupted. Reconnecting (2/2)...",
    );
  });
});
