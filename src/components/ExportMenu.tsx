import { useState, useRef, useEffect, useCallback } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import {
  Download,
  ChevronDown,
  LoaderCircle,
  CircleCheck,
  CircleAlert,
  Info,
} from "lucide-react";
import type { ChannelResult } from "../lib/types";
import { exportCsv, exportSplit, exportRenamed } from "../lib/tauri";

interface ExportMenuProps {
  results: ChannelResult[];
  playlistName: string;
  playlistPath: string;
  disabled: boolean;
  menuRequest?: {
    id: number;
    action: "csv" | "split" | "renamed";
  } | null;
}

export function ExportMenu({
  results,
  playlistName,
  playlistPath,
  disabled,
  menuRequest,
}: ExportMenuProps) {
  const [open, setOpen] = useState(false);
  const [busyAction, setBusyAction] = useState<"csv" | "split" | "renamed" | null>(null);
  const [feedback, setFeedback] = useState<{
    kind: "success" | "error" | "info";
    message: string;
  } | null>(null);
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

  const handleExportCsv = useCallback(async () => {
    setOpen(false);
    const path = await save({
      defaultPath: `${playlistName}_results.csv`,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (!path) {
      setFeedback({ kind: "info", message: "Export CSV cancelled." });
      return;
    }

    setBusyAction("csv");
    try {
      await exportCsv(results, path, playlistName);
      setFeedback({
        kind: "success",
        message: `Exported CSV to ${path}.`,
      });
    } catch (err) {
      setFeedback({
        kind: "error",
        message: `CSV export failed: ${String(err)}`,
      });
    } finally {
      setBusyAction(null);
    }
  }, [playlistName, results]);

  const handleExportSplit = useCallback(async () => {
    setOpen(false);
    setBusyAction("split");
    try {
      await exportSplit(results, playlistPath);
      setFeedback({
        kind: "success",
        message: `Split playlists exported to ${sourceDir}.`,
      });
    } catch (err) {
      setFeedback({
        kind: "error",
        message: `Split export failed: ${String(err)}`,
      });
    } finally {
      setBusyAction(null);
    }
  }, [playlistPath, results, sourceDir]);

  const handleExportRenamed = useCallback(async () => {
    setOpen(false);
    setBusyAction("renamed");
    try {
      await exportRenamed(results, playlistPath);
      setFeedback({
        kind: "success",
        message: `Renamed playlist exported to ${sourceDir}/${sourceStem}_renamed.m3u8.`,
      });
    } catch (err) {
      setFeedback({
        kind: "error",
        message: `Renamed export failed: ${String(err)}`,
      });
    } finally {
      setBusyAction(null);
    }
  }, [playlistPath, results, sourceDir, sourceStem]);

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
    }
  }, [
    menuRequest,
    disabled,
    exporting,
    handleExportCsv,
    handleExportSplit,
    handleExportRenamed,
  ]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        disabled={disabled || exporting}
        className="flex items-center gap-2 px-3 py-1.5 min-h-9 text-[14px] rounded-md toolbar-btn disabled:opacity-40 disabled:pointer-events-none"
      >
        {exporting ? (
          <LoaderCircle className="w-4 h-4 animate-spin" />
        ) : (
          <Download className="w-4 h-4" />
        )}
        {exporting ? "Exporting..." : "Export"}
        {!exporting && <ChevronDown className="w-[14px] h-[14px]" />}
      </button>
      {open && (
        <div className="macos-popover absolute right-0 top-full mt-1 w-48 bg-dropdown backdrop-blur-xl border border-border-app rounded-lg shadow-xl z-50 py-1">
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
