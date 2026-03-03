import { useState, useRef, useEffect } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { Download, ChevronDown } from "lucide-react";
import type { ChannelResult } from "../lib/types";
import { exportCsv, exportSplit, exportRenamed } from "../lib/tauri";

interface ExportMenuProps {
  results: ChannelResult[];
  playlistName: string;
  playlistPath: string;
  disabled: boolean;
}

export function ExportMenu({
  results,
  playlistName,
  playlistPath,
  disabled,
}: ExportMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleExportCsv = async () => {
    setOpen(false);
    const path = await save({
      defaultPath: `${playlistName}_results.csv`,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (path) {
      await exportCsv(results, path, playlistName);
    }
  };

  const handleExportSplit = async () => {
    setOpen(false);
    await exportSplit(results, playlistPath);
  };

  const handleExportRenamed = async () => {
    setOpen(false);
    await exportRenamed(results, playlistPath);
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        disabled={disabled}
        className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-btn hover:bg-btn-hover disabled:opacity-50 disabled:cursor-not-allowed rounded-md transition-colors"
      >
        <Download className="w-4 h-4" />
        Export
        <ChevronDown className="w-3 h-3" />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-48 bg-dropdown backdrop-blur-xl border border-border-app rounded-lg shadow-xl z-50 py-1">
          <button
            onClick={handleExportCsv}
            className="w-full text-left px-3 py-2 text-sm hover:bg-btn-hover transition-colors"
          >
            Export CSV
          </button>
          <button
            onClick={handleExportSplit}
            className="w-full text-left px-3 py-2 text-sm hover:bg-btn-hover transition-colors"
          >
            Split Playlists
          </button>
          <button
            onClick={handleExportRenamed}
            className="w-full text-left px-3 py-2 text-sm hover:bg-btn-hover transition-colors"
          >
            Renamed Playlist
          </button>
        </div>
      )}
    </div>
  );
}
