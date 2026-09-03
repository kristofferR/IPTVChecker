import { hasArchive } from "./archive";
import type { ArchiveProbeEntry } from "./archiveProbe";
import { archiveVerdict, measuredDepthDays } from "./archiveVerification";
import type { ChannelResult, PlaylistScore } from "./types";

// A week of archive is the customary full-marks depth; deeper is a bonus that
// stops mattering, and depth stops counting past two weeks entirely.
const FULL_DEPTH_DAYS = 7;
const DEPTH_CAP_DAYS = 14;

function clampScore10(value: number): number {
  return Math.min(10, Math.max(0, value));
}

/**
 * Catch-up score component, or null for playlists without any catch-up.
 *
 * Before verification the score reflects advertised coverage only. Once
 * channels are probed it blends coverage, reliability (verified full marks,
 * shallower partial credit, fake none), and measured depth.
 */
export function computeCatchupScore(
  results: ChannelResult[],
  probes: Record<number, ArchiveProbeEntry>,
): number | null {
  const liveChannels = results.filter((result) => result.content_type === "live");
  if (liveChannels.length === 0) {
    return null;
  }
  const catchupChannels = liveChannels.filter(hasArchive);
  if (catchupChannels.length === 0) {
    return null;
  }
  const coverage = catchupChannels.length / liveChannels.length;

  let tested = 0;
  let reliabilityPoints = 0;
  let depthSum = 0;
  for (const channel of catchupChannels) {
    const entry = probes[channel.index];
    const verdict = archiveVerdict(channel, entry);
    const completed = entry != null && !entry.running && entry.checkedAt != null;
    if (!completed) {
      continue;
    }
    tested += 1;
    if (verdict === "verified") {
      reliabilityPoints += 1;
    } else if (verdict === "shallower") {
      reliabilityPoints += 0.6;
    }
    const depth =
      verdict === "verified"
        ? (channel.catchup_days ?? measuredDepthDays(entry) ?? 1)
        : measuredDepthDays(entry);
    if (depth != null) {
      depthSum += Math.min(depth, DEPTH_CAP_DAYS);
    }
  }

  if (tested === 0) {
    return clampScore10(coverage * 10);
  }

  const reliability = reliabilityPoints / tested;
  const depthScore = Math.min(1, depthSum / tested / FULL_DEPTH_DAYS);
  const verifiedScore = coverage * 0.5 + reliability * 0.35 + depthScore * 0.15;
  const testedFraction = tested / catchupChannels.length;
  return clampScore10((coverage * (1 - testedFraction) + verifiedScore * testedFraction) * 10);
}

/** Add catch-up as 15% of the displayed overall score when it is available. */
export function withCatchupScore(score: PlaylistScore, catchupScore: number | null): PlaylistScore {
  if (catchupScore == null) return score;
  return {
    ...score,
    overall: clampScore10(
      score.ping * 0.2 + score.content * 0.35 + score.quality * 0.3 + catchupScore * 0.15,
    ),
  };
}
