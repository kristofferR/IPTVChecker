import { CircleHelp, Filter } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { isScanActive } from "../lib/scanState";
import {
  hasDirtySourceFilter,
  validateSourceFilterPattern,
} from "../lib/sourceFilter";
import { useAppStore } from "../store";

interface FilterBarProps {
  onApply: () => void;
  variant?: "content" | "chrome";
}

export function FilterBar({
  onApply,
  variant = "content",
}: FilterBarProps) {
  const channelSearch = useAppStore((s) => s.channelSearch);
  const setChannelSearch = useAppStore((s) => s.setChannelSearch);
  const scanState = useAppStore((s) => s.scanState);
  const playlist = useAppStore((s) => s.playlist);
  const playlistLoading = useAppStore((s) => s.playlistLoading);
  const visible = useAppStore((s) => s.settings.show_prescan_filter);
  const currentSourceDescriptor = useAppStore((s) => s.currentSourceDescriptor);
  const lastAppliedSourceFilter = useAppStore((s) => s.lastAppliedSourceFilter);
  const channelSearchError = useMemo(
    () => validateSourceFilterPattern(channelSearch),
    [channelSearch],
  );
  const isScanning = isScanActive(scanState);
  const sourceFilterDirty = useMemo(
    () =>
      hasDirtySourceFilter(
        channelSearch,
        lastAppliedSourceFilter,
        currentSourceDescriptor,
    ),
    [channelSearch, currentSourceDescriptor, lastAppliedSourceFilter],
  );
  const showApplyButton =
    !!playlist &&
    !isScanning &&
    !channelSearchError &&
    sourceFilterDirty;
  const canApply = showApplyButton && !playlistLoading;
  const [showRegexHelp, setShowRegexHelp] = useState(false);
  const regexHelpRef = useRef<HTMLDivElement>(null);
  const isChromeVariant = variant === "chrome";

  useEffect(() => {
    if (!showRegexHelp) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && regexHelpRef.current?.contains(target)) return;
      setShowRegexHelp(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowRegexHelp(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [showRegexHelp]);

  if (!visible || !playlist) return null;

  return (
    <div
      className={`shrink-0 border-b border-border-app px-4 py-2 ${
        isChromeVariant ? "bg-panel-muted" : "bg-content"
      }`}
    >
      <div className="flex flex-col flex-1 max-w-sm">
        <div ref={regexHelpRef} className="relative">
          <Filter className="search-icon absolute left-3 top-1/2 -translate-y-1/2 w-[15px] h-[15px] text-text-tertiary" />
          <input
            type="text"
            placeholder="Source Filter (regex)"
            value={channelSearch}
            onChange={(e) => setChannelSearch(e.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && canApply) {
                event.preventDefault();
                onApply();
              }
            }}
            disabled={isScanning}
            className={`native-field w-full min-h-9 pl-9 pr-[8.75rem] py-1.5 text-[13px] bg-input border rounded-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50 ${
              channelSearchError ? "border-red-500" : "border-border-app"
            }`}
          />
          <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
            {showApplyButton && (
              <button
                type="button"
                onClick={onApply}
                disabled={!canApply}
                className="rounded-md border border-border-app bg-btn px-2 py-1 text-[11px] font-medium text-text-primary hover:bg-btn-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {playlistLoading ? "Applying..." : "Apply"}
              </button>
            )}
            <button
              type="button"
              aria-label="Regex quick reference"
              aria-expanded={showRegexHelp}
              onClick={() => setShowRegexHelp((open) => !open)}
              className="p-1 text-text-tertiary hover:text-text-primary rounded"
            >
              <CircleHelp className="w-4 h-4" />
            </button>
          </div>
          {showRegexHelp && (
            <div className="macos-popover absolute top-full right-0 mt-1 z-50 w-80 max-w-[calc(100vw-2rem)] bg-dropdown border border-border-app rounded-lg shadow-xl p-3 text-[12px] text-text-secondary leading-relaxed">
              <p className="font-semibold text-text-primary mb-1">Regex quick reference</p>
              <p>
                <code>.</code> any char, <code>*</code> zero or more, <code>+</code> one or more,{" "}
                <code>?</code> optional
              </p>
              <p>
                <code>[abc]</code>, <code>[a-z]</code>, <code>\d</code>, <code>\w</code>
              </p>
              <p>
                <code>^</code> start, <code>$</code> end, <code>foo|bar</code> alternation
              </p>
              <p className="mt-1">
                Examples: <code>(?i)sport</code>, <code>^(HBO|CNN)</code>,{" "}
                <code>^(?!.*(event|ppv))</code>
              </p>
              <p className="mt-1 text-text-tertiary">
                Matches are case-insensitive. Lookahead filters are supported.
              </p>
            </div>
          )}
        </div>
        <p className="mt-1 text-[11px] text-text-tertiary">
          Click Apply to reload the current source. Scan applies pending changes automatically.
        </p>
        {channelSearchError && (
          <p className="mt-1 text-[11px] text-red-400 truncate" title={channelSearchError}>
            {channelSearchError}
          </p>
        )}
      </div>
    </div>
  );
}
