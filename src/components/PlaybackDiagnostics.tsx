import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { ChevronRight, Download } from "lucide-react";
import { useCallback, useState, useSyncExternalStore } from "react";
import { useDisclosure } from "../hooks/useDisclosure";
import {
  type PlaybackEventKind,
  type PlaybackRecord,
  playbackTelemetry,
  sanitizePlaybackText,
} from "../lib/playbackTelemetry";

const eventLabels: Record<PlaybackEventKind, string> = {
  route: "Playback route",
  ready: "Media ready",
  first_frame: "First frame presented",
  waiting: "Waiting for media",
  stalled: "Media loading stalled",
  reconnect: "Clean reconnect started",
  reconnect_restored: "Clean reconnect restored playback",
  resync: "Timestamp gap skipped",
  latency_trim: "Accumulated latency trimmed",
  library_recovery: "In-place engine recovery",
  player_failure: "Playback could not resume",
  media_error: "Media error",
  engine_error: "Player engine error",
  append_error: "Buffer append error",
  remove_error: "Buffer removal error",
  upstream_eof: "Upstream ended",
  upstream_timeout: "Upstream timed out",
  upstream_error: "Upstream request failed",
  proxy_reconnect: "Proxy reconnect started",
  proxy_connected: "Proxy connection established",
  pacing_warning: "Transport clock re-anchored",
  remux_warning: "Transport remux warning",
};
const seconds = (ms: number | null) =>
  ms === null ? "Not available" : `${(ms / 1000).toFixed(1)} s`;
