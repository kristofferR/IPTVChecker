import { useState } from "react";
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
  scanState: string;
}

function isValidRegex(pattern: string): boolean {
  if (!pattern) return true;
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
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
  scanState,
}: FilterBarProps) {
  const [regexValid, setRegexValid] = useState(true);
  const isScanning = scanState === "scanning" || scanState === "paused";

  const handleChannelSearchChange = (value: string) => {
    setRegexValid(isValidRegex(value));
    onChannelSearchChange(value);
  };

  return (
    <div className="flex items-center gap-3 px-4 py-2 border-b border-border-app bg-panel-muted">
      <div className="relative flex-1 max-w-sm">
        <Search className="search-icon absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-text-tertiary" />
        <input
          type="search"
          placeholder="Search channels..."
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          className="native-field w-full pl-8 pr-3 py-1.5 text-sm bg-input border border-border-app rounded-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
        />
      </div>
      <div className="relative flex-1 max-w-48">
        <Filter className="search-icon absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-tertiary" />
        <input
          type="text"
          placeholder="Pre-scan filter (regex)"
          value={channelSearch}
          onChange={(e) => handleChannelSearchChange(e.target.value)}
          disabled={isScanning}
          className={`native-field w-full pl-8 pr-3 py-1.5 text-sm bg-input border rounded-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50 ${
            !regexValid ? "border-red-500" : "border-border-app"
          }`}
        />
      </div>
      <select
        value={groupFilter}
        onChange={(e) => onGroupChange(e.target.value)}
        className="native-field px-3 py-1.5 text-sm bg-input border border-border-app rounded-md text-text-primary focus:outline-none focus:ring-1 focus:ring-blue-500"
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
        className="native-field px-3 py-1.5 text-sm bg-input border border-border-app rounded-md text-text-primary focus:outline-none focus:ring-1 focus:ring-blue-500"
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
