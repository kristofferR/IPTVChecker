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
        className="flex items-center gap-2 px-3 py-1.5 min-h-9 text-[14px] rounded-md toolbar-btn disabled:opacity-40 disabled:pointer-events-none"
      >
        <Download className="w-4 h-4" />
        Export
        <ChevronDown className="w-[14px] h-[14px]" />
      </button>
      {open && (
        <div className="macos-popover absolute right-0 top-full mt-1 w-48 bg-dropdown backdrop-blur-xl border border-border-app rounded-lg shadow-xl z-50 py-1">
          <button
            onClick={handleExportCsv}
            className="w-full text-left px-3 py-2.5 min-h-10 text-[14px] hover:bg-btn-hover"
          >
            Export CSV
          </button>
          <button
            onClick={handleExportSplit}
            className="w-full text-left px-3 py-2.5 min-h-10 text-[14px] hover:bg-btn-hover"
          >
            Split Playlists
          </button>
          <button
            onClick={handleExportRenamed}
            className="w-full text-left px-3 py-2.5 min-h-10 text-[14px] hover:bg-btn-hover"
          >
            Renamed Playlist
          </button>
        </div>
      )}
    </div>
  );
}
