import { CircleHelp, Filter } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { isScanActive, type ScanState } from "../lib/scanState";

interface FilterBarProps {
  channelSearch: string;
  onChannelSearchChange: (value: string) => void;
  channelSearchError: string | null;
  scanState: ScanState;
  visible: boolean;
}

export function FilterBar({
  channelSearch,
  onChannelSearchChange,
  channelSearchError,
  scanState,
  visible,
}: FilterBarProps) {
  const isScanning = isScanActive(scanState);
  const [showRegexHelp, setShowRegexHelp] = useState(false);
  const regexHelpRef = useRef<HTMLDivElement>(null);

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

  if (!visible) return null;

  return (
    <div className="flex items-center gap-3 px-4 py-2 border-b border-border-app bg-panel-muted">
      <div className="flex flex-col flex-1 max-w-sm">
        <div ref={regexHelpRef} className="relative">
          <Filter className="search-icon absolute left-3 top-1/2 -translate-y-1/2 w-[15px] h-[15px] text-text-tertiary" />
          <input
            type="text"
            placeholder="Pre-scan filter (regex)"
            value={channelSearch}
            onChange={(e) => onChannelSearchChange(e.target.value)}
            disabled={isScanning}
            className={`native-field w-full min-h-9 pl-9 pr-9 py-1.5 text-[13px] bg-input border rounded-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50 ${
              channelSearchError ? "border-red-500" : "border-border-app"
            }`}
          />
          <button
            type="button"
            aria-label="Regex quick reference"
            aria-expanded={showRegexHelp}
            onClick={() => setShowRegexHelp((open) => !open)}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-text-tertiary hover:text-text-primary rounded"
          >
            <CircleHelp className="w-4 h-4" />
          </button>
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
                Examples: <code>(?i)sport</code>, <code>^(HBO|CNN)</code>, <code>\bHD\b</code>
              </p>
              <p className="mt-1 text-text-tertiary">Uses Rust regex crate syntax.</p>
            </div>
          )}
        </div>
        {channelSearchError && (
          <p className="mt-1 text-[11px] text-red-400 truncate" title={channelSearchError}>
            {channelSearchError}
          </p>
        )}
      </div>
    </div>
  );
}
