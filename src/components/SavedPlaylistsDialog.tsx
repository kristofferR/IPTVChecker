import { FolderOpen, Pencil, Server, Trash2, X } from "lucide-react";
import { useEffect } from "react";
import { savedPlaylistSecondaryLabel } from "../lib/savedPlaylists";
import type { SavedPlaylistEntry } from "../lib/types";

interface SavedPlaylistsDialogProps {
  playlists: SavedPlaylistEntry[];
  onOpen: (id: string) => void;
  onEdit: (entry: SavedPlaylistEntry) => void;
  onDelete: (id: string) => void;
  onTestServers: (entry: SavedPlaylistEntry) => void;
  onClose: () => void;
}

export default function SavedPlaylistsDialog({
  playlists,
  onOpen,
  onEdit,
  onDelete,
  onTestServers,
  onClose,
}: SavedPlaylistsDialogProps) {
  const closeThen = (action: () => void) => {
    onClose();
    window.setTimeout(action, 0);
  };

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center px-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-full max-w-4xl rounded-xl border border-border-app bg-overlay shadow-2xl">
        <div className="flex items-start justify-between border-b border-border-app px-5 pb-3 pt-4">
          <div>
            <p className="text-[11px] uppercase tracking-[0.08em] text-text-tertiary mb-1">
              Library
            </p>
            <h2 className="text-[18px] font-semibold text-text-primary">Saved Playlists</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 hover:bg-btn-hover transition-colors"
            aria-label="Close saved playlists"
          >
            <X className="w-[18px] h-[18px]" />
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto p-5">
          {playlists.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border-app px-4 py-8 text-center text-text-tertiary">
              No saved playlists yet.
            </div>
          ) : (
            <div className="space-y-3">
              {playlists.map((entry) => (
                <div
                  key={entry.id}
                  className="rounded-xl border border-border-app bg-panel-subtle px-4 py-3"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-[15px] font-medium text-text-primary truncate">
                        {entry.display_name}
                      </p>
                      <p
                        className="mt-1 text-[12px] text-text-tertiary truncate"
                        title={savedPlaylistSecondaryLabel(entry)}
                      >
                        {savedPlaylistSecondaryLabel(entry)}
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          onOpen(entry.id);
                          onClose();
                        }}
                        className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-blue-500 transition-colors"
                      >
                        <FolderOpen className="h-3.5 w-3.5" />
                        Open
                      </button>
                      <button
                        type="button"
                        onClick={() => closeThen(() => onEdit(entry))}
                        className="inline-flex items-center gap-1.5 rounded-md bg-btn px-3 py-1.5 text-[12px] text-text-primary hover:bg-btn-hover transition-colors"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                        Edit
                      </button>
                      {entry.kind === "xtream" && (
                        <button
                          type="button"
                          onClick={() => closeThen(() => onTestServers(entry))}
                          className="inline-flex items-center gap-1.5 rounded-md bg-btn px-3 py-1.5 text-[12px] text-text-primary hover:bg-btn-hover transition-colors"
                        >
                          <Server className="h-3.5 w-3.5" />
                          Test Servers
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => onDelete(entry.id)}
                        className="inline-flex items-center gap-1.5 rounded-md bg-red-500/15 px-3 py-1.5 text-[12px] text-red-300 hover:bg-red-500/25 transition-colors"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        Delete
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
