import type { ChannelResult } from "../lib/types";

export interface ScanUiMetrics {
  presentCount: number;
  lowFpsCount: number;
  mislabeledCount: number;
}

export interface ScanResultCollections {
  resultsByIndex: (ChannelResult | null)[];
  flatResults: ChannelResult[];
  indexToFlatPos: Map<number, number>;
  metrics: ScanUiMetrics;
}

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

export function applyResultUpdates(
  previous: ScanResultCollections,
  batch: ChannelResult[],
): ScanResultCollections {
  if (batch.length === 0) {
    return previous;
  }

  const resultsByIndex = [...previous.resultsByIndex];
  let flatResults = previous.flatResults;
  let indexToFlatPos = previous.indexToFlatPos;
  let presentCount = previous.metrics.presentCount;
  let lowFpsCount = previous.metrics.lowFpsCount;
  let mislabeledCount = previous.metrics.mislabeledCount;
  let metricsChanged = false;

  for (const result of batch) {
    const previousResult = resultsByIndex[result.index] ?? null;
    resultsByIndex[result.index] = result;

    if (!previousResult) {
      presentCount += 1;
      metricsChanged = true;
    }

    const previousLowFps = previousResult?.low_framerate ?? false;
    if (previousLowFps !== result.low_framerate) {
      lowFpsCount += result.low_framerate ? 1 : -1;
      metricsChanged = true;
    }

    const previousMislabeled =
      (previousResult?.label_mismatches.length ?? 0) > 0;
    const nextMislabeled = result.label_mismatches.length > 0;
    if (previousMislabeled !== nextMislabeled) {
      mislabeledCount += nextMislabeled ? 1 : -1;
      metricsChanged = true;
    }

    const flatPos = indexToFlatPos.get(result.index);
    if (flatPos == null) {
      if (flatResults === previous.flatResults) {
        flatResults = [...previous.flatResults];
      }
      if (indexToFlatPos === previous.indexToFlatPos) {
        indexToFlatPos = new Map(previous.indexToFlatPos);
      }
      indexToFlatPos.set(result.index, flatResults.length);
      flatResults.push(result);
      continue;
    }

    if (flatResults[flatPos] !== result) {
      if (flatResults === previous.flatResults) {
        flatResults = [...previous.flatResults];
      }
      flatResults[flatPos] = result;
    }
  }

  return {
    resultsByIndex,
    flatResults,
    indexToFlatPos,
    metrics: metricsChanged
      ? {
          presentCount,
          lowFpsCount,
          mislabeledCount,
        }
      : previous.metrics,
  };
}
