import { useEffect, useState } from "react";
import { FolderOpen, X } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import type { SavedPlaylistDraft } from "../lib/types";

interface SavedPlaylistEditorDialogProps {
  draft: SavedPlaylistDraft;
  onSave: (draft: SavedPlaylistDraft) => void | Promise<void>;
  onClose: () => void;
}

function validateDraft(draft: SavedPlaylistDraft): string | null {
  if (!draft.display_name.trim()) {
    return "Display name cannot be empty.";
  }
  if (draft.kind === "file" && !draft.path.trim()) {
    return "Path cannot be empty.";
  }
  if (draft.kind === "url") {
    const value = draft.url.trim();
    if (!value) {
      return "URL cannot be empty.";
    }
    if (!/^https?:\/\//i.test(value)) {
      return "URL must start with http:// or https://";
    }
  }
  if (draft.kind === "xtream") {
    if (!draft.username.trim()) {
      return "Xtream username cannot be empty.";
    }
    if (!draft.password?.trim()) {
      return "Xtream password cannot be empty.";
    }
    if (draft.servers.filter((value) => value.trim().length > 0).length === 0) {
      return "Add at least one Xtream server.";
    }
  }
  return null;
}

export default function SavedPlaylistEditorDialog({
  draft,
  onSave,
  onClose,
}: SavedPlaylistEditorDialogProps) {
  const [form, setForm] = useState<SavedPlaylistDraft>(draft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setForm(draft);
    setBusy(false);
    setError(null);
  }, [draft]);

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

  const handleBrowse = async () => {
    const path = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "M3U Playlists", extensions: ["m3u", "m3u8"] }],
    });
    const selected = Array.isArray(path) ? path[0] : path;
    if (!selected || form.kind !== "file") {
      return;
    }
    setForm({ ...form, path: selected });
  };

  const handleSave = async () => {
    const normalized =
      form.kind === "xtream"
        ? {
            ...form,
            display_name: form.display_name.trim(),
            username: form.username.trim(),
            password: form.password?.trim() ?? null,
            preferred_server: form.preferred_server?.trim() || null,
            servers: form.servers.map((server) => server.trim()).filter(Boolean),
          }
        : form.kind === "url"
          ? {
              ...form,
              display_name: form.display_name.trim(),
              url: form.url.trim(),
            }
          : {
              ...form,
              display_name: form.display_name.trim(),
              path: form.path.trim(),
            };

    const validationError = validateDraft(normalized);
    if (validationError) {
      setError(validationError);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await onSave(normalized);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const title = form.id ? "Edit Saved Playlist" : "Save Playlist";

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center px-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-full max-w-2xl rounded-xl border border-border-app bg-overlay shadow-2xl">
        <div className="flex items-start justify-between border-b border-border-app px-5 pb-3 pt-4">
          <div>
            <p className="text-[11px] uppercase tracking-[0.08em] text-text-tertiary mb-1">
              Saved Playlist
            </p>
            <h2 className="text-[18px] font-semibold text-text-primary">{title}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 hover:bg-btn-hover transition-colors"
            aria-label="Close saved playlist editor"
          >
            <X className="w-[18px] h-[18px]" />
          </button>
        </div>

        <div className="space-y-4 p-5">
          <div className="space-y-1.5">
            <label className="text-[12px] font-medium text-text-secondary">
              Display Name
            </label>
            <input
              type="text"
              value={form.display_name}
              onChange={(event) =>
                setForm({ ...form, display_name: event.target.value } as SavedPlaylistDraft)
              }
              className="w-full rounded-md border border-border-app bg-input px-3 py-2 text-[14px] text-text-primary focus:border-blue-500 focus:outline-none"
            />
          </div>

          {form.kind === "file" && (
            <div className="space-y-1.5">
              <label className="text-[12px] font-medium text-text-secondary">Path</label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={form.path}
                  onChange={(event) =>
                    setForm({ ...form, path: event.target.value } as SavedPlaylistDraft)
                  }
                  className="w-full rounded-md border border-border-app bg-input px-3 py-2 text-[13px] text-text-primary focus:border-blue-500 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => void handleBrowse()}
                  className="inline-flex items-center gap-1.5 rounded-md bg-btn px-3 py-2 text-[12px] text-text-primary hover:bg-btn-hover transition-colors"
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                  Browse
                </button>
              </div>
            </div>
          )}

          {form.kind === "url" && (
            <div className="space-y-1.5">
              <label className="text-[12px] font-medium text-text-secondary">URL</label>
              <input
                type="text"
                value={form.url}
                onChange={(event) =>
                  setForm({ ...form, url: event.target.value } as SavedPlaylistDraft)
                }
                className="w-full rounded-md border border-border-app bg-input px-3 py-2 text-[13px] text-text-primary focus:border-blue-500 focus:outline-none"
              />
            </div>
          )}

          {form.kind === "xtream" && (
            <>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-1.5">
                  <label className="text-[12px] font-medium text-text-secondary">
                    Username
                  </label>
                  <input
                    type="text"
                    value={form.username}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        username: event.target.value,
                      } as SavedPlaylistDraft)
                    }
                    className="w-full rounded-md border border-border-app bg-input px-3 py-2 text-[13px] text-text-primary focus:border-blue-500 focus:outline-none"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[12px] font-medium text-text-secondary">
                    Password
                  </label>
                  <input
                    type="password"
                    value={form.password ?? ""}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        password: event.target.value,
                      } as SavedPlaylistDraft)
                    }
                    className="w-full rounded-md border border-border-app bg-input px-3 py-2 text-[13px] text-text-primary focus:border-blue-500 focus:outline-none"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-[12px] font-medium text-text-secondary">
                  Servers
                </label>
                <textarea
                  rows={5}
                  value={form.servers.join("\n")}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      servers: event.target.value.split("\n"),
                    } as SavedPlaylistDraft)
                  }
                  className="w-full rounded-md border border-border-app bg-input px-3 py-2 text-[13px] text-text-primary focus:border-blue-500 focus:outline-none font-mono resize-none"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-[12px] font-medium text-text-secondary">
                  Preferred Server
                </label>
                <select
                  value={form.preferred_server ?? ""}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      preferred_server: event.target.value || null,
                    } as SavedPlaylistDraft)
                  }
                  className="w-full rounded-md border border-border-app bg-input px-3 py-2 text-[13px] text-text-primary focus:border-blue-500 focus:outline-none"
                >
                  <option value="">First available</option>
                  {form.servers
                    .map((server) => server.trim())
                    .filter(Boolean)
                    .map((server) => (
                      <option key={server} value={server}>
                        {server}
                      </option>
                    ))}
                </select>
              </div>
            </>
          )}

          {error && <p className="text-[12px] text-red-400">{error}</p>}

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md bg-btn px-3 py-2 text-[13px] text-text-primary hover:bg-btn-hover transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={busy}
              className="rounded-md bg-blue-600 px-3 py-2 text-[13px] font-medium text-white hover:bg-blue-500 disabled:opacity-50 disabled:pointer-events-none transition-colors"
            >
              {busy ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
