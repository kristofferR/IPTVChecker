import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import type Hls from "hls.js";
import { Events } from "hls.js";
import { logger } from "../src/lib/logger";
import { observePlayback } from "../src/lib/playbackObserver";
import { PlaybackRecorder } from "../src/lib/playbackTelemetry";

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
let restoreLogs = () => {};
beforeEach(() => {
  const info = spyOn(logger, "info").mockImplementation(() => {});
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  restoreLogs = () => {
    info.mockRestore();
    warn.mockRestore();
  };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: Object.assign(new EventTarget(), { hidden: false }),
  });
});
afterEach(() => {
  restoreLogs();
  if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
  else Reflect.deleteProperty(globalThis, "document");
});

function observerFixture() {
  const video = Object.assign(new EventTarget(), {
    buffered: { length: 0 },
    currentTime: 0,
    paused: false,
    seeking: false,
    canPlayType: () => "",
  }) as unknown as HTMLVideoElement;
  const recorder = new PlaybackRecorder({
    id: "observer-test",
    channelIndex: 0,
    channelName: "Replay",
    mode: "archive",
    streamType: "mpegts",
    appVersion: "test",
    platform: "macos",
  });
  return { observer: observePlayback(video, recorder, () => false), video, recorder };
}

function engineFixture() {
  let destroyed = false;
  let removals = 0;
  const listeners = new Map<string, (...args: unknown[]) => void>();
  return {
    on(event: string, listener: (...args: unknown[]) => void) {
      listeners.set(event, listener);
    },
    off(event: string) {
      removals++;
      if (destroyed) throw new Error("this._player_engine is null");
      listeners.delete(event);
    },
    destroy() {
      destroyed = true;
    },
    attachMediaElement() {},
    load() {},
    removals: () => removals,
    emit: (event: string, ...args: unknown[]) => listeners.get(event)?.(...args),
  };
}

it("detaches failed-route diagnostics before destruction and can close the next route", () => {
  const { observer } = observerFixture();
  const player = engineFixture();
  try {
    observer.route("mpegts.js");
    observer.mpegts(player);
    observer.closeRoute();
    player.destroy();
    expect(() => observer.route("native")).not.toThrow();
    expect(player.removals()).toBe(2);
  } finally {
    observer.close();
  }
});

it("drains every diagnostic listener even when an engine was already destroyed", () => {
  const { observer } = observerFixture();
  const disposed = engineFixture();
  const remaining = engineFixture();
  try {
    observer.route("mpegts.js");
    observer.mpegts(disposed);
    observer.mpegts(remaining);
    disposed.destroy();
    expect(() => observer.closeRoute()).not.toThrow();
    expect(remaining.removals()).toBe(2);
    expect(() => observer.closeRoute()).not.toThrow();
    expect(disposed.removals()).toBe(2);
    expect(remaining.removals()).toBe(2);
  } finally {
    observer.close();
  }
});

it("retains startup codecs and structured errors across fallback routes with redacted logs", () => {
  const { observer, video, recorder } = observerFixture();
  const player = {
    ...engineFixture(),
    mediaInfo: {
      videoCodec: "avc1.640028",
      audioCodec: "ac-3",
      mimeType: 'video/mp2t; codecs="avc1.640028,ac-3"',
    },
  };
  try {
    observer.route("mpegts.js", "direct");
    observer.mpegts(player);
    player.emit("media_info");
    player.emit("media_info");
    player.emit("error", "MediaError", "CodecUnsupported", {
      code: 4,
      msg: "Decoder rejected https://provider/live/user/secret/1.ts?token=secret",
      get message() {
        throw new Error("Unavailable engine detail");
      },
      response: "private response body",
    });
    observer.failure("MPEG-TS rejected");
    observer.closeRoute();
    player.destroy();
    observer.route("native", "unknown");
    Object.defineProperty(video, "error", {
      value: {
        code: 4,
        message: "DEMUXER_ERROR_NO_SUPPORTED_STREAMS https://provider/live/user/secret/1.ts",
      },
    });
    video.dispatchEvent(new Event("error"));
    observer.failure("Format not supported");

    const events = recorder.snapshot().events;
    const details = events.map((event) => event.detail).join("\n");
    expect(details).toContain("avc1.640028");
    expect(details).toContain("ac-3");
    expect(details).toContain("code=4; msg=Decoder rejected [URL redacted]");
    expect(details).toContain("DEMUXER_ERROR_NO_SUPPORTED_STREAMS [URL redacted]");
    expect(details).toContain("Format not detected before route failed");
    expect(details).not.toContain("secret");
    expect(details).not.toContain("private response body");
    expect(
      events.filter((event) => event.kind === "route_failure").map((event) => event.detail),
    ).toEqual([
      "mpegts.js #1 (direct): MPEG-TS rejected",
      "native #2 (unknown): Format not supported",
    ]);
    expect(
      events.filter(
        (event) => event.kind === "stream_format" && event.detail.includes("video=avc1"),
      ).length,
    ).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("DEMUXER_ERROR_NO_SUPPORTED_STREAMS [URL redacted]"),
    );
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("audio=ac-3"));
  } finally {
    observer.close();
  }
});

