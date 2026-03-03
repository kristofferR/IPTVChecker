import { CircleHelp, Filter, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";

interface FilterBarProps {
  search: string;
  onSearchChange: (value: string) => void;
  groups: string[];
  groupFilter: string;
  onGroupChange: (value: string) => void;
  statusFilter: string;
  onStatusChange: (value: string) => void;
  channelSearch: string;
  onChannelSearchChange: (value: string) => void;
  channelSearchError: string | null;
  scanState: string;
}

export function FilterBar({
  search,
  onSearchChange,
  groups,
  groupFilter,
  onGroupChange,
  statusFilter,
  onStatusChange,
  channelSearch,
  onChannelSearchChange,
  channelSearchError,
  scanState,
}: FilterBarProps) {
  const isScanning = scanState === "scanning" || scanState === "paused";
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

  return (
    <div className="flex items-center gap-3 px-4 py-2 border-b border-border-app bg-panel-muted">
      <div className="relative flex-1 max-w-sm">
        <Search className="search-icon absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-tertiary" />
        <input
          type="search"
          placeholder="Search channels..."
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          className="native-field w-full min-h-9 pl-9 pr-3 py-1.5 text-[13px] bg-input border border-border-app rounded-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
        />
      </div>
      <div className="flex flex-col flex-1 max-w-48">
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
      <select
        value={groupFilter}
        onChange={(e) => onGroupChange(e.target.value)}
        className="native-field min-h-9 px-3 py-1.5 text-[13px] bg-input border border-border-app rounded-md text-text-primary focus:outline-none focus:ring-1 focus:ring-blue-500"
      >
        <option value="all">All Groups</option>
        {groups.map((g) => (
          <option key={g} value={g}>
            {g}
          </option>
        ))}
      </select>
      <select
        value={statusFilter}
        onChange={(e) => onStatusChange(e.target.value)}
        className="native-field min-h-9 px-3 py-1.5 text-[13px] bg-input border border-border-app rounded-md text-text-primary focus:outline-none focus:ring-1 focus:ring-blue-500"
      >
        <option value="all">All Status</option>
        <option value="alive">Alive</option>
        <option value="dead">Dead</option>
        <option value="geoblocked">Geoblocked</option>
        <option value="audio_only">Audio Only</option>
        <option value="duplicates">Duplicates</option>
        <option value="pending">Pending</option>
      </select>
    </div>
  );
}
