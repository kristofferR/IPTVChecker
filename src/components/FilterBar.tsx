import { Search } from "lucide-react";

interface FilterBarProps {
  search: string;
  onSearchChange: (value: string) => void;
  groups: string[];
  groupFilter: string;
  onGroupChange: (value: string) => void;
  statusFilter: string;
  onStatusChange: (value: string) => void;
}

export function FilterBar({
  search,
  onSearchChange,
  groups,
  groupFilter,
  onGroupChange,
  statusFilter,
  onStatusChange,
}: FilterBarProps) {
  return (
    <div className="flex items-center gap-3 px-4 py-2 border-b border-zinc-700 bg-zinc-800/30">
      <div className="relative flex-1 max-w-sm">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
        <input
          type="text"
          placeholder="Search channels..."
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          className="w-full pl-8 pr-3 py-1.5 text-sm bg-zinc-800 border border-zinc-700 rounded-md text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
        />
      </div>
      <select
        value={groupFilter}
        onChange={(e) => onGroupChange(e.target.value)}
        className="px-3 py-1.5 text-sm bg-zinc-800 border border-zinc-700 rounded-md text-zinc-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
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
        className="px-3 py-1.5 text-sm bg-zinc-800 border border-zinc-700 rounded-md text-zinc-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
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
