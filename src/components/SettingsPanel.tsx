import { useState, useEffect, useRef } from "react";
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
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  // Focus trap
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;

    const previouslyFocused = document.activeElement as HTMLElement;
    panel.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;

      const focusableElements = panel.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      const first = focusableElements[0];
      const last = focusableElements[focusableElements.length - 1];

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    panel.addEventListener("keydown", handleKeyDown);
    return () => {
      panel.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus();
    };
  }, []);

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

  const handleSelectScreenshotsDir = async () => {
    const path = await open({
      multiple: false,
      directory: true,
    });
    if (path) {
      update("screenshots_dir", path as string);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal="true" aria-label="Settings">
      <div className="flex-1 bg-black/50" onClick={onClose} />
      <div ref={panelRef} tabIndex={-1} className="macos-sheet w-[26rem] bg-overlay backdrop-blur-xl border-l border-border-app flex flex-col focus:outline-none">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-app">
          <h2 className="text-sm font-semibold">Settings</h2>
          <button
            onClick={onClose}
            aria-label="Close settings"
            className="p-1.5 hover:bg-btn-hover rounded"
          >
            <X className="w-[18px] h-[18px]" />
          </button>
        </div>

        <div className="native-scroll flex-1 overflow-y-auto p-4 space-y-[16px]">
          <div>
            <label className="block text-[12px] text-text-secondary mb-1.5">
              Timeout (seconds)
            </label>
            <input
              type="number"
              value={draft.timeout}
              onChange={(e) => {
                const val = parseFloat(e.target.value);
                update("timeout", Number.isNaN(val) ? 10 : Math.max(0.5, val));
              }}
              step="0.5"
              min="1"
              className="native-field w-full min-h-9 px-3 py-1.5 text-[13px] bg-input border border-border-app rounded-md text-text-primary focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-[12px] text-text-secondary mb-1.5">
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
              className="native-field w-full min-h-9 px-3 py-1.5 text-[13px] bg-input border border-border-app rounded-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-[12px] text-text-secondary mb-1.5">
              Concurrency (1 = sequential)
            </label>
            <input
              type="number"
              value={draft.concurrency}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10);
                update(
                  "concurrency",
                  Number.isNaN(val) ? 1 : Math.max(1, Math.min(20, val)),
                );
              }}
              min="1"
              max="20"
              className="native-field w-full min-h-9 px-3 py-1.5 text-[13px] bg-input border border-border-app rounded-md text-text-primary focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <p className="text-[12px] text-text-tertiary mt-1.5">
              Most IPTV servers enforce 1 connection. Increase only if your server
              supports multiple connections.
            </p>
          </div>

          <div>
            <label className="block text-[12px] text-text-secondary mb-1.5">
              Retries
            </label>
            <input
              type="number"
              value={draft.retries}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10);
                update("retries", Number.isNaN(val) ? 6 : Math.max(1, val));
              }}
              min="1"
              max="20"
              className="native-field w-full min-h-9 px-3 py-1.5 text-[13px] bg-input border border-border-app rounded-md text-text-primary focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-[12px] text-text-secondary mb-1.5">
              User Agent
            </label>
            <input
              type="text"
              value={draft.user_agent}
              onChange={(e) => update("user_agent", e.target.value)}
              className="native-field w-full min-h-9 px-3 py-1.5 text-[13px] bg-input border border-border-app rounded-md text-text-primary focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          <div className="space-y-2.5">
            <label className="flex items-center gap-2.5 text-[13px] cursor-pointer">
              <input
                type="checkbox"
                checked={draft.skip_screenshots}
                onChange={(e) => update("skip_screenshots", e.target.checked)}
                className="h-4 w-4 rounded border-border-app"
              />
              Skip screenshots
            </label>

            <label className="flex items-center gap-2.5 text-[13px] cursor-pointer">
              <input
                type="checkbox"
                checked={draft.profile_bitrate}
                onChange={(e) => update("profile_bitrate", e.target.checked)}
                className="h-4 w-4 rounded border-border-app"
              />
              Profile video bitrate (slower)
            </label>

            <label className="flex items-center gap-2.5 text-[13px] cursor-pointer">
              <input
                type="checkbox"
                checked={draft.test_geoblock}
                onChange={(e) => update("test_geoblock", e.target.checked)}
                className="h-4 w-4 rounded border-border-app"
              />
              Test geoblocks with proxies
            </label>
          </div>

          <div>
            <label className="block text-[12px] text-text-secondary mb-1.5">
              Proxy File
            </label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={draft.proxy_file ?? ""}
                readOnly
                placeholder="No proxy file selected"
                className="native-field flex-1 min-h-9 px-3 py-1.5 text-[13px] bg-input border border-border-app rounded-md text-text-primary placeholder:text-text-tertiary focus:outline-none"
              />
              <button
                onClick={handleSelectProxy}
                className="macos-btn px-3 py-1.5 min-h-9 text-[13px] bg-btn hover:bg-btn-hover rounded-md"
              >
                Browse
              </button>
            </div>
          </div>

          <div>
            <label className="block text-[12px] text-text-secondary mb-1.5">
              Save Screenshots To
            </label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={draft.screenshots_dir ?? ""}
                readOnly
                placeholder="Not saved (in-app preview only)"
                className="native-field flex-1 min-h-9 px-3 py-1.5 text-[13px] bg-input border border-border-app rounded-md text-text-primary placeholder:text-text-tertiary focus:outline-none"
              />
              <button
                onClick={handleSelectScreenshotsDir}
                className="macos-btn px-3 py-1.5 min-h-9 text-[13px] bg-btn hover:bg-btn-hover rounded-md"
              >
                Browse
              </button>
              {draft.screenshots_dir && (
                <button
                  onClick={() => update("screenshots_dir", null)}
                  className="macos-btn px-3 py-1.5 min-h-9 text-[13px] bg-btn hover:bg-btn-hover rounded-md"
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          <div>
            <label className="block text-[12px] text-text-secondary mb-1.5">
              Log Level
            </label>
            <select
              value={draft.log_level}
              onChange={(e) => update("log_level", e.target.value)}
              className="native-field w-full min-h-9 px-3 py-1.5 text-[13px] bg-input border border-border-app rounded-md text-text-primary focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="error">Error</option>
              <option value="warn">Warning</option>
              <option value="info">Info</option>
              <option value="debug">Debug</option>
              <option value="trace">Trace</option>
            </select>
          </div>
        </div>

        <div className="flex items-center gap-2 p-4 border-t border-border-app">
          <button
            onClick={handleSave}
            className="macos-btn macos-btn-primary flex-1 px-3 py-2 min-h-9 text-[13px] font-medium bg-blue-600 hover:bg-blue-500 rounded-md"
          >
            Save Settings
          </button>
          <button
            onClick={onClose}
            className="macos-btn px-3 py-2 min-h-9 text-[13px] bg-btn hover:bg-btn-hover rounded-md"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
