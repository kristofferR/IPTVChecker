import { useState, useEffect, useRef, useCallback } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Gauge,
  Layers,
  Network,
  SlidersHorizontal,
  Wrench,
} from "lucide-react";
import {
  clearScreenshotCache,
  deleteScanPreset,
  getScanPresets,
  getScreenshotCacheStats,
  renameScanPreset,
  saveScanPreset,
  setDefaultScanPreset,
  setDefaultM3u8FileAssociation,
} from "../lib/tauri";
import type {
  AppSettings,
  ScanPresetCollection,
  ScanPresetConfig,
  ScanSettingsPreset,
  ScreenshotCacheStats,
} from "../lib/types";

type SettingsTab = "general" | "scanning" | "media" | "network" | "advanced";

interface SettingsPanelProps {
  settings: AppSettings;
  onSave: (settings: AppSettings) => Promise<void> | void;
}

interface PersistOptions {
  immediate?: boolean;
}

const SAVE_DEBOUNCE_MS = 280;
const inputClass =
  "native-field w-full min-h-9 px-3 py-1.5 text-[13px] bg-input border border-border-app rounded-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-blue-500";
const blockClass = "rounded-2xl border border-border-app/70 bg-panel-subtle";
const rowClass =
  "flex items-center justify-between gap-3 px-4 py-3 border-b border-border-subtle last:border-b-0";
const PRESET_NAME_MAX_LENGTH = 64;

function buildScanPresetConfig(settings: AppSettings): ScanPresetConfig {
  return {
    timeout: settings.timeout,
    extended_timeout: settings.extended_timeout,
    concurrency: settings.concurrency,
    retries: settings.retries,
    retry_backoff: settings.retry_backoff,
    user_agent: settings.user_agent,
    skip_screenshots: settings.skip_screenshots,
    profile_bitrate: settings.profile_bitrate,
    ffprobe_timeout_secs: settings.ffprobe_timeout_secs,
    ffmpeg_bitrate_timeout_secs: settings.ffmpeg_bitrate_timeout_secs,
    accept_invalid_certs: settings.accept_invalid_certs,
    proxy_file: settings.proxy_file,
    test_geoblock: settings.test_geoblock,
    screenshots_dir: settings.screenshots_dir,
    low_fps_threshold: settings.low_fps_threshold,
    screenshot_format: settings.screenshot_format,
  };
}

function applyScanPresetConfig(
  base: AppSettings,
  config: ScanPresetConfig,
): AppSettings {
  return {
    ...base,
    timeout: config.timeout,
    extended_timeout: config.extended_timeout,
    concurrency: config.concurrency,
    retries: config.retries,
    retry_backoff: config.retry_backoff,
    user_agent: config.user_agent,
    skip_screenshots: config.skip_screenshots,
    profile_bitrate: config.profile_bitrate,
    ffprobe_timeout_secs: config.ffprobe_timeout_secs,
    ffmpeg_bitrate_timeout_secs: config.ffmpeg_bitrate_timeout_secs,
    accept_invalid_certs: config.accept_invalid_certs,
    proxy_file: config.proxy_file,
    test_geoblock: config.test_geoblock,
    screenshots_dir: config.screenshots_dir,
    low_fps_threshold: config.low_fps_threshold,
    screenshot_format: config.screenshot_format,
  };
}

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

