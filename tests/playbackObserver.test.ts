import { afterEach, beforeEach, expect, it } from "bun:test";
import { observePlayback } from "../src/lib/playbackObserver";
import { PlaybackRecorder } from "../src/lib/playbackTelemetry";

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
beforeEach(() => {
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: Object.assign(new EventTarget(), { hidden: false }),
  });
});
afterEach(() => {
  if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
  else Reflect.deleteProperty(globalThis, "document");
});

function observerFixture() {
  const video = Object.assign(new EventTarget(), {
    buffered: { length: 0 },
    currentTime: 0,
    paused: false,
    seeking: false,
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
  return observePlayback(video, recorder, () => false);
}

function engineFixture() {
  let destroyed = false;
  let removals = 0;
  return {
    on() {},
    off() {
      removals++;
      if (destroyed) throw new Error("this._player_engine is null");
    },
    destroy() {
      destroyed = true;
    },
    attachMediaElement() {},
    load() {},
    removals: () => removals,
  };
}

it("detaches failed-route diagnostics before destruction and can close the next route", () => {
  const observer = observerFixture();
  const player = engineFixture();
  try {
    observer.route("mpegts.js");
    observer.mpegts(player);
    observer.closeRoute();
    player.destroy();
    expect(() => observer.route("native")).not.toThrow();
    expect(player.removals()).toBe(1);
  } finally {
    observer.close();
  }
});

it("drains every diagnostic listener even when an engine was already destroyed", () => {
  const observer = observerFixture();
  const disposed = engineFixture();
  const remaining = engineFixture();
  try {
    observer.route("mpegts.js");
    observer.mpegts(disposed);
    observer.mpegts(remaining);
    disposed.destroy();
    expect(() => observer.closeRoute()).not.toThrow();
    expect(remaining.removals()).toBe(1);
    expect(() => observer.closeRoute()).not.toThrow();
    expect(disposed.removals()).toBe(1);
    expect(remaining.removals()).toBe(1);
  } finally {
    observer.close();
  }
});
