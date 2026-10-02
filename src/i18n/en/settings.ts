export default {
  tabs: {
    general: "General",
    scanning: "Scanning",
    media: "Media",
    network: "Network",
    advanced: "Advanced",
  },
  saveError: "Could not save one or more changes: {error}",
  browse: "Browse",
  clear: "Clear",
  password: {
    show: "Show password",
    hide: "Hide password",
  },
  general: {
    language: {
      label: "Language",
      description: "Changes apply after a restart.",
      restart: "Restart to apply",
    },
    theme: {
      label: "Theme",
      description: "Choose system, light, or dark appearance.",
      system: "System",
      light: "Light",
      dark: "Dark",
    },
    logoSize: {
      label: "Channel logo size",
      description: "Controls logo size in the channel name column.",
      small: "Small (16px)",
      medium: "Medium (24px)",
      large: "Large (36px)",
      huge: "Huge (48px)",
    },
    titleBar: {
      label: "Title bar",
      description:
        "Automatic hides the title bar on tiling window managers (Hyprland, Sway, i3…) and keeps it on regular desktops.",
      auto: "Automatic",
      show: "Shown",
      hide: "Hidden",
    },
    externalPlayer: {
      label: "External player",
      systemDefaultTitle: "System default",
      systemDefaultDescription: "Use the operating system default for external playback.",
      change: "Change",
      chooseApp: "Choose App",
      useSystemDefault: "System Default",
      dialogTitle: "Choose External Player",
      applicationsFilter: "Applications",
    },
    profileBitrate: {
      label: "Profile video bitrate",
      description: "Captures 10s of each stream for accurate video bitrate values. Much slower.",
      ariaLabel: "Profile bitrate",
    },
    minVideoBitrate: {
      label: "Minimum video bitrate",
      description:
        "Flag profiled streams that measure below this many kbps. Leave empty to turn off.",
      placeholder: "Off",
    },
    sourceFilterBar: {
      label: "Show source filter bar",
      description: "Display the regex source filter bar above the table.",
    },
    hideVod: {
      label: "Hide VOD / series entries",
      description:
        "Remove movies and series from loaded playlists, scans, and exports until re-enabled.",
      ariaLabel: "Hide VOD and series entries",
    },
    reportAutoReveal: {
      label: "Auto-reveal report panel",
      description: "Slide in the playlist report near scan completion.",
    },
    placeholderStatus: {
      label: "Separate placeholder status",
      description:
        "Show placeholder streams as a distinct status. When off, they are grouped under Dead.",
    },
    headerButtonText: {
      label: "Show header button text",
      descriptionMacos:
        "Display labels beside toolbar icons instead of the default icon-only macOS header.",
      description: "Display labels beside toolbar icons in the main window header.",
    },
    scanNotifications: {
      label: "Scan completion notifications",
      description: "Show native notifications when scans complete or are cancelled.",
    },
    updateChecks: {
      label: "Automatic update checks",
      description:
        "Look for a signed update on launch and every six hours. Updates are only ever installed after you confirm.",
    },
    fileAssociation: {
      label: "Default app for .m3u/.m3u8",
      description: "Open playlist files in IPTV Checker by default.",
      setAsDefault: "Set as Default",
      applying: "Applying...",
    },
  },
  scanning: {
    presets: {
      title: "Scan Presets",
      defaultName: "Default: {name}",
      none: "No presets",
      select: "Select preset",
      optionDefault: "{name} (Default)",
      load: "Load",
      namePlaceholder: "Preset name",
      saveAsDefault: "Save as default",
      markDefault: "Mark Default",
      clearDefault: "Clear Default",
      rename: "Rename",
      renamePrompt: "Rename preset",
      deleteConfirm: 'Delete preset "{name}"?',
      errors: {
        nameRequired: "Enter a preset name first.",
        nameTooLong: "Preset name must be {max} characters or fewer.",
        selectToLoad: "Select a preset to load.",
        selectToRename: "Select a preset to rename.",
        selectToDelete: "Select a preset to delete.",
        selectToMarkDefault: "Select a preset to mark as default.",
      },
      notices: {
        saved: 'Saved preset "{name}".',
        loaded: 'Loaded preset "{name}".',
        renamed: 'Renamed preset to "{name}".',
        deleted: 'Deleted preset "{name}".',
        defaultSet: 'Default preset set to "{name}".',
        defaultCleared: "Cleared default preset.",
      },
    },
    timeout: "Timeout (seconds)",
    extendedTimeout: "Extended Timeout (seconds)",
    extendedTimeoutPlaceholder: "Disabled",
    concurrency: "Concurrency",
    concurrencyPlaceholder: "Auto",
    concurrencyHint:
      "0 or empty = auto (Xtream max for Xtream playlists, 10 for multi-server, 1 for single-server)",
    maxRetries: "Max Retries",
    retryBackoff: {
      label: "Retry Backoff",
      linear: "Linear",
      exponential: "Exponential",
    },
    lowFps: {
      label: "Low FPS threshold",
      description: "Streams below this FPS are flagged as low framerate.",
    },
    userAgent: {
      label: "User agent",
      description: "HTTP user agent string sent with stream requests.",
    },
  },
  media: {
    skipScreenshots: {
      label: "Skip screenshots",
      description: "Disable frame captures for faster checks.",
    },
    screenshotFormat: {
      label: "Screenshot format",
      description: "WebP is faster and smaller. PNG is lossless.",
    },
    autoCaptureClips: {
      label: "Auto-capture sample clips",
      description:
        "Record a clip from every alive channel during scans. Adds scan time and disk usage.",
    },
    clipDuration: {
      label: "Sample clip duration",
      description:
        "Seconds recorded per clip, {min} to {max}. Clips are saved without re-encoding.",
      ariaLabel: "Sample clip duration in seconds",
    },
    saveMediaTo: {
      label: "Save media to",
      notSaved: "Not saved (preview only)",
    },
    cache: {
      label: "Temp Media Cache",
      size: { one: "{size} ({count} file)", other: "{size} ({count} files)" },
      unavailable: "Unavailable",
      free: "{size} free",
      clear: "Clear Cache",
      clearing: "Clearing...",
    },
    retention: "Media Retention",
    lowSpaceThreshold: "Low Space Threshold (GB)",
  },
  network: {
    proxyFile: {
      label: "Proxy file",
      none: "No proxy file selected",
      textFilesFilter: "Text files",
    },
    geoblock: {
      label: "Confirm geoblocks with proxies",
      description: "Re-test geoblocked streams through your proxy list.",
    },
    insecureCerts: {
      label: "Skip certificate verification (insecure)",
      description: "Accept invalid/self-signed TLS certificates during stream checks.",
      ariaLabel: "Skip certificate verification",
    },
  },
  dispatcharr: {
    rankOrder: {
      label: "Rank working streams by",
      description: "Fix order compares streams on each signal in turn; a tie moves on to the next.",
      moveUp: "Move {signal} up",
      moveDown: "Move {signal} down",
      footnote:
        "Video bitrate compares in 500 kbps steps, audio bitrate in 32 kbps steps and latency in 250 ms steps, so small differences between scans do not reshuffle channels.",
    },
    rankSignals: {
      resolution: "Resolution",
      frameRate: "Frame rate",
      bitrate: "Video bitrate",
      latency: "Low latency",
      audioBitrate: "Audio bitrate",
    },
    deadStreams: {
      label: "Dead streams",
      description: "Unlinked streams stay in Dispatcharr and can be added back.",
      unlink: "Unlink",
      moveToEnd: "Move to end",
    },
    lowQualityAsDead: {
      label: "Treat low-quality streams as dead",
      description:
        "Streams flagged low bitrate or frozen video are unlinked or moved like dead ones, unless no other stream works.",
    },
    writeStats: {
      label: "Write probe results to Dispatcharr",
      description:
        "After scanning a Dispatcharr source, store each stream's codec, resolution, and bitrate in Dispatcharr.",
    },
  },
  advanced: {
    xtreamNotice: {
      label: "Keep Xtream connection notice visible",
      description: "Keep the detected max-connections banner visible until you dismiss it.",
    },
    logLevel: {
      label: "Log Level",
      error: "Error",
      warn: "Warning",
      info: "Info",
      debug: "Debug",
      trace: "Trace",
    },
    historyRetention: "Scan History Retention",
    ffprobeTimeout: "ffprobe timeout (seconds)",
    ffmpegBitrateTimeout: "ffmpeg bitrate timeout (seconds)",
  },
} as const;
