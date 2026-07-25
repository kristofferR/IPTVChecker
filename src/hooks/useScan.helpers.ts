import type { ChannelResult } from "../lib/types";

export interface ScanUiMetrics {
  presentCount: number;
  lowFpsCount: number;
  mislabeledCount: number;
}

/**
 * The scan results as the UI holds them.
 *
 * `flatResults` is the single store of record; `positions` only says where a
 * channel index landed in it. There is deliberately no second copy of the
 * results keyed by index — maintaining one meant spreading an N-key object on
 * every batch, which made a whole scan quadratic (a 50k-channel playlist spent
 * ~14s just folding results into the store).
 */
export interface ScanResultCollections {
  flatResults: ChannelResult[];
  /**
   * Channel index -> position in `flatResults`.
   *
   * Append-only and mutated in place: a result keeps its position for the
   * lifetime of a scan, so this never needs copying. Readers must therefore
   * depend on `flatResults` — whose identity does change per batch — rather
   * than on this map's identity.
   */
  positions: Map<number, number>;
  metrics: ScanUiMetrics;
}

export function emptyResultCollections(): ScanResultCollections {
  return {
    flatResults: [],
    positions: new Map(),
    metrics: { presentCount: 0, lowFpsCount: 0, mislabeledCount: 0 },
  };
}

/** The result for a channel index, or null if it has not been checked yet. */
export function resultAtIndex(
  collections: Pick<ScanResultCollections, "flatResults" | "positions">,
  index: number,
): ChannelResult | null {
  const position = collections.positions.get(index);
  return position == null ? null : (collections.flatResults[position] ?? null);
}

export function isRunScopedEventForActiveRun(
  activeRunId: string | null,
  eventRunId: string,
): boolean {
  return activeRunId != null && activeRunId === eventRunId;
}

export function applyResultUpdates(
  previous: ScanResultCollections,
  batch: ChannelResult[],
): ScanResultCollections {
  if (batch.length === 0) {
    return previous;
  }

  const positions = previous.positions;
  let flatResults = previous.flatResults;
  let presentCount = previous.metrics.presentCount;
  let lowFpsCount = previous.metrics.lowFpsCount;
  let mislabeledCount = previous.metrics.mislabeledCount;
  let metricsChanged = false;

  // Copy once per batch, not once per result: React needs a fresh array
  // identity to re-render, but only one per applied batch.
  const ensureOwnFlatResults = () => {
    if (flatResults === previous.flatResults) {
      flatResults = [...previous.flatResults];
    }
    return flatResults;
  };

  for (const result of batch) {
    const position = positions.get(result.index);
    // Read through the working array, not `previous.flatResults`: an index
    // first seen earlier in this same batch already has a position past the
    // end of the old array, and reading there would count it as new twice.
    const previousResult = position == null ? null : (flatResults[position] ?? null);

    if (!previousResult) {
      presentCount += 1;
      metricsChanged = true;
    }

    const previousLowFps = previousResult?.low_framerate ?? false;
    if (previousLowFps !== result.low_framerate) {
      lowFpsCount += result.low_framerate ? 1 : -1;
      metricsChanged = true;
    }

    const previousMislabeled = (previousResult?.label_mismatches.length ?? 0) > 0;
    const nextMislabeled = result.label_mismatches.length > 0;
    if (previousMislabeled !== nextMislabeled) {
      mislabeledCount += nextMislabeled ? 1 : -1;
      metricsChanged = true;
    }

    if (position == null) {
      const next = ensureOwnFlatResults();
      positions.set(result.index, next.length);
      next.push(result);
      continue;
    }

    if (flatResults[position] !== result) {
      ensureOwnFlatResults()[position] = result;
    }
  }

  return {
    flatResults,
    positions,
    metrics: metricsChanged ? { presentCount, lowFpsCount, mislabeledCount } : previous.metrics,
  };
}
