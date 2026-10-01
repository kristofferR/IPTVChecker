import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen, X } from "lucide-react";
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useState } from "react";
import { t } from "../i18n";
import type { SavedPlaylistDraft } from "../lib/types";
import PasswordField from "./PasswordField";

interface SavedPlaylistEditorDialogProps {
  draft: SavedPlaylistDraft;
  onSave: (draft: SavedPlaylistDraft) => void | Promise<void>;
  onClose: () => void;
}

function validateDraft(draft: SavedPlaylistDraft): string | null {
  if (!draft.display_name.trim()) {
    return t("saved.editor.validation.displayNameEmpty");
  }
  if (draft.kind === "file" && !draft.path.trim()) {
    return t("saved.editor.validation.pathEmpty");
  }
  if (draft.kind === "url") {
    const value = draft.url.trim();
    if (!value) {
      return t("saved.editor.validation.urlEmpty");
    }
    if (!/^https?:\/\//i.test(value)) {
      return t("saved.editor.validation.urlScheme");
    }
  }
  if (draft.kind === "xtream") {
    if (!draft.username.trim()) {
      return t("saved.editor.validation.xtreamUsernameEmpty");
    }
    if (!draft.password?.trim()) {
      return t("saved.editor.validation.xtreamPasswordEmpty");
    }
    if (draft.servers.filter((value) => value.trim().length > 0).length === 0) {
      return t("saved.editor.validation.xtreamServersEmpty");
    }
  }
  if (draft.kind === "dispatcharr") {
    if (!/^https?:\/\//i.test(draft.server.trim())) {
      return t("saved.editor.validation.dispatcharrServerScheme");
    }
    if (!draft.api_key?.trim() && !(draft.username?.trim() && draft.password?.trim())) {
      return t("saved.editor.validation.dispatcharrCredentialsMissing");
    }
  }
  return null;
}

