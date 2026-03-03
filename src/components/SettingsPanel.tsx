import { useState, useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { X } from "lucide-react";
import type { AppSettings } from "../lib/types";

interface SettingsPanelProps {
  settings: AppSettings;
  onSave: (settings: AppSettings) => void;
  onClose: () => void;
}

export function SettingsPanel({ settings, onSave, onClose }: SettingsPanelProps) {
  const [draft, setDraft] = useState<AppSettings>(settings);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = () => {
    onSave(draft);
    onClose();
  };

  const handleSelectProxy = async () => {
    const path = await open({
      multiple: false,
      filters: [{ name: "Text files", extensions: ["txt", "json"] }],
    });
    if (path) {
      update("proxy_file", path as string);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/50" onClick={onClose} />
      <div className="w-96 bg-zinc-900 border-l border-zinc-700 flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-700">
          <h2 className="text-sm font-semibold">Settings</h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-zinc-800 rounded transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div>
            <label className="block text-xs text-zinc-400 mb-1">
              Timeout (seconds)
            </label>
            <input
              type="number"
              value={draft.timeout}
              onChange={(e) => update("timeout", parseFloat(e.target.value) || 10)}
              step="0.5"
              min="1"
              className="w-full px-3 py-1.5 text-sm bg-zinc-800 border border-zinc-700 rounded-md text-zinc-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs text-zinc-400 mb-1">
              Extended Timeout (seconds)
            </label>
            <input
              type="number"
              value={draft.extended_timeout ?? ""}
              onChange={(e) =>
                update(
                  "extended_timeout",
                  e.target.value ? parseFloat(e.target.value) : null,
                )
              }
              placeholder="Disabled"
              step="1"
              min="1"
              className="w-full px-3 py-1.5 text-sm bg-zinc-800 border border-zinc-700 rounded-md text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs text-zinc-400 mb-1">
              Concurrency (1 = sequential)
            </label>
            <input
              type="number"
              value={draft.concurrency}
              onChange={(e) =>
                update(
                  "concurrency",
                  Math.max(1, Math.min(20, parseInt(e.target.value) || 1)),
                )
              }
              min="1"
              max="20"
              className="w-full px-3 py-1.5 text-sm bg-zinc-800 border border-zinc-700 rounded-md text-zinc-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <p className="text-xs text-zinc-500 mt-1">
              Most IPTV servers enforce 1 connection. Increase only if your server
              supports multiple connections.
            </p>
          </div>

          <div>
            <label className="block text-xs text-zinc-400 mb-1">
              Retries
            </label>
            <input
              type="number"
              value={draft.retries}
              onChange={(e) =>
                update("retries", Math.max(1, parseInt(e.target.value) || 6))
              }
              min="1"
              max="20"
              className="w-full px-3 py-1.5 text-sm bg-zinc-800 border border-zinc-700 rounded-md text-zinc-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs text-zinc-400 mb-1">
              User Agent
            </label>
            <input
              type="text"
              value={draft.user_agent}
              onChange={(e) => update("user_agent", e.target.value)}
              className="w-full px-3 py-1.5 text-sm bg-zinc-800 border border-zinc-700 rounded-md text-zinc-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={draft.skip_screenshots}
                onChange={(e) => update("skip_screenshots", e.target.checked)}
                className="rounded border-zinc-600"
              />
              Skip screenshots
            </label>

            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={draft.profile_bitrate}
                onChange={(e) => update("profile_bitrate", e.target.checked)}
                className="rounded border-zinc-600"
              />
              Profile video bitrate (slower)
            </label>

            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={draft.test_geoblock}
                onChange={(e) => update("test_geoblock", e.target.checked)}
                className="rounded border-zinc-600"
              />
              Test geoblocks with proxies
            </label>
          </div>

          <div>
            <label className="block text-xs text-zinc-400 mb-1">
              Proxy File
            </label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={draft.proxy_file ?? ""}
                readOnly
                placeholder="No proxy file selected"
                className="flex-1 px-3 py-1.5 text-sm bg-zinc-800 border border-zinc-700 rounded-md text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
              />
              <button
                onClick={handleSelectProxy}
                className="px-3 py-1.5 text-sm bg-zinc-700 hover:bg-zinc-600 rounded-md transition-colors"
              >
                Browse
              </button>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 p-4 border-t border-zinc-700">
          <button
            onClick={handleSave}
            className="flex-1 px-3 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-500 rounded-md transition-colors"
          >
            Save Settings
          </button>
          <button
            onClick={onClose}
            className="px-3 py-2 text-sm bg-zinc-700 hover:bg-zinc-600 rounded-md transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
