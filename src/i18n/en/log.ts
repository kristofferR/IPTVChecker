/** Log window chrome. Log entries themselves are data and stay untranslated. */
export default {
  levels: {
    trace: "TRACE",
    debug: "DEBUG",
    info: "INFO",
    warn: "WARN",
    error: "ERROR",
  },
  filterPlaceholder: "Filter logs...",
  entryCount: { one: "{count} entry", other: "{count} entries" },
  filteredCount: "{shown} / {total}",
  exportTitle: "Save matching log entries as a file",
  exporting: "Exporting…",
  export: "Export Log…",
  exportFailed: "Could not export log: {error}",
  clear: "Clear log",
  entriesLabel: "Log entries",
  scrollToBottom: "Scroll to bottom",
} as const;