function handleSelectAllShortcut(
  event: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
): void {
  const lowerKey = event.key.toLowerCase();
  const hasPrimaryModifier = (event.metaKey && !event.ctrlKey) || (event.ctrlKey && !event.metaKey);

  if (!hasPrimaryModifier || event.altKey || event.shiftKey || lowerKey !== "a") {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  event.currentTarget.select();
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
      filters: [{ name: t("saved.editor.fileFilterName"), extensions: ["m3u", "m3u8"] }],
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
        ? (() => {
            const servers = form.servers.map((server) => server.trim()).filter(Boolean);
            const preferredServer = form.preferred_server?.trim() ?? "";

            return {
              ...form,
              display_name: form.display_name.trim(),
              username: form.username.trim(),
              password: form.password?.trim() ?? null,
              preferred_server:
                preferredServer && servers.includes(preferredServer) ? preferredServer : null,
              servers,
            };
          })()
        : form.kind === "url"
          ? {
              ...form,
              display_name: form.display_name.trim(),
              url: form.url.trim(),
            }
          : form.kind === "dispatcharr"
            ? {
                ...form,
                display_name: form.display_name.trim(),
                server: form.server.trim(),
                username: form.username?.trim() || null,
                password: form.password?.trim() || null,
                api_key: form.api_key?.trim() || null,
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

  const title = form.id ? t("saved.editor.editTitle") : t("saved.editor.saveTitle");

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center px-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-full max-w-2xl rounded-xl border border-border-app bg-overlay shadow-2xl">
        <div className="flex items-start justify-between border-b border-border-app px-5 pb-3 pt-4">
          <div>
            <h2 className="text-[18px] font-semibold text-text-primary">{title}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 hover:bg-btn-hover transition-colors"
            aria-label={t("saved.editor.closeLabel")}
          >
            <X className="w-[18px] h-[18px]" />
          </button>
        </div>

        <div className="space-y-4 p-5">
          <div className="space-y-1.5">
            <label className="text-[12px] font-medium text-text-secondary">
              {t("saved.editor.displayName")}
            </label>
            <input
              type="text"
              dir="auto"
              value={form.display_name}
              onKeyDown={handleSelectAllShortcut}
              onChange={(event) =>
                setForm({ ...form, display_name: event.target.value } as SavedPlaylistDraft)
              }
              className="w-full rounded-md border border-border-app bg-input px-3 py-2 text-[14px] text-text-primary focus:border-blue-500 focus:outline-none"
            />
          </div>

          {form.kind === "file" && (
            <div className="space-y-1.5">
              <label className="text-[12px] font-medium text-text-secondary">
                {t("saved.editor.path")}
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  dir="ltr"
                  value={form.path}
                  onKeyDown={handleSelectAllShortcut}
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
                  {t("saved.editor.browse")}
                </button>
              </div>
            </div>
          )}

          {form.kind === "url" && (
            <div className="space-y-1.5">
              <label className="text-[12px] font-medium text-text-secondary">URL</label>
              <input
                type="text"
                dir="ltr"
                value={form.url}
                onKeyDown={handleSelectAllShortcut}
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
                    {t("saved.editor.username")}
                  </label>
                  <input
                    type="text"
                    dir="ltr"
                    value={form.username}
                    onKeyDown={handleSelectAllShortcut}
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
                  <label
                    htmlFor="saved-playlist-xtream-password"
                    className="text-[12px] font-medium text-text-secondary"
                  >
                    {t("saved.editor.password")}
                  </label>
                  <PasswordField
                    id="saved-playlist-xtream-password"
                    value={form.password ?? ""}
                    onKeyDown={handleSelectAllShortcut}
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
                  {t("saved.editor.servers")}
                </label>
                <textarea
                  rows={5}
                  dir="ltr"
                  value={form.servers.join("\n")}
                  placeholder={"http://server-1.example.com\nhttp://server-2.example.com"}
                  onKeyDown={handleSelectAllShortcut}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      servers: event.target.value.split("\n"),
                    } as SavedPlaylistDraft)
                  }
                  className="w-full rounded-md border border-border-app bg-input px-3 py-2 text-[13px] text-text-primary focus:border-blue-500 focus:outline-none font-mono resize-none"
                />
                <p className="text-[11px] text-text-tertiary">{t("saved.editor.serversHint")}</p>
              </div>

              <div className="space-y-1.5">
                <label className="text-[12px] font-medium text-text-secondary">
                  {t("saved.editor.preferredServer")}
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
                  <option value="">{t("saved.editor.firstAvailable")}</option>
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

          {form.kind === "dispatcharr" && (
            <>
              <div className="space-y-1.5">
                <label
                  htmlFor="saved-playlist-dispatcharr-server"
                  className="text-[12px] font-medium text-text-secondary"
                >
                  {t("saved.editor.server")}
                </label>
                <input
                  id="saved-playlist-dispatcharr-server"
                  type="text"
                  dir="ltr"
                  value={form.server}
                  onKeyDown={handleSelectAllShortcut}
                  onChange={(event) => setForm({ ...form, server: event.target.value })}
                  className="w-full rounded-md border border-border-app bg-input px-3 py-2 text-[13px] text-text-primary focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div className="space-y-1.5">
                <label
                  htmlFor="saved-playlist-dispatcharr-api-key"
                  className="text-[12px] font-medium text-text-secondary"
                >
                  {t("saved.editor.apiKey")}
                </label>
                <PasswordField
                  id="saved-playlist-dispatcharr-api-key"
                  value={form.api_key ?? ""}
                  onKeyDown={handleSelectAllShortcut}
                  onChange={(event) => setForm({ ...form, api_key: event.target.value })}
                  className="w-full rounded-md border border-border-app bg-input px-3 py-2 text-[13px] text-text-primary focus:border-blue-500 focus:outline-none"
                />
                <p className="text-[11px] text-text-tertiary">{t("saved.editor.apiKeyHint")}</p>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-1.5">
                  <label
                    htmlFor="saved-playlist-dispatcharr-username"
                    className="text-[12px] font-medium text-text-secondary"
                  >
                    {t("saved.editor.username")}
                  </label>
                  <input
                    id="saved-playlist-dispatcharr-username"
                    type="text"
                    dir="ltr"
                    value={form.username ?? ""}
                    onKeyDown={handleSelectAllShortcut}
                    onChange={(event) => setForm({ ...form, username: event.target.value })}
                    className="w-full rounded-md border border-border-app bg-input px-3 py-2 text-[13px] text-text-primary focus:border-blue-500 focus:outline-none"
                  />
                </div>
                <div className="space-y-1.5">
                  <label
                    htmlFor="saved-playlist-dispatcharr-password"
                    className="text-[12px] font-medium text-text-secondary"
                  >
                    {t("saved.editor.password")}
                  </label>
                  <PasswordField
                    id="saved-playlist-dispatcharr-password"
                    value={form.password ?? ""}
                    onKeyDown={handleSelectAllShortcut}
                    onChange={(event) => setForm({ ...form, password: event.target.value })}
                    className="w-full rounded-md border border-border-app bg-input px-3 py-2 text-[13px] text-text-primary focus:border-blue-500 focus:outline-none"
                  />
                </div>
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
              {t("common.cancel")}
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={busy}
              className="rounded-md bg-blue-600 px-3 py-2 text-[13px] font-medium text-white hover:bg-blue-500 disabled:opacity-50 disabled:pointer-events-none transition-colors"
            >
              {busy ? t("saved.editor.saving") : t("common.save")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
