import type { ChannelResult } from "../lib/types";

export function isRunScopedEventForActiveRun(
  activeRunId: string | null,
  eventRunId: string,
): boolean {
  return activeRunId != null && activeRunId === eventRunId;
}

export function applyResultBatch(
  previous: (ChannelResult | null)[],
  batch: ChannelResult[],
): (ChannelResult | null)[] {
  const updated = [...previous];
  for (const result of batch) {
    updated[result.index] = result;
  }
  return updated;
}
