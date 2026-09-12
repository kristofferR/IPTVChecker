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
