import { useState, useEffect, useRef, useCallback } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { X } from "lucide-react";
import {
  clearScreenshotCache,
  getScreenshotCacheStats,
  setDefaultM3u8FileAssociation,
} from "../lib/tauri";
import {
  HapticFeedbackPattern,
  PerformanceTime,
  triggerHaptic,
} from "../lib/haptics";
import type { AppSettings, ScreenshotCacheStats } from "../lib/types";

interface SettingsPanelProps {
  settings: AppSettings;
  onSave: (settings: AppSettings) => void;
  onClose: () => void;
}

const sectionClass =
  "rounded-2xl border border-border-app/70 bg-panel-subtle p-4 md:p-5";
const labelClass = "block text-[12px] font-medium text-text-secondary mb-1.5";
const inputClass =
  "native-field w-full min-h-9 px-3 py-1.5 text-[13px] bg-input border border-border-app rounded-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-blue-500";
const toggleRowClass =
  "flex items-start gap-2.5 p-2.5 rounded-xl border border-border-subtle hover:border-border-app transition-colors";

function formatBytes(totalBytes: number): string {
  if (totalBytes < 1024) return `${totalBytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = totalBytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

export function SettingsPanel({ settings, onSave, onClose }: SettingsPanelProps) {
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [cacheStats, setCacheStats] = useState<ScreenshotCacheStats | null>(null);
  const [cacheBusy, setCacheBusy] = useState(false);
  const [associationBusy, setAssociationBusy] = useState(false);
  const [associationNotice, setAssociationNotice] = useState<string | null>(null);
  const [associationError, setAssociationError] = useState<string | null>(null);
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

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;

      const focusableElements = panel.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      const first = focusableElements[0];
      const last = focusableElements[focusableElements.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
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

  const refreshCacheStats = useCallback(async () => {
    try {
      const stats = await getScreenshotCacheStats();
      setCacheStats(stats);
    } catch {
      setCacheStats(null);
    }
  }, []);

  useEffect(() => {
    void refreshCacheStats();
  }, [refreshCacheStats]);

  const handleSave = () => {
    onSave(draft);
    void triggerHaptic(HapticFeedbackPattern.LevelChange, PerformanceTime.Now);
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

  const handleClearScreenshotCache = async () => {
    setCacheBusy(true);
    try {
      const stats = await clearScreenshotCache();
      setCacheStats(stats);
    } finally {
      setCacheBusy(false);
    }
  };

  const handleSetDefaultM3u8Association = async () => {
    setAssociationBusy(true);
    setAssociationNotice(null);
    setAssociationError(null);
    try {
      const message = await setDefaultM3u8FileAssociation();
      setAssociationNotice(message);
    } catch (err) {
      setAssociationError(err instanceof Error ? err.message : String(err));
    } finally {
      setAssociationBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal="true" aria-label="Settings">
      <div className="flex-1 bg-black/40" onClick={onClose} />
      <div
        ref={panelRef}
        tabIndex={-1}
        className="macos-sheet w-[36rem] max-w-[96vw] bg-overlay backdrop-blur-xl border-l border-border-app flex flex-col focus:outline-none"
      >
        <div className="flex items-start justify-between px-6 pt-5 pb-4 border-b border-border-app">
          <div>
            <p className="text-[11px] uppercase tracking-[0.08em] text-text-tertiary mb-1">
              Preferences
            </p>
            <h2 className="text-[17px] font-semibold">Scan Settings</h2>
            <p className="text-[12px] text-text-secondary mt-1">
              Tune reliability, speed, and output behavior.
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close settings"
            className="p-1.5 hover:bg-btn-hover rounded-md transition-colors"
            type="button"
          >
            <X className="w-[18px] h-[18px]" />
          </button>
        </div>

        <div className="native-scroll flex-1 overflow-y-auto px-5 py-5 space-y-4">
          <section className={sectionClass}>
            <h3 className="text-[13px] font-semibold mb-3">Performance</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className={labelClass}>Timeout (seconds)</label>
                <input
                  type="number"
                  value={draft.timeout}
                  onChange={(event) => {
                    const value = parseFloat(event.target.value);
                    update("timeout", Number.isNaN(value) ? 10 : Math.max(0.5, value));
                  }}
                  step="0.5"
                  min="0.5"
                  className={inputClass}
                />
              </div>

              <div>
                <label className={labelClass}>Extended Timeout (seconds)</label>
                <input
                  type="number"
                  value={draft.extended_timeout ?? ""}
                  onChange={(event) => {
                    if (!event.target.value) {
                      update("extended_timeout", null);
                    } else {
                      const value = parseFloat(event.target.value);
                      update(
                        "extended_timeout",
                        Number.isNaN(value) ? null : Math.max(1, value),
                      );
                    }
                  }}
                  placeholder="Disabled"
                  step="1"
                  min="1"
                  className={inputClass}
                />
              </div>

              <div>
                <label className={labelClass}>Concurrency</label>
                <input
                  type="number"
                  value={draft.concurrency}
                  onChange={(event) => {
                    const value = parseInt(event.target.value, 10);
                    update(
                      "concurrency",
                      Number.isNaN(value) ? 1 : Math.max(1, Math.min(20, value)),
                    );
                  }}
                  min="1"
                  max="20"
                  className={inputClass}
                />
                <p className="text-[11px] text-text-tertiary mt-1">
                  Use 1 unless your IPTV provider allows multiple simultaneous connections.
                </p>
              </div>

              <div>
                <label className={labelClass}>Max Retries</label>
                <input
                  type="number"
                  value={draft.retries}
                  onChange={(event) => {
                    const value = parseInt(event.target.value, 10);
                    update(
                      "retries",
                      Number.isNaN(value) ? 3 : Math.max(0, Math.min(10, value)),
                    );
                  }}
                  min="0"
                  max="10"
                  className={inputClass}
                />
                <p className="text-[11px] text-text-tertiary mt-1">
                  Number of retry attempts after the initial request.
                </p>
              </div>

              <div>
                <label className={labelClass}>Retry Backoff</label>
                <select
                  value={draft.retry_backoff}
                  onChange={(event) =>
                    update("retry_backoff", event.target.value as AppSettings["retry_backoff"])
                  }
                  className={inputClass}
                >
                  <option value="none">None</option>
                  <option value="linear">Linear</option>
                  <option value="exponential">Exponential</option>
                </select>
              </div>

              <div>
                <label className={labelClass}>Low FPS Threshold</label>
                <input
                  type="number"
                  value={draft.low_fps_threshold}
                  onChange={(event) => {
                    const value = parseFloat(event.target.value);
                    update(
                      "low_fps_threshold",
                      Number.isNaN(value) ? 23.0 : Math.max(0, Math.min(240, value)),
                    );
                  }}
                  step="0.1"
                  min="0"
                  max="240"
                  className={inputClass}
                />
                <p className="text-[11px] text-text-tertiary mt-1">
                  Mark channels as low framerate when FPS is at or below this value.
                </p>
              </div>
            </div>
          </section>

          <section className={sectionClass}>
            <h3 className="text-[13px] font-semibold mb-3">Stream Behavior</h3>
            <div className="space-y-3">
              <div>
                <label className={labelClass}>User Agent</label>
                <input
                  type="text"
                  value={draft.user_agent}
                  onChange={(event) => update("user_agent", event.target.value)}
                  className={inputClass}
                />
              </div>

              <label className={toggleRowClass}>
                <input
                  type="checkbox"
                  checked={draft.skip_screenshots}
                  onChange={(event) => update("skip_screenshots", event.target.checked)}
                  className="mt-[2px] h-4 w-4 rounded border-border-app"
                />
                <span>
                  <span className="block text-[13px] font-medium">Skip screenshots</span>
                  <span className="block text-[11px] text-text-tertiary mt-0.5">
                    Disable frame captures for faster checks.
                  </span>
                </span>
              </label>

              <div className="flex flex-col gap-1">
                <label className={labelClass}>Screenshot format</label>
                <select
                  value={draft.screenshot_format}
                  onChange={(event) =>
                    update("screenshot_format", event.target.value as "webp" | "png")
                  }
                  className={inputClass}
                  disabled={draft.skip_screenshots}
                >
                  <option value="webp">WebP (smaller, faster)</option>
                  <option value="png">PNG (lossless)</option>
                </select>
              </div>

              <label className={toggleRowClass}>
                <input
                  type="checkbox"
                  checked={draft.profile_bitrate}
                  onChange={(event) => update("profile_bitrate", event.target.checked)}
                  className="mt-[2px] h-4 w-4 rounded border-border-app"
                />
                <span>
                  <span className="block text-[13px] font-medium">Profile video bitrate</span>
                  <span className="block text-[11px] text-text-tertiary mt-0.5">
                    Runs deeper ffmpeg sampling. More accurate, but slower.
                  </span>
                </span>
              </label>

              <label className={toggleRowClass}>
                <input
                  type="checkbox"
                  checked={draft.test_geoblock}
                  onChange={(event) => update("test_geoblock", event.target.checked)}
                  className="mt-[2px] h-4 w-4 rounded border-border-app"
                />
                <span>
                  <span className="block text-[13px] font-medium">Confirm geoblocks with proxies</span>
                  <span className="block text-[11px] text-text-tertiary mt-0.5">
                    Re-tests geoblocked streams through your proxy list.
                  </span>
                </span>
              </label>
            </div>
          </section>

          <section className={sectionClass}>
            <h3 className="text-[13px] font-semibold mb-3">Appearance</h3>
            <div className="space-y-3">
              <div>
                <label className={labelClass}>Theme</label>
                <select
                  value={draft.theme}
                  onChange={(event) =>
                    update("theme", event.target.value as AppSettings["theme"])
                  }
                  className={inputClass}
                >
                  <option value="system">System</option>
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                </select>
                <p className="text-[11px] text-text-tertiary mt-1">
                  Applied immediately and saved for future launches.
                </p>
              </div>

              <label className={toggleRowClass}>
                <input
                  type="checkbox"
                  checked={draft.show_prescan_filter}
                  onChange={(event) => update("show_prescan_filter", event.target.checked)}
                  className="mt-[2px] h-4 w-4 rounded border-border-app"
                />
                <span>
                  <span className="block text-[13px] font-medium">Show pre-scan filter bar</span>
                  <span className="block text-[11px] text-text-tertiary mt-0.5">
                    Display the regex filter bar for narrowing channels before scanning.
                  </span>
                </span>
              </label>

              <div>
                <label className={labelClass}>Channel Logo Size</label>
                <select
                  value={draft.channel_logo_size}
                  onChange={(event) =>
                    update(
                      "channel_logo_size",
                      event.target.value as AppSettings["channel_logo_size"],
                    )
                  }
                  className={inputClass}
                >
                  <option value="small">Small (16px)</option>
                  <option value="medium">Medium (24px)</option>
                  <option value="large">Large (36px)</option>
                  <option value="huge">Huge (48px)</option>
                </select>
                <p className="text-[11px] text-text-tertiary mt-1">
                  Controls logo size in the channel name column.
                </p>
              </div>
            </div>
          </section>

          <section className={sectionClass}>
            <h3 className="text-[13px] font-semibold mb-3">Files and Output</h3>
            <div className="space-y-3">
              <div>
                <label className={labelClass}>Proxy File</label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={draft.proxy_file ?? ""}
                    readOnly
                    placeholder="No proxy file selected"
                    className={`${inputClass} flex-1`}
                  />
                  <button
                    onClick={handleSelectProxy}
                    className="macos-btn px-3 py-1.5 min-h-9 text-[13px] bg-btn hover:bg-btn-hover rounded-md"
                    type="button"
                  >
                    Browse
                  </button>
                </div>
              </div>

              <div>
                <label className={labelClass}>Save Screenshots To</label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={draft.screenshots_dir ?? ""}
                    readOnly
                    placeholder="Not saved (preview only)"
                    className={`${inputClass} flex-1`}
                  />
                  <button
                    onClick={handleSelectScreenshotsDir}
                    className="macos-btn px-3 py-1.5 min-h-9 text-[13px] bg-btn hover:bg-btn-hover rounded-md"
                    type="button"
                  >
                    Browse
                  </button>
                  {draft.screenshots_dir && (
                    <button
                      onClick={() => update("screenshots_dir", null)}
                      className="macos-btn px-3 py-1.5 min-h-9 text-[13px] bg-btn hover:bg-btn-hover rounded-md"
                      type="button"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>

              <div className="rounded-xl border border-border-subtle p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[12px] font-medium">Default app for .m3u8</p>
                    <p className="text-[11px] text-text-tertiary mt-0.5">
                      Open .m3u8 playlist files in IPTV Checker by default.
                    </p>
                  </div>
                  <button
                    onClick={handleSetDefaultM3u8Association}
                    disabled={associationBusy}
                    className="macos-btn px-3 py-1.5 min-h-9 text-[13px] bg-btn hover:bg-btn-hover rounded-md disabled:opacity-50 disabled:pointer-events-none"
                    type="button"
                  >
                    {associationBusy ? "Applying..." : "Set as Default"}
                  </button>
                </div>
                {associationNotice && (
                  <p className="mt-2 text-[11px] text-emerald-400">{associationNotice}</p>
                )}
                {associationError && (
                  <p className="mt-2 text-[11px] text-red-400">{associationError}</p>
                )}
              </div>

              <div className="rounded-xl border border-border-subtle p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <p className="text-[12px] font-medium">Temp Screenshot Cache</p>
                      {cacheStats?.disk_space && (
                        <span
                          className={`inline-block w-2 h-2 rounded-full ${
                            cacheStats.disk_space.tier === "critical"
                              ? "bg-red-500"
                              : cacheStats.disk_space.tier === "low"
                                ? "bg-amber-500"
                                : cacheStats.disk_space.tier === "moderate"
                                  ? "bg-yellow-400"
                                  : "bg-emerald-500"
                          }`}
                          title={`Disk space: ${formatBytes(cacheStats.disk_space.available_bytes)} available (${cacheStats.disk_space.tier})`}
                        />
                      )}
                    </div>
                    <p className="text-[11px] text-text-tertiary mt-0.5">
                      {cacheStats
                        ? `${formatBytes(cacheStats.total_bytes)} (${cacheStats.file_count} files)`
                        : "Unavailable"}
                      {cacheStats?.disk_space && (
                        <span className="ml-1.5 text-text-tertiary/70">
                          · {formatBytes(cacheStats.disk_space.available_bytes)} free
                        </span>
                      )}
                    </p>
                  </div>
                  <button
                    onClick={handleClearScreenshotCache}
                    disabled={cacheBusy || !cacheStats || cacheStats.file_count === 0}
                    className="macos-btn px-3 py-1.5 min-h-9 text-[13px] bg-btn hover:bg-btn-hover rounded-md disabled:opacity-50 disabled:pointer-events-none"
                    type="button"
                  >
                    {cacheBusy ? "Clearing..." : "Clear Cache"}
                  </button>
                </div>
                {cacheStats && (
                  <p
                    className="mt-2 text-[11px] text-text-tertiary truncate"
                    title={cacheStats.cache_dir}
                  >
                    {cacheStats.cache_dir}
                  </p>
                )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className={labelClass}>Screenshot Retention</label>
                  <input
                    type="number"
                    value={draft.screenshot_retention_count}
                    onChange={(event) => {
                      const value = parseInt(event.target.value, 10);
                      update(
                        "screenshot_retention_count",
                        Number.isNaN(value) ? 1 : Math.max(0, Math.min(100, value)),
                      );
                    }}
                    min="0"
                    max="100"
                    className={inputClass}
                  />
                  <p className="text-[11px] text-text-tertiary mt-1">
                    Keep last N scan screenshot dirs per playlist source. 0 = no retention.
                  </p>
                </div>

                <div>
                  <label className={labelClass}>Low Space Threshold (GB)</label>
                  <input
                    type="number"
                    value={draft.low_space_threshold_gb}
                    onChange={(event) => {
                      const value = parseFloat(event.target.value);
                      update(
                        "low_space_threshold_gb",
                        Number.isNaN(value) ? 5.0 : Math.max(1, Math.min(50, value)),
                      );
                    }}
                    step="0.5"
                    min="1"
                    max="50"
                    className={inputClass}
                  />
                  <p className="text-[11px] text-text-tertiary mt-1">
                    Pause screenshots during scans when free disk space drops below this.
                  </p>
                </div>
              </div>
            </div>
          </section>

          <section className={sectionClass}>
            <h3 className="text-[13px] font-semibold mb-3">Diagnostics</h3>
            <div className="space-y-3">
              <div>
                <label className={labelClass}>Scan History Retention</label>
                <input
                  type="number"
                  value={draft.scan_history_limit}
                  onChange={(event) => {
                    const value = parseInt(event.target.value, 10);
                    update(
                      "scan_history_limit",
                      Number.isNaN(value) ? 20 : Math.max(1, Math.min(200, value)),
                    );
                  }}
                  min="1"
                  max="200"
                  className={inputClass}
                />
                <p className="text-[11px] text-text-tertiary mt-1">
                  Max completed scans to keep per playlist.
                </p>
              </div>

              <label className={toggleRowClass}>
                <input
                  type="checkbox"
                  checked={draft.scan_notifications}
                  onChange={(event) => update("scan_notifications", event.target.checked)}
                  className="mt-[2px] h-4 w-4 rounded border-border-app"
                />
                <span>
                  <span className="block text-[13px] font-medium">Scan completion notifications</span>
                  <span className="block text-[11px] text-text-tertiary mt-0.5">
                    Show native OS notifications when scans complete or are cancelled.
                  </span>
                </span>
              </label>

              <div>
              <label className={labelClass}>Log Level</label>
              <select
                value={draft.log_level}
                onChange={(event) => update("log_level", event.target.value)}
                className={inputClass}
              >
                <option value="error">Error</option>
                <option value="warn">Warning</option>
                <option value="info">Info</option>
                <option value="debug">Debug</option>
                <option value="trace">Trace</option>
              </select>
              </div>
            </div>
          </section>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border-app bg-panel-subtle">
          <button
            onClick={onClose}
            className="macos-btn px-3.5 py-2 min-h-9 text-[13px] bg-btn hover:bg-btn-hover rounded-md"
            type="button"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="macos-btn macos-btn-primary px-4 py-2 min-h-9 text-[13px] font-medium bg-blue-600 hover:bg-blue-500 rounded-md"
            type="button"
          >
            Save Settings
          </button>
        </div>
      </div>
    </div>
  );
}
