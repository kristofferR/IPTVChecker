import { hasArchive } from "./archive";
import {
  type ArchiveProbeEntry,
  type ArchiveProbeOutcome,
  probeArchivePoint,
  verifyArchiveDepthResponse,
  verifyArchivePointResponse,
} from "./archiveProbe";
import type { ChannelResult } from "./types";

export type ArchiveVerdict = "advertised" | "verified" | "shallower" | "fake";

/** Quick answers real vs fake from the −1 h point; full also measures depth. */
export type ArchiveVerifyMode = "quick" | "full";

/**
 * Why an advertised archive is fake:
 * - `empty`: the provider answers but serves no media for any time
 * - `live`: the archive URL serves the live stream instead of the requested time
 * - `http`: the archive URL fails with an HTTP status while live works
 * - `timeout`: the archive URL never answers
 * - `unreachable`: any other failure to fetch the archive
 */
export interface ArchiveFailure {
  kind: "empty" | "live" | "http" | "timeout" | "unreachable";
  status?: number;
}

function nearOutcome(entry: ArchiveProbeEntry | undefined): ArchiveProbeOutcome | undefined {
  return entry?.outcomes.find((outcome) => outcome.daysBack <= 0);
}

/** Classify a failed probe from the checker's error text and media-time check. */
export function classifyArchiveFailure(outcome: ArchiveProbeOutcome): ArchiveFailure | null {
  if (outcome.ok) {
    return outcome.depthVerified || outcome.depthUnknown ? null : { kind: "live" };
  }
  const error = outcome.error ?? "";
  if (/empty manifest|no playable uri|no segments|empty/i.test(error)) return { kind: "empty" };
  const status = error.match(/HTTP\s+(\d{3})/i);
  if (status) return { kind: "http", status: Number(status[1]) };
  if (/timed? ?out|timeout/i.test(error)) return { kind: "timeout" };
  return { kind: "unreachable" };
}

/** Why a channel's archive was judged fake, from its near probe. */
export function archiveFailure(entry: ArchiveProbeEntry | undefined): ArchiveFailure | null {
  const near = nearOutcome(entry);
  if (!near || entry?.running || entry?.checkedAt == null) return null;
  return classifyArchiveFailure(near);
}

/** Short chip text for a fake archive: EMPTY, LIVE, 404, TIMEOUT, ERROR. */
export function archiveFailureLabel(failure: ArchiveFailure): string {
  switch (failure.kind) {
    case "empty":
      return "EMPTY";
    case "live":
      return "LIVE";
    case "http":
      return failure.status != null ? String(failure.status) : "HTTP";
    case "timeout":
      return "TIMEOUT";
    default:
      return "ERROR";
  }
}

export function archiveFailureSentence(failure: ArchiveFailure): string {
  switch (failure.kind) {
    case "empty":
      return "The provider answers archive requests but serves no media. The channel is flagged for catch-up yet keeps nothing.";
    case "live":
      return "Archive requests return the live stream instead of the requested time. The provider ignores the catch-up start.";
    case "http":
      return `Archive requests fail with HTTP ${failure.status ?? "error"} while the channel itself answers.`;
    case "timeout":
      return "Archive requests never answer.";
    default:
      return "Archive requests fail before any media arrives.";
  }
}

/**
 * Derive a channel's verification verdict from its probe outcomes:
 * - no completed probes → still just "advertised"
 * - the −1 h point fails or serves live instead of archive → "fake"
 * - the advertised depth answered → "verified"
 * - otherwise the archive works but is shallower than advertised.
 */
export function archiveVerdict(
  result: Pick<ChannelResult, "catchup" | "catchup_days" | "catchup_source">,
  entry: ArchiveProbeEntry | undefined,
): ArchiveVerdict {
  if (!hasArchive(result)) return "advertised";
  const outcomes = entry?.outcomes ?? [];
  if (entry?.running || entry?.checkedAt == null || outcomes.length === 0) return "advertised";
  if (!outcomes.some((outcome) => outcome.ok)) return "fake";
  const near = nearOutcome(entry);
  if (near?.ok && !near.depthVerified && !near.depthUnknown) return "fake";
  if (!outcomes.some((outcome) => outcome.ok && outcome.depthVerified)) return "advertised";
  const advertisedDays = result.catchup_days;
  if (advertisedDays == null) return "verified";
  // Quick mode stops after the near point: real, but depth not measured.
  if (!outcomes.some((outcome) => outcome.daysBack > 0)) return "verified";
  if (
    outcomes.some(
      (outcome) => outcome.ok && outcome.depthUnknown && outcome.daysBack >= advertisedDays,
    )
  ) {
    return "advertised";
  }
  return outcomes.some(
    (outcome) => outcome.ok && outcome.depthVerified && outcome.daysBack >= advertisedDays,
  )
    ? "verified"
    : "shallower";
}

