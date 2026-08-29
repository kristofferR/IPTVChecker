import { buildArchiveUrl } from "./archive";
import { quickCheckChannel } from "./tauri";
import type { ChannelResult } from "./types";

export interface ArchiveProbeOutcome {
  label: string;
  /** How far back this point reached, in days (0 = the −1 h near point). */
  daysBack: number;
  ok: boolean;
  /** Whether this response identifies media distinct from the near probe. */
  depthVerified: boolean;
  /** The probe reached through a proxy but cannot establish media identity. */
  depthUnknown?: boolean;
  responseUrl: string | null;
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
  daysBack: number;
  startEpochS: number;
}

function responseIdentity(responseUrl: string | null): string | null {
  if (!responseUrl) return null;
  try {
    const parsed = new URL(responseUrl);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return responseUrl;
  }
}

/** A deep response proves depth when its successful request identifies a different archive window. */
export function verifyArchiveDepthResponse(
  outcome: ArchiveProbeOutcome,
  near: ArchiveProbeOutcome | undefined,
): ArchiveProbeOutcome {
  if (!outcome.ok || outcome.daysBack <= 0) return outcome;
  const response = responseIdentity(outcome.responseUrl);
  const nearResponse = responseIdentity(near?.responseUrl ?? null);
  return {
    ...outcome,
    depthVerified: response != null && nearResponse != null && response !== nearResponse,
  };
}

/** One hour back, plus a point just inside the advertised depth when known. */
export function archiveProbePoints(result: ChannelResult, nowEpochS: number): ArchiveProbePoint[] {
  const points: ArchiveProbePoint[] = [
    { label: "Archive −1 h", daysBack: 0, startEpochS: nowEpochS - 3600 },
  ];
  const depthDays = result.catchup_days;
  if (depthDays != null && depthDays > 0) {
    points.push({
      label: `Archive −${depthDays} d`,
      daysBack: depthDays,
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
    const reachable =
      checked.status === "alive" ||
      checked.status === "drm" ||
      checked.status === "geoblocked_confirmed";
    return {
      label: point.label,
      daysBack: point.daysBack,
      ok: reachable,
      depthVerified: reachable && point.daysBack <= 0,
      depthUnknown: checked.status === "geoblocked_confirmed" && point.daysBack > 0,
      responseUrl: checked.stream_url,
      latencyMs: checked.latency_ms,
      error: reachable ? null : (checked.error_reason ?? checked.status),
    };
  } catch (error) {
    return {
      label: point.label,
      daysBack: point.daysBack,
      ok: false,
      depthVerified: false,
      responseUrl: null,
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
): Promise<ArchiveProbeEntry> {
  const nowEpochS = Math.floor(Date.now() / 1000);
  const outcomes: ArchiveProbeOutcome[] = [];
  onUpdate({ running: true, outcomes: [], checkedAt: null });
  for (const point of archiveProbePoints(result, nowEpochS)) {
    const probed = await probeArchivePoint(result, point, nowEpochS);
    const outcome = probed ? verifyArchiveDepthResponse(probed, outcomes[0]) : null;
    if (outcome) {
      outcomes.push(outcome);
      onUpdate({ running: true, outcomes: [...outcomes], checkedAt: null });
    }
  }
  const entry: ArchiveProbeEntry = { running: false, outcomes, checkedAt: nowEpochS };
  onUpdate(entry);
  return entry;
}
