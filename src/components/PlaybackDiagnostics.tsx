import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { ChevronRight, Download } from "lucide-react";
import { useCallback, useState, useSyncExternalStore } from "react";
import { useDisclosure } from "../hooks/useDisclosure";
import { formatCount, getFormatLocale, type MessageKey, t } from "../i18n";
import {
  type PlaybackEventKind,
  type PlaybackRecord,
  playbackTelemetry,
  sanitizePlaybackText,
} from "../lib/playbackTelemetry";

const eventLabels = {
  route: "player.diagnostics.eventKinds.route",
  route_failure: "player.diagnostics.eventKinds.routeFailure",
  stream_format: "player.diagnostics.eventKinds.streamFormat",
  ready: "player.diagnostics.eventKinds.ready",
  first_frame: "player.diagnostics.eventKinds.firstFrame",
  waiting: "player.diagnostics.eventKinds.waiting",
  stalled: "player.diagnostics.eventKinds.stalled",
  reconnect: "player.diagnostics.eventKinds.reconnect",
  reconnect_restored: "player.diagnostics.eventKinds.reconnectRestored",
  resync: "player.diagnostics.eventKinds.resync",
  latency_trim: "player.diagnostics.eventKinds.latencyTrim",
  library_recovery: "player.diagnostics.eventKinds.libraryRecovery",
  player_failure: "player.diagnostics.eventKinds.playerFailure",
  media_error: "player.diagnostics.eventKinds.mediaError",
  engine_error: "player.diagnostics.eventKinds.engineError",
  append_error: "player.diagnostics.eventKinds.appendError",
  remove_error: "player.diagnostics.eventKinds.removeError",
  upstream_eof: "player.diagnostics.eventKinds.upstreamEof",
  upstream_timeout: "player.diagnostics.eventKinds.upstreamTimeout",
  upstream_error: "player.diagnostics.eventKinds.upstreamError",
  proxy_reconnect: "player.diagnostics.eventKinds.proxyReconnect",
  proxy_connected: "player.diagnostics.eventKinds.proxyConnected",
  pacing_warning: "player.diagnostics.eventKinds.pacingWarning",
  remux_warning: "player.diagnostics.eventKinds.remuxWarning",
} as const satisfies Record<PlaybackEventKind, MessageKey>;
/** One-decimal number in the UI locale. */
const decimal = (value: number, digits = 1) =>
  value.toLocaleString(getFormatLocale(), {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
const secondsValue = (value: number) => t("player.diagnostics.seconds", { value: decimal(value) });
const seconds = (ms: number | null) =>
  ms === null ? t("player.diagnostics.notAvailable") : secondsValue(ms / 1000);
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
        {busy ? t("player.diagnostics.exporting") : t("player.diagnostics.export")}
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
  const [expanded, setExpanded] = useDisclosure("playback-expanded", true);
  const [activityOpen, setActivityOpen] = useDisclosure("playback-activity-expanded");
  if (!record) return null;
  const { summary: s } = record;
  const count = (kind: PlaybackEventKind) => s.counters[kind] ?? 0;
  const state = t(
    s.ended
      ? s.ended === "failed"
        ? "player.diagnostics.state.failed"
        : "player.diagnostics.state.completed"
      : s.context === "paused"
        ? "player.diagnostics.state.paused"
        : s.context === "background"
          ? "player.diagnostics.state.background"
          : s.phase === "starting"
            ? "player.diagnostics.state.connecting"
            : s.phase === "reconnecting"
              ? "player.diagnostics.state.reconnecting"
              : "player.diagnostics.state.playing",
  );
  const notAvailable = t("player.diagnostics.notAvailable");
  const dropRate =
    s.framesAvailable && s.foregroundFrames > 0
      ? new Intl.NumberFormat(getFormatLocale(), {
          style: "percent",
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }).format(s.foregroundDropped / s.foregroundFrames)
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
    [
      "player.diagnostics.technical.engine",
      `${s.engine ?? t("player.diagnostics.notSelected")} · ${s.streamType}`,
    ],
    ["player.diagnostics.technical.mediaReady", seconds(s.readyMs)],
    ["player.diagnostics.technical.mediaProgress", secondsValue(s.mediaTime)],
    ["player.diagnostics.technical.noProgressIntervals", formatCount(s.noProgressIntervals)],
    [
      "player.diagnostics.technical.waitingStalled",
      t("player.diagnostics.events", {
        waiting: formatCount(count("waiting")),
        stalled: formatCount(count("stalled")),
      }),
    ],
    [
      "player.diagnostics.technical.resyncsSkipped",
      `${formatCount(count("resync"))} / ${secondsValue(s.skippedSeconds)}`,
    ],
    ["player.diagnostics.technical.latencyTrims", formatCount(count("latency_trim"))],
    [
      "player.diagnostics.technical.cleanReconnects",
      t("player.diagnostics.reconnects", {
        restored: formatCount(count("reconnect_restored")),
        attempted: formatCount(count("reconnect")),
      }),
    ],
    ["player.diagnostics.technical.engineRecoveryAttempts", formatCount(count("library_recovery"))],
    [
      "player.diagnostics.technical.mediaEngineErrors",
      `${formatCount(count("media_error"))} / ${formatCount(count("engine_error"))}`,
    ],
    [
      "player.diagnostics.technical.foregroundFrames",
      s.framesAvailable
        ? t("player.diagnostics.frames", {
            dropped: formatCount(s.foregroundDropped),
            total: formatCount(s.foregroundFrames),
          })
        : notAvailable,
    ],
    [
      "player.diagnostics.technical.backgroundFrames",
      s.framesAvailable
        ? t("player.diagnostics.frames", {
            dropped: formatCount(s.backgroundDropped),
            total: formatCount(s.backgroundFrames),
          })
        : notAvailable,
    ],
    [
      "player.diagnostics.technical.foregroundBackground",
      `${clock(s.foregroundMs)} / ${clock(s.backgroundMs)}`,
    ],
    ["player.diagnostics.technical.unobservedTime", clock(s.unobservedMs)],
    [
      "player.diagnostics.technical.bufferMinMedianMax",
      s.bufferMin === null
        ? notAvailable
        : t("player.diagnostics.seconds", {
            value: `${decimal(s.bufferMin)} / ${s.bufferMedian === 60 ? "≥60" : `≈${s.bufferMedian === null ? "" : decimal(s.bufferMedian)}`} / ${s.bufferMax === null ? "" : decimal(s.bufferMax)}`,
          }),
    ],
    [
      "player.diagnostics.technical.bufferAppendsRemoves",
      s.sourceBufferAvailable
        ? `${formatCount(s.appends)} / ${formatCount(s.removes)}`
        : notAvailable,
    ],
    [
      "player.diagnostics.technical.bytesAppended",
      s.sourceBufferAvailable
        ? t("player.diagnostics.megabytes", { value: decimal(s.appendedBytes / 1024 / 1024) })
        : notAvailable,
    ],
    [
      "player.diagnostics.technical.appendRemoveErrors",
      s.sourceBufferAvailable
        ? `${formatCount(count("append_error"))} / ${formatCount(count("remove_error"))}`
        : notAvailable,
    ],
    [
      "player.diagnostics.technical.upstreamEofTimeoutErrors",
      s.transportAvailable
        ? `${formatCount(count("upstream_eof"))} / ${formatCount(count("upstream_timeout"))} / ${formatCount(count("upstream_error"))}`
        : notAvailable,
    ],
    [
      "player.diagnostics.technical.proxyReconnectsConnected",
      s.transportAvailable
        ? `${formatCount(count("proxy_reconnect"))} / ${formatCount(count("proxy_connected"))}`
        : notAvailable,
    ],
    [
      "player.diagnostics.technical.pacingRemuxWarnings",
      s.transportAvailable
        ? `${formatCount(count("pacing_warning"))} / ${formatCount(count("remux_warning"))}`
        : notAvailable,
    ],
    ["player.diagnostics.technical.environment", `${s.platform} · ${s.appVersion}`],
  ] as const satisfies ReadonlyArray<readonly [MessageKey, string]>;
  return (
    <details
      aria-label={t("player.diagnostics.label")}
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
      className="group/diagnostics overflow-hidden rounded border border-border-app bg-panel-muted"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 p-2 [&::-webkit-details-marker]:hidden focus-visible:outline-2 focus-visible:outline-blue-500">
        <span className="text-[12px] font-medium">
          {s.ended ? t("player.diagnostics.lastPlayback") : t("player.diagnostics.playback")}
          {s.mode === "archive" ? ` · ${t("player.diagnostics.archive")}` : ""}
        </span>
        <span
          className={`ms-auto text-[9px] tabular-nums ${s.ended === "failed" ? "text-red-400" : s.phase === "reconnecting" && !s.ended ? "text-amber-500" : "text-text-secondary"}`}
        >
          {state} · {clock(s.durationMs)}
        </span>
        <ChevronRight className="h-3 w-3 shrink-0 group-open/diagnostics:rotate-90 rtl:-scale-x-100 rtl:group-open/diagnostics:-rotate-90" />
      </summary>
      <div className="grid grid-cols-2 gap-x-3 gap-y-2 p-2">
        <Metric
          label={t("player.diagnostics.firstFrame")}
          value={s.firstFrameMs === null ? "—" : seconds(s.firstFrameMs)}
          note={s.firstFrameMs === null ? t("player.diagnostics.notObserved") : undefined}
        />
        <Metric
          label={t("player.diagnostics.bufferAhead")}
          value={s.bufferSeconds === null ? "—" : secondsValue(s.bufferSeconds)}
        />
        <Metric
          label={t("player.diagnostics.interruptions")}
          value={formatCount(s.interruptions)}
          note={t("player.diagnostics.totalDuration", { duration: seconds(s.interruptionMs) })}
        />
        <Metric
          label={t("player.diagnostics.droppedFrames")}
          value={dropRate}
          note={dropRate === "—" ? notAvailable : t("player.diagnostics.foreground")}
        />
      </div>
      <details
        open={activityOpen}
        onToggle={(event) => setActivityOpen(event.currentTarget.open)}
        className="group/playback border-t border-border-subtle"
      >
        <summary className="flex min-h-8 cursor-pointer list-none items-center gap-2 px-2 text-[10px] [&::-webkit-details-marker]:hidden focus-visible:outline-2 focus-visible:outline-blue-500">
          <span>{t("player.diagnostics.sessionActivity")}</span>
          <span className="ms-auto text-[9px] text-text-secondary">
            {s.ended === "failed"
              ? t("player.diagnostics.unrecovered")
              : count("reconnect_restored") || count("resync")
                ? t("player.diagnostics.recoveryObserved")
                : ""}
          </span>
          <ChevronRight className="h-3 w-3 shrink-0 group-open/playback:rotate-90 rtl:-scale-x-100 rtl:group-open/playback:-rotate-90" />
        </summary>
        <div className="px-2 pb-2">
          {activityOpen && recent.length > 1 && (
            <div className="pb-2">
              <div className="flex justify-between text-[9px] text-text-secondary">
                <span>{t("player.diagnostics.bufferAhead")}</span>
                <span>{t("player.diagnostics.scale", { max: decimal(maxBuffer) })}</span>
              </div>
              <svg
                viewBox="0 0 260 64"
                className="h-16 w-full rtl:-scale-x-100"
                role="img"
                aria-label={t("player.diagnostics.recentBufferDepth")}
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
                  <p className="text-[10px] font-medium">{t(eventLabels[event.kind])}</p>
                  {(event.detail || event.seconds !== undefined) && (
                    <p className="break-words text-[9px] text-text-secondary">
                      <span dir="ltr">{event.detail}</span>
                      {event.seconds !== undefined ? ` · ${secondsValue(event.seconds)}` : ""}
                    </p>
                  )}
                </div>
              </div>
            ))}
          <p className="mt-2 text-[9px] text-text-secondary">
            {t("player.diagnostics.exclusionNote")}{" "}
            {s.ended === "failed"
              ? t("player.diagnostics.failedNote")
              : t("player.diagnostics.observationNote")}
          </p>
          <details className="group/technical mt-2 border-t border-border-subtle">
            <summary className="flex min-h-8 cursor-pointer list-none items-center justify-between gap-2 text-[10px] [&::-webkit-details-marker]:hidden">
              <span>{t("player.diagnostics.technicalCounters")}</span>
              <ChevronRight className="h-3 w-3 group-open/technical:rotate-90 rtl:-scale-x-100 rtl:group-open/technical:-rotate-90" />
            </summary>
            <dl className="space-y-1">
              {technical.map(([label, value]) => (
                <div key={label} className="flex flex-wrap justify-between gap-x-2 text-[9px]">
                  <dt className="text-text-secondary">{t(label)}</dt>
                  <dd className="break-words tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
          </details>
          {(s.omittedEvents > 0 || s.omittedSamples > 0 || (s.ended && !record.events.length)) && (
            <p className="mt-2 text-[9px] text-text-secondary">
              {t("player.diagnostics.boundedNote")}
            </p>
          )}
          <ExportDiagnostics record={record} />
        </div>
      </details>
    </details>
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
      <h3 className="text-[11px] font-medium text-text-secondary">
        {t("player.diagnostics.report.heading")}
      </h3>
      <p className="mt-2 text-[12px]">
        {t("player.diagnostics.report.observed", {
          count: summaries.length,
          completed: formatCount(completed.length),
        })}
      </p>
      <p className="mt-1 text-[10px] text-text-secondary">
        {t("player.diagnostics.report.description")}
      </p>
      <ExportDiagnostics />
    </section>
  );
}
