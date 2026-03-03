import { Filter, Search } from "lucide-react";

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
        <div className="relative">
          <Filter className="search-icon absolute left-3 top-1/2 -translate-y-1/2 w-[15px] h-[15px] text-text-tertiary" />
          <input
            type="text"
            placeholder="Pre-scan filter (regex)"
            value={channelSearch}
            onChange={(e) => onChannelSearchChange(e.target.value)}
            disabled={isScanning}
            className={`native-field w-full min-h-9 pl-9 pr-3 py-1.5 text-[13px] bg-input border rounded-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50 ${
              channelSearchError ? "border-red-500" : "border-border-app"
            }`}
          />
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
        <option value="pending">Pending</option>
      </select>
    </div>
  );
}
