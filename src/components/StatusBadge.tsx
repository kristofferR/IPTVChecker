import { statusDotColor } from "../lib/format";
import type { ChannelStatus } from "../lib/types";

export function StatusBadge({ status, title }: { status: ChannelStatus; title?: string }) {
  return (
    <span title={title} className={`inline-block w-2 h-2 rounded-full ${statusDotColor(status)}`} />
  );
}
