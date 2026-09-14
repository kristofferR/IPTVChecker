/** Bounded, framework-independent playback observations. No stream URLs are retained. */
export const PLAYBACK_SAMPLE_LIMIT = 600;
export const PLAYBACK_EVENT_LIMIT = 200;
export const PLAYBACK_SESSION_LIMIT = 20;
export const PLAYBACK_SUMMARY_LIMIT = 1000;

export type PlaybackEventKind =
  | "route"
  | "route_failure"
  | "stream_format"
  | "ready"
  | "first_frame"
  | "waiting"
  | "stalled"
  | "reconnect"
  | "reconnect_restored"
  | "resync"
  | "latency_trim"
  | "library_recovery"
  | "player_failure"
  | "media_error"
  | "engine_error"
  | "append_error"
  | "remove_error"
  | "upstream_eof"
  | "upstream_timeout"
  | "upstream_error"
  | "proxy_reconnect"
  | "proxy_connected"
  | "pacing_warning"
  | "remux_warning";
export type PlaybackEndReason = "stopped" | "switched" | "finished" | "failed" | "unmounted";
export type PlaybackPhase = "starting" | "playing" | "reconnecting";
export type PlaybackEngine = "native" | "hls.js" | "mpegts.js";
export interface PlaybackIdentity {
  id: string;
  channelIndex: number;
  channelName: string;
  mode: "live" | "archive" | "vod";
  streamType: string;
  platform: string;
  appVersion: string;
}
export interface PlaybackSample {
  atMs: number;
  mediaTime: number;
  bufferSeconds: number;
  context: "foreground" | "background" | "paused" | "seeking" | "unobserved";
}
export interface PlaybackEvent {
  sequence: number;
  atMs: number;
  kind: PlaybackEventKind;
  detail: string;
  seconds?: number;
}
export interface PlaybackSummary extends PlaybackIdentity {
  startedAt: number;
  durationMs: number;
  engine: PlaybackEngine | null;
  phase: PlaybackPhase;
  context: PlaybackSample["context"];
  ended: PlaybackEndReason | null;
  readyMs: number | null;
  firstFrameMs: number | null;
  mediaTime: number;
  bufferSeconds: number | null;
  bufferMin: number | null;
  bufferMedian: number | null;
  bufferMax: number | null;
  interruptions: number;
  interruptionMs: number;
  noProgressIntervals: number;
  foregroundMs: number;
  backgroundMs: number;
  unobservedMs: number;
  foregroundFrames: number;
  foregroundDropped: number;
  backgroundFrames: number;
  backgroundDropped: number;
  framesAvailable: boolean;
  sourceBufferAvailable: boolean;
  transportAvailable: boolean;
  appends: number;
  removes: number;
  appendedBytes: number;
  counters: Partial<Record<PlaybackEventKind, number>>;
  skippedSeconds: number;
  omittedSamples: number;
  omittedEvents: number;
}
export interface PlaybackRecord {
  summary: PlaybackSummary;
  samples: readonly PlaybackSample[];
  events: readonly PlaybackEvent[];
}

