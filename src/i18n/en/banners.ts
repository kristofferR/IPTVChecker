export default {
  ffmpegMissing: "ffmpeg/ffprobe not found. Screenshots and media info will be disabled.",
  capturePaused: "Screenshot and clip capture paused: low disk space",
  networkPaused: "Scan paused — network connectivity lost. Waiting for recovery...",
  busyAccounts:
    "Waiting for {accounts}: someone is watching through Dispatcharr, and the provider allows no more connections.",
  dismissScanError: "Dismiss scan error",
  dismissPlaybackError: "Dismiss playback error",
  dismissPlaylistError: "Dismiss playlist error",
  dismissInputError: "Dismiss input error",
  dismissNotification: "Dismiss notification",
  dispatcharrConvert: {
    message:
      "This playlist comes from Dispatcharr. Convert it to a Dispatcharr source to check each channel's provider streams and fix their order.",
    convert: "Convert",
    dismiss: "Dismiss Dispatcharr suggestion",
  },
  providerDown: {
    allFailed: {
      one: "All {count} stream from {account} failed with {cause}. The provider may be down; Fix order keeps its streams.",
      other:
        "All {count} streams from {account} failed with {cause}. The provider may be down; Fix order keeps its streams.",
    },
    someFailed: {
      one: "{failed} of {count} stream from {account} failed with {cause}. The provider may be down; Fix order keeps its streams.",
      other:
        "{failed} of {count} streams from {account} failed with {cause}. The provider may be down; Fix order keeps its streams.",
    },
    causes: {
      timeouts: "timeouts",
      connectionErrors: "connection errors",
    },
    refreshing: "Dispatcharr is refreshing it; reload once it finishes to get the new stream URLs.",
    refreshFailed: "Refresh failed: {error}",
    refresh: "Refresh in Dispatcharr",
    reload: "Reload",
    rescan: "Rescan",
    dismiss: "Dismiss the notice about {account}",
  },
  recording: {
    progress: "Recording {title}",
    saved: "Saved {title} to {path}",
    failed: "Recording {title} failed: {error}",
    unknownError: "unknown error",
    cancelled: "Recording {title} cancelled",
    dismiss: "Dismiss recording notice",
  },
  update: {
    available: "Update available: v{version}.",
    availableWithCurrent: "Update available: v{version} (current v{current}).",
    install: "Install v{version}",
    installing: "Installing…",
    howToUpdate: "How to update",
    confirmManual: "IPTV Checker {version} is available. Open the update instructions?",
    confirmInstall: "Install IPTV Checker {version} now? The app will restart.",
    dismiss: "Dismiss update notice",
    upToDate: "You're up to date.",
    upToDateVersion: "You're up to date (v{version}).",
    alreadyUpToDate: "IPTV Checker is already up to date.",
    checkFailed: "Update check failed: {error}",
    openPageFailed: "Could not open the update page: {error}",
    installFailed: "Update install failed: {error}",
  },
} as const;
