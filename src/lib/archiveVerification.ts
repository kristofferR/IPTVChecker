import { hasArchive } from "./archive";
import {
  type ArchiveProbeEntry,
  type ArchiveProbeOutcome,
  probeArchivePoint,
} from "./archiveProbe";
import type { ChannelResult } from "./types";

export type ArchiveVerdict = "advertised" | "verified" | "shallower" | "broken";

/**
 * Derive a channel's verification verdict from its probe outcomes:
 * - no completed probes → still just "advertised"
 * - nothing reachable → "broken"
 * - the advertised depth answered → "verified"
 * - otherwise the archive works but is shallower than advertised.
 */
export function archiveVerdict(
  result: Pick<ChannelResult, "catchup" | "catchup_days" | "catchup_source">,
  entry: ArchiveProbeEntry | undefined,
): ArchiveVerdict {
  if (!hasArchive(result)) return "advertised";
  const outcomes = entry?.outcomes ?? [];
  if (entry?.running || outcomes.length === 0) return "advertised";
  if (!outcomes.some((outcome) => outcome.ok)) return "broken";
  const advertisedDays = result.catchup_days;
  if (advertisedDays == null) return "verified";
  return outcomes.some((outcome) => outcome.ok && outcome.daysBack >= advertisedDays)
    ? "verified"
    : "shallower";
}

/** Deepest point that answered, in days; null without any successful probe. */
export function measuredDepthDays(entry: ArchiveProbeEntry | undefined): number | null {
  const okDays = (entry?.outcomes ?? [])
    .filter((outcome) => outcome.ok)
    .map((outcome) => outcome.daysBack);
  if (okDays.length === 0) return null;
  const deepest = Math.max(...okDays);
  // The near point alone proves less than a day of archive.
  return deepest === 0 ? 1 : deepest;
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

/**
 * Verify one channel's archive: probe −1 h, then the advertised depth, and on
 * a mismatch bisect a few points to estimate the real depth. Streams partial
 * entries through `onUpdate`; points run sequentially (provider limits).
 */
export async function verifyChannelArchive(
  result: ChannelResult,
  onUpdate: (entry: ArchiveProbeEntry) => void,
): Promise<ArchiveProbeEntry> {
  const nowEpochS = Math.floor(Date.now() / 1000);
  const outcomes: ArchiveProbeOutcome[] = [];
  const push = (outcome: ArchiveProbeOutcome | null, done: boolean) => {
    if (outcome) outcomes.push(outcome);
    const entry: ArchiveProbeEntry = {
      running: !done,
      outcomes: [...outcomes],
      checkedAt: done ? nowEpochS : null,
    };
    onUpdate(entry);
    return entry;
  };

  push(null, false);
  const near = await probeArchivePoint(result, probePointForDays(0, nowEpochS), nowEpochS);
  if (!near?.ok) {
    return push(near, true);
  }
  push(near, false);

  const advertisedDays = result.catchup_days;
  if (advertisedDays == null || advertisedDays <= 0) {
    return push(null, true);
  }

  const deep = await probeArchivePoint(
    result,
    probePointForDays(advertisedDays, nowEpochS),
    nowEpochS,
  );
  if (!deep || deep.ok) {
    return push(deep, true);
  }
  push(deep, false);

  // The advertised depth lied; bisect between the working near point and the
  // failing deep point to estimate what the provider actually keeps.
  let workingDays = 0;
  let failingDays = advertisedDays;
  for (let step = 0; step < MAX_BISECT_STEPS; step += 1) {
    const midDays = Math.round((workingDays + failingDays) / 2);
    if (midDays <= workingDays || midDays >= failingDays) break;
    const outcome = await probeArchivePoint(
      result,
      probePointForDays(midDays, nowEpochS),
      nowEpochS,
    );
    if (!outcome) break;
    if (outcome.ok) {
      workingDays = midDays;
    } else {
      failingDays = midDays;
    }
    push(outcome, false);
  }
  return push(null, true);
}
