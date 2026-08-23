import { save } from "@tauri-apps/plugin-dialog";
import { ChevronDown, CircleAlert, CircleCheck, Download, Info, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { type ExportScope, exportScopeFileSuffix, exportScopeLabel } from "../lib/exportScope";
import { HapticFeedbackPattern, PerformanceTime, triggerHaptic } from "../lib/haptics";
import { logger } from "../lib/logger";
import { isScanActive, type ScanState } from "../lib/scanState";
import { readStoredVisibleColumnOrder } from "../lib/tableColumns";
import { exportCsv, exportM3u, exportRenamed, exportScanLogJson, exportSplit } from "../lib/tauri";
import type { ChannelResult } from "../lib/types";
import { SFChevronDown, SFSquareArrowUp } from "./SFSymbols";

interface ExportMenuProps {
  scopeCounts: Record<ExportScope, number>;
  resolveScopeResults: (scope: ExportScope) => ChannelResult[];
  playlistName: string;
  playlistPath: string;
  disabled: boolean;
  showButtonText?: boolean;
  menuRequest?: {
    id: number;
    action: "csv" | "split" | "renamed" | "m3u" | "scanlog";
  } | null;
  scanState: ScanState;
  isMac?: boolean;
}

interface ExportFeedback {
  kind: "success" | "error" | "info";
  message: string;
}

export function ExportMenu({
  scopeCounts,
  resolveScopeResults,
  playlistName,
  playlistPath,
  disabled,
  showButtonText = true,
  menuRequest,
  scanState,
  isMac,
}: ExportMenuProps) {
  const IconExport = isMac ? SFSquareArrowUp : Download;
  const IconChevron = isMac ? SFChevronDown : ChevronDown;
  const [open, setOpen] = useState(false);
  const [busyAction, setBusyAction] = useState<
    "csv" | "split" | "renamed" | "m3u" | "scanlog" | null
  >(null);
  const [feedback, setFeedback] = useState<ExportFeedback | null>(null);
  const [scope, setScope] = useState<ExportScope>("all");
  const ref = useRef<HTMLDivElement>(null);
  const lastMenuRequestId = useRef<number | null>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(null), 7000);
    return () => clearTimeout(timer);
  }, [feedback]);

  const isPartial = isScanActive(scanState);
  const normalizedPlaylistPath = playlistPath.replace(/\\/g, "/");
  const sourceDir = normalizedPlaylistPath.includes("/")
    ? normalizedPlaylistPath.slice(0, normalizedPlaylistPath.lastIndexOf("/"))
    : ".";
  const sourceFileName = normalizedPlaylistPath.includes("/")
    ? normalizedPlaylistPath.slice(normalizedPlaylistPath.lastIndexOf("/") + 1)
    : normalizedPlaylistPath;
  const sourceStem = sourceFileName.includes(".")
    ? sourceFileName.slice(0, sourceFileName.lastIndexOf("."))
    : sourceFileName;
  const partialSuffix = isPartial ? "_partial" : "";

  const showFeedback = useCallback((next: ExportFeedback) => {
    setFeedback(next);
    const message = `[Export] ${next.message}`;
    if (next.kind === "error") {
      logger.error(message);
    } else {
      logger.info(message);
    }
  }, []);

  const resolveScopedResults = useCallback((): ChannelResult[] | null => {
    const scoped = resolveScopeResults(scope);
    if (scoped.length > 0) {
      return scoped;
    }

    if (scope === "selected") {
      showFeedback({
        kind: "info",
        message: "No selected channels to export.",
      });
      return null;
    }
    if (scope === "filtered") {
      showFeedback({
        kind: "info",
        message: "No channels match the current filters.",
      });
      return null;
    }
    showFeedback({
      kind: "info",
      message: "No channels available to export.",
    });
    return null;
  }, [scope, resolveScopeResults, showFeedback]);

  const handleExportCsv = useCallback(async () => {
    const scoped = resolveScopedResults();
    if (!scoped) return;

    setOpen(false);
    const path = await save({
      defaultPath: `${playlistName}_${exportScopeFileSuffix(scope)}${partialSuffix}.csv`,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (!path) {
      showFeedback({ kind: "info", message: "Export CSV cancelled." });
      return;
    }

    setBusyAction("csv");
    logger.info(
      `[Export] Starting ${exportScopeLabel(scope)} CSV export: channels=${scoped.length}, path=${path}`,
    );
    try {
      await exportCsv(
        scoped,
        path,
        playlistName,
        readStoredVisibleColumnOrder().includes("latency"),
      );
      showFeedback({
        kind: "success",
        message: `Exported ${exportScopeLabel(scope)} CSV (${scoped.length} channels) to ${path}.`,
      });
      void triggerHaptic(HapticFeedbackPattern.Generic, PerformanceTime.Now);
    } catch (err) {
      showFeedback({
        kind: "error",
        message: `CSV export failed: ${String(err)}`,
      });
    } finally {
      setBusyAction(null);
    }
  }, [playlistName, scope, resolveScopedResults, showFeedback]);

  const handleExportSplit = useCallback(async () => {
    const scoped = resolveScopedResults();
    if (!scoped) return;

    setOpen(false);
    setBusyAction("split");
    logger.info(
      `[Export] Starting ${exportScopeLabel(scope)} split export: channels=${scoped.length}, source=${playlistPath}`,
    );
    try {
      await exportSplit(scoped, playlistPath);
      showFeedback({
        kind: "success",
        message: `Exported ${exportScopeLabel(scope)} split playlists (${scoped.length} channels) to ${sourceDir}.`,
      });
      void triggerHaptic(HapticFeedbackPattern.Generic, PerformanceTime.Now);
    } catch (err) {
      showFeedback({
        kind: "error",
        message: `Split export failed: ${String(err)}`,
      });
    } finally {
      setBusyAction(null);
    }
  }, [playlistPath, scope, sourceDir, resolveScopedResults, showFeedback]);

  const handleExportRenamed = useCallback(async () => {
    const scoped = resolveScopedResults();
    if (!scoped) return;

    setOpen(false);
    setBusyAction("renamed");
    logger.info(
      `[Export] Starting ${exportScopeLabel(scope)} renamed-playlist export: channels=${scoped.length}, source=${playlistPath}`,
    );
    try {
      await exportRenamed(scoped, playlistPath);
      showFeedback({
        kind: "success",
        message: `Exported ${exportScopeLabel(scope)} renamed playlist (${scoped.length} channels) to ${sourceDir}/${sourceStem}_renamed.m3u8.`,
      });
      void triggerHaptic(HapticFeedbackPattern.Generic, PerformanceTime.Now);
    } catch (err) {
      showFeedback({
        kind: "error",
        message: `Renamed export failed: ${String(err)}`,
      });
    } finally {
      setBusyAction(null);
    }
  }, [playlistPath, scope, sourceDir, sourceStem, resolveScopedResults, showFeedback]);

  const handleExportM3u = useCallback(async () => {
    const scoped = resolveScopedResults();
    if (!scoped) return;

    setOpen(false);

    const path = await save({
      defaultPath: `${sourceStem}_${exportScopeFileSuffix(scope)}${partialSuffix}.m3u8`,
      filters: [{ name: "M3U Playlist", extensions: ["m3u8", "m3u"] }],
    });
    if (!path) {
      showFeedback({ kind: "info", message: "M3U export cancelled." });
      return;
    }

    setBusyAction("m3u");
    logger.info(
      `[Export] Starting ${exportScopeLabel(scope)} M3U export: channels=${scoped.length}, path=${path}`,
    );
    try {
      await exportM3u(scoped, path);
      showFeedback({
        kind: "success",
        message: `Exported ${exportScopeLabel(scope)} M3U (${scoped.length} channels) to ${path}.`,
      });
      void triggerHaptic(HapticFeedbackPattern.Generic, PerformanceTime.Now);
    } catch (err) {
      showFeedback({
        kind: "error",
        message: `M3U export failed: ${String(err)}`,
      });
    } finally {
      setBusyAction(null);
    }
  }, [scope, sourceStem, resolveScopedResults, showFeedback]);

  const handleExportScanLog = useCallback(async () => {
    if (scanState === "idle") {
      showFeedback({
        kind: "info",
        message: "Run a scan first to generate a scan log.",
      });
      return;
    }

    setOpen(false);
    const path = await save({
      defaultPath: `${sourceStem}_scan-log${partialSuffix}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!path) {
      showFeedback({ kind: "info", message: "Scan log export cancelled." });
      return;
    }

    setBusyAction("scanlog");
    logger.info(`[Export] Starting structured scan log export: path=${path}`);
    try {
      await exportScanLogJson(path);
      showFeedback({
        kind: "success",
        message: `Exported structured scan log to ${path}.`,
      });
      void triggerHaptic(HapticFeedbackPattern.Generic, PerformanceTime.Now);
    } catch (err) {
      showFeedback({
        kind: "error",
        message: `Scan log export failed: ${String(err)}`,
      });
    } finally {
      setBusyAction(null);
    }
  }, [scanState, sourceStem, showFeedback]);

  const exporting = busyAction !== null;

  useEffect(() => {
    if (!menuRequest || disabled || exporting) return;
    if (lastMenuRequestId.current === menuRequest.id) return;
    lastMenuRequestId.current = menuRequest.id;

    if (menuRequest.action === "csv") {
      void handleExportCsv();
    } else if (menuRequest.action === "split") {
      void handleExportSplit();
    } else if (menuRequest.action === "renamed") {
      void handleExportRenamed();
    } else if (menuRequest.action === "m3u") {
      void handleExportM3u();
    } else if (menuRequest.action === "scanlog") {
      void handleExportScanLog();
    }
  }, [
    menuRequest,
    disabled,
    exporting,
    handleExportCsv,
    handleExportSplit,
    handleExportRenamed,
    handleExportM3u,
    handleExportScanLog,
  ]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        disabled={disabled || exporting}
        title="Export"
        className={
          showButtonText
            ? isMac
              ? "flex flex-col items-center justify-center gap-1 px-3 py-[6px] min-h-[3.05rem] text-[11px] leading-none text-center whitespace-nowrap toolbar-btn disabled:opacity-40 disabled:pointer-events-none"
              : "flex flex-col items-center justify-center gap-1 px-3 py-1.5 min-h-[3.15rem] text-[11px] leading-none text-center whitespace-nowrap rounded-md toolbar-btn disabled:opacity-40 disabled:pointer-events-none"
            : isMac
              ? "flex items-center justify-center px-3 py-[6px] toolbar-btn disabled:opacity-40 disabled:pointer-events-none"
              : "flex items-center justify-center px-2.5 py-1.5 min-h-9 text-[14px] rounded-md toolbar-btn disabled:opacity-40 disabled:pointer-events-none"
        }
        aria-label={exporting ? "Exporting" : "Export"}
      >
        {exporting ? (
          <LoaderCircle
            className={isMac ? "w-[22px] h-[22px] animate-spin" : "w-4 h-4 animate-spin"}
          />
        ) : (
          <IconExport className={isMac ? "w-[22px] h-[22px]" : "w-4 h-4"} />
        )}
        {showButtonText &&
          (exporting ? (
            <span className="leading-none">Exporting...</span>
          ) : (
            <span className="inline-flex items-center gap-1 leading-none">
              <span>Export</span>
              <IconChevron className="h-3 w-3" />
            </span>
          ))}
      </button>
      {open && (
        <div className="macos-popover absolute right-0 top-full mt-1 w-64 bg-dropdown backdrop-blur-xl border border-border-app rounded-lg shadow-xl z-50 py-1">
          {isPartial && (
            <div className="px-3 pt-2 pb-1.5 border-b border-border-subtle">
              <p className="text-[11px] text-yellow-400">
                Scan in progress — exported files will contain partial results
              </p>
            </div>
          )}
          <div className="px-3 pt-2 pb-1.5 border-b border-border-subtle">
            <p className="text-[11px] uppercase tracking-[0.04em] text-text-tertiary mb-1.5">
              Export Scope
            </p>
            <div className="grid grid-cols-3 gap-1">
              {(
                [
                  ["all", "All"],
                  ["filtered", "Filtered"],
                  ["selected", "Selected"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  disabled={exporting}
                  onClick={() => setScope(value)}
                  className={`rounded-md px-2 py-1 text-[11px] text-left transition-colors ${
                    scope === value
                      ? "bg-btn-hover text-text-primary"
                      : "text-text-secondary hover:bg-btn-hover/70"
                  }`}
                >
                  <span className="block leading-tight">{label}</span>
                  <span className="block leading-tight text-[10px] text-text-tertiary">
                    {scopeCounts[value]}
                  </span>
                </button>
              ))}
            </div>
          </div>
          <button
            onClick={handleExportCsv}
            disabled={exporting}
            className="w-full text-left px-3 py-2.5 min-h-10 text-[14px] hover:bg-btn-hover disabled:opacity-50 disabled:pointer-events-none"
          >
            Export CSV
          </button>
          <button
            onClick={handleExportSplit}
            disabled={exporting}
            className="w-full text-left px-3 py-2.5 min-h-10 text-[14px] hover:bg-btn-hover disabled:opacity-50 disabled:pointer-events-none"
          >
            Split Playlists
          </button>
          <button
            onClick={handleExportRenamed}
            disabled={exporting}
            className="w-full text-left px-3 py-2.5 min-h-10 text-[14px] hover:bg-btn-hover disabled:opacity-50 disabled:pointer-events-none"
          >
            Renamed Playlist
          </button>
          <button
            onClick={handleExportM3u}
            disabled={exporting}
            className="w-full text-left px-3 py-2.5 min-h-10 text-[14px] hover:bg-btn-hover disabled:opacity-50 disabled:pointer-events-none"
          >
            Export M3U/M3U8
          </button>
          <button
            onClick={handleExportScanLog}
            disabled={exporting || scanState === "idle"}
            className="w-full text-left px-3 py-2.5 min-h-10 text-[14px] hover:bg-btn-hover disabled:opacity-50 disabled:pointer-events-none"
            title={scanState === "idle" ? "Run a scan first" : undefined}
          >
            Export Scan Log (JSON)
          </button>
        </div>
      )}
      {feedback && (
        <div className="absolute right-0 top-full mt-1 z-50 w-80 rounded-lg border border-border-app bg-dropdown/95 backdrop-blur-xl shadow-xl p-2.5">
          <div className="flex items-start gap-2 text-[12px] leading-5">
            {feedback.kind === "success" ? (
              <CircleCheck className="w-4 h-4 text-green-400 mt-0.5 shrink-0" />
            ) : feedback.kind === "error" ? (
              <CircleAlert className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
            ) : (
              <Info className="w-4 h-4 text-text-secondary mt-0.5 shrink-0" />
            )}
            <p
              className={
                feedback.kind === "error"
                  ? "text-red-300"
                  : feedback.kind === "success"
                    ? "text-green-300"
                    : "text-text-secondary"
              }
            >
              {feedback.message}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