/** Whether the entry established depth beyond the near point (full mode). */
export function archiveDepthMeasured(entry: ArchiveProbeEntry | undefined): boolean {
  return (entry?.outcomes ?? []).some((outcome) => outcome.daysBack > 0);
}

/** Deepest point that answered, in days; null without any successful probe. */
export function measuredDepthDays(entry: ArchiveProbeEntry | undefined): number | null {
  const okDays = (entry?.outcomes ?? [])
    .filter((outcome) => outcome.ok && outcome.depthVerified)
    .map((outcome) => outcome.daysBack);
  if (okDays.length === 0) return null;
  const deepest = Math.max(...okDays);
  // The near point is one hour back; keep that sub-day evidence distinct from
  // a probe that actually established a full day of archive.
  return deepest === 0 ? 1 / 24 : deepest;
}

function probePointForDays(daysBack: number, nowEpochS: number) {
  if (daysBack <= 0) {
    return { label: "Archive −1 h", daysBack: 0, startEpochS: nowEpochS - 3600 };
  }
  return {
    label: `Archive −${daysBack} d`,
    daysBack,
    startEpochS: nowEpochS - daysBack * 86_400 + 1800,
  };
}

const MAX_BISECT_STEPS = 3;

/** Next probe point between the deepest working and shallowest failing depths. */
export function archiveDepthMidpoint(workingDays: number, failingDays: number): number | null {
  const midpoint = (workingDays + failingDays) / 2;
  return midpoint > workingDays && midpoint < failingDays ? midpoint : null;
}

/**
 * Verify one channel's archive: probe −1 h (quick mode stops here with a
 * real-or-fake answer), then the advertised depth, and on a mismatch bisect a
 * few points to estimate the real depth. Streams partial entries through
 * `onUpdate`; points run sequentially (provider limits).
 */
export async function verifyChannelArchive(
  result: ChannelResult,
  onUpdate: (entry: ArchiveProbeEntry) => void,
  shouldCancel: () => boolean = () => false,
  signal?: AbortSignal,
  mode: ArchiveVerifyMode = "full",
): Promise<ArchiveProbeEntry> {
  const nowEpochS = Math.floor(Date.now() / 1000);
  const outcomes: ArchiveProbeOutcome[] = [];
  const push = (outcome: ArchiveProbeOutcome | null, done: boolean, completed = done) => {
    if (outcome) outcomes.push(outcome);
    const entry: ArchiveProbeEntry = {
      running: !done,
      outcomes: [...outcomes],
      checkedAt: completed ? nowEpochS : null,
    };
    onUpdate(entry);
    return entry;
  };

  push(null, false);
  if (shouldCancel()) {
    return push(null, true, false);
  }
  const probedNear = await probeArchivePoint(
    result,
    probePointForDays(0, nowEpochS),
    nowEpochS,
    signal,
  );
  const near = probedNear ? verifyArchivePointResponse(probedNear) : null;
  if (shouldCancel()) {
    return push(near, true, false);
  }
  if (!near?.ok) {
    return push(near, true);
  }
  if (mode === "quick") {
    return push(near, true);
  }
  push(near, false);

  const advertisedDays = result.catchup_days;
  if (advertisedDays == null || advertisedDays <= 0) {
    return push(null, true);
  }

  if (shouldCancel()) {
    return push(null, true, false);
  }

  const probedDeep = await probeArchivePoint(
    result,
    probePointForDays(advertisedDays, nowEpochS),
    nowEpochS,
    signal,
  );
  const deep = probedDeep ? verifyArchiveDepthResponse(probedDeep, near) : null;
  if (shouldCancel()) {
    return push(deep, true, false);
  }
  if (!deep || (deep.ok && (deep.depthVerified || deep.depthUnknown))) {
    return push(deep, true);
  }
  push(deep, false);

  // Without a verified near point there is no working archive depth from
  // which to start bisection. A reachable live stream is not archive evidence.
  if (!near.depthVerified) return push(null, true);

  // The advertised depth lied; bisect between the working near point and the
  // failing deep point to estimate what the provider actually keeps.
  let workingDays = 0;
  let failingDays = advertisedDays;
  for (let step = 0; step < MAX_BISECT_STEPS; step += 1) {
    if (shouldCancel()) return push(null, true, false);
    const midDays = archiveDepthMidpoint(workingDays, failingDays);
    if (midDays == null) break;
    const probedOutcome = await probeArchivePoint(
      result,
      probePointForDays(midDays, nowEpochS),
      nowEpochS,
      signal,
    );
    const outcome = probedOutcome ? verifyArchiveDepthResponse(probedOutcome, near) : null;
    if (shouldCancel()) return push(outcome, true, false);
    if (!outcome) break;
    if (outcome.ok && outcome.depthVerified) {
      workingDays = midDays;
    } else {
      failingDays = midDays;
    }
    push(outcome, false);
  }
  return push(null, true);
}