it("captures HLS codec announcements and buffer failures before playback starts", () => {
  const { observer, recorder } = observerFixture();
  const engine = engineFixture();
  const hls = {
    ...engine,
    levels: [
      { videoCodec: "hvc1.1.6.L120.B0", audioCodec: "mp4a.40.2", width: 1920, height: 1080 },
    ],
  } as unknown as Hls;
  try {
    observer.route("hls.js");
    observer.hls(hls, Events);
    engine.emit(Events.MANIFEST_PARSED);
    engine.emit(Events.BUFFER_CODECS, Events.BUFFER_CODECS, {
      video: { container: "video/mp4", codec: "hvc1.1.6.L120.B0" },
    });
    engine.emit(Events.ERROR, Events.ERROR, {
      type: "mediaError",
      details: "bufferAddCodecError",
      fatal: true,
      mimeType: 'video/mp4; codecs="hvc1.1.6.L120.B0"',
      error: new Error("Unsupported codec https://provider/?password=secret"),
    });
    observer.failure("mediaError: bufferAddCodecError");
    observer.closeRoute();
    const events = recorder.snapshot().events;
    expect(events.some((event) => event.kind === "first_frame")).toBe(false);
    expect(events.map((event) => event.detail).join("\n")).toContain(
      'MIME=video/mp4; codecs="hvc1.1.6.L120.B0"',
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Error: Unsupported codec [URL redacted]"),
    );
    const count = events.length;
    engine.emit(Events.ERROR, Events.ERROR, { type: "ignored" });
    expect(recorder.snapshot().events.length).toBe(count);
  } finally {
    observer.close();
  }
});

it("records the requested MIME even when MediaSource rejects buffer creation", () => {
  const originalMediaSource = Object.getOwnPropertyDescriptor(globalThis, "MediaSource");
  class RejectingMediaSource {
    static isTypeSupported() {
      return false;
    }
    addSourceBuffer(_mime: string): never {
      throw new DOMException("Unsupported codec", "NotSupportedError");
    }
  }
  Object.defineProperty(globalThis, "MediaSource", {
    configurable: true,
    value: RejectingMediaSource,
  });
  const objectUrl = spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
  const { observer, recorder } = observerFixture();
  const source = new RejectingMediaSource();
  const originalAdd = source.addSourceBuffer;
  try {
    observer.route("mpegts.js");
    observer.attachMpegts(() => URL.createObjectURL(source as unknown as MediaSource));
    expect(() => source.addSourceBuffer('video/mp4; codecs="ac-3"')).toThrow("Unsupported codec");
    const details = recorder
      .snapshot()
      .events.map((event) => event.detail)
      .join("\n");
    expect(details).toContain('MIME=video/mp4; codecs="ac-3"; MSE=false; native=unsupported');
    expect(details).toContain("addSourceBuffer: NotSupportedError: Unsupported codec");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("addSourceBuffer: NotSupportedError"),
    );
    observer.closeRoute();
    expect(source.addSourceBuffer).toBe(originalAdd);
  } finally {
    observer.close();
    objectUrl.mockRestore();
    if (originalMediaSource) Object.defineProperty(globalThis, "MediaSource", originalMediaSource);
    else Reflect.deleteProperty(globalThis, "MediaSource");
  }
});
