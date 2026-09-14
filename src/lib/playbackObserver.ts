import type Hls from "hls.js";
import type { BufferCodecsData, BufferCreatedData, ErrorData, Events } from "hls.js";
import { logger } from "./logger";
import { bufferedSecondsAhead, playbackErrorDetail, readMediaErrorDetail } from "./playback";
import {
  type PlaybackEngine,
  type PlaybackRecorder,
  playbackTelemetry,
  sanitizePlaybackText,
} from "./playbackTelemetry";
import type { MpegtsPlayer } from "./runtimeMonitor";

/** Observe only this player's media and buffers, never patch SourceBuffer.prototype. */
export function observePlayback(
  video: HTMLVideoElement,
  recorder: PlaybackRecorder,
  isPaused: () => boolean,
) {
  let routeActive = false;
  let routeNumber = 0;
  let routeLabel = "";
  let formatDetected = false;
  const reportedDetails = new Set<string>();
  const report = (
    kind: "stream_format" | "media_error" | "engine_error" | "route_failure",
    detail: string,
  ) => {
    if (!routeActive || recorder.ended) return;
    if (kind === "stream_format") formatDetected = true;
    const sanitized = sanitizePlaybackText(`${routeLabel}: ${detail}`);
    const key = `${kind}:${sanitized}`;
    if (reportedDetails.has(key)) return;
    // Bound diagnostic deduplication even for long-running, changing streams.
    if (reportedDetails.size >= 200) reportedDetails.clear();
    reportedDetails.add(key);
    recorder.event(kind, sanitized);
    const log = kind === "stream_format" ? logger.info : logger.warn;
    log(`[Player][${recorder.id}] ${kind}: ${sanitized}`);
  };
  const reportMime = (mime: string) => {
    let support = "";
    try {
      const mse =
        typeof MediaSource === "undefined" ? "unavailable" : MediaSource.isTypeSupported(mime);
      support = `; MSE=${mse}; native=${video.canPlayType(mime) || "unsupported"}`;
    } catch {
      /* Capability probes must not interfere with playback. */
    }
    report("stream_format", `MIME=${mime}${support}`);
  };
  let frameRequest: number | null = null;
  let routeCleanups: Array<() => void> = [];
  const cleanups: Array<() => void> = [];
  const observedBuffers = new WeakSet<SourceBuffer>();
  const context = () =>
    recorder.context(
      isPaused()
        ? "paused"
        : video.seeking
          ? "seeking"
          : document.hidden
            ? "background"
            : "foreground",
    );
  const sample = () => {
    if (recorder.ended) return;
    context();
    if (routeActive) {
      const ranges = Array.from({ length: video.buffered.length }, (_, i) => ({
        start: video.buffered.start(i),
        end: video.buffered.end(i),
      }));
      const quality = video.getVideoPlaybackQuality?.();
      recorder.sample(
        video.currentTime,
        bufferedSecondsAhead(video.currentTime, ranges),
        quality
          ? {
              total: quality.totalVideoFrames,
              dropped: quality.droppedVideoFrames,
            }
          : undefined,
      );
      if (
        !video.requestVideoFrameCallback &&
        quality &&
        quality.totalVideoFrames > quality.droppedVideoFrames &&
        !video.paused
      )
        recorder.firstFrame();
    }
    playbackTelemetry.publish();
  };
  const listen = (target: EventTarget, name: string, handler: () => void) => {
    target.addEventListener(name, handler);
    cleanups.push(() => target.removeEventListener(name, handler));
  };
  listen(document, "visibilitychange", () => {
    context();
    sample();
  });
  for (const name of ["pause", "play", "seeking", "seeked"]) listen(video, name, context);
  for (const name of ["waiting", "stalled"] as const)
    listen(video, name, () => {
      context();
      if (routeActive && !isPaused() && !video.paused && !video.seeking) recorder.event(name);
    });
  listen(video, "canplay", () => {
    if (routeActive) recorder.event("ready");
  });
  listen(video, "error", () => {
    report("media_error", readMediaErrorDetail(video.error));
  });
  const interval = setInterval(sample, 1000);

  const observeBuffer = (buffer: SourceBuffer) => {
    if (observedBuffers.has(buffer)) return;
    observedBuffers.add(buffer);
    const append = buffer.appendBuffer;
    const remove = buffer.remove;
    const appendDescriptor = Object.getOwnPropertyDescriptor(buffer, "appendBuffer");
    const removeDescriptor = Object.getOwnPropertyDescriptor(buffer, "remove");
    let appending = false;
    const wrappedAppend: SourceBuffer["appendBuffer"] = function (this: SourceBuffer, data) {
      try {
        append.call(this, data);
        appending = true;
        recorder.sourceBuffer("append", data.byteLength);
      } catch (error) {
        recorder.event(
          "append_error",
          error instanceof DOMException ? error.name : "Append rejected",
        );
        throw error;
      }
    };
    const wrappedRemove: SourceBuffer["remove"] = function (this: SourceBuffer, start, end) {
      try {
        remove.call(this, start, end);
        appending = false;
        recorder.sourceBuffer("remove");
      } catch (error) {
        recorder.event(
          "remove_error",
          error instanceof DOMException ? error.name : "Remove rejected",
        );
        throw error;
      }
    };
    const onError = () =>
      recorder.event(
        appending ? "append_error" : "remove_error",
        "SourceBuffer asynchronous error",
      );
    const restore = () => {
      if (buffer.appendBuffer === wrappedAppend) {
        if (appendDescriptor) Object.defineProperty(buffer, "appendBuffer", appendDescriptor);
        else Reflect.deleteProperty(buffer, "appendBuffer");
      }
      if (buffer.remove === wrappedRemove) {
        if (removeDescriptor) Object.defineProperty(buffer, "remove", removeDescriptor);
        else Reflect.deleteProperty(buffer, "remove");
      }
      buffer.removeEventListener("error", onError);
    };
    try {
      Object.defineProperty(buffer, "appendBuffer", { configurable: true, value: wrappedAppend });
      Object.defineProperty(buffer, "remove", { configurable: true, value: wrappedRemove });
      buffer.addEventListener("error", onError);
      recorder.sourceBuffer();
      routeCleanups.push(restore);
    } catch {
      restore();
    } // Unsupported host objects leave these metrics unavailable.
  };
  const closeRoute = () => {
    routeActive = false;
    if (frameRequest !== null) video.cancelVideoFrameCallback(frameRequest);
    frameRequest = null;
    const pending = routeCleanups;
    routeCleanups = [];
    for (const cleanup of pending) {
      try {
        cleanup();
      } catch {
        // Diagnostics must not block stopping playback or opening an external
        // player if a library has already disposed its event emitter.
      }
    }
  };
  return {
    sample,
    closeRoute,
    failure(reason: string) {
      if (!formatDetected) report("stream_format", "Format not detected before route failed");
      report("route_failure", reason);
    },
    route(engine: PlaybackEngine, detail?: string) {
      closeRoute();
      reportedDetails.clear();
      formatDetected = false;
      routeLabel = `${engine} #${++routeNumber}${detail ? ` (${detail})` : ""}`;
      recorder.route(engine);
      routeActive = true;
      if (video.requestVideoFrameCallback)
        frameRequest = video.requestVideoFrameCallback(() => {
          frameRequest = null;
          if (routeActive && !recorder.ended) recorder.firstFrame();
        });
    },
    hls(hls: Hls, events: typeof Events) {
      const onCodecs = (_event: Events.BUFFER_CODECS, data: BufferCodecsData) => {
        for (const name of ["video", "audio", "audiovideo"] as const) {
          const track = data[name];
          if (!track) continue;
          report(
            "stream_format",
            `${name}: codec=${track.codec ?? "unknown"}; levelCodec=${track.levelCodec ?? "unknown"}; container=${track.container}`,
          );
          const codec = track.levelCodec || track.codec;
          reportMime(codec ? `${track.container}; codecs="${codec}"` : track.container);
        }
      };
      const onManifest = () => {
        for (const level of hls.levels) {
          report(
            "stream_format",
            `manifest: video=${level.videoCodec ?? "unknown"}; audio=${level.audioCodec ?? "unknown"}; resolution=${level.width}x${level.height}`,
          );
        }
      };
      const onBuffers = (_event: Events.BUFFER_CREATED, data: BufferCreatedData) => {
        for (const track of Object.values(data.tracks)) observeBuffer(track.buffer);
      };
      const onError = (_event: Events.ERROR, data: ErrorData) => {
        if (data.mimeType) reportMime(data.mimeType);
        report(
          "engine_error",
          [
            data.type,
            data.details,
            data.fatal ? "fatal" : "nonfatal",
            data.reason,
            playbackErrorDetail(data.error),
          ]
            .filter(Boolean)
            .join(": "),
        );
      };
      hls.on(events.MANIFEST_PARSED, onManifest);
      hls.on(events.BUFFER_CODECS, onCodecs);
      hls.on(events.BUFFER_CREATED, onBuffers);
      hls.on(events.ERROR, onError);
      routeCleanups.push(() => {
        hls.off(events.MANIFEST_PARSED, onManifest);
        hls.off(events.BUFFER_CODECS, onCodecs);
        hls.off(events.BUFFER_CREATED, onBuffers);
        hls.off(events.ERROR, onError);
      });
    },
    mpegts(player: MpegtsPlayer) {
      const onMediaInfo = () => {
        const info = player.mediaInfo;
        if (!info) return;
        report(
          "stream_format",
          `video=${info.videoCodec ?? "unknown"}; audio=${info.audioCodec ?? "unknown"}; resolution=${info.width ?? "unknown"}x${info.height ?? "unknown"}`,
        );
        if (info.mimeType) reportMime(info.mimeType);
      };
      const onError = (type?: unknown, detail?: unknown, info?: unknown) => {
        onMediaInfo();
        report(
          "engine_error",
          [type, detail, info].map(playbackErrorDetail).filter(Boolean).join(": "),
        );
      };
      player.on?.("media_info", onMediaInfo);
      player.on?.("error", onError);
      routeCleanups.push(() => player.off?.("media_info", onMediaInfo));
      routeCleanups.push(() => player.off?.("error", onError));
    },
    attachMpegts(attach: () => void) {
      // mpegts.js creates its MediaSource synchronously during attachment. The
      // temporary URL hook discovers that instance and is restored before return.
      const original = URL.createObjectURL;
      const wrapped: typeof URL.createObjectURL = (object) => {
        if (typeof MediaSource !== "undefined" && object instanceof MediaSource) {
          const source = object;
          const add = source.addSourceBuffer;
          const descriptor = Object.getOwnPropertyDescriptor(source, "addSourceBuffer");
          const wrappedAdd: MediaSource["addSourceBuffer"] = function (this: MediaSource, mime) {
            reportMime(mime);
            try {
              const buffer = add.call(this, mime);
              observeBuffer(buffer);
              return buffer;
            } catch (error) {
              report("engine_error", `addSourceBuffer: ${playbackErrorDetail(error)}`);
              throw error;
            }
          };
          try {
            Object.defineProperty(source, "addSourceBuffer", {
              configurable: true,
              value: wrappedAdd,
            });
            routeCleanups.push(() => {
              if (source.addSourceBuffer !== wrappedAdd) return;
              if (descriptor) Object.defineProperty(source, "addSourceBuffer", descriptor);
              else Reflect.deleteProperty(source, "addSourceBuffer");
            });
          } catch {} // Managed/worker MediaSource may not expose buffers here.
        }
        return original.call(URL, object);
      };
      try {
        URL.createObjectURL = wrapped;
      } catch {
        attach();
        return;
      }
      try {
        attach();
      } finally {
        URL.createObjectURL = original;
      }
    },
    close() {
      sample();
      closeRoute();
      clearInterval(interval);
      for (const cleanup of cleanups) cleanup();
    },
  };
}
export type PlaybackObserver = ReturnType<typeof observePlayback>;
