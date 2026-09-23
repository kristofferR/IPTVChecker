import { describe, expect, it } from "bun:test";
import { confirmPlaybackStarted } from "../src/lib/playbackStartup";

function mediaFixture() {
  let callback: VideoFrameRequestCallback | undefined;
  const video = {
    currentTime: 0,
    paused: false,
    error: null,
    videoWidth: 1920,
    play: () => Promise.resolve(),
    requestVideoFrameCallback: (next: VideoFrameRequestCallback) => {
      callback = next;
      return 1;
    },
    cancelVideoFrameCallback: () => {
      callback = undefined;
    },
  };
  return {
    video: video as unknown as HTMLVideoElement,
    presentFrame: () => callback?.(0, {} as VideoFrameCallbackMetadata),
    hasFrameCallback: () => callback !== undefined,
    pause: () => {
      video.paused = true;
    },
  };
}

describe("playback startup", () => {
  it("observes the first video frame when track discovery corrects an audio-only result", async () => {
    const fixture = mediaFixture();
    let audioOnly = true;
    let started = false;
    const cancel = confirmPlaybackStarted(
      fixture.video,
      () => audioOnly,
      () => {
        started = true;
      },
      () => {},
    );
    try {
      expect(fixture.hasFrameCallback()).toBe(false);
      audioOnly = false;
      await Bun.sleep(120);
      expect(fixture.hasFrameCallback()).toBe(true);
      expect(started).toBe(false);
      fixture.presentFrame();
      expect(started).toBe(true);
    } finally {
      cancel();
    }
  });

  it("accepts radio playback when track discovery completes after startup begins", async () => {
    const fixture = mediaFixture();
    Object.defineProperty(fixture.video, "videoWidth", { value: 0 });
    let audioOnly = false;
    let started = false;
    const cancel = confirmPlaybackStarted(
      fixture.video,
      () => audioOnly,
      () => {
        started = true;
      },
      () => {},
    );
    try {
      audioOnly = true;
      fixture.video.currentTime = 1;
      await Bun.sleep(120);
      expect(started).toBe(true);
    } finally {
      cancel();
    }
  });

  it("does not mistake progressing audio for working video when a video track exists", async () => {
    const fixture = mediaFixture();
    Object.defineProperty(fixture.video, "videoWidth", { value: 0 });
    let started = false;
    const cancel = confirmPlaybackStarted(
      fixture.video,
      () => false,
      () => {
        started = true;
      },
      () => {},
    );
    try {
      fixture.video.currentTime = 1;
      await Bun.sleep(120);
      expect(started).toBe(false);
    } finally {
      cancel();
    }
  });

  it("keeps a ready video in startup until it presents a frame", () => {
    const fixture = mediaFixture();
    let started = false;
    const cancel = confirmPlaybackStarted(
      fixture.video,
      false,
      () => {
        started = true;
      },
      () => {},
    );
    try {
      expect(started).toBe(false);
      fixture.presentFrame();
      expect(started).toBe(true);
    } finally {
      cancel();
    }
  });

  it("accepts decoded frames when WebKit does not deliver video frame callbacks", async () => {
    const fixture = mediaFixture();
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { visibilityState: "visible" },
    });
    let totalVideoFrames = 0;
    let droppedVideoFrames = 0;
    fixture.video.getVideoPlaybackQuality = () =>
      ({ totalVideoFrames, droppedVideoFrames }) as VideoPlaybackQuality;
    let started = false;
    const cancel = confirmPlaybackStarted(
      fixture.video,
      false,
      () => {
        started = true;
      },
      () => {},
    );
    try {
      fixture.video.currentTime = 1;
      totalVideoFrames = 12;
      droppedVideoFrames = 12;
      await Bun.sleep(120);
      expect(started).toBe(false);
      totalVideoFrames = 13;
      await Bun.sleep(120);
      expect(started).toBe(true);
    } finally {
      cancel();
      if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
      else Reflect.deleteProperty(globalThis, "document");
    }
  });

  it("does not accept a preview frame while paused, or callbacks after cancellation", () => {
    const fixture = mediaFixture();
    let starts = 0;
    fixture.pause();
    const cancel = confirmPlaybackStarted(
      fixture.video,
      false,
      () => {
        starts++;
      },
      () => {},
    );
    fixture.presentFrame();
    expect(starts).toBe(0);
    cancel();
    expect(fixture.hasFrameCallback()).toBe(false);
    fixture.presentFrame();
    expect(starts).toBe(0);
  });

  it("rejects playback denial so the caller can try its next route", async () => {
    const fixture = mediaFixture();
    fixture.video.play = () => Promise.reject(new Error("Decode failed"));
    let failure: string | undefined;
    const cancel = confirmPlaybackStarted(
      fixture.video,
      false,
      () => {},
      (reason) => {
        failure = reason;
      },
    );
    await Promise.resolve();
    cancel();
    expect(failure).toBe("Decode failed");
  });

  it("accepts progressing audio-only playback without requiring a video frame", async () => {
    const fixture = mediaFixture();
    let started = false;
    const cancel = confirmPlaybackStarted(
      fixture.video,
      true,
      () => {
        started = true;
      },
      () => {},
    );
    try {
      expect(fixture.hasFrameCallback()).toBe(false);
      expect(started).toBe(false);
      fixture.video.currentTime = 1;
      await Bun.sleep(120);
      expect(started).toBe(true);
    } finally {
      cancel();
    }
  });
});
