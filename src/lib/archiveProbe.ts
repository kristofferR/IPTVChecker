import { buildArchiveUrl, MAX_CATCHUP_DAYS } from "./archive";
import { quickCheckChannel } from "./tauri";
import type { ChannelResult } from "./types";

export interface ArchiveProbeOutcome {
  label: string;
  ok: boolean;
  latencyMs: number | null;
  error: string | null;
}

export interface ArchiveProbeEntry {
  running: boolean;
  outcomes: ArchiveProbeOutcome[];
  checkedAt: number | null;
}

export interface ArchiveProbePoint {
  label: string;
  startEpochS: number;
}

let archiveProbeGeneration = 0;
const inFlightArchiveChecks = new Set<Promise<void>>();

/** Keep a multi-channel sequence tied to the generation in which it started. */
export function createArchiveProbeSequenceGuard(): () => boolean {
  const generation = archiveProbeGeneration;
  return () => generation === archiveProbeGeneration;
}

/** Stop probe sequences and wait for their current backend checks to release the provider. */
export async function cancelArchiveProbes(): Promise<void> {
  archiveProbeGeneration += 1;
  await Promise.all(inFlightArchiveChecks);
}

/** One hour back, plus a point just inside the advertised depth when known. */
export function archiveProbePoints(
  result: Pick<ChannelResult, "catchup_days">,
  nowEpochS: number,
): ArchiveProbePoint[] {
  const points: ArchiveProbePoint[] = [{ label: "Archive −1 h", startEpochS: nowEpochS - 3600 }];
  const depthDays =
    result.catchup_days == null ? null : Math.min(MAX_CATCHUP_DAYS, result.catchup_days);
  if (depthDays != null && depthDays > 0) {
    points.push({
      label: `Archive −${depthDays} d`,
      startEpochS: nowEpochS - depthDays * 86_400 + 1800,
    });
  }
  return points;
}

export async function probeArchivePoint(
  result: ChannelResult,
  point: ArchiveProbePoint,
  nowEpochS: number,
): Promise<ArchiveProbeOutcome | null> {
  const url = buildArchiveUrl(result, {
    startEpochS: point.startEpochS,
    durationS: 300,
    nowEpochS,
  });
  if (!url) {
    return null;
  }
  try {
    const checked = await quickCheckChannel({
      ...result,
      url,
      content_type: "movie",
      stream_url: null,
      status: "pending",
    });
    return {
      label: point.label,
      ok: checked.status === "alive" || checked.status === "drm",
      latencyMs: checked.latency_ms,
      error:
        checked.status === "alive" || checked.status === "drm"
          ? null
          : (checked.error_reason ?? checked.status),
    };
  } catch (error) {
    return {
      label: point.label,
      ok: false,
      latencyMs: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Probe a channel's archive, streaming partial outcomes through `onUpdate` so
 * UIs can render as each point completes. Points run sequentially — IPTV
 * providers commonly enforce single-connection limits.
 */
export async function probeChannelArchive(
  result: ChannelResult,
  onUpdate: (entry: ArchiveProbeEntry) => void,
  shouldContinue: () => boolean = () => true,
): Promise<ArchiveProbeEntry> {
  const generation = archiveProbeGeneration;
  const canContinue = () => generation === archiveProbeGeneration && shouldContinue();
  if (!canContinue()) {
    return { running: false, outcomes: [], checkedAt: null };
  }
  const nowEpochS = Math.floor(Date.now() / 1000);
  const outcomes: ArchiveProbeOutcome[] = [];
  let cancelled = false;
  onUpdate({ running: true, outcomes: [], checkedAt: null });
  for (const point of archiveProbePoints(result, nowEpochS)) {
    if (!canContinue()) {
      cancelled = true;
      break;
    }
    const pendingCheck = probeArchivePoint(result, point, nowEpochS);
    const completion = pendingCheck.then(
      () => undefined,
      () => undefined,
    );
    inFlightArchiveChecks.add(completion);
    const outcome = await pendingCheck.finally(() => inFlightArchiveChecks.delete(completion));
    if (!canContinue()) {
      cancelled = true;
      break;
    }
    if (outcome) {
      outcomes.push(outcome);
      onUpdate({ running: true, outcomes: [...outcomes], checkedAt: null });
    }
  }
  const entry: ArchiveProbeEntry = {
    running: false,
    outcomes,
    checkedAt: cancelled ? null : nowEpochS,
  };
  onUpdate(entry);
  return entry;
}
