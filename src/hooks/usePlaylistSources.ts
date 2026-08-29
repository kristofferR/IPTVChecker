import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorToString, formatPlaylistOpenError, formatSourceReloadError } from "../lib/errors";
import { logger } from "../lib/logger";
import { parseXtreamRecent, serializeXtreamRecent } from "../lib/recentPlaylists";
import {
  buildSavedPlaylistDraftFromSource,
  findSavedPlaylistForCurrentSource,
  savedEntryToSourceDescriptor,
} from "../lib/savedPlaylists";
import {
  applyContentVisibilityToPreview,
  applySourceFilterToPreview,
  hasDirtySourceFilter,
  normalizeSourceFilter,
  resolvePreservedGroupFilter,
  validateSourceFilterPattern,
} from "../lib/sourceFilter";
import {
  addRecentPlaylist,
  clearRecentPlaylists,
  deleteSavedPlaylist,
  getRecentPlaylists,
  getSavedPlaylists,
  openPlaylist,
  openPlaylistStalker,
  openPlaylistUrl,
  openPlaylistXtream,
  openSavedPlaylist,
  upsertSavedPlaylist,
} from "../lib/tauri";
import type {
  Channel,
  CurrentSourceDescriptor,
  PlaylistPreview,
  RecentPlaylistEntry,
  SavedPlaylistDraft,
  SavedPlaylistEntry,
  StalkerOpenRequest,
  XtreamOpenRequest,
} from "../lib/types";
import { selectResultByIndex, useAppStore } from "../store";

// Non-reactive store access for writes inside callbacks/effects.
const getStore = () => useAppStore.getState();

type SourceLoadMode = "freshOpen" | "reapplySourceFilter";

type LoadAndCommitSourceResult =
  | {
      ok: true;
      preview: PlaylistPreview;
    }
  | {
      ok: false;
      error: string;
      superseded: boolean;
    };

function applyDisplayNameToPreview(
  preview: PlaylistPreview,
  displayName: string,
  savedPlaylistId?: string | null,
): PlaylistPreview {
  const uniquePlaylistLabels = new Set(
    preview.channels.map((channel) => channel.playlist.trim()).filter((value) => value.length > 0),
  );
  const shouldRewriteChannelPlaylists = uniquePlaylistLabels.size <= 1;

  return {
    ...preview,
    file_name: displayName,
    saved_playlist_id: savedPlaylistId ?? null,
    channels: shouldRewriteChannelPlaylists
      ? preview.channels.map((channel) => ({
          ...channel,
          playlist: displayName,
        }))
      : preview.channels,
  };
}

function buildVisiblePlaylistPreview(
  preview: PlaylistPreview,
  sourceFilter: string,
  hideVodContent: boolean,
): PlaylistPreview {
  return applyContentVisibilityToPreview(
    applySourceFilterToPreview(preview, sourceFilter),
    hideVodContent,
  );
}

function savedEntryToDraft(entry: SavedPlaylistEntry): SavedPlaylistDraft {
  switch (entry.kind) {
    case "file":
      return {
        id: entry.id,
        kind: "file",
        display_name: entry.display_name,
        path: entry.path,
      };
    case "url":
      return {
        id: entry.id,
        kind: "url",
        display_name: entry.display_name,
        url: entry.url,
      };
    case "xtream":
      return {
        id: entry.id,
        kind: "xtream",
        display_name: entry.display_name,
        servers: [...entry.servers],
        preferred_server: entry.preferred_server,
        username: entry.username,
        password: entry.password,
      };
  }
}

export interface UsePlaylistSourcesParams {
  /** From useScan: rebuilds the scan cache when a source is (re)loaded. */
  initFromPlaylist: (channels: Channel[], shouldApply?: () => boolean) => Promise<boolean>;
  /** From useScan: re-syncs the scan cache, optionally preserving results. */
  syncFromPlaylist: (
    channels: Channel[],
    preserveExistingResults?: boolean,
    shouldApply?: () => boolean,
  ) => Promise<boolean>;
}

/** Playlist source management: opening file/URL/Xtream/Stalker sources,
 *  recent/saved playlist refresh + CRUD, and source-filter (re)application. */