function Switch({
  checked,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-10 shrink-0 items-center rounded-full border transition-colors ${
        checked
          ? "border-blue-500 bg-blue-500/80"
          : "border-border-app bg-panel"
      }`}
    >
      <span
        className={`h-4 w-4 rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-5" : "translate-x-1"
        }`}
      />
    </button>
  );
}

function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border border-border-app bg-panel-subtle p-1">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={`rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors ${
              selected
                ? "bg-blue-600 text-white"
                : "text-text-secondary hover:bg-btn-hover"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function SettingsPanel({ settings, onSave }: SettingsPanelProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [presetCollection, setPresetCollection] = useState<ScanPresetCollection>({
    presets: [],
    default_preset: null,
  });
  const [selectedPresetName, setSelectedPresetName] = useState("");
  const [presetNameDraft, setPresetNameDraft] = useState("");
  const [presetSetAsDefault, setPresetSetAsDefault] = useState(false);
  const [presetBusy, setPresetBusy] = useState(false);
  const [presetError, setPresetError] = useState<string | null>(null);
  const [presetNotice, setPresetNotice] = useState<string | null>(null);
  const [cacheStats, setCacheStats] = useState<ScreenshotCacheStats | null>(null);
  const [cacheBusy, setCacheBusy] = useState(false);
  const [associationBusy, setAssociationBusy] = useState(false);
  const [associationNotice, setAssociationNotice] = useState<string | null>(null);
  const [associationError, setAssociationError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);
  const pendingSaveRef = useRef<AppSettings | null>(null);
  const debounceTimerRef = useRef<number | null>(null);
  const saveQueueRef = useRef(Promise.resolve());

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  const refreshPresets = useCallback(async () => {
    try {
      const next = await getScanPresets();
      setPresetCollection(next);
      setPresetError(null);
    } catch (error) {
      setPresetError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void refreshPresets();
  }, [refreshPresets]);

  useEffect(() => {
    if (presetCollection.presets.length === 0) {
      setSelectedPresetName("");
      return;
    }
    const selectedExists = presetCollection.presets.some(
      (preset) => preset.name === selectedPresetName,
    );
    if (selectedExists) return;
    setSelectedPresetName(
      presetCollection.default_preset ?? presetCollection.presets[0]?.name ?? "",
    );
  }, [presetCollection, selectedPresetName]);

  const selectedPreset: ScanSettingsPreset | null =
    presetCollection.presets.find((preset) => preset.name === selectedPresetName) ??
    null;

  const persist = useCallback(
    (next: AppSettings) => {
      saveQueueRef.current = saveQueueRef.current
        .catch(() => {
          // Keep queue alive after a failed write.
        })
        .then(async () => {
          await onSave(next);
          setSaveError(null);
        })
        .catch((error) => {
          setSaveError(error instanceof Error ? error.message : String(error));
        });
    },
    [onSave],
  );

  const flushPendingSave = useCallback(() => {
    if (!pendingSaveRef.current) return;
    const next = pendingSaveRef.current;
    pendingSaveRef.current = null;
    persist(next);
  }, [persist]);

  const schedulePersist = useCallback(
    (next: AppSettings, options?: PersistOptions) => {
      pendingSaveRef.current = next;
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }

      if (options?.immediate) {
        flushPendingSave();
        return;
      }

      debounceTimerRef.current = window.setTimeout(() => {
        debounceTimerRef.current = null;
        flushPendingSave();
      }, SAVE_DEBOUNCE_MS);
    },
    [flushPendingSave],
  );

  const updateSetting = useCallback(
    <K extends keyof AppSettings>(
      key: K,
      value: AppSettings[K],
      options?: PersistOptions,
    ) => {
      setDraft((prev) => {
        const next = { ...prev, [key]: value };
        schedulePersist(next, options);
        return next;
      });
    },
    [schedulePersist],
  );

  const applyPresetToDraft = useCallback(
    (config: ScanPresetConfig) => {
      setDraft((prev) => {
        const next = applyScanPresetConfig(prev, config);
        schedulePersist(next, { immediate: true });
        return next;
      });
    },
    [schedulePersist],
  );

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
      }
      flushPendingSave();
    };
  }, [flushPendingSave]);

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

  const handleSelectProxy = async () => {
    const path = await open({
      multiple: false,
      filters: [{ name: "Text files", extensions: ["txt", "json"] }],
    });
    if (path) {
      updateSetting("proxy_file", path as string, { immediate: true });
    }
  };

  const handleSelectScreenshotsDir = async () => {
    const path = await open({
      multiple: false,
      directory: true,
    });
    if (path) {
      updateSetting("screenshots_dir", path as string, { immediate: true });
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

  const handleSavePreset = async () => {
    const name = presetNameDraft.trim() || selectedPresetName.trim();
    if (!name) {
      setPresetError("Enter a preset name first.");
      return;
    }
    if (name.length > PRESET_NAME_MAX_LENGTH) {
      setPresetError(`Preset name must be ${PRESET_NAME_MAX_LENGTH} characters or fewer.`);
      return;
    }

    setPresetBusy(true);
    setPresetError(null);
    setPresetNotice(null);
    try {
      const next = await saveScanPreset(
        name,
        buildScanPresetConfig(draft),
        presetSetAsDefault,
      );
      setPresetCollection(next);
      setSelectedPresetName(name);
      setPresetNameDraft(name);
      setPresetNotice(`Saved preset "${name}".`);
    } catch (error) {
      setPresetError(error instanceof Error ? error.message : String(error));
    } finally {
      setPresetBusy(false);
    }
  };

  const handleLoadPreset = () => {
    if (!selectedPreset) {
      setPresetError("Select a preset to load.");
      return;
    }
    setPresetError(null);
    setPresetNotice(`Loaded preset "${selectedPreset.name}".`);
    applyPresetToDraft(selectedPreset.config);
  };

  const handleRenamePreset = async () => {
    if (!selectedPreset) {
      setPresetError("Select a preset to rename.");
      return;
    }
    const nextName = window
      .prompt("Rename preset", selectedPreset.name)
      ?.trim();
    if (!nextName || nextName === selectedPreset.name) {
      return;
    }
    if (nextName.length > PRESET_NAME_MAX_LENGTH) {
      setPresetError(`Preset name must be ${PRESET_NAME_MAX_LENGTH} characters or fewer.`);
      return;
    }

    setPresetBusy(true);
    setPresetError(null);
    setPresetNotice(null);
    try {
      const next = await renameScanPreset(selectedPreset.name, nextName);
      setPresetCollection(next);
      setSelectedPresetName(nextName);
      setPresetNameDraft(nextName);
      setPresetNotice(`Renamed preset to "${nextName}".`);
    } catch (error) {
      setPresetError(error instanceof Error ? error.message : String(error));
    } finally {
      setPresetBusy(false);
    }
  };

  const handleDeletePreset = async () => {
    if (!selectedPreset) {
      setPresetError("Select a preset to delete.");
      return;
    }
    if (!window.confirm(`Delete preset "${selectedPreset.name}"?`)) {
      return;
    }

    setPresetBusy(true);
    setPresetError(null);
    setPresetNotice(null);
    try {
      const next = await deleteScanPreset(selectedPreset.name);
      setPresetCollection(next);
      setPresetNameDraft("");
      setSelectedPresetName(
        next.default_preset ?? next.presets[0]?.name ?? "",
      );
      setPresetNotice(`Deleted preset "${selectedPreset.name}".`);
    } catch (error) {
      setPresetError(error instanceof Error ? error.message : String(error));
    } finally {
      setPresetBusy(false);
    }
  };

  const handleSetDefaultPreset = async () => {
    if (!selectedPreset) {
      setPresetError("Select a preset to mark as default.");
      return;
    }
    setPresetBusy(true);
    setPresetError(null);
    setPresetNotice(null);
    try {
      const next = await setDefaultScanPreset(selectedPreset.name);
      setPresetCollection(next);
      setPresetNotice(`Default preset set to "${selectedPreset.name}".`);
    } catch (error) {
      setPresetError(error instanceof Error ? error.message : String(error));
    } finally {
      setPresetBusy(false);
    }
  };

  const handleClearDefaultPreset = async () => {
    setPresetBusy(true);
    setPresetError(null);
    setPresetNotice(null);
    try {
      const next = await setDefaultScanPreset(null);
      setPresetCollection(next);
      setPresetNotice("Cleared default preset.");
    } catch (error) {
      setPresetError(error instanceof Error ? error.message : String(error));
    } finally {
      setPresetBusy(false);
    }
  };

  const tabs: Array<{
    id: SettingsTab;
    label: string;
    Icon: typeof SlidersHorizontal;
  }> = [
    { id: "general", label: "General", Icon: SlidersHorizontal },
    { id: "scanning", label: "Scanning", Icon: Gauge },
    { id: "media", label: "Screenshots", Icon: Layers },
    { id: "network", label: "Network", Icon: Network },
    { id: "advanced", label: "Advanced", Icon: Wrench },
  ];

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      className="flex flex-col h-full bg-overlay focus:outline-none"
    >
      <div className="relative flex items-center justify-center px-4 pt-4 pb-3 border-b border-border-app bg-panel-subtle" data-tauri-drag-region>
        <div className="flex items-center gap-1">
          {tabs.map(({ id, label, Icon }) => {
            const active = activeTab === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setActiveTab(id)}
                className={`flex flex-col items-center gap-1.5 w-[72px] py-2 rounded-lg text-[11px] font-medium whitespace-nowrap transition-colors ${
                  active
                    ? "bg-black/[0.08] dark:bg-white/[0.12] text-text-primary"
                    : "text-text-tertiary hover:text-text-secondary hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                }`}
              >
                <Icon className="h-[22px] w-[22px]" strokeWidth={active ? 1.7 : 1.4} />
                {label}
              </button>
            );
          })}
        </div>
      </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {saveError && (
            <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-[12px] text-red-300">
              Could not save one or more changes: {saveError}
            </div>
          )}

          {activeTab === "general" && (
            <>
              <section className={blockClass}>
                <div className={rowClass}>
                  <div>
                    <p className="text-[13px] font-medium">Theme</p>
                    <p className="text-[11px] text-text-tertiary mt-0.5">
                      Choose system, light, or dark appearance.
                    </p>
                  </div>
                  <SegmentedControl
                    value={draft.theme}
                    options={[
                      { value: "system", label: "System" },
                      { value: "light", label: "Light" },
                      { value: "dark", label: "Dark" },
                    ]}
                    onChange={(value) => updateSetting("theme", value, { immediate: true })}
                  />
                </div>

                <div className={rowClass}>
                  <div>
                    <p className="text-[13px] font-medium">Channel logo size</p>
                    <p className="text-[11px] text-text-tertiary mt-0.5">
                      Controls logo size in the channel name column.
                    </p>
                  </div>
                  <select
                    value={draft.channel_logo_size}
                    onChange={(event) =>
                      updateSetting(
                        "channel_logo_size",
                        event.target.value as AppSettings["channel_logo_size"],
                        { immediate: true },
                      )
                    }
                    className={`${inputClass} w-44`}
                  >
                    <option value="small">Small (16px)</option>
                    <option value="medium">Medium (24px)</option>
                    <option value="large">Large (36px)</option>
                    <option value="huge">Huge (48px)</option>
                  </select>
                </div>
              </section>

              <section className={blockClass}>
                <div className={rowClass}>
                  <div>
                    <p className="text-[13px] font-medium">Profile video bitrate</p>
                    <p className="text-[11px] text-text-tertiary mt-0.5">
                      Deeper ffmpeg sampling for more accurate bitrate values.
                    </p>
                  </div>
                  <Switch
                    checked={draft.profile_bitrate}
                    onChange={(checked) =>
                      updateSetting("profile_bitrate", checked, { immediate: true })
                    }
                    ariaLabel="Profile bitrate"
                  />
                </div>
              </section>

              <section className={blockClass}>
                <div className={rowClass}>
                  <div>
                    <p className="text-[13px] font-medium">Show pre-scan filter bar</p>
                    <p className="text-[11px] text-text-tertiary mt-0.5">
                      Display the regex filter bar before scanning.
                    </p>
                  </div>
                  <Switch
                    checked={draft.show_prescan_filter}
                    onChange={(checked) =>
                      updateSetting("show_prescan_filter", checked, { immediate: true })
                    }
                    ariaLabel="Show pre-scan filter bar"
                  />
                </div>

                <div className={rowClass}>
                  <div>
                    <p className="text-[13px] font-medium">Auto-reveal report panel</p>
                    <p className="text-[11px] text-text-tertiary mt-0.5">
                      Slide in the playlist report near scan completion.
                    </p>
                  </div>
                  <Switch
                    checked={draft.report_auto_reveal}
                    onChange={(checked) =>
                      updateSetting("report_auto_reveal", checked, { immediate: true })
                    }
                    ariaLabel="Auto-reveal report panel"
                  />
                </div>
              </section>

              <section className={blockClass}>
                <div className={rowClass}>
                  <div>
                    <p className="text-[13px] font-medium">Scan completion notifications</p>
                    <p className="text-[11px] text-text-tertiary mt-0.5">
                      Show native notifications when scans complete or are cancelled.
                    </p>
                  </div>
                  <Switch
                    checked={draft.scan_notifications}
                    onChange={(checked) =>
                      updateSetting("scan_notifications", checked, { immediate: true })
                    }
                    ariaLabel="Scan completion notifications"
                  />
                </div>
              </section>

              <section className={blockClass}>
                <div className={rowClass}>
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium">Default app for .m3u/.m3u8</p>
                    <p className="text-[11px] text-text-tertiary mt-0.5">
                      Open playlist files in IPTV Checker by default.
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
                  <p className="px-4 py-2 text-[11px] text-emerald-400 border-t border-border-subtle">
                    {associationNotice}
                  </p>
                )}
                {associationError && (
                  <p className="px-4 py-2 text-[11px] text-red-400 border-t border-border-subtle">
                    {associationError}
                  </p>
                )}
              </section>
            </>
          )}

          {activeTab === "scanning" && (
            <>
              <section className={`${blockClass} px-4 py-3 space-y-2`}>
                <div className="flex items-center justify-between gap-3">
                  <p className="text-[12px] font-medium text-text-primary">Scan Presets</p>
                  {presetCollection.default_preset && (
                    <span className="text-[10px] text-text-tertiary">
                      Default: {presetCollection.default_preset}
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-1.5">
                  <div className="flex gap-1.5">
                    <select
                      value={selectedPresetName}
                      onChange={(event) => {
                        setSelectedPresetName(event.target.value);
                        setPresetNameDraft(event.target.value);
                      }}
                      className={`${inputClass} min-w-0 flex-1`}
                      disabled={presetBusy || presetCollection.presets.length === 0}
                    >
                      <option value="">
                        {presetCollection.presets.length === 0
                          ? "No presets"
                          : "Select preset"}
                      </option>
                      {presetCollection.presets.map((preset) => (
                        <option key={preset.name} value={preset.name}>
                          {preset.name}
                          {presetCollection.default_preset === preset.name
                            ? " (Default)"
                            : ""}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={handleLoadPreset}
                      disabled={presetBusy || !selectedPreset}
                      className="macos-btn px-2.5 py-1 min-h-[30px] text-[12px] bg-btn hover:bg-btn-hover rounded-md disabled:opacity-50 disabled:pointer-events-none"
                    >
                      Load
                    </button>
                  </div>
                  <div className="flex gap-1.5">
                    <input
                      type="text"
                      value={presetNameDraft}
                      onChange={(event) =>
                        setPresetNameDraft(event.target.value.slice(0, PRESET_NAME_MAX_LENGTH))
                      }
                      placeholder="Preset name"
                      className={`${inputClass} min-w-0 flex-1`}
                      disabled={presetBusy}
                    />
                    <button
                      type="button"
                      onClick={handleSavePreset}
                      disabled={presetBusy}
                      className="macos-btn px-2.5 py-1 min-h-[30px] text-[12px] bg-btn hover:bg-btn-hover rounded-md disabled:opacity-50 disabled:pointer-events-none"
                    >
                      Save
                    </button>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <label className="inline-flex items-center gap-1.5 text-[11px] text-text-secondary">
                    <input
                      type="checkbox"
                      checked={presetSetAsDefault}
                      onChange={(event) => setPresetSetAsDefault(event.target.checked)}
                      disabled={presetBusy}
                    />
                    Save as default
                  </label>
                  <button
                    type="button"
                    onClick={handleSetDefaultPreset}
                    disabled={presetBusy || !selectedPreset}
                    className="macos-btn px-2 py-0.5 text-[11px] bg-btn hover:bg-btn-hover rounded disabled:opacity-50 disabled:pointer-events-none"
                  >
                    Mark Default
                  </button>
                  <button
                    type="button"
                    onClick={handleClearDefaultPreset}
                    disabled={presetBusy || !presetCollection.default_preset}
                    className="macos-btn px-2 py-0.5 text-[11px] bg-btn hover:bg-btn-hover rounded disabled:opacity-50 disabled:pointer-events-none"
                  >
                    Clear Default
                  </button>
                  <button
                    type="button"
                    onClick={handleRenamePreset}
                    disabled={presetBusy || !selectedPreset}
                    className="macos-btn px-2 py-0.5 text-[11px] bg-btn hover:bg-btn-hover rounded disabled:opacity-50 disabled:pointer-events-none"
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    onClick={handleDeletePreset}
                    disabled={presetBusy || !selectedPreset}
                    className="macos-btn px-2 py-0.5 text-[11px] bg-btn hover:bg-btn-hover rounded disabled:opacity-50 disabled:pointer-events-none text-red-400"
                  >
                    Delete
                  </button>
                </div>

                {presetNotice && (
                  <p className="text-[11px] text-emerald-400">{presetNotice}</p>
                )}
                {presetError && (
                  <p className="text-[11px] text-red-400">{presetError}</p>
                )}
              </section>

              <section className={`${blockClass} p-4`}>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[12px] font-medium text-text-secondary mb-1.5">
                      Timeout (seconds)
                    </label>
                    <input
                      type="number"
                      value={draft.timeout}
                      onChange={(event) => {
                        const value = parseFloat(event.target.value);
                        updateSetting(
                          "timeout",
                          Number.isNaN(value) ? 10 : Math.max(0.5, value),
                        );
                      }}
                      step="0.5"
                      min="0.5"
                      className={inputClass}
                    />
                  </div>

                  <div>
                    <label className="block text-[12px] font-medium text-text-secondary mb-1.5">
                      Extended Timeout (seconds)
                    </label>
                    <input
                      type="number"
                      value={draft.extended_timeout ?? ""}
                      onChange={(event) => {
                        if (!event.target.value) {
                          updateSetting("extended_timeout", null);
                          return;
                        }
                        const value = parseFloat(event.target.value);
                        updateSetting(
                          "extended_timeout",
                          Number.isNaN(value) ? null : Math.max(1, value),
                        );
                      }}
                      placeholder="Disabled"
                      step="1"
                      min="1"
                      className={inputClass}
                    />
                  </div>

                  <div>
                    <label className="block text-[12px] font-medium text-text-secondary mb-1.5">
                      Concurrency
                    </label>
                    <input
                      type="number"
                      value={draft.concurrency}
                      onChange={(event) => {
                        const value = parseInt(event.target.value, 10);
                        updateSetting(
                          "concurrency",
                          Number.isNaN(value) ? 1 : Math.max(1, Math.min(20, value)),
                        );
                      }}
                      min="1"
                      max="20"
                      className={inputClass}
                    />
                  </div>

                </div>
              </section>

              <section className={`${blockClass} p-4`}>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[12px] font-medium text-text-secondary mb-1.5">
                      Max Retries
                    </label>
                    <input
                      type="number"
                      value={draft.retries}
                      onChange={(event) => {
                        const value = parseInt(event.target.value, 10);
                        updateSetting(
                          "retries",
                          Number.isNaN(value) ? 3 : Math.max(0, Math.min(10, value)),
                        );
                      }}
                      min="0"
                      max="10"
                      className={inputClass}
                    />
                  </div>

                  <div>
                    <label className="block text-[12px] font-medium text-text-secondary mb-1.5">
                      Retry Backoff
                    </label>
                    <SegmentedControl
                      value={draft.retry_backoff}
                      options={[
                        { value: "none", label: "None" },
                        { value: "linear", label: "Linear" },
                        { value: "exponential", label: "Exponential" },
                      ]}
                      onChange={(value) =>
                        updateSetting("retry_backoff", value, { immediate: true })
                      }
                    />
                  </div>
                </div>
              </section>

              <section className={blockClass}>
                <div className={rowClass}>
                  <div>
                    <p className="text-[13px] font-medium">Low FPS threshold</p>
                    <p className="text-[11px] text-text-tertiary mt-0.5">
                      Streams below this FPS are flagged as low framerate.
                    </p>
                  </div>
                  <input
                    type="number"
                    value={draft.low_fps_threshold}
                    onChange={(event) => {
                      const value = parseFloat(event.target.value);
                      updateSetting(
                        "low_fps_threshold",
                        Number.isNaN(value) ? 23.0 : Math.max(0, Math.min(240, value)),
                      );
                    }}
                    step="0.1"
                    min="0"
                    max="240"
                    className={`${inputClass} w-24`}
                  />
                </div>
              </section>

              <section className={blockClass}>
                <div className={rowClass}>
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium">User agent</p>
                    <p className="text-[11px] text-text-tertiary mt-0.5">
                      HTTP user agent string sent with stream requests.
                    </p>
                  </div>
                  <input
                    type="text"
                    value={draft.user_agent}
                    onChange={(event) => updateSetting("user_agent", event.target.value)}
                    className={`${inputClass} w-56`}
                  />
                </div>
              </section>

            </>
          )}

          {activeTab === "media" && (
            <>
              <section className={blockClass}>
                <div className={rowClass}>
                  <div>
                    <p className="text-[13px] font-medium">Skip screenshots</p>
                    <p className="text-[11px] text-text-tertiary mt-0.5">
                      Disable frame captures for faster checks.
                    </p>
                  </div>
                  <Switch
                    checked={draft.skip_screenshots}
                    onChange={(checked) =>
                      updateSetting("skip_screenshots", checked, { immediate: true })
                    }
                    ariaLabel="Skip screenshots"
                  />
                </div>

                <div className={rowClass}>
                  <div>
                    <p className="text-[13px] font-medium">Screenshot format</p>
                    <p className="text-[11px] text-text-tertiary mt-0.5">
                      WebP is faster and smaller. PNG is lossless.
                    </p>
                  </div>
                  <select
                    value={draft.screenshot_format}
                    onChange={(event) =>
                      updateSetting(
                        "screenshot_format",
                        event.target.value as AppSettings["screenshot_format"],
                        { immediate: true },
                      )
                    }
                    className={`${inputClass} w-44`}
                    disabled={draft.skip_screenshots}
                  >
                    <option value="webp">WebP</option>
                    <option value="png">PNG</option>
                  </select>
                </div>

                <div className={rowClass}>
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-medium">Save screenshots to</p>
                    <p
                      className="text-[11px] text-text-tertiary mt-0.5 truncate"
                      title={draft.screenshots_dir ?? "Not saved (preview only)"}
                    >
                      {draft.screenshots_dir ?? "Not saved (preview only)"}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleSelectScreenshotsDir}
                      className="macos-btn px-3 py-1.5 min-h-9 text-[13px] bg-btn hover:bg-btn-hover rounded-md"
                      type="button"
                    >
                      Browse
                    </button>
                    {draft.screenshots_dir && (
                      <button
                        onClick={() =>
                          updateSetting("screenshots_dir", null, { immediate: true })
                        }
                        className="macos-btn px-3 py-1.5 min-h-9 text-[13px] bg-btn hover:bg-btn-hover rounded-md"
                        type="button"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </div>
              </section>

              <section className={blockClass}>
                <div className={rowClass}>
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium">Temp Screenshot Cache</p>
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
                    className="px-4 py-2 text-[11px] text-text-tertiary border-t border-border-subtle truncate"
                    title={cacheStats.cache_dir}
                  >
                    {cacheStats.cache_dir}
                  </p>
                )}

                <div className="grid grid-cols-1 grid-cols-2 gap-3 p-4 border-t border-border-subtle">
                  <div>
                    <label className="block text-[12px] font-medium text-text-secondary mb-1.5">
                      Screenshot Retention
                    </label>
                    <input
                      type="number"
                      value={draft.screenshot_retention_count}
                      onChange={(event) => {
                        const value = parseInt(event.target.value, 10);
                        updateSetting(
                          "screenshot_retention_count",
                          Number.isNaN(value) ? 1 : Math.max(0, Math.min(100, value)),
                        );
                      }}
                      min="0"
                      max="100"
                      className={inputClass}
                    />
                  </div>

                  <div>
                    <label className="block text-[12px] font-medium text-text-secondary mb-1.5">
                      Low Space Threshold (GB)
                    </label>
                    <input
                      type="number"
                      value={draft.low_space_threshold_gb}
                      onChange={(event) => {
                        const value = parseFloat(event.target.value);
                        updateSetting(
                          "low_space_threshold_gb",
                          Number.isNaN(value) ? 5.0 : Math.max(1, Math.min(50, value)),
                        );
                      }}
                      step="0.5"
                      min="1"
                      max="50"
                      className={inputClass}
                    />
                  </div>
                </div>
              </section>
            </>
          )}

          {activeTab === "network" && (
            <>
              <section className={blockClass}>
                <div className={rowClass}>
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-medium">Proxy file</p>
                    <p
                      className="text-[11px] text-text-tertiary mt-0.5 truncate"
                      title={draft.proxy_file ?? "No proxy file selected"}
                    >
                      {draft.proxy_file ?? "No proxy file selected"}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleSelectProxy}
                      className="macos-btn px-3 py-1.5 min-h-9 text-[13px] bg-btn hover:bg-btn-hover rounded-md"
                      type="button"
                    >
                      Browse
                    </button>
                    {draft.proxy_file && (
                      <button
                        onClick={() => updateSetting("proxy_file", null, { immediate: true })}
                        className="macos-btn px-3 py-1.5 min-h-9 text-[13px] bg-btn hover:bg-btn-hover rounded-md"
                        type="button"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </div>

                <div className={rowClass}>
                  <div>
                    <p className="text-[13px] font-medium">Confirm geoblocks with proxies</p>
                    <p className="text-[11px] text-text-tertiary mt-0.5">
                      Re-test geoblocked streams through your proxy list.
                    </p>
                  </div>
                  <Switch
                    checked={draft.test_geoblock}
                    onChange={(checked) =>
                      updateSetting("test_geoblock", checked, { immediate: true })
                    }
                    ariaLabel="Confirm geoblocks with proxies"
                  />
                </div>
              </section>

              <section className={blockClass}>
                <div className={rowClass}>
                  <div>
                    <p className="text-[13px] font-medium">Skip certificate verification (insecure)</p>
                    <p className="text-[11px] text-text-tertiary mt-0.5">
                      Accept invalid/self-signed TLS certificates during stream checks.
                    </p>
                  </div>
                  <Switch
                    checked={draft.accept_invalid_certs}
                    onChange={(checked) =>
                      updateSetting("accept_invalid_certs", checked, { immediate: true })
                    }
                    ariaLabel="Skip certificate verification"
                  />
                </div>
              </section>
            </>
          )}

          {activeTab === "advanced" && (
            <>
              <section className={`${blockClass} p-4`}>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[12px] font-medium text-text-secondary mb-1.5">
                    Log Level
                  </label>
                  <select
                    value={draft.log_level}
                    onChange={(event) =>
                      updateSetting("log_level", event.target.value, { immediate: true })
                    }
                    className={inputClass}
                  >
                    <option value="error">Error</option>
                    <option value="warn">Warning</option>
                    <option value="info">Info</option>
                    <option value="debug">Debug</option>
                    <option value="trace">Trace</option>
                  </select>
                </div>

                <div>
                  <label className="block text-[12px] font-medium text-text-secondary mb-1.5">
                    Scan History Retention
                  </label>
                  <input
                    type="number"
                    value={draft.scan_history_limit}
                    onChange={(event) => {
                      const value = parseInt(event.target.value, 10);
                      updateSetting(
                        "scan_history_limit",
                        Number.isNaN(value) ? 20 : Math.max(1, Math.min(200, value)),
                      );
                    }}
                    min="1"
                    max="200"
                    className={inputClass}
                  />
                </div>

              </div>
            </section>

            <section className={`${blockClass} p-4`}>
              <h3 className="text-[13px] font-medium text-text-secondary mb-3">ffmpeg / ffprobe</h3>
              <div className="grid grid-cols-1 grid-cols-2 gap-3">
                <div>
                  <label className="block text-[12px] font-medium text-text-secondary mb-1.5">
                    ffprobe timeout (seconds)
                  </label>
                  <input
                    type="number"
                    value={draft.ffprobe_timeout_secs}
                    onChange={(event) => {
                      const value = parseFloat(event.target.value);
                      updateSetting(
                        "ffprobe_timeout_secs",
                        Number.isNaN(value) ? 30 : Math.max(1, Math.min(300, value)),
                      );
                    }}
                    step="1"
                    min="1"
                    max="300"
                    className={inputClass}
                  />
                </div>

                <div>
                  <label className="block text-[12px] font-medium text-text-secondary mb-1.5">
                    ffmpeg bitrate timeout (seconds)
                  </label>
                  <input
                    type="number"
                    value={draft.ffmpeg_bitrate_timeout_secs}
                    onChange={(event) => {
                      const value = parseFloat(event.target.value);
                      updateSetting(
                        "ffmpeg_bitrate_timeout_secs",
                        Number.isNaN(value) ? 60 : Math.max(5, Math.min(300, value)),
                      );
                    }}
                    step="1"
                    min="5"
                    max="300"
                    className={inputClass}
                  />
                </div>
              </div>
            </section>
            </>
          )}
        </div>
    </div>
  );
}
