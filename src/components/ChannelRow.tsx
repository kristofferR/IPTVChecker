import type { ChannelResult } from "../lib/types";
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
      <div className="flex items-center h-[34px] px-4 text-sm text-text-tertiary border-b border-border-subtle">
        <span className="w-12 tabular-nums">{index + 1}</span>
        <span className="w-8" />
        <span className="flex-1 italic">Checking...</span>
      </div>
    );
  }

  const isAlive = result.status === "alive";

  return (
    <div
      className={`channel-row flex items-center h-[34px] px-4 text-sm border-b border-border-subtle cursor-pointer hover:bg-panel-subtle ${
        selected ? "selected bg-panel-subtle" : ""
      } ${focused ? "ring-1 ring-border-app" : ""}`}
      onClick={() => onClick(result)}
    >
      <span className="w-12 text-text-tertiary tabular-nums">{index + 1}</span>
      <span className="w-8">
        <StatusBadge status={result.status} />
      </span>
      <span className="flex-1 min-w-0 truncate px-2 font-medium">
        {result.name}
      </span>
      <span className="w-32 truncate text-text-secondary px-2">{result.group}</span>
      <span className="w-16 text-center text-text-secondary tabular-nums">
        {isAlive ? (result.resolution ?? "—") : "—"}
      </span>
      <span className="w-16 text-center text-text-secondary">
        {isAlive ? (result.codec ?? "—") : "—"}
      </span>
      <span className="w-12 text-center text-text-secondary tabular-nums">
        {isAlive && result.fps ? result.fps : "—"}
      </span>
      <span className="w-20 text-right text-text-secondary tabular-nums">
        {isAlive && result.audio_bitrate
          ? `${result.audio_bitrate} kbps`
          : "—"}
      </span>
    </div>
  );
}