export function usePlaylistSources({
  initFromPlaylist,
  syncFromPlaylist,
}: UsePlaylistSourcesParams) {
  const channelSearch = useAppStore((s) => s.channelSearch);
  const settingsHydrated = useAppStore((s) => s.settingsHydrated);
  const hideVodContent = useAppStore((s) => s.settings.hide_vod_content);

  const [savedPlaylistsDialogOpen, setSavedPlaylistsDialogOpen] = useState(false);
  const [savedPlaylistEditorDraft, setSavedPlaylistEditorDraft] =
    useState<SavedPlaylistDraft | null>(null);
  const [savedXtreamTestEntry, setSavedXtreamTestEntry] = useState<SavedPlaylistEntry | null>(null);
  const sourceLoadGenerationRef = useRef(0);

  const refreshRecentPlaylists = useCallback(async () => {
    try {
      const entries = await getRecentPlaylists();
      getStore().setRecentPlaylists(entries);
    } catch (err) {
      logger.warn("[Recent Playlists] Failed to load entries:", errorToString(err));
    }
  }, []);

  const refreshSavedPlaylists = useCallback(async (): Promise<SavedPlaylistEntry[]> => {
    try {
      const entries = await getSavedPlaylists();
      getStore().setSavedPlaylists(entries);
      return entries;
    } catch (err) {
      logger.warn("[Saved Playlists] Failed to load entries:", errorToString(err));
      return [];
    }
  }, []);

  const handleClearRecentPlaylists = useCallback(async () => {
    try {
      const entries = await clearRecentPlaylists();
      getStore().setRecentPlaylists(entries);
      logger.info("[Recent Playlists] Cleared entries");
    } catch (err) {
      logger.warn("[Recent Playlists] Failed to clear entries:", errorToString(err));
    }
  }, []);

  useEffect(() => {
    void refreshRecentPlaylists();
  }, [refreshRecentPlaylists]);

  useEffect(() => {
    void refreshSavedPlaylists();
  }, [refreshSavedPlaylists]);

  const commitLoadedPlaylist = useCallback(
    async (
      preview: PlaylistPreview,
      cachedPreview: PlaylistPreview,
      descriptor: CurrentSourceDescriptor,
      mode: SourceLoadMode,
      appliedSourceFilter: string,
      shouldApply: () => boolean,
    ): Promise<boolean> => {
      const initStartedAt = performance.now();
      logger.info(`[App] Preparing scan cache for ${preview.channels.length} visible channels`);
      const initialized = await initFromPlaylist(preview.channels, shouldApply);
      if (!initialized || !shouldApply()) {
        return false;
      }
      logger.info(`[App] Scan cache ready in ${(performance.now() - initStartedAt).toFixed(1)}ms`);

      const state = getStore();
      state.setPlaylist(preview);
      state.setCachedSourcePreview(cachedPreview);
      state.setCurrentSourceDescriptor(descriptor);
      state.setLastAppliedSourceFilter(appliedSourceFilter);
      state.setPlaylistOpenError(null);

      if (mode === "freshOpen") {
        state.setSearch("");
        state.setGroupFilter("all");
        state.setStatusFilter("all");
        state.setShowHistory(false);
      } else {
        state.setGroupFilter(resolvePreservedGroupFilter(state.groupFilter, preview.groups));
      }

      state.setSelectedChannel(null);
      state.setSelectedChannelIndices([]);
      state.clearArchiveProbes();
      state.setPendingPlaybackChannel(null);

      return true;
    },
    [initFromPlaylist],
  );

  const loadFullSourcePreview = useCallback(
    async (descriptor: CurrentSourceDescriptor): Promise<PlaylistPreview> => {
      switch (descriptor.kind) {
        case "path":
          return openPlaylist(descriptor.path, undefined, undefined);
        case "url":
          return openPlaylistUrl(descriptor.url, undefined, undefined);
        case "saved":
          return openSavedPlaylist(descriptor.id, undefined, undefined);
        case "xtream":
          return openPlaylistXtream(
            {
              server: descriptor.server,
              username: descriptor.username,
              password: descriptor.password,
            },
            undefined,
            undefined,
          );
        case "stalker":
          return openPlaylistStalker(
            {
              portal: descriptor.portal,
              mac: descriptor.mac,
            },
            undefined,
            undefined,
          );
      }
    },
    [],
  );

  const buildVisiblePreview = useCallback(
    (preview: PlaylistPreview, sourceFilter: string) =>
      buildVisiblePlaylistPreview(preview, sourceFilter, hideVodContent),
    [hideVodContent],
  );

  const loadAndCommitSource = useCallback(
    async (
      descriptor: CurrentSourceDescriptor,
      mode: SourceLoadMode,
    ): Promise<LoadAndCommitSourceResult> => {
      const loadGeneration = sourceLoadGenerationRef.current + 1;
      sourceLoadGenerationRef.current = loadGeneration;
      const isCurrentLoad = () => sourceLoadGenerationRef.current === loadGeneration;

      const normalizedSourceFilter = normalizeSourceFilter(channelSearch);
      const currentSourceFilterError = validateSourceFilterPattern(normalizedSourceFilter);
      if (currentSourceFilterError) {
        const error =
          mode === "reapplySourceFilter"
            ? formatSourceReloadError(currentSourceFilterError)
            : formatPlaylistOpenError(currentSourceFilterError);
        getStore().setPlaylistOpenError(error);
        getStore().setPlaylistLoading(false);
        getStore().setPlaylistLoadProgress(null);
        logger.warn(`[Playlist] Load rejected: ${error}`);
        return { ok: false, error, superseded: false };
      }

      const loadStartedAt = performance.now();
      const sourceLabel = (() => {
        switch (descriptor.kind) {
          case "path":
            return `path=${descriptor.path}`;
          case "url":
            return `url=${descriptor.url}`;
          case "saved":
            return `saved id=${descriptor.id}`;
          case "xtream":
            return `xtream server=${descriptor.server}, username=***`;
          case "stalker":
            return `stalker portal=${descriptor.portal}, mac=***`;
        }
      })();
      const loadingAction =
        mode === "reapplySourceFilter" ? "Reloading source with source filter" : "Opening source";
      const supersededResult = (): LoadAndCommitSourceResult => {
        logger.info(
          `[Playlist] ${loadingAction} superseded after ${((performance.now() - loadStartedAt) / 1000).toFixed(1)}s: ${sourceLabel}`,
        );
        return {
          ok: false,
          error: "",
          superseded: true,
        };
      };

      getStore().setPlaylistOpenError(null);
      getStore().setPlaylistLoadProgress(null);
      getStore().setPlaylistLoading(true);
      logger.info(`[Playlist] ${loadingAction}: ${sourceLabel}`);

      try {
        const state = getStore();
        const canReuseCachedPreview =
          mode === "reapplySourceFilter" && state.cachedSourcePreview != null;

        const cachedPreview = canReuseCachedPreview
          ? state.cachedSourcePreview!
          : await loadFullSourcePreview(descriptor);
        if (!isCurrentLoad()) {
          return supersededResult();
        }

        const latestState = getStore();
        const savedEntry =
          descriptor.kind === "saved"
            ? latestState.savedPlaylists.find((entry) => entry.id === descriptor.id)
            : undefined;
        const xtreamUsername = (() => {
          if (descriptor.kind === "xtream") {
            return descriptor.username;
          }
          return savedEntry?.kind === "xtream" ? savedEntry.username : undefined;
        })();
        const safeFileName = xtreamUsername
          ? cachedPreview.file_name.replaceAll(xtreamUsername, "***")
          : descriptor.kind === "saved" && !savedEntry
            ? "Saved playlist"
            : cachedPreview.file_name;
        if (!canReuseCachedPreview) {
          logger.debug(
            `[App] ${loadingAction}: ${sourceLabel}, channelSearch="${normalizedSourceFilter}"`,
          );
          logger.debug(
            `[App] Source loaded: ${safeFileName}, channels=${cachedPreview.total_channels}, groups=${cachedPreview.groups.length}`,
            cachedPreview.groups,
          );
        } else {
          logger.debug(
            `[App] ${loadingAction} from cached preview: ${sourceLabel}, channelSearch="${normalizedSourceFilter}", cachedChannels=${cachedPreview.total_channels}`,
          );
        }

        const preview = buildVisiblePreview(cachedPreview, normalizedSourceFilter);
        const committed = await commitLoadedPlaylist(
          preview,
          cachedPreview,
          descriptor,
          mode,
          normalizedSourceFilter,
          isCurrentLoad,
        );
        if (!committed) {
          return supersededResult();
        }
        logger.info(
          `[Playlist] Loaded ${safeFileName}: visible=${preview.channels.length}, total=${cachedPreview.total_channels}, groups=${preview.groups.length}, preview=${canReuseCachedPreview ? "memory-cache" : "fresh"}, elapsed=${((performance.now() - loadStartedAt) / 1000).toFixed(1)}s`,
        );
        return { ok: true, preview };
      } catch (err) {
        if (!isCurrentLoad()) {
          return supersededResult();
        }

        logger.error(
          mode === "reapplySourceFilter"
            ? `[Playlist] Failed to reload source with source filter after ${((performance.now() - loadStartedAt) / 1000).toFixed(1)}s:`
            : `[Playlist] Failed to open source after ${((performance.now() - loadStartedAt) / 1000).toFixed(1)}s:`,
          err,
        );
        const message =
          mode === "reapplySourceFilter"
            ? formatSourceReloadError(err)
            : formatPlaylistOpenError(err);
        getStore().setPlaylistOpenError(message);

        if (mode === "freshOpen") {
          // Keep app interaction predictable after a failed fresh open attempt.
          getStore().setSelectedChannel(null);
          getStore().setSelectedChannelIndices([]);
          getStore().clearArchiveProbes();
          getStore().setPendingPlaybackChannel(null);
          getStore().setShowHistory(false);
          void refreshRecentPlaylists();
        }

        return { ok: false, error: message, superseded: false };
      } finally {
        if (isCurrentLoad()) {
          getStore().setPlaylistLoading(false);
          getStore().setPlaylistLoadProgress(null);
        }
      }
    },
    [
      buildVisiblePreview,
      channelSearch,
      commitLoadedPlaylist,
      loadFullSourcePreview,
      refreshRecentPlaylists,
    ],
  );

  const previousHideVodContentRef = useRef(hideVodContent);

  useEffect(() => {
    if (!settingsHydrated) {
      previousHideVodContentRef.current = hideVodContent;
      return;
    }

    if (previousHideVodContentRef.current === hideVodContent) {
      return;
    }
    previousHideVodContentRef.current = hideVodContent;

    const state = getStore();
    if (!state.cachedSourcePreview) {
      return;
    }

    const nextPreview = buildVisiblePreview(
      state.cachedSourcePreview,
      state.lastAppliedSourceFilter,
    );
    const visibleIndices = new Set(nextPreview.channels.map((channel) => channel.index));
    const selectedIndex = state.selectedChannel?.index ?? null;
    const pendingPlaybackIndex = state.pendingPlaybackChannel?.index ?? null;
    const nextSelectedIndices = state.selectedChannelIndices.filter((index) =>
      visibleIndices.has(index),
    );

    state.setPlaylist(nextPreview);
    state.setGroupFilter(resolvePreservedGroupFilter(state.groupFilter, nextPreview.groups));
    state.setSelectedChannelIndices(nextSelectedIndices);

    if (selectedIndex == null || !visibleIndices.has(selectedIndex)) {
      state.setSelectedChannel(null);
    }
    if (pendingPlaybackIndex == null || !visibleIndices.has(pendingPlaybackIndex)) {
      state.setPendingPlaybackChannel(null);
    }

    void syncFromPlaylist(nextPreview.channels, true).then(() => {
      if (selectedIndex == null || !visibleIndices.has(selectedIndex)) {
        return;
      }

      const refreshed = selectResultByIndex(getStore(), selectedIndex);
      if (refreshed) {
        getStore().setSelectedChannel(refreshed);
      }
    });
  }, [buildVisiblePreview, hideVodContent, settingsHydrated, syncFromPlaylist]);

  const patchCurrentPlaylistMetadata = useCallback(
    (displayName: string, savedPlaylistId?: string | null) => {
      const state = getStore();
      if (state.playlist) {
        state.setPlaylist(applyDisplayNameToPreview(state.playlist, displayName, savedPlaylistId));
      }
      if (state.cachedSourcePreview) {
        state.setCachedSourcePreview(
          applyDisplayNameToPreview(state.cachedSourcePreview, displayName, savedPlaylistId),
        );
      }
    },
    [],
  );

  const openSavedPlaylistById = useCallback(
    async (id: string): Promise<string | true> => {
      const result = await loadAndCommitSource(
        {
          kind: "saved",
          id,
        },
        "freshOpen",
      );
      if (!result.ok) {
        return result.superseded ? true : result.error;
      }

      const nextSaved = await refreshSavedPlaylists();
      const savedEntry = nextSaved.find((entry) => entry.id === id);
      if (!savedEntry) {
        void refreshRecentPlaylists();
        return true;
      }

      try {
        const recentPayload =
          savedEntry.kind === "file"
            ? {
                kind: "file" as const,
                value: savedEntry.path,
              }
            : savedEntry.kind === "url"
              ? {
                  kind: "url" as const,
                  value: savedEntry.url,
                }
              : {
                  kind: "xtream" as const,
                  value: serializeXtreamRecent({
                    server: savedEntry.preferred_server ?? savedEntry.servers[0] ?? "",
                    username: savedEntry.username,
                    password: savedEntry.password ?? undefined,
                  }),
                };

        const entries = await addRecentPlaylist(
          recentPayload.kind,
          recentPayload.value,
          savedEntry.display_name,
          savedEntry.id,
        );
        getStore().setRecentPlaylists(entries);
      } catch (err) {
        logger.warn("[Recent Playlists] Failed to record saved playlist:", errorToString(err));
      }

      return true;
    },
    [loadAndCommitSource, refreshRecentPlaylists, refreshSavedPlaylists],
  );

  const openPlaylistPath = useCallback(
    async (selectedPath: string) => {
      const result = await loadAndCommitSource(
        {
          kind: "path",
          path: selectedPath,
        },
        "freshOpen",
      );
      if (!result.ok) {
        return;
      }

      try {
        const entries = await addRecentPlaylist("file", selectedPath, null, null);
        getStore().setRecentPlaylists(entries);
      } catch (err) {
        logger.warn("[Recent Playlists] Failed to record file playlist:", errorToString(err));
      }
    },
    [loadAndCommitSource],
  );

  const handleOpen = useCallback(async () => {
    const path = await open({
      multiple: false,
      filters: [{ name: "M3U Playlists", extensions: ["m3u", "m3u8"] }],
      directory: false,
    });
    if (!path) return;

    const selectedPath = Array.isArray(path) ? path[0] : path;
    if (!selectedPath) return;

    await openPlaylistPath(selectedPath);
  }, [openPlaylistPath]);

  const handleOpenFolder = useCallback(async () => {
    const path = await open({
      multiple: false,
      directory: true,
    });
    if (!path) return;

    const selectedPath = Array.isArray(path) ? path[0] : path;
    if (!selectedPath) return;

    await openPlaylistPath(selectedPath);
  }, [openPlaylistPath]);

  const openPlaylistUrlValue = useCallback(
    async (url: string): Promise<string | true> => {
      const result = await loadAndCommitSource(
        {
          kind: "url",
          url,
        },
        "freshOpen",
      );
      if (!result.ok) {
        return result.superseded ? true : result.error;
      }

      try {
        const entries = await addRecentPlaylist("url", url, null, null);
        getStore().setRecentPlaylists(entries);
      } catch (err) {
        logger.warn("[Recent Playlists] Failed to record URL playlist:", errorToString(err));
      }

      return true;
    },
    [loadAndCommitSource],
  );

  const openPlaylistXtreamValue = useCallback(
    async (source: XtreamOpenRequest, savePassword?: boolean): Promise<string | true> => {
      const result = await loadAndCommitSource(
        {
          kind: "xtream",
          server: source.server,
          username: source.username,
          password: source.password,
        },
        "freshOpen",
      );
      if (!result.ok) {
        return result.superseded ? true : result.error;
      }

      if (
        typeof result.preview.xtream_max_connections === "number" &&
        Number.isFinite(result.preview.xtream_max_connections) &&
        result.preview.xtream_max_connections > 0
      ) {
        const effectiveConcurrency = Math.max(
          1,
          Math.min(20, Math.round(result.preview.xtream_max_connections)),
        );
        const message = `Xtream max connections detected: ${result.preview.xtream_max_connections}. Scan concurrency will use ${effectiveConcurrency}.`;
        getStore().setMenuInfo(
          message,
          "warn",
          getStore().settings.persistent_xtream_connection_notice,
        );
      }

      try {
        const entries = await addRecentPlaylist(
          "xtream",
          serializeXtreamRecent({
            server: source.server,
            username: source.username,
            password: savePassword ? source.password : undefined,
          }),
          null,
          null,
        );
        getStore().setRecentPlaylists(entries);
      } catch (err) {
        logger.warn("[Recent Playlists] Failed to record Xtream playlist:", errorToString(err));
      }

      return true;
    },
    [loadAndCommitSource],
  );

  const openPlaylistStalkerValue = useCallback(
    async (source: StalkerOpenRequest): Promise<string | true> => {
      const result = await loadAndCommitSource(
        {
          kind: "stalker",
          portal: source.portal,
          mac: source.mac,
        },
        "freshOpen",
      );
      return result.ok || result.superseded ? true : result.error;
    },
    [loadAndCommitSource],
  );

  const handleOpenSaved = useCallback(
    (id: string) => {
      void openSavedPlaylistById(id);
    },
    [openSavedPlaylistById],
  );

  const handleManageSavedPlaylists = useCallback(() => {
    setSavedPlaylistsDialogOpen(true);
  }, []);

  /** Opens the saved-playlist editor pre-filled from an existing entry. */
  const editSavedPlaylist = useCallback((entry: SavedPlaylistEntry) => {
    setSavedPlaylistEditorDraft(savedEntryToDraft(entry));
  }, []);

  const handleSaveCurrentPlaylist = useCallback(() => {
    const state = getStore();
    const currentPlaylist = state.playlist;
    const descriptor = state.currentSourceDescriptor;
    const existing = findSavedPlaylistForCurrentSource(
      state.savedPlaylists,
      descriptor,
      currentPlaylist?.saved_playlist_id,
    );

    if (existing) {
      setSavedPlaylistEditorDraft(savedEntryToDraft(existing));
      return;
    }

    const draft = buildSavedPlaylistDraftFromSource(
      descriptor,
      currentPlaylist?.file_name ?? "",
      null,
    );
    if (!draft) {
      state.setMenuInfo("Open a file, URL, or Xtream source first.");
      return;
    }
    setSavedPlaylistEditorDraft(draft);
  }, []);

  const handleSavePlaylistDraft = useCallback(
    async (draft: SavedPlaylistDraft) => {
      const action = draft.id ? "Updating" : "Saving";
      logger.info(`[Saved Playlists] ${action} "${draft.display_name}"`);
      const result = await upsertSavedPlaylist(draft).catch((err: unknown) => {
        logger.error(`[Saved Playlists] Failed to save "${draft.display_name}":`, err);
        throw err;
      });

      getStore().setSavedPlaylists(result.entries);
      setSavedPlaylistEditorDraft(null);
      void refreshRecentPlaylists();
      logger.info(`[Saved Playlists] Saved "${result.entry.display_name}"`);

      const state = getStore();
      const currentPlaylist = state.playlist;
      const currentSaved = currentPlaylist?.saved_playlist_id ?? null;
      const currentMatch = findSavedPlaylistForCurrentSource(
        result.entries,
        state.currentSourceDescriptor,
        currentSaved,
      );
      if (currentMatch && currentMatch.id === result.entry.id) {
        try {
          const reloadResult = await openSavedPlaylistById(result.entry.id);
          if (reloadResult !== true) {
            logger.warn(
              `[Saved Playlists] Saved "${result.entry.display_name}", but failed to reload the current source: ${reloadResult}`,
            );
          }
        } catch (err) {
          logger.warn(
            `[Saved Playlists] Saved "${result.entry.display_name}", but failed to reload the current source:`,
            err,
          );
        }
      }
    },
    [openSavedPlaylistById, refreshRecentPlaylists],
  );

  const handleDeleteSavedPlaylistById = useCallback(
    async (id: string) => {
      const confirmed = window.confirm("Delete this saved playlist?");
      if (!confirmed) {
        return;
      }

      try {
        const currentState = getStore();
        const deletedEntry = currentState.savedPlaylists.find((entry) => entry.id === id) ?? null;
        const fallbackDescriptor = deletedEntry ? savedEntryToSourceDescriptor(deletedEntry) : null;
        const entries = await deleteSavedPlaylist(id);
        getStore().setSavedPlaylists(entries);
        void refreshRecentPlaylists();

        const state = getStore();
        if (state.playlist?.saved_playlist_id === id) {
          state.setCurrentSourceDescriptor(fallbackDescriptor);
          patchCurrentPlaylistMetadata(state.playlist.file_name, null);
        }
        logger.info(`[Saved Playlists] Deleted "${deletedEntry?.display_name ?? id}"`);
      } catch (err) {
        getStore().setMenuInfo(errorToString(err), "error");
      }
    },
    [patchCurrentPlaylistMetadata, refreshRecentPlaylists],
  );

  const handlePreferSavedXtreamServer = useCallback(
    async (entry: SavedPlaylistEntry, server: string) => {
      if (entry.kind !== "xtream") {
        return;
      }
      try {
        const result = await upsertSavedPlaylist({
          id: entry.id,
          kind: "xtream",
          display_name: entry.display_name,
          servers: [...entry.servers],
          preferred_server: server,
          username: entry.username,
          password: entry.password,
        });
        getStore().setSavedPlaylists(result.entries);
        setSavedXtreamTestEntry(null);

        const state = getStore();
        if (state.playlist?.saved_playlist_id === entry.id) {
          await openSavedPlaylistById(entry.id);
        }
        logger.info(
          `[Saved Playlists] Preferred Xtream server updated for "${entry.display_name}": ${server}`,
        );
      } catch (err) {
        getStore().setMenuInfo(errorToString(err), "error");
      }
    },
    [openSavedPlaylistById],
  );

  const ensureSourceFilterApplied = useCallback(async () => {
    const state = getStore();
    if (
      !hasDirtySourceFilter(
        state.channelSearch,
        state.lastAppliedSourceFilter,
        state.currentSourceDescriptor,
      )
    ) {
      return { ok: true, reapplied: false };
    }

    if (!state.currentSourceDescriptor) {
      return { ok: true, reapplied: false };
    }

    const result = await loadAndCommitSource(state.currentSourceDescriptor, "reapplySourceFilter");
    return { ok: result.ok, reapplied: result.ok };
  }, [loadAndCommitSource]);

  const handleApplySourceFilter = useCallback(() => {
    const state = getStore();
    if (!state.currentSourceDescriptor) {
      return;
    }
    if (
      !hasDirtySourceFilter(
        state.channelSearch,
        state.lastAppliedSourceFilter,
        state.currentSourceDescriptor,
      )
    ) {
      return;
    }
    void loadAndCommitSource(state.currentSourceDescriptor, "reapplySourceFilter");
  }, [loadAndCommitSource]);

  const handleOpenRecent = useCallback(
    (entry: RecentPlaylistEntry) => {
      if (entry.saved_playlist_id) {
        void openSavedPlaylistById(entry.saved_playlist_id);
        return;
      }
      if (entry.kind === "url") {
        void openPlaylistUrlValue(entry.value);
        return;
      }
      if (entry.kind === "xtream") {
        const source = parseXtreamRecent(entry.value);
        if (!source) {
          getStore().setMenuInfo("This Xtream recent entry is invalid.", "warn");
          void refreshRecentPlaylists();
          return;
        }
        if (source.password) {
          void openPlaylistXtreamValue(
            { server: source.server, username: source.username, password: source.password },
            true,
          );
          return;
        }
        getStore().setOpenSourceDialogState({
          mode: "xtream",
          initialUrl: "",
          initialXtream: source,
          initialStalker: null,
        });
        return;
      }
      void openPlaylistPath(entry.value);
    },
    [
      openPlaylistPath,
      openPlaylistUrlValue,
      openPlaylistXtreamValue,
      openSavedPlaylistById,
      refreshRecentPlaylists,
    ],
  );

  return {
    refreshRecentPlaylists,
    refreshSavedPlaylists,
    handleClearRecentPlaylists,
    handleOpen,
    handleOpenFolder,
    openPlaylistPath,
    openPlaylistUrlValue,
    openPlaylistXtreamValue,
    openPlaylistStalkerValue,
    openSavedPlaylistById,
    handleOpenSaved,
    handleOpenRecent,
    handleManageSavedPlaylists,
    editSavedPlaylist,
    handleSaveCurrentPlaylist,
    handleSavePlaylistDraft,
    handleDeleteSavedPlaylistById,
    handlePreferSavedXtreamServer,
    ensureSourceFilterApplied,
    handleApplySourceFilter,
    savedPlaylistsDialogOpen,
    setSavedPlaylistsDialogOpen,
    savedPlaylistEditorDraft,
    setSavedPlaylistEditorDraft,
    savedXtreamTestEntry,
    setSavedXtreamTestEntry,
  };
}
