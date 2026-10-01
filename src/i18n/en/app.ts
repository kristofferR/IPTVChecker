export default {
  loadingSettings: "Loading settings...",
  windows: {
    settings: "Settings",
    log: "Log",
  },
  errorBoundary: {
    title: "Something went wrong",
    fallback: "An unexpected error occurred",
    tryAgain: "Try Again",
  },
  scanNotification: {
    complete: "Scan complete",
    cancelled: "Scan cancelled",
    alive: "Alive {count}",
    drm: "DRM {count}",
    dead: "Dead {count}",
    geoblocked: "Geoblocked {count}",
    score: "Score {score}/10",
  },
  dropOverlay: {
    title: "Drop Playlist",
    hint: "Release to open `.m3u` / `.m3u8`",
  },
  pendingPlayback: {
    archiveProbeTitle: "Catch-up test currently running",
    sampleCaptureTitle: "Sample capture currently running",
    scanTitle: "Scan currently running",
    archiveProbeBody:
      "Playback will start when the catch-up test finishes, so a single-connection server is not interrupted.",
    sampleCaptureBody:
      "Playback will start when the sample capture finishes, so a single-connection server is not interrupted.",
    scanBody:
      "A scan is currently running. Playing a channel while scanning may interfere with the scan or cause playback issues if the server's max connection limit is exceeded.",
    proceed: "Proceed",
  },
  playback: {
    blockedByArchiveVerification:
      "Cancel the running catch-up verification or download before starting playback",
    stopScanFirst: "Stop the scan first: the provider allows only so many connections at once.",
    waitForSampleCapture: "Wait for the sample capture to finish before playing externally.",
    pictureInPictureFailed: "Picture-in-picture: {error}",
    liveEnded: "Live stream ended unexpectedly",
    ended: "Playback ended",
    stalled: "Stream stalled during playback",
    stoppedProgressing: "Playback stopped progressing",
  },
  scan: {
    confirmCloseExternalPlayer: "Close the external player before scanning. Continue?",
    stopPlaybackFirst: "Stop playback first: the provider allows only so many connections at once.",
    waitForDispatcharrSave: "Wait for the Dispatcharr changes to finish saving.",
    invalidSourceFilter: "Invalid source filter regex: {error}",
    reloadToScanLinked: "Reload the source to scan streams linked from Find streams.",
    selectedStreamsRemoved: "The selected streams were removed from their channels.",
  },
  sample: {
    alreadyCapturing: "Another sample is being captured.",
    stopCasting: "Stop casting to capture a sample from this playlist.",
    confirmCloseExternalPlayer: "Close the external player before capturing a sample. Continue?",
    waitForCatchup: "Wait for the catch-up test or recording to finish before capturing.",
  },
  notices: {
    openPlaylistForHistory: "Open a playlist first to view scan history.",
    openedMultiple: {
      one: "Opened {count} item. Loaded the first one.",
      other: "Opened {count} items. Loaded the first one.",
    },
    droppedNotPlaylist: "Dropped file is not an M3U/M3U8 playlist.",
  },
  sources: {
    m3uFileFilter: "M3U Playlists",
    xtreamMaxConnections:
      "Xtream max connections detected: {max}. Scan concurrency will use {concurrency}.",
    savedPlaylistMissing: "The saved playlist no longer exists.",
    openSourceFirst: "Open a file, URL, or Xtream source first.",
    confirmDeleteSaved: "Delete this saved playlist?",
    invalidXtreamRecent: "This Xtream recent entry is invalid.",
    invalidDispatcharrRecent: "This Dispatcharr recent entry is invalid.",
  },
  recent: {
    path: "Path - {value}",
    url: "URL - {value}",
    dispatcharr: "Dispatcharr - {server}",
    dispatcharrInvalid: "Dispatcharr - Invalid source",
    xtream: "Xtream - {server} ({username})",
    xtreamInvalid: "Xtream - Invalid source",
  },
  errors: {
    openPlaylist: "Failed to open playlist: {error}",
    openPlaylistFallback:
      "Failed to open playlist. Please verify the file path and playlist format.",
    reloadSource: "Failed to reload source: {error}",
    reloadSourceFallback: "Failed to reload source. Please verify the source settings and filter.",
  },
} as const;