// Diagnostics deliberately omit entire URLs, including encoded proxy targets.
export function sanitizePlaybackText(value: string): string {
  return value
    .replace(/https?(?::\/\/|%3a%2f%2f)[^\s<>"']*/gi, "[URL redacted]")
    .replace(/(?:\/(?:live|movie|series|timeshift))\/[^\s?#]+/gi, "/[path redacted]")
    .replace(/([?&](?:[^=\s&]+)=)[^\s&#]*/g, "$1[redacted]")
    .slice(0, 240);
}

class Ring<T> {
  private values: T[] = [];
  private cursor = 0;
  omitted = 0;
  constructor(private readonly limit: number) {}
  push(value: T) {
    if (this.values.length < this.limit) this.values.push(value);
    else {
      this.values[this.cursor] = value;
      this.cursor = (this.cursor + 1) % this.limit;
      this.omitted++;
    }
  }
  read(): T[] {
    return [...this.values.slice(this.cursor), ...this.values.slice(0, this.cursor)];
  }
}

export class PlaybackRecorder {
  private readonly started: number;
  private lastTick: number;
  private lastProgress: number;
  private previousMediaTime: number | null = null;
  private interruptionStart: number | null = null;
  private reconnectPending = false;
  private hasProgress = false;
  private transportAttempt = -1;
  private transportCounters: Partial<Record<PlaybackEventKind, number>> = {};
  private frameBaseline: { total: number; dropped: number } | null = null;
  private samples = new Ring<PlaybackSample>(PLAYBACK_SAMPLE_LIMIT);
  private events = new Ring<PlaybackEvent>(PLAYBACK_EVENT_LIMIT);
  // Half-second histogram, last bucket includes everything >= 60 seconds.
  private bufferHistogram = new Uint32Array(121);
  private bufferCount = 0;
  private eventSequence = 0;
  private summary: PlaybackSummary;

  constructor(
    identity: PlaybackIdentity,
    private readonly now = () => performance.now(),
  ) {
    this.started = this.lastTick = this.lastProgress = now();
    this.summary = {
      ...identity,
      channelName: sanitizePlaybackText(identity.channelName),
      startedAt: Date.now(),
      durationMs: 0,
      engine: null,
      phase: "starting",
      context: "foreground",
      ended: null,
      readyMs: null,
      firstFrameMs: null,
      mediaTime: 0,
      bufferSeconds: null,
      bufferMin: null,
      bufferMedian: null,
      bufferMax: null,
      interruptions: 0,
      interruptionMs: 0,
      noProgressIntervals: 0,
      foregroundMs: 0,
      backgroundMs: 0,
      unobservedMs: 0,
      foregroundFrames: 0,
      foregroundDropped: 0,
      backgroundFrames: 0,
      backgroundDropped: 0,
      framesAvailable: false,
      sourceBufferAvailable: false,
      transportAvailable: false,
      appends: 0,
      removes: 0,
      appendedBytes: 0,
      counters: {},
      skippedSeconds: 0,
      omittedSamples: 0,
      omittedEvents: 0,
    };
  }
  get id() {
    return this.summary.id;
  }
  get channelIndex() {
    return this.summary.channelIndex;
  }
  get ended() {
    return this.summary.ended !== null;
  }

  private tick() {
    const now = this.now();
    if (this.ended) return now;
    const elapsed = Math.max(0, now - this.lastTick);
    if (this.summary.context === "background") this.summary.backgroundMs += elapsed;
    else if (elapsed > 5000) {
      // A suspended WebView gives no evidence of source failure during the gap.
      this.summary.unobservedMs += elapsed;
      this.closeInterruption(this.lastTick);
      this.lastProgress = now;
      this.frameBaseline = null;
    } else if (this.summary.context === "foreground") this.summary.foregroundMs += elapsed;
    this.summary.durationMs = Math.max(0, now - this.started);
    this.lastTick = now;
    return now;
  }
  private closeInterruption(at = this.now()) {
    if (this.interruptionStart === null) return;
    this.summary.interruptionMs += Math.max(0, at - this.interruptionStart);
    this.interruptionStart = null;
  }
  private interrupt(at = this.now()) {
    if (
      !this.hasProgress ||
      this.summary.context !== "foreground" ||
      this.interruptionStart !== null
    )
      return;
    this.interruptionStart = at;
    this.summary.interruptions++;
  }
  context(context: PlaybackSample["context"]) {
    if (this.ended || context === this.summary.context) return;
    const now = this.tick();
    this.closeInterruption(now);
    this.summary.context = context;
    this.frameBaseline = null;
    this.previousMediaTime = null;
    this.lastProgress = now;
  }
  route(engine: PlaybackEngine) {
    if (this.ended) return;
    this.tick();
    this.summary.engine = engine;
    this.summary.sourceBufferAvailable = false;
    this.summary.transportAvailable = false;
    this.frameBaseline = null;
    this.previousMediaTime = null;
    this.lastProgress = this.now();
    this.event("route", engine);
  }
  event(kind: PlaybackEventKind, detail = "", seconds?: number, occurrences = 1) {
    if (this.ended) return;
    const now = this.tick();
    this.summary.counters[kind] = (this.summary.counters[kind] ?? 0) + occurrences;
    this.events.push({
      sequence: ++this.eventSequence,
      atMs: now - this.started,
      kind,
      detail: sanitizePlaybackText(detail),
      seconds,
    });
    if (kind === "waiting" || kind === "stalled") this.interrupt(now);
    if (kind === "reconnect") {
      this.interrupt(now);
      this.reconnectPending = true;
      this.summary.phase = "reconnecting";
    }
    if (kind === "resync" && seconds !== undefined)
      this.summary.skippedSeconds += Math.max(0, seconds);
    if (kind === "ready" && this.summary.readyMs === null)
      this.summary.readyMs = now - this.started;
  }
  enableTransport() {
    this.summary.transportAvailable = true;
  }
  transport(attempt: number, counters: Partial<Record<PlaybackEventKind, number>>) {
    if (this.ended || attempt < this.transportAttempt) return;
    if (attempt !== this.transportAttempt) {
      this.transportAttempt = attempt;
      this.transportCounters = {};
    }
    const kinds = [
      "upstream_eof",
      "upstream_timeout",
      "upstream_error",
      "proxy_reconnect",
      "proxy_connected",
      "pacing_warning",
      "remux_warning",
    ] as const;
    for (const kind of kinds) {
      const value = counters[kind];
      const previous = this.transportCounters[kind] ?? 0;
      if (value !== undefined && Number.isSafeInteger(value) && value > previous) {
        this.event(kind, "", undefined, value - previous);
        this.transportCounters[kind] = value;
      }
    }
  }
  firstFrame() {
    if (this.ended) return;
    if (this.summary.firstFrameMs === null) {
      this.summary.firstFrameMs = this.now() - this.started;
      this.event("first_frame");
    }
    this.progress();
  }
  private progress() {
    this.hasProgress = true;
    this.summary.phase = "playing";
    this.lastProgress = this.now();
    this.closeInterruption();
    if (this.reconnectPending) {
      this.reconnectPending = false;
      this.event("reconnect_restored");
    }
  }
  sourceBuffer(operation?: "append" | "remove", bytes = 0) {
    if (this.ended) return;
    this.summary.sourceBufferAvailable = true;
    if (operation === "append") {
      this.summary.appends++;
      this.summary.appendedBytes += bytes;
    }
    if (operation === "remove") this.summary.removes++;
  }
  sample(mediaTime: number, bufferSeconds: number, frames?: { total: number; dropped: number }) {
    if (this.ended || !Number.isFinite(mediaTime) || !Number.isFinite(bufferSeconds)) return;
    const before = this.lastTick;
    const now = this.tick();
    const measurable = now - before <= 5000;
    const context = measurable ? this.summary.context : "unobserved";
    if (context === "foreground" && this.previousMediaTime !== null) {
      if (mediaTime > this.previousMediaTime + 0.01) this.progress();
      else if (
        this.hasProgress &&
        now - this.lastProgress >= 2000 &&
        this.interruptionStart === null
      ) {
        this.interrupt(this.lastProgress);
        this.summary.noProgressIntervals++;
      }
    }
    this.previousMediaTime = mediaTime;
    this.summary.mediaTime = mediaTime;
    this.summary.bufferSeconds = Math.max(0, bufferSeconds);
    if (context === "foreground" && this.summary.phase === "playing") {
      const buffer = this.summary.bufferSeconds;
      this.summary.bufferMin = Math.min(this.summary.bufferMin ?? buffer, buffer);
      this.summary.bufferMax = Math.max(this.summary.bufferMax ?? buffer, buffer);
      this.bufferHistogram[Math.min(120, Math.floor(buffer * 2))]++;
      this.bufferCount++;
    }
    if (frames && Number.isFinite(frames.total) && Number.isFinite(frames.dropped)) {
      this.summary.framesAvailable = true;
      const baseline = this.frameBaseline;
      if (
        baseline &&
        frames.total >= baseline.total &&
        frames.dropped >= baseline.dropped &&
        measurable
      ) {
        const total = frames.total - baseline.total;
        const dropped = Math.min(total, frames.dropped - baseline.dropped);
        if (context === "foreground") {
          this.summary.foregroundFrames += total;
          this.summary.foregroundDropped += dropped;
        } else if (context === "background") {
          this.summary.backgroundFrames += total;
          this.summary.backgroundDropped += dropped;
        }
      }
      this.frameBaseline = frames;
    }
    this.samples.push({
      atMs: now - this.started,
      mediaTime,
      bufferSeconds: this.summary.bufferSeconds,
      context,
    });
  }
  finish(reason: PlaybackEndReason) {
    if (this.ended) return;
    this.tick();
    this.closeInterruption();
    this.summary.ended = reason;
    this.summary.bufferSeconds = null;
  }
  snapshot(): PlaybackRecord {
    this.tick();
    let accumulated = 0;
    let median: number | null = null;
    for (let bucket = 0; this.bufferCount > 0 && bucket < this.bufferHistogram.length; bucket++) {
      accumulated += this.bufferHistogram[bucket];
      if (accumulated >= this.bufferCount / 2) {
        median = bucket / 2;
        break;
      }
    }
    return {
      summary: {
        ...this.summary,
        counters: { ...this.summary.counters },
        bufferMedian: median,
        interruptionMs:
          this.summary.interruptionMs +
          (this.interruptionStart === null ? 0 : this.now() - this.interruptionStart),
        omittedSamples: this.samples.omitted,
        omittedEvents: this.events.omitted,
      },
      samples: this.samples.read(),
      events: this.events.read(),
    };
  }
}

/** Live notifications go only to the selected diagnostic card; report updates happen at boundaries. */
export class PlaybackTelemetryStore {
  private current: PlaybackRecorder | null = null;
  private records = new Map<string, PlaybackRecord>();
  private latest = new Map<number, PlaybackRecord>();
  private listeners = new Set<() => void>();
  private reportListeners = new Set<() => void>();
  private summaries: readonly PlaybackSummary[] = [];
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  subscribeReport = (listener: () => void) => {
    this.reportListeners.add(listener);
    return () => {
      this.reportListeners.delete(listener);
    };
  };
  getSummaries = () => this.summaries;
  get = (index: number) => this.latest.get(index) ?? null;
  transport(
    sessionId: string,
    attempt: number,
    counters: Partial<Record<PlaybackEventKind, number>>,
  ) {
    if (this.current?.id === sessionId) this.current.transport(attempt, counters);
  }
  start(recorder: PlaybackRecorder) {
    this.finish("switched");
    this.current = recorder;
    this.publish();
    this.report();
  }
  publish() {
    if (!this.current) return;
    const record = this.current.snapshot();
    this.latest.delete(record.summary.channelIndex);
    this.latest.set(record.summary.channelIndex, record);
    while (this.latest.size > PLAYBACK_SUMMARY_LIMIT)
      this.latest.delete(this.latest.keys().next().value!);
    for (const listener of this.listeners) listener();
  }
  finish(reason: PlaybackEndReason) {
    if (!this.current) return;
    this.current.finish(reason);
    this.publish();
    const record = this.current.snapshot();
    this.records.set(record.summary.id, record);
    while (this.records.size > PLAYBACK_SESSION_LIMIT) {
      const [id, evicted] = this.records.entries().next().value!;
      this.records.delete(id);
      if (this.latest.get(evicted.summary.channelIndex)?.summary.id === id) {
        this.latest.set(evicted.summary.channelIndex, {
          summary: evicted.summary,
          samples: [],
          events: [],
        });
      }
    }
    this.current = null;
    this.report();
  }
  clear() {
    this.finish("switched");
    this.records.clear();
    this.latest.clear();
    for (const listener of this.listeners) listener();
    this.report();
  }
  private report() {
    this.summaries = [...this.latest.values()].map((record) => record.summary);
    for (const listener of this.reportListeners) listener();
  }
  exportRecords() {
    this.publish();
    const records = [...this.records.values()];
    if (this.current) records.push(this.current.snapshot());
    return {
      version: 1,
      exportedAt: Date.now(),
      summaries: [...this.latest.values()].map((r) => r.summary),
      sessions: records,
    };
  }
}
export const playbackTelemetry = new PlaybackTelemetryStore();
