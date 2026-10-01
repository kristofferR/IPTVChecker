import { open } from "@tauri-apps/plugin-dialog";
import {
  ArrowDown,
  ArrowUp,
  Gauge,
  Layers,
  ListOrdered,
  Network,
  SlidersHorizontal,
  Wrench,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatCount, getLaunchLanguage, LOCALES, type MessageKey, t } from "../i18n";
import { fixPreferencesFrom } from "../lib/dispatcharr";
import { formatBytes } from "../lib/format";
import {
  clampSampleClipDuration,
  MAX_SAMPLE_CLIP_DURATION_SECS,
  MIN_SAMPLE_CLIP_DURATION_SECS,
} from "../lib/sampleClip";
import {
  clearScreenshotCache,
  deleteScanPreset,
  getScanPresets,
  getScreenshotCacheStats,
  renameScanPreset,
  restartApp,
  saveScanPreset,
  setDefaultM3u8FileAssociation,
  setDefaultScanPreset,
} from "../lib/tauri";
import type {
  AppSettings,
  DispatcharrRankSignal,
  ScanPresetCollection,
  ScanPresetConfig,
  ScanSettingsPreset,
  ScreenshotCacheStats,
} from "../lib/types";
import { useAppStore } from "../store";

type SettingsTab = "general" | "scanning" | "media" | "network" | "dispatcharr" | "advanced";

const RANK_SIGNAL_LABELS = {
  resolution: "settings.dispatcharr.rankSignals.resolution",
  frame_rate: "settings.dispatcharr.rankSignals.frameRate",
  bitrate: "settings.dispatcharr.rankSignals.bitrate",
  latency: "settings.dispatcharr.rankSignals.latency",
} as const satisfies Record<DispatcharrRankSignal, MessageKey>;

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
    auto_capture_sample_clips: settings.auto_capture_sample_clips,
    sample_clip_duration_secs: settings.sample_clip_duration_secs,
  };
}

