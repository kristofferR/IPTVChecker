export default {
  button: "Export",
  exporting: "Exporting",
  exportingEllipsis: "Exporting...",
  partialWarning: "Scan in progress — exported files will contain partial results",
  scopeHeading: "Export Scope",
  scope: {
    all: "All",
    filtered: "Filtered",
    selected: "Selected",
  },
  actions: {
    csv: "Export CSV",
    split: "Split Playlists",
    renamed: "Renamed Playlist",
    m3u: "Export M3U/M3U8",
    realCatchup: "Real Catch-up Only (M3U)",
    realCatchupHint: "Only channels whose archive answered, with the measured depth written back",
    strippedCatchup: "Playlist Without Fake Catch-up",
    strippedCatchupHint: "The full list with catch-up attributes removed from fake channels",
    scanLog: "Export Scan Log (JSON)",
    scanLogNeedsScan: "Run a scan first",
  },
  dialogFilterM3u: "M3U Playlist",
  feedback: {
    noSelected: "No selected channels to export.",
    noFiltered: "No channels match the current filters.",
    noChannels: "No channels available to export.",
    noVerifiedCatchup: "No verified catch-up channels to export.",
    csvCancelled: "Export CSV cancelled.",
    m3uCancelled: "M3U export cancelled.",
    scanLogCancelled: "Scan log export cancelled.",
    scanLogNeedsScan: "Run a scan first to generate a scan log.",
    csvExported: {
      all: {
        one: "Exported All CSV ({count} channel) to {path}.",
        other: "Exported All CSV ({count} channels) to {path}.",
      },
      filtered: {
        one: "Exported Filtered CSV ({count} channel) to {path}.",
        other: "Exported Filtered CSV ({count} channels) to {path}.",
      },
      selected: {
        one: "Exported Selected CSV ({count} channel) to {path}.",
        other: "Exported Selected CSV ({count} channels) to {path}.",
      },
    },
    splitExported: {
      all: {
        one: "Exported All split playlists ({count} channel) to {path}.",
        other: "Exported All split playlists ({count} channels) to {path}.",
      },
      filtered: {
        one: "Exported Filtered split playlists ({count} channel) to {path}.",
        other: "Exported Filtered split playlists ({count} channels) to {path}.",
      },
      selected: {
        one: "Exported Selected split playlists ({count} channel) to {path}.",
        other: "Exported Selected split playlists ({count} channels) to {path}.",
      },
    },
    renamedExported: {
      all: {
        one: "Exported All renamed playlist ({count} channel) to {path}.",
        other: "Exported All renamed playlist ({count} channels) to {path}.",
      },
      filtered: {
        one: "Exported Filtered renamed playlist ({count} channel) to {path}.",
        other: "Exported Filtered renamed playlist ({count} channels) to {path}.",
      },
      selected: {
        one: "Exported Selected renamed playlist ({count} channel) to {path}.",
        other: "Exported Selected renamed playlist ({count} channels) to {path}.",
      },
    },
    m3uExported: {
      all: {
        one: "Exported All M3U ({count} channel) to {path}.",
        other: "Exported All M3U ({count} channels) to {path}.",
      },
      filtered: {
        one: "Exported Filtered M3U ({count} channel) to {path}.",
        other: "Exported Filtered M3U ({count} channels) to {path}.",
      },
      selected: {
        one: "Exported Selected M3U ({count} channel) to {path}.",
        other: "Exported Selected M3U ({count} channels) to {path}.",
      },
    },
    realCatchupExported: {
      one: "Exported {count} channel with working catch-up to {path}.",
      other: "Exported {count} channels with working catch-up to {path}.",
    },
    strippedCatchupExported: {
      one: "Exported {count} channel with fake catch-up flags removed to {path}.",
      other: "Exported {count} channels with fake catch-up flags removed to {path}.",
    },
    scanLogExported: "Exported structured scan log to {path}.",
    csvFailed: "CSV export failed: {error}",
    splitFailed: "Split export failed: {error}",
    renamedFailed: "Renamed export failed: {error}",
    m3uFailed: "M3U export failed: {error}",
    scanLogFailed: "Scan log export failed: {error}",
  },
} as const;
