import type { ChannelStatus } from "../lib/types";
import { statusBgColor, statusIcon } from "../lib/format";

export function StatusBadge({ status }: { status: ChannelStatus }) {
  return (
    <span
      className={`inline-flex items-center justify-center w-6 h-6 rounded text-xs font-bold border ${statusBgColor(status)}`}
    >
      {statusIcon(status)}
    </span>
  );
}