function applyScanPresetConfig(base: AppSettings, config: ScanPresetConfig): AppSettings {
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
    auto_capture_sample_clips: config.auto_capture_sample_clips,
    sample_clip_duration_secs: config.sample_clip_duration_secs,
  };
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
        checked ? "border-blue-500 bg-blue-500/80" : "border-border-app bg-panel"
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
              selected ? "bg-blue-600 text-white" : "text-text-secondary hover:bg-btn-hover"
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
  const platform = useAppStore((s) => s.platform);
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
  const [externalPlayerError, setExternalPlayerError] = useState<string | null>(null);
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
    presetCollection.presets.find((preset) => preset.name === selectedPresetName) ?? null;

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
    <K extends keyof AppSettings>(key: K, value: AppSettings[K], options?: PersistOptions) => {
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

  // Restarting before the language save lands would reopen in the old language.
  const restartWithSavedSettings = async () => {
    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    flushPendingSave();
    await saveQueueRef.current;
    await restartApp();
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

  const handleSelectProxy = async () => {
    const path = await open({
      multiple: false,
      filters: [
        { name: t("settings.network.proxyFile.textFilesFilter"), extensions: ["txt", "json"] },
      ],
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

  const handleSelectExternalPlayer = async () => {
    setExternalPlayerError(null);
    try {
      const filters =
        platform === "macos"
          ? [{ name: t("settings.general.externalPlayer.applicationsFilter"), extensions: ["app"] }]
          : platform === "windows"
            ? [
                {
                  name: t("settings.general.externalPlayer.applicationsFilter"),
                  extensions: ["exe"],
                },
              ]
            : undefined;
      const path = await open({
        multiple: false,
        title: t("settings.general.externalPlayer.dialogTitle"),
        ...(filters ? { filters } : {}),
      });
      if (typeof path === "string") {
        updateSetting("external_player_path", path, { immediate: true });
      }
    } catch (error) {
      setExternalPlayerError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleUseSystemDefaultPlayer = () => {
    setExternalPlayerError(null);
    updateSetting("external_player_path", null, { immediate: true });
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
      setPresetError(t("settings.scanning.presets.errors.nameRequired"));
      return;
    }
    if (name.length > PRESET_NAME_MAX_LENGTH) {
      setPresetError(
        t("settings.scanning.presets.errors.nameTooLong", {
          max: formatCount(PRESET_NAME_MAX_LENGTH),
        }),
      );
      return;
    }

    setPresetBusy(true);
    setPresetError(null);
    setPresetNotice(null);
    try {
      const next = await saveScanPreset(name, buildScanPresetConfig(draft), presetSetAsDefault);
      setPresetCollection(next);
      setSelectedPresetName(name);
      setPresetNameDraft(name);
      setPresetNotice(t("settings.scanning.presets.notices.saved", { name }));
    } catch (error) {
      setPresetError(error instanceof Error ? error.message : String(error));
    } finally {
      setPresetBusy(false);
    }
  };

  const handleLoadPreset = () => {
    if (!selectedPreset) {
      setPresetError(t("settings.scanning.presets.errors.selectToLoad"));
      return;
    }
    setPresetError(null);
    setPresetNotice(t("settings.scanning.presets.notices.loaded", { name: selectedPreset.name }));
    applyPresetToDraft(selectedPreset.config);
  };

  const handleRenamePreset = async () => {
    if (!selectedPreset) {
      setPresetError(t("settings.scanning.presets.errors.selectToRename"));
      return;
    }
    const nextName = window
      .prompt(t("settings.scanning.presets.renamePrompt"), selectedPreset.name)
      ?.trim();
    if (!nextName || nextName === selectedPreset.name) {
      return;
    }
    if (nextName.length > PRESET_NAME_MAX_LENGTH) {
      setPresetError(
        t("settings.scanning.presets.errors.nameTooLong", {
          max: formatCount(PRESET_NAME_MAX_LENGTH),
        }),
      );
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
      setPresetNotice(t("settings.scanning.presets.notices.renamed", { name: nextName }));
    } catch (error) {
      setPresetError(error instanceof Error ? error.message : String(error));
    } finally {
      setPresetBusy(false);
    }
  };

  const handleDeletePreset = async () => {
    if (!selectedPreset) {
      setPresetError(t("settings.scanning.presets.errors.selectToDelete"));
      return;
    }
    if (
      !window.confirm(t("settings.scanning.presets.deleteConfirm", { name: selectedPreset.name }))
    ) {
      return;
    }

    setPresetBusy(true);
    setPresetError(null);
    setPresetNotice(null);
    try {
      const next = await deleteScanPreset(selectedPreset.name);
      setPresetCollection(next);
      setPresetNameDraft("");
      setSelectedPresetName(next.default_preset ?? next.presets[0]?.name ?? "");
      setPresetNotice(
        t("settings.scanning.presets.notices.deleted", { name: selectedPreset.name }),
      );
    } catch (error) {
      setPresetError(error instanceof Error ? error.message : String(error));
    } finally {
      setPresetBusy(false);
    }
  };

  const handleSetDefaultPreset = async () => {
    if (!selectedPreset) {
      setPresetError(t("settings.scanning.presets.errors.selectToMarkDefault"));
      return;
    }
    setPresetBusy(true);
    setPresetError(null);
    setPresetNotice(null);
    try {
      const next = await setDefaultScanPreset(selectedPreset.name);
      setPresetCollection(next);
      setPresetNotice(
        t("settings.scanning.presets.notices.defaultSet", { name: selectedPreset.name }),
      );
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
      setPresetNotice(t("settings.scanning.presets.notices.defaultCleared"));
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
    { id: "general", label: t("settings.tabs.general"), Icon: SlidersHorizontal },
    { id: "scanning", label: t("settings.tabs.scanning"), Icon: Gauge },
    { id: "media", label: t("settings.tabs.media"), Icon: Layers },
    { id: "network", label: t("settings.tabs.network"), Icon: Network },
    { id: "dispatcharr", label: "Dispatcharr", Icon: ListOrdered },
    { id: "advanced", label: t("settings.tabs.advanced"), Icon: Wrench },
  ];

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      className="flex flex-col h-full bg-overlay focus:outline-none"
    >
      <div
        className="relative flex items-center justify-center px-4 pt-4 pb-3 border-b border-border-app bg-panel-subtle"
        data-tauri-drag-region
      >
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
            {t("settings.saveError", { error: saveError })}
          </div>
        )}

        {activeTab === "general" && (
          <>
            <section className={blockClass}>
              <div className={rowClass}>
                <div>
                  <p className="text-[13px] font-medium">{t("settings.general.language.label")}</p>
                  <p className="text-[11px] text-text-tertiary mt-0.5">
                    {t("settings.general.language.description")}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {draft.language !== getLaunchLanguage() && (
                    <button
                      type="button"
                      onClick={() => void restartWithSavedSettings()}
                      className="macos-btn px-3 py-1.5 min-h-9 text-[13px] bg-btn hover:bg-btn-hover rounded-md"
                    >
                      {t("settings.general.language.restart")}
                    </button>
                  )}
                  <select
                    value={draft.language ?? ""}
                    onChange={(event) =>
                      updateSetting("language", event.target.value || null, { immediate: true })
                    }
                    className={`${inputClass} w-44`}
                  >
                    <option value="">{t("settings.general.language.system")}</option>
                    {Object.entries(LOCALES).map(([code, { name }]) => (
                      <option key={code} value={code}>
                        {name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className={rowClass}>
                <div>
                  <p className="text-[13px] font-medium">{t("settings.general.theme.label")}</p>
                  <p className="text-[11px] text-text-tertiary mt-0.5">
                    {t("settings.general.theme.description")}
                  </p>
                </div>
                <SegmentedControl
                  value={draft.theme}
                  options={[
                    { value: "system", label: t("settings.general.theme.system") },
                    { value: "light", label: t("settings.general.theme.light") },
                    { value: "dark", label: t("settings.general.theme.dark") },
                  ]}
                  onChange={(value) => updateSetting("theme", value, { immediate: true })}
                />
              </div>

              <div className={rowClass}>
                <div>
                  <p className="text-[13px] font-medium">{t("settings.general.logoSize.label")}</p>
                  <p className="text-[11px] text-text-tertiary mt-0.5">
                    {t("settings.general.logoSize.description")}
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
                  <option value="small">{t("settings.general.logoSize.small")}</option>
                  <option value="medium">{t("settings.general.logoSize.medium")}</option>
                  <option value="large">{t("settings.general.logoSize.large")}</option>
                  <option value="huge">{t("settings.general.logoSize.huge")}</option>
                </select>
              </div>

              {platform === "linux" && (
                <div className={rowClass}>
                  <div>
                    <p className="text-[13px] font-medium">
                      {t("settings.general.titleBar.label")}
                    </p>
                    <p className="text-[11px] text-text-tertiary mt-0.5">
                      {t("settings.general.titleBar.description")}
                    </p>
                  </div>
                  <select
                    value={draft.title_bar}
                    onChange={(event) =>
                      updateSetting("title_bar", event.target.value as AppSettings["title_bar"], {
                        immediate: true,
                      })
                    }
                    className={`${inputClass} w-44`}
                  >
                    <option value="auto">{t("settings.general.titleBar.auto")}</option>
                    <option value="show">{t("settings.general.titleBar.show")}</option>
                    <option value="hide">{t("settings.general.titleBar.hide")}</option>
                  </select>
                </div>
              )}
            </section>

            <section className={blockClass}>
              <div className={rowClass}>
                <div className="min-w-0">
                  <p className="text-[13px] font-medium">
                    {t("settings.general.externalPlayer.label")}
                  </p>
                  <p
                    className="text-[11px] text-text-tertiary mt-0.5 truncate"
                    title={
                      draft.external_player_path ??
                      t("settings.general.externalPlayer.systemDefaultTitle")
                    }
                  >
                    {draft.external_player_path ??
                      t("settings.general.externalPlayer.systemDefaultDescription")}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    onClick={handleSelectExternalPlayer}
                    className="macos-btn px-3 py-1.5 min-h-9 text-[13px] bg-btn hover:bg-btn-hover rounded-md"
                    type="button"
                  >
                    {draft.external_player_path
                      ? t("settings.general.externalPlayer.change")
                      : t("settings.general.externalPlayer.chooseApp")}
                  </button>
                  {draft.external_player_path && (
                    <button
                      onClick={handleUseSystemDefaultPlayer}
                      className="macos-btn px-3 py-1.5 min-h-9 text-[13px] bg-btn hover:bg-btn-hover rounded-md"
                      type="button"
                    >
                      {t("settings.general.externalPlayer.useSystemDefault")}
                    </button>
                  )}
                </div>
              </div>
              {externalPlayerError && (
                <p className="px-4 py-2 text-[11px] text-red-400 border-t border-border-subtle">
                  {externalPlayerError}
                </p>
              )}
            </section>

            <section className={blockClass}>
              <div className={rowClass}>
                <div>
                  <p className="text-[13px] font-medium">
                    {t("settings.general.profileBitrate.label")}
                  </p>
                  <p className="text-[11px] text-text-tertiary mt-0.5">
                    {t("settings.general.profileBitrate.description")}
                  </p>
                </div>
                <Switch
                  checked={draft.profile_bitrate}
                  onChange={(checked) =>
                    updateSetting("profile_bitrate", checked, { immediate: true })
                  }
                  ariaLabel={t("settings.general.profileBitrate.ariaLabel")}
                />
              </div>
            </section>

            <section className={blockClass}>
              <div className={rowClass}>
                <div>
                  <p className="text-[13px] font-medium">
                    {t("settings.general.sourceFilterBar.label")}
                  </p>
                  <p className="text-[11px] text-text-tertiary mt-0.5">
                    {t("settings.general.sourceFilterBar.description")}
                  </p>
                </div>
                <Switch
                  checked={draft.show_prescan_filter}
                  onChange={(checked) =>
                    updateSetting("show_prescan_filter", checked, { immediate: true })
                  }
                  ariaLabel={t("settings.general.sourceFilterBar.label")}
                />
              </div>

              <div className={rowClass}>
                <div>
                  <p className="text-[13px] font-medium">{t("settings.general.hideVod.label")}</p>
                  <p className="text-[11px] text-text-tertiary mt-0.5">
                    {t("settings.general.hideVod.description")}
                  </p>
                </div>
                <Switch
                  checked={draft.hide_vod_content}
                  onChange={(checked) =>
                    updateSetting("hide_vod_content", checked, { immediate: true })
                  }
                  ariaLabel={t("settings.general.hideVod.ariaLabel")}
                />
              </div>

              <div className={rowClass}>
                <div>
                  <p className="text-[13px] font-medium">
                    {t("settings.general.reportAutoReveal.label")}
                  </p>
                  <p className="text-[11px] text-text-tertiary mt-0.5">
                    {t("settings.general.reportAutoReveal.description")}
                  </p>
                </div>
                <Switch
                  checked={draft.report_auto_reveal}
                  onChange={(checked) =>
                    updateSetting("report_auto_reveal", checked, { immediate: true })
                  }
                  ariaLabel={t("settings.general.reportAutoReveal.label")}
                />
              </div>

              <div className={rowClass}>
                <div>
                  <p className="text-[13px] font-medium">
                    {t("settings.general.placeholderStatus.label")}
                  </p>
                  <p className="text-[11px] text-text-tertiary mt-0.5">
                    {t("settings.general.placeholderStatus.description")}
                  </p>
                </div>
                <Switch
                  checked={draft.separate_placeholder_status}
                  onChange={(checked) =>
                    updateSetting("separate_placeholder_status", checked, { immediate: true })
                  }
                  ariaLabel={t("settings.general.placeholderStatus.label")}
                />
              </div>

              <div className={rowClass}>
                <div>
                  <p className="text-[13px] font-medium">
                    {t("settings.general.headerButtonText.label")}
                  </p>
                  <p className="text-[11px] text-text-tertiary mt-0.5">
                    {platform === "macos"
                      ? t("settings.general.headerButtonText.descriptionMacos")
                      : t("settings.general.headerButtonText.description")}
                  </p>
                </div>
                <Switch
                  checked={draft.show_header_button_text}
                  onChange={(checked) =>
                    updateSetting("show_header_button_text", checked, {
                      immediate: true,
                    })
                  }
                  ariaLabel={t("settings.general.headerButtonText.label")}
                />
              </div>
            </section>

            <section className={blockClass}>
              <div className={rowClass}>
                <div>
                  <p className="text-[13px] font-medium">
                    {t("settings.general.scanNotifications.label")}
                  </p>
                  <p className="text-[11px] text-text-tertiary mt-0.5">
                    {t("settings.general.scanNotifications.description")}
                  </p>
                </div>
                <Switch
                  checked={draft.scan_notifications}
                  onChange={(checked) =>
                    updateSetting("scan_notifications", checked, { immediate: true })
                  }
                  ariaLabel={t("settings.general.scanNotifications.label")}
                />
              </div>
            </section>

            <section className={blockClass}>
              <div className={rowClass}>
                <div>
                  <p className="text-[13px] font-medium">
                    {t("settings.general.updateChecks.label")}
                  </p>
                  <p className="text-[11px] text-text-tertiary mt-0.5">
                    {t("settings.general.updateChecks.description")}
                  </p>
                </div>
                <Switch
                  checked={draft.automatic_update_checks}
                  onChange={(checked) =>
                    updateSetting("automatic_update_checks", checked, { immediate: true })
                  }
                  ariaLabel={t("settings.general.updateChecks.label")}
                />
              </div>
            </section>

            <section className={blockClass}>
              <div className={rowClass}>
                <div className="min-w-0">
                  <p className="text-[13px] font-medium">
                    {t("settings.general.fileAssociation.label")}
                  </p>
                  <p className="text-[11px] text-text-tertiary mt-0.5">
                    {t("settings.general.fileAssociation.description")}
                  </p>
                </div>
                <button
                  onClick={handleSetDefaultM3u8Association}
                  disabled={associationBusy}
                  className="macos-btn px-3 py-1.5 min-h-9 text-[13px] bg-btn hover:bg-btn-hover rounded-md disabled:opacity-50 disabled:pointer-events-none"
                  type="button"
                >
                  {associationBusy
                    ? t("settings.general.fileAssociation.applying")
                    : t("settings.general.fileAssociation.setAsDefault")}
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
                <p className="text-[12px] font-medium text-text-primary">
                  {t("settings.scanning.presets.title")}
                </p>
                {presetCollection.default_preset && (
                  <span className="text-[10px] text-text-tertiary">
                    {t("settings.scanning.presets.defaultName", {
                      name: presetCollection.default_preset,
                    })}
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
                        ? t("settings.scanning.presets.none")
                        : t("settings.scanning.presets.select")}
                    </option>
                    {presetCollection.presets.map((preset) => (
                      <option key={preset.name} value={preset.name}>
                        {presetCollection.default_preset === preset.name
                          ? t("settings.scanning.presets.optionDefault", { name: preset.name })
                          : preset.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={handleLoadPreset}
                    disabled={presetBusy || !selectedPreset}
                    className="macos-btn px-2.5 py-1 min-h-[30px] text-[12px] bg-btn hover:bg-btn-hover rounded-md disabled:opacity-50 disabled:pointer-events-none"
                  >
                    {t("settings.scanning.presets.load")}
                  </button>
                </div>
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    value={presetNameDraft}
                    onChange={(event) =>
                      setPresetNameDraft(event.target.value.slice(0, PRESET_NAME_MAX_LENGTH))
                    }
                    placeholder={t("settings.scanning.presets.namePlaceholder")}
                    className={`${inputClass} min-w-0 flex-1`}
                    disabled={presetBusy}
                  />
                  <button
                    type="button"
                    onClick={handleSavePreset}
                    disabled={presetBusy}
                    className="macos-btn px-2.5 py-1 min-h-[30px] text-[12px] bg-btn hover:bg-btn-hover rounded-md disabled:opacity-50 disabled:pointer-events-none"
                  >
                    {t("common.save")}
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
                  {t("settings.scanning.presets.saveAsDefault")}
                </label>
                <button
                  type="button"
                  onClick={handleSetDefaultPreset}
                  disabled={presetBusy || !selectedPreset}
                  className="macos-btn px-2 py-0.5 text-[11px] bg-btn hover:bg-btn-hover rounded disabled:opacity-50 disabled:pointer-events-none"
                >
                  {t("settings.scanning.presets.markDefault")}
                </button>
                <button
                  type="button"
                  onClick={handleClearDefaultPreset}
                  disabled={presetBusy || !presetCollection.default_preset}
                  className="macos-btn px-2 py-0.5 text-[11px] bg-btn hover:bg-btn-hover rounded disabled:opacity-50 disabled:pointer-events-none"
                >
                  {t("settings.scanning.presets.clearDefault")}
                </button>
                <button
                  type="button"
                  onClick={handleRenamePreset}
                  disabled={presetBusy || !selectedPreset}
                  className="macos-btn px-2 py-0.5 text-[11px] bg-btn hover:bg-btn-hover rounded disabled:opacity-50 disabled:pointer-events-none"
                >
                  {t("settings.scanning.presets.rename")}
                </button>
                <button
                  type="button"
                  onClick={handleDeletePreset}
                  disabled={presetBusy || !selectedPreset}
                  className="macos-btn px-2 py-0.5 text-[11px] bg-btn hover:bg-btn-hover rounded disabled:opacity-50 disabled:pointer-events-none text-red-400"
                >
                  {t("common.delete")}
                </button>
              </div>

              {presetNotice && <p className="text-[11px] text-emerald-400">{presetNotice}</p>}
              {presetError && <p className="text-[11px] text-red-400">{presetError}</p>}
            </section>

            <section className={`${blockClass} p-4`}>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[12px] font-medium text-text-secondary mb-1.5">
                    {t("settings.scanning.timeout")}
                  </label>
                  <input
                    type="number"
                    value={draft.timeout}
                    onChange={(event) => {
                      const value = parseFloat(event.target.value);
                      updateSetting("timeout", Number.isNaN(value) ? 10 : Math.max(0.5, value));
                    }}
                    step="0.5"
                    min="0.5"
                    className={inputClass}
                  />
                </div>

                <div>
                  <label className="block text-[12px] font-medium text-text-secondary mb-1.5">
                    {t("settings.scanning.extendedTimeout")}
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
                    placeholder={t("settings.scanning.extendedTimeoutPlaceholder")}
                    step="1"
                    min="1"
                    className={inputClass}
                  />
                </div>

                <div>
                  <label className="block text-[12px] font-medium text-text-secondary mb-1.5">
                    {t("settings.scanning.concurrency")}
                  </label>
                  <input
                    type="number"
                    value={draft.concurrency || ""}
                    placeholder={t("settings.scanning.concurrencyPlaceholder")}
                    onChange={(event) => {
                      const raw = event.target.value.trim();
                      if (raw === "") {
                        updateSetting("concurrency", 0);
                        return;
                      }
                      const value = parseInt(raw, 10);
                      updateSetting(
                        "concurrency",
                        Number.isNaN(value) ? 0 : Math.max(0, Math.min(20, value)),
                      );
                    }}
                    min="0"
                    max="20"
                    className={inputClass}
                  />
                  <p className="text-[11px] text-text-quaternary mt-1">
                    {t("settings.scanning.concurrencyHint")}
                  </p>
                </div>
              </div>
            </section>

            <section className={`${blockClass} p-4`}>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[12px] font-medium text-text-secondary mb-1.5">
                    {t("settings.scanning.maxRetries")}
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
                    {t("settings.scanning.retryBackoff.label")}
                  </label>
                  <SegmentedControl
                    value={draft.retry_backoff}
                    options={[
                      { value: "none", label: t("common.none") },
                      { value: "linear", label: t("settings.scanning.retryBackoff.linear") },
                      {
                        value: "exponential",
                        label: t("settings.scanning.retryBackoff.exponential"),
                      },
                    ]}
                    onChange={(value) => updateSetting("retry_backoff", value, { immediate: true })}
                  />
                </div>
              </div>
            </section>

            <section className={blockClass}>
              <div className={rowClass}>
                <div>
                  <p className="text-[13px] font-medium">{t("settings.scanning.lowFps.label")}</p>
                  <p className="text-[11px] text-text-tertiary mt-0.5">
                    {t("settings.scanning.lowFps.description")}
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
                  <p className="text-[13px] font-medium">
                    {t("settings.scanning.userAgent.label")}
                  </p>
                  <p className="text-[11px] text-text-tertiary mt-0.5">
                    {t("settings.scanning.userAgent.description")}
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
                  <p className="text-[13px] font-medium">
                    {t("settings.media.skipScreenshots.label")}
                  </p>
                  <p className="text-[11px] text-text-tertiary mt-0.5">
                    {t("settings.media.skipScreenshots.description")}
                  </p>
                </div>
                <Switch
                  checked={draft.skip_screenshots}
                  onChange={(checked) =>
                    updateSetting("skip_screenshots", checked, { immediate: true })
                  }
                  ariaLabel={t("settings.media.skipScreenshots.label")}
                />
              </div>

              <div className={rowClass}>
                <div>
                  <p className="text-[13px] font-medium">
                    {t("settings.media.screenshotFormat.label")}
                  </p>
                  <p className="text-[11px] text-text-tertiary mt-0.5">
                    {t("settings.media.screenshotFormat.description")}
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
                <div>
                  <p className="text-[13px] font-medium">
                    {t("settings.media.autoCaptureClips.label")}
                  </p>
                  <p className="text-[11px] text-text-tertiary mt-0.5">
                    {t("settings.media.autoCaptureClips.description")}
                  </p>
                </div>
                <Switch
                  checked={draft.auto_capture_sample_clips}
                  onChange={(checked) =>
                    updateSetting("auto_capture_sample_clips", checked, { immediate: true })
                  }
                  ariaLabel={t("settings.media.autoCaptureClips.label")}
                />
              </div>

              <div className={rowClass}>
                <div>
                  <p className="text-[13px] font-medium">
                    {t("settings.media.clipDuration.label")}
                  </p>
                  <p className="text-[11px] text-text-tertiary mt-0.5">
                    {t("settings.media.clipDuration.description", {
                      min: formatCount(MIN_SAMPLE_CLIP_DURATION_SECS),
                      max: formatCount(MAX_SAMPLE_CLIP_DURATION_SECS),
                    })}
                  </p>
                </div>
                <input
                  type="number"
                  value={draft.sample_clip_duration_secs}
                  onChange={(event) =>
                    updateSetting(
                      "sample_clip_duration_secs",
                      clampSampleClipDuration(Number.parseInt(event.target.value, 10)),
                    )
                  }
                  min={MIN_SAMPLE_CLIP_DURATION_SECS}
                  max={MAX_SAMPLE_CLIP_DURATION_SECS}
                  aria-label={t("settings.media.clipDuration.ariaLabel")}
                  className={`${inputClass} w-24`}
                />
              </div>

              <div className={rowClass}>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium">{t("settings.media.saveMediaTo.label")}</p>
                  <p
                    className="text-[11px] text-text-tertiary mt-0.5 truncate"
                    title={draft.screenshots_dir ?? t("settings.media.saveMediaTo.notSaved")}
                  >
                    {draft.screenshots_dir ?? t("settings.media.saveMediaTo.notSaved")}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleSelectScreenshotsDir}
                    className="macos-btn px-3 py-1.5 min-h-9 text-[13px] bg-btn hover:bg-btn-hover rounded-md"
                    type="button"
                  >
                    {t("settings.browse")}
                  </button>
                  {draft.screenshots_dir && (
                    <button
                      onClick={() => updateSetting("screenshots_dir", null, { immediate: true })}
                      className="macos-btn px-3 py-1.5 min-h-9 text-[13px] bg-btn hover:bg-btn-hover rounded-md"
                      type="button"
                    >
                      {t("settings.clear")}
                    </button>
                  )}
                </div>
              </div>
            </section>

            <section className={blockClass}>
              <div className={rowClass}>
                <div className="min-w-0">
                  <p className="text-[13px] font-medium">{t("settings.media.cache.label")}</p>
                  <p className="text-[11px] text-text-tertiary mt-0.5">
                    {cacheStats
                      ? t("settings.media.cache.size", {
                          size: formatBytes(cacheStats.total_bytes),
                          count: cacheStats.file_count,
                        })
                      : t("settings.media.cache.unavailable")}
                    {cacheStats?.disk_space && (
                      <span className="ml-1.5 text-text-tertiary/70">
                        ·{" "}
                        {t("settings.media.cache.free", {
                          size: formatBytes(cacheStats.disk_space.available_bytes),
                        })}
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
                  {cacheBusy ? t("settings.media.cache.clearing") : t("settings.media.cache.clear")}
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

              <div className="grid grid-cols-2 gap-3 p-4 border-t border-border-subtle">
                <div>
                  <label className="block text-[12px] font-medium text-text-secondary mb-1.5">
                    {t("settings.media.retention")}
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
                    {t("settings.media.lowSpaceThreshold")}
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
                  <p className="text-[13px] font-medium">{t("settings.network.proxyFile.label")}</p>
                  <p
                    className="text-[11px] text-text-tertiary mt-0.5 truncate"
                    title={draft.proxy_file ?? t("settings.network.proxyFile.none")}
                  >
                    {draft.proxy_file ?? t("settings.network.proxyFile.none")}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleSelectProxy}
                    className="macos-btn px-3 py-1.5 min-h-9 text-[13px] bg-btn hover:bg-btn-hover rounded-md"
                    type="button"
                  >
                    {t("settings.browse")}
                  </button>
                  {draft.proxy_file && (
                    <button
                      onClick={() => updateSetting("proxy_file", null, { immediate: true })}
                      className="macos-btn px-3 py-1.5 min-h-9 text-[13px] bg-btn hover:bg-btn-hover rounded-md"
                      type="button"
                    >
                      {t("settings.clear")}
                    </button>
                  )}
                </div>
              </div>

              <div className={rowClass}>
                <div>
                  <p className="text-[13px] font-medium">{t("settings.network.geoblock.label")}</p>
                  <p className="text-[11px] text-text-tertiary mt-0.5">
                    {t("settings.network.geoblock.description")}
                  </p>
                </div>
                <Switch
                  checked={draft.test_geoblock}
                  onChange={(checked) =>
                    updateSetting("test_geoblock", checked, { immediate: true })
                  }
                  ariaLabel={t("settings.network.geoblock.label")}
                />
              </div>
            </section>

            <section className={blockClass}>
              <div className={rowClass}>
                <div>
                  <p className="text-[13px] font-medium">
                    {t("settings.network.insecureCerts.label")}
                  </p>
                  <p className="text-[11px] text-text-tertiary mt-0.5">
                    {t("settings.network.insecureCerts.description")}
                  </p>
                </div>
                <Switch
                  checked={draft.accept_invalid_certs}
                  onChange={(checked) =>
                    updateSetting("accept_invalid_certs", checked, { immediate: true })
                  }
                  ariaLabel={t("settings.network.insecureCerts.ariaLabel")}
                />
              </div>
            </section>
          </>
        )}

        {activeTab === "dispatcharr" && (
          <>
            <section className={blockClass}>
              <div className="px-4 pt-3 pb-2">
                <p className="text-[13px] font-medium">
                  {t("settings.dispatcharr.rankOrder.label")}
                </p>
                <p className="text-[11px] text-text-tertiary mt-0.5">
                  {t("settings.dispatcharr.rankOrder.description")}
                </p>
              </div>
              {fixPreferencesFrom(draft).rankOrder.map((signal, position, order) => {
                const move = (offset: number) => {
                  const next = [...order];
                  next.splice(position, 1);
                  next.splice(position + offset, 0, signal);
                  updateSetting("dispatcharr_rank_order", next, { immediate: true });
                };
                const signalLabel = t(RANK_SIGNAL_LABELS[signal]);
                return (
                  <div key={signal} className={rowClass}>
                    <p className="text-[13px]">
                      <span className="mr-2 text-text-tertiary tabular-nums">{position + 1}</span>
                      {signalLabel}
                    </p>
                    <div className="flex gap-1">
                      <button
                        type="button"
                        aria-label={t("settings.dispatcharr.rankOrder.moveUp", {
                          signal: signalLabel,
                        })}
                        disabled={position === 0}
                        onClick={() => move(-1)}
                        className="rounded-md border border-border-app bg-btn p-1 text-text-secondary hover:bg-btn-hover hover:text-text-primary disabled:opacity-40"
                      >
                        <ArrowUp className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        aria-label={t("settings.dispatcharr.rankOrder.moveDown", {
                          signal: signalLabel,
                        })}
                        disabled={position === order.length - 1}
                        onClick={() => move(1)}
                        className="rounded-md border border-border-app bg-btn p-1 text-text-secondary hover:bg-btn-hover hover:text-text-primary disabled:opacity-40"
                      >
                        <ArrowDown className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
              <p className="px-4 pb-3 text-[11px] text-text-tertiary">
                {t("settings.dispatcharr.rankOrder.footnote")}
              </p>
            </section>

            <section className={blockClass}>
              <div className={rowClass}>
                <div>
                  <p className="text-[13px] font-medium">
                    {t("settings.dispatcharr.deadStreams.label")}
                  </p>
                  <p className="text-[11px] text-text-tertiary mt-0.5">
                    {t("settings.dispatcharr.deadStreams.description")}
                  </p>
                </div>
                <SegmentedControl
                  value={draft.dispatcharr_dead_streams ?? "unlink"}
                  options={[
                    { value: "unlink", label: t("settings.dispatcharr.deadStreams.unlink") },
                    {
                      value: "move_to_end",
                      label: t("settings.dispatcharr.deadStreams.moveToEnd"),
                    },
                  ]}
                  onChange={(value) =>
                    updateSetting("dispatcharr_dead_streams", value, { immediate: true })
                  }
                />
              </div>
            </section>

            <section className={blockClass}>
              <div className={rowClass}>
                <div>
                  <p className="text-[13px] font-medium">
                    {t("settings.dispatcharr.writeStats.label")}
                  </p>
                  <p className="text-[11px] text-text-tertiary mt-0.5">
                    {t("settings.dispatcharr.writeStats.description")}
                  </p>
                </div>
                <Switch
                  checked={draft.dispatcharr_write_stats}
                  onChange={(checked) =>
                    updateSetting("dispatcharr_write_stats", checked, { immediate: true })
                  }
                  ariaLabel={t("settings.dispatcharr.writeStats.label")}
                />
              </div>
            </section>
          </>
        )}

        {activeTab === "advanced" && (
          <>
            <section className={blockClass}>
              <div className={rowClass}>
                <div>
                  <p className="text-[13px] font-medium">
                    {t("settings.advanced.xtreamNotice.label")}
                  </p>
                  <p className="text-[11px] text-text-tertiary mt-0.5">
                    {t("settings.advanced.xtreamNotice.description")}
                  </p>
                </div>
                <Switch
                  checked={draft.persistent_xtream_connection_notice}
                  onChange={(checked) =>
                    updateSetting("persistent_xtream_connection_notice", checked, {
                      immediate: true,
                    })
                  }
                  ariaLabel={t("settings.advanced.xtreamNotice.label")}
                />
              </div>
            </section>

            <section className={`${blockClass} p-4`}>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[12px] font-medium text-text-secondary mb-1.5">
                    {t("settings.advanced.logLevel.label")}
                  </label>
                  <select
                    value={draft.log_level}
                    onChange={(event) =>
                      updateSetting("log_level", event.target.value, { immediate: true })
                    }
                    className={inputClass}
                  >
                    <option value="error">{t("settings.advanced.logLevel.error")}</option>
                    <option value="warn">{t("settings.advanced.logLevel.warn")}</option>
                    <option value="info">{t("settings.advanced.logLevel.info")}</option>
                    <option value="debug">{t("settings.advanced.logLevel.debug")}</option>
                    <option value="trace">{t("settings.advanced.logLevel.trace")}</option>
                  </select>
                </div>

                <div>
                  <label className="block text-[12px] font-medium text-text-secondary mb-1.5">
                    {t("settings.advanced.historyRetention")}
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
                    {t("settings.advanced.ffprobeTimeout")}
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
                    {t("settings.advanced.ffmpegBitrateTimeout")}
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
