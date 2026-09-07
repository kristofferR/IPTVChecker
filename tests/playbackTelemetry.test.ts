import { describe, expect, test } from "bun:test";
import {
  PLAYBACK_EVENT_LIMIT,
  PLAYBACK_SAMPLE_LIMIT,
  PLAYBACK_SESSION_LIMIT,
  PLAYBACK_SUMMARY_LIMIT,
  PlaybackRecorder,
  PlaybackTelemetryStore,
  sanitizePlaybackText,
} from "../src/lib/playbackTelemetry";

function session(index = 1) {
  let now = 0;
  const recorder = new PlaybackRecorder(
    {
      id: `session-${index}`,
      channelIndex: index,
      channelName: "Nature",
      mode: "live",
      streamType: "mpegts",
      appVersion: "test",
      platform: "linux",
    },
    () => now,
  );
  return {
    recorder,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("playback observations", () => {
  test("overlapping waiting and stalled signals count one interruption, closed only by progress", () => {
    const { recorder: r, advance } = session();
    r.route("mpegts.js");
    r.firstFrame();
    r.sample(0, 6);
    advance(1000);
    r.sample(1, 6);
    r.event("waiting");
    r.event("stalled");
    advance(1200);
    r.event("resync", "timestamp gap", 0.8);
    expect(r.snapshot().summary.interruptionMs).toBe(1200);
    expect(r.snapshot().summary.interruptions).toBe(1);
    r.sample(2, 6);
    advance(1000);
    r.sample(3, 6);
    expect(r.snapshot().summary.interruptionMs).toBe(1200);
    expect(r.snapshot().summary.skippedSeconds).toBe(0.8);
  });
  test("reconnect and engine fallback preserve the session and confirm recovery on progress", () => {
    const { recorder: r, advance } = session();
    r.route("native");
    advance(200);
    r.event("ready");
    advance(800);
    r.firstFrame();
    r.sample(1, 2);
    r.event("reconnect");
    advance(1000);
    r.route("hls.js");
    r.event("ready");
    expect(r.snapshot().summary.counters.reconnect_restored).toBeUndefined();
    advance(500);
    r.firstFrame();
    r.finish("stopped");
    const s = r.snapshot().summary;
    expect(s.firstFrameMs).toBe(1000);
    expect(s.readyMs).toBe(200);
    expect(s.interruptionMs).toBe(1500);
    expect(s.counters.reconnect_restored).toBe(1);
    expect(s.engine).toBe("hls.js");
    expect(s.id).toBe("session-1");
    advance(5000);
    r.finish("failed");
    r.event("waiting");
    expect(r.snapshot().summary).toEqual(s);
  });
  test("paused, seeking and background intervals do not imply source interruptions", () => {
    const { recorder: r, advance } = session();
    r.firstFrame();
    r.sample(1, 6);
    for (const context of ["paused", "seeking", "background"] as const) {
      r.context(context);
      r.event("waiting");
      advance(1000);
      r.sample(1, 5);
    }
    r.context("foreground");
    advance(1000);
    r.sample(1, 5);
    expect(r.snapshot().summary.interruptions).toBe(0);
    expect(r.snapshot().summary.backgroundMs).toBe(1000);
  });
  test("frame deltas are scoped by visibility and tolerate counters resetting on reload", () => {
    const { recorder: r, advance } = session();
    r.firstFrame();
    r.sample(1, 5, { total: 100, dropped: 1 });
    advance(1000);
    r.sample(2, 5, { total: 150, dropped: 2 });
    r.context("background");
    r.sample(2, 5, { total: 150, dropped: 2 });
    advance(1000);
    r.sample(3, 5, { total: 200, dropped: 42 });
    r.context("foreground");
    r.sample(3, 5, { total: 200, dropped: 42 });
    advance(1000);
    r.sample(4, 5, { total: 250, dropped: 43 });
    r.route("hls.js");
    r.sample(0, 5, { total: 0, dropped: 0 });
    advance(1000);
    r.sample(1, 5, { total: 50, dropped: 1 });
    const s = r.snapshot().summary;
    expect(s.foregroundFrames).toBe(150);
    expect(s.foregroundDropped).toBe(3);
    expect(s.backgroundFrames).toBe(50);
    expect(s.backgroundDropped).toBe(40);
  });
  test("a suspended timer records unobserved time without counting drops or a source stall", () => {
    const { recorder: r, advance } = session();
    r.firstFrame();
    r.sample(1, 5, { total: 50, dropped: 0 });
    advance(60_000);
    r.sample(1, 5, { total: 3050, dropped: 3000 });
    const s = r.snapshot().summary;
    expect(s.unobservedMs).toBe(60_000);
    expect(s.interruptions).toBe(0);
    expect(s.foregroundDropped).toBe(0);
    expect(r.snapshot().samples.at(-1)?.context).toBe("unobserved");
  });
  test("no-progress detection starts at the last observed advance and closes on finish", () => {
    const { recorder: r, advance } = session();
    r.firstFrame();
    r.sample(1, 2);
    advance(1000);
    r.sample(1, 1);
    advance(1000);
    r.sample(1, 0);
    advance(1000);
    r.finish("failed");
    expect(r.snapshot().summary.noProgressIntervals).toBe(1);
    expect(r.snapshot().summary.interruptionMs).toBe(3000);
  });
  test("raw ring eviction never changes full-session counters or the buffer distribution", () => {
    const { recorder: r, advance } = session();
    r.firstFrame();
    for (let i = 0; i < PLAYBACK_SAMPLE_LIMIT + 100; i++) {
      advance(1000);
      r.sample(i, 4);
      r.event("engine_error", "network error");
    }
    const record = r.snapshot();
    expect(record.samples.length).toBe(PLAYBACK_SAMPLE_LIMIT);
    expect(record.events.length).toBe(PLAYBACK_EVENT_LIMIT);
    expect(record.summary.counters.engine_error).toBe(700);
    expect(record.summary.omittedSamples).toBe(100);
    expect(record.summary.bufferMedian).toBe(4);
    expect(record.samples[0].atMs).toBe(101000);
  });
  test("transport snapshots deduplicate cumulative counters and reject old attempts", () => {
    const { recorder: r } = session();
    r.transport(1, { upstream_timeout: 1 });
    r.transport(1, { upstream_timeout: 1 });
    r.transport(2, { upstream_timeout: 1, remux_warning: 8 });
    r.transport(1, { upstream_timeout: 20 });
    expect(r.snapshot().summary.counters.upstream_timeout).toBe(2);
    expect(r.snapshot().summary.counters.remux_warning).toBe(8);
  });
});

describe("retention and exports", () => {
  test("keeps bounded details and summaries, and clears reused channel identities with the playlist", () => {
    const store = new PlaybackTelemetryStore();
    for (let i = 0; i < PLAYBACK_SUMMARY_LIMIT + 5; i++) {
      const { recorder } = session(i);
      store.start(recorder);
      recorder.event("ready");
      store.finish("stopped");
    }
    expect(store.getSummaries().length).toBe(PLAYBACK_SUMMARY_LIMIT);
    expect(store.exportRecords().sessions.length).toBe(PLAYBACK_SESSION_LIMIT);
    expect(store.get(5)?.events).toEqual([]);
    expect(store.get(0)).toBeNull();
    store.clear();
    store.start(session(5).recorder);
    expect(store.getSummaries().length).toBe(1);
    expect(store.get(5)?.summary.ended).toBeNull();
  });
  test("report subscribers are not notified by live sampling", () => {
    const store = new PlaybackTelemetryStore();
    let reportUpdates = 0;
    store.subscribeReport(() => reportUpdates++);
    store.start(session().recorder);
    for (let i = 0; i < 100; i++) store.publish();
    expect(reportUpdates).toBe(1);
    store.finish("stopped");
    expect(reportUpdates).toBe(2);
  });
  test("sanitizes credentials before retention, including nested encoded proxy URLs", () => {
    const { recorder: r } = session();
    const secrets = [
      "https://user:secret@example.com/live/alice/password/1.ts?token=hidden",
      "https%3A%2F%2Fhost%2Flive%2Fsecret%2Fp%2F1",
      "/timeshift/alice/secret/60/start/1.ts",
      "failed?token=secret&password=secret",
    ];
    for (const value of secrets) r.event("engine_error", value);
    const json = JSON.stringify(r.snapshot());
    for (const secret of ["secret", "alice", "hidden", "password/", "user:"])
      expect(json).not.toContain(secret);
    expect(sanitizePlaybackText("normal decoder error")).toBe("normal decoder error");
  });
});
