import { buildArchiveUrl, MAX_CATCHUP_DAYS } from "./archive";
import { cancelQuickCheck, quickCheckChannel } from "./tauri";
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
  /** Archive start requested from the provider. */
  requestedStartEpochS: number;
  /** URL requested from the provider before redirects or manifest traversal. */
  requestUrl: string;
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

// The requested five-minute window may be segment-aligned, but must not
// accept a live segment returned in place of the requested archive media.
const MEDIA_TIME_TOLERANCE_SECONDS = 300;

function responseMediaTimeMatchesRequest(outcome: ArchiveProbeOutcome): boolean | null {
  const response = responseIdentity(outcome.responseUrl);
  if (response == null) return null;

  try {
    const pathname = new URL(response).pathname;
    const timestamps = Array.from(
      pathname.matchAll(/(?:^|\D)(\d{13}|\d{10})(?=\D|$)/g),
      (match) => {
        const value = Number(match[1]);
        return match[1].length === 13 ? value / 1000 : value;
      },
    );
    if (timestamps.length === 0) return null;
    return timestamps.some(
      (timestamp) =>
        Math.abs(timestamp - outcome.requestedStartEpochS) <= MEDIA_TIME_TOLERANCE_SECONDS,
    );
  } catch {
    return null;
  }
}

/** A point is verified only when returned media identifies the requested archive time. */
export function verifyArchivePointResponse(outcome: ArchiveProbeOutcome): ArchiveProbeOutcome {
  if (!outcome.ok) return outcome;
  const mediaTimeMatches = responseMediaTimeMatchesRequest(outcome);
  return {
    ...outcome,
    depthVerified: mediaTimeMatches === true,
    depthUnknown: outcome.depthUnknown || mediaTimeMatches == null,
  };
}

/** A deep response proves depth only when returned media identifies the requested archive time. */
export function verifyArchiveDepthResponse(
  outcome: ArchiveProbeOutcome,
  near: ArchiveProbeOutcome | undefined,
): ArchiveProbeOutcome {
  if (!outcome.ok || outcome.daysBack <= 0) return outcome;
  const response = responseIdentity(outcome.responseUrl);
  const nearResponse = responseIdentity(near?.responseUrl ?? null);
  const mediaTimeMatches = responseMediaTimeMatchesRequest(outcome);
  const depthVerified =
    response != null &&
    nearResponse != null &&
    response !== nearResponse &&
    mediaTimeMatches === true;
  return {
    ...outcome,
    depthVerified,
    depthUnknown: outcome.depthUnknown || mediaTimeMatches == null,
  };
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
  const points: ArchiveProbePoint[] = [
    { label: "Archive −1 h", daysBack: 0, startEpochS: nowEpochS - 3600 },
  ];
  const depthDays =
    result.catchup_days == null ? null : Math.min(MAX_CATCHUP_DAYS, result.catchup_days);
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
  signal?: AbortSignal,
): Promise<ArchiveProbeOutcome | null> {
  const url = buildArchiveUrl(result, {
    startEpochS: point.startEpochS,
    durationS: 300,
    nowEpochS,
  });
  if (!url) {
    return null;
  }
  if (signal?.aborted) {
    return null;
  }
  const requestId = crypto.randomUUID();
  const cancel = () => {
    void cancelQuickCheck(requestId);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const checked = await quickCheckChannel(
      {
        ...result,
        url,
        content_type: "movie",
        stream_url: null,
        status: "pending",
      },
      requestId,
    );
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
      requestedStartEpochS: point.startEpochS,
      requestUrl: url,
      responseUrl: checked.stream_url,
      // The quick check keeps the failed direct request's latency when a proxy
      // confirms access, so it does not represent archive startup time.
      latencyMs: checked.status === "geoblocked_confirmed" ? null : checked.latency_ms,
      error: reachable ? null : (checked.error_reason ?? checked.status),
    };
  } catch (error) {
    return {
      label: point.label,
      daysBack: point.daysBack,
      ok: false,
      depthVerified: false,
      requestedStartEpochS: point.startEpochS,
      requestUrl: url,
      responseUrl: null,
      latencyMs: null,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    signal?.removeEventListener("abort", cancel);
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
    const probed = await pendingCheck.finally(() => inFlightArchiveChecks.delete(completion));
    if (!canContinue()) {
      cancelled = true;
      break;
    }
    const outcome = probed
      ? point.daysBack <= 0
        ? verifyArchivePointResponse(probed)
        : verifyArchiveDepthResponse(probed, outcomes[0])
      : null;
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