function clock(ms: number) {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
function Metric({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="min-w-0">
      <span className="block text-[10px] text-text-secondary">{label}</span>
      <strong className="block text-[17px] font-medium tabular-nums break-words">{value}</strong>
      {note && <small className="block text-[9px] text-text-secondary">{note}</small>}
    </div>
  );
}
function ExportDiagnostics({ record }: { record?: PlaybackRecord }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const exportSession = async () => {
    setBusy(true);
    setError(null);
    try {
      const path = await save({
        defaultPath: "playback-diagnostics.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) return;
      const payload = record
        ? { version: 1, exportedAt: Date.now(), sessions: [record] }
        : playbackTelemetry.exportRecords();
      await invoke("export_playback_diagnostics", { path, payload });
    } catch (error) {
      setError(sanitizePlaybackText(String(error)));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <button
        type="button"
        disabled={busy}
        onClick={() => void exportSession()}
        className="mt-2 flex items-center gap-1 text-[10px] text-blue-500 hover:underline disabled:opacity-50"
      >
        <Download className="h-3 w-3" />
        {busy ? "Exporting…" : "Export diagnostics…"}
      </button>
      {error && (
        <p role="alert" className="mt-1 text-[10px] text-red-400 break-words">
          {error}
        </p>
      )}
    </div>
  );
}

export function PlaybackDiagnostics({ channelIndex }: { channelIndex: number }) {
  const getRecord = useCallback(() => playbackTelemetry.get(channelIndex), [channelIndex]);
  const record = useSyncExternalStore(playbackTelemetry.subscribe, getRecord);
  const [activityOpen, setActivityOpen] = useDisclosure("playback-activity-expanded");
  if (!record) return null;
  const { summary: s } = record;
  const count = (kind: PlaybackEventKind) => s.counters[kind] ?? 0;
  const state = s.ended
    ? s.ended === "failed"
      ? "Failed"
      : "Completed"
    : s.context === "paused"
      ? "Paused"
      : s.context === "background"
        ? "Background"
        : s.phase === "starting"
          ? "Connecting"
          : s.phase === "reconnecting"
            ? "Reconnecting"
            : "Playing";
  const dropRate =
    s.framesAvailable && s.foregroundFrames > 0
      ? `${((s.foregroundDropped / s.foregroundFrames) * 100).toFixed(2)}%`
      : "—";
  const recent = record.samples;
  const maxBuffer = Math.max(1, ...recent.map((sample) => sample.bufferSeconds));
  const chartStart = recent[0]?.atMs ?? 0;
  const chartDuration = Math.max(1, (recent.at(-1)?.atMs ?? chartStart) - chartStart);
  const points = recent
    .filter(
      (_, i) => i % Math.max(1, Math.floor(recent.length / 120)) === 0 || i === recent.length - 1,
    )
    .map(
      (sample) =>
        `${(((sample.atMs - chartStart) / chartDuration) * 260).toFixed(1)},${(58 - (sample.bufferSeconds / maxBuffer) * 50).toFixed(1)}`,
    )
    .join(" ");
  const technical = [
    ["Engine", `${s.engine ?? "Not selected"} · ${s.streamType}`],
    ["Media ready", seconds(s.readyMs)],
    ["Media progress", `${s.mediaTime.toFixed(1)} s`],
    ["No-progress intervals", String(s.noProgressIntervals)],
    ["Waiting / stalled", `${count("waiting")} / ${count("stalled")} events`],
    ["In-place resyncs / skipped", `${count("resync")} / ${s.skippedSeconds.toFixed(1)} s`],
    ["Latency trims", String(count("latency_trim"))],
    [
      "Clean reconnects",
      `${count("reconnect_restored")} restored / ${count("reconnect")} attempted`,
    ],
    ["Engine recovery attempts", String(count("library_recovery"))],
    ["Media / engine errors", `${count("media_error")} / ${count("engine_error")}`],
    [
      "Foreground frames",
      s.framesAvailable
        ? `${s.foregroundDropped} dropped / ${s.foregroundFrames}`
        : "Not available",
    ],
    [
      "Background frames",
      s.framesAvailable
        ? `${s.backgroundDropped} dropped / ${s.backgroundFrames}`
        : "Not available",
    ],
    ["Foreground / background", `${clock(s.foregroundMs)} / ${clock(s.backgroundMs)}`],
    ["Unobserved time", clock(s.unobservedMs)],
    [
      "Buffer min / median / max",
      s.bufferMin === null
        ? "Not available"
        : `${s.bufferMin.toFixed(1)} / ${s.bufferMedian === 60 ? "≥60" : `≈${s.bufferMedian?.toFixed(1)}`} / ${s.bufferMax?.toFixed(1)} s`,
    ],
    [
      "Buffer appends / removes",
      s.sourceBufferAvailable ? `${s.appends} / ${s.removes}` : "Not available",
    ],
    [
      "Bytes appended",
      s.sourceBufferAvailable
        ? `${(s.appendedBytes / 1024 / 1024).toFixed(1)} MB`
        : "Not available",
    ],
    [
      "Append / remove errors",
      s.sourceBufferAvailable
        ? `${count("append_error")} / ${count("remove_error")}`
        : "Not available",
    ],
    [
      "Upstream EOF / timeout / errors",
      s.transportAvailable
        ? `${count("upstream_eof")} / ${count("upstream_timeout")} / ${count("upstream_error")}`
        : "Not available",
    ],
    [
      "Proxy reconnects / connected",
      s.transportAvailable
        ? `${count("proxy_reconnect")} / ${count("proxy_connected")}`
        : "Not available",
    ],
    [
      "Pacing / remux warnings",
      s.transportAvailable
        ? `${count("pacing_warning")} / ${count("remux_warning")}`
        : "Not available",
    ],
    ["Environment", `${s.platform} · ${s.appVersion}`],
  ];
  return (
    <section
      aria-label="Playback diagnostics"
      className="overflow-hidden rounded border border-border-app bg-panel-muted"
    >
      <div className="flex flex-wrap items-center justify-between gap-1 px-2 pt-2">
        <h4 className="text-[12px] font-medium">
          {s.ended ? "Last playback" : "Playback"}
          {s.mode === "archive" ? " · Archive" : ""}
        </h4>
        <span
          className={`text-[9px] tabular-nums ${s.ended === "failed" ? "text-red-400" : s.phase === "reconnecting" && !s.ended ? "text-amber-500" : "text-text-secondary"}`}
        >
          {state} · {clock(s.durationMs)}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-2 p-2">
        <Metric
          label="First frame"
          value={s.firstFrameMs === null ? "—" : seconds(s.firstFrameMs)}
          note={s.firstFrameMs === null ? "Not observed" : undefined}
        />
        <Metric
          label="Buffer ahead"
          value={s.bufferSeconds === null ? "—" : `${s.bufferSeconds.toFixed(1)} s`}
        />
        <Metric
          label="Interruptions"
          value={String(s.interruptions)}
          note={`${seconds(s.interruptionMs)} total`}
        />
        <Metric
          label="Dropped frames"
          value={dropRate}
          note={dropRate === "—" ? "Not available" : "foreground"}
        />
      </div>
      <details
        open={activityOpen}
        onToggle={(event) => setActivityOpen(event.currentTarget.open)}
        className="group/playback border-t border-border-subtle"
      >
        <summary className="flex min-h-8 cursor-pointer list-none items-center gap-2 px-2 text-[10px] [&::-webkit-details-marker]:hidden focus-visible:outline-2 focus-visible:outline-blue-500">
          <span>Session activity</span>
          <span className="ml-auto text-[9px] text-text-secondary">
            {s.ended === "failed"
              ? "Unrecovered"
              : count("reconnect_restored") || count("resync")
                ? "Recovery observed"
                : ""}
          </span>
          <ChevronRight className="h-3 w-3 shrink-0 group-open/playback:rotate-90" />
        </summary>
        <div className="px-2 pb-2">
          {activityOpen && recent.length > 1 && (
            <div className="pb-2">
              <div className="flex justify-between text-[9px] text-text-secondary">
                <span>Buffer ahead</span>
                <span>Scale 0–{maxBuffer.toFixed(1)} s</span>
              </div>
              <svg
                viewBox="0 0 260 64"
                className="h-16 w-full"
                role="img"
                aria-label="Recent buffer depth"
              >
                <polyline
                  points={points}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  className="text-blue-400"
                />
              </svg>
              <div className="flex justify-between text-[8px] text-text-secondary tabular-nums">
                <span>{clock(chartStart)}</span>
                <span>{clock(recent.at(-1)?.atMs ?? 0)}</span>
              </div>
            </div>
          )}
          {record.events
            .slice(-12)
            .reverse()
            .map((event) => (
              <div key={event.sequence} className="flex gap-2 border-b border-border-subtle py-2">
                <time className="shrink-0 text-[9px] text-text-tertiary tabular-nums">
                  {clock(event.atMs)}
                </time>
                <div className="min-w-0">
                  <p className="text-[10px] font-medium">{eventLabels[event.kind]}</p>
                  {(event.detail || event.seconds !== undefined) && (
                    <p className="break-words text-[9px] text-text-secondary">
                      {event.detail}
                      {event.seconds !== undefined ? ` · ${event.seconds.toFixed(1)} s` : ""}
                    </p>
                  )}
                </div>
              </div>
            ))}
          <p className="mt-2 text-[9px] text-text-secondary">
            Background drops, pauses and seeks are excluded from interruption measurements.{" "}
            {s.ended === "failed"
              ? "Playback could not resume; the cause may be unconfirmed."
              : "Observations do not change the availability scan result."}
          </p>
          <details className="group/technical mt-2 border-t border-border-subtle">
            <summary className="flex min-h-8 cursor-pointer list-none items-center justify-between gap-2 text-[10px] [&::-webkit-details-marker]:hidden">
              <span>Technical counters</span>
              <ChevronRight className="h-3 w-3 group-open/technical:rotate-90" />
            </summary>
            <dl className="space-y-1">
              {technical.map(([label, value]) => (
                <div key={label} className="flex flex-wrap justify-between gap-x-2 text-[9px]">
                  <dt className="text-text-secondary">{label}</dt>
                  <dd className="break-words tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
          </details>
          {(s.omittedEvents > 0 || s.omittedSamples > 0 || (s.ended && !record.events.length)) && (
            <p className="mt-2 text-[9px] text-text-secondary">
              Recent details are bounded. Summary totals cover the whole session.
            </p>
          )}
          <ExportDiagnostics record={record} />
        </div>
      </details>
    </section>
  );
}

export function PlaybackReportSummary() {
  const summaries = useSyncExternalStore(
    playbackTelemetry.subscribeReport,
    playbackTelemetry.getSummaries,
  );
  if (!summaries.length) return null;
  const completed = summaries.filter((s) => s.ended);
  return (
    <section className="rounded-lg border border-border-app bg-panel-muted p-3">
      <h3 className="text-[11px] font-medium text-text-secondary">PLAYBACK OBSERVATIONS</h3>
      <p className="mt-2 text-[12px]">
        {summaries.length} {summaries.length === 1 ? "channel" : "channels"} observed ·{" "}
        {completed.length} completed
      </p>
      <p className="mt-1 text-[10px] text-text-secondary">
        Latest session per channel. Select a channel for details. Live totals update when the
        session ends.
      </p>
      <ExportDiagnostics />
    </section>
  );
}
