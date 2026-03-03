import type { ChannelResult } from "../lib/types";
import { formatAudioInfo, formatVideoInfo } from "../lib/format";
import { StatusBadge } from "./StatusBadge";

interface ChannelRowProps {
  result: ChannelResult | null;
  index: number;
  onClick: (result: ChannelResult) => void;
  selected: boolean;
  focused?: boolean;
}

export function ChannelRow({ result, index, onClick, selected, focused }: ChannelRowProps) {
  if (!result) {
    return (
      <div className="flex items-center h-11 px-4 text-sm text-zinc-600 border-b border-zinc-800">
        <span className="w-12 tabular-nums">{index + 1}</span>
        <span className="w-8" />
        <span className="flex-1 text-zinc-500 italic">Checking...</span>
      </div>
    );
  }

  const isAlive = result.status === "alive";

  return (
    <div
      className={`flex items-center h-11 px-4 text-sm border-b border-zinc-800 cursor-pointer transition-colors hover:bg-zinc-800/50 ${
        selected ? "bg-zinc-700/40" : ""
      } ${focused ? "ring-1 ring-blue-500/50" : ""}`}
      onClick={() => onClick(result)}
    >
      <span className="w-12 text-zinc-500 tabular-nums">{index + 1}</span>
      <span className="w-8">
        <StatusBadge status={result.status} />
      </span>
      <span className="flex-1 min-w-0 truncate px-2 font-medium">
        {result.name}
      </span>
      <span className="w-32 truncate text-zinc-400 px-2">{result.group}</span>
      <span className="w-16 text-center text-zinc-400 tabular-nums">
        {isAlive ? (result.resolution ?? "—") : "—"}
      </span>
      <span className="w-16 text-center text-zinc-400">
        {isAlive ? (result.codec ?? "—") : "—"}
      </span>
      <span className="w-12 text-center text-zinc-400 tabular-nums">
        {isAlive && result.fps ? result.fps : "—"}
      </span>
      <span className="w-20 text-right text-zinc-400 tabular-nums">
        {isAlive && result.audio_bitrate
          ? `${result.audio_bitrate} kbps`
          : "—"}
      </span>
    </div>
  );
}
