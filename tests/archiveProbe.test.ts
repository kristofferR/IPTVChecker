import { describe, expect, it } from "bun:test";
import {
  type ArchiveProbeOutcome,
  cancelArchiveProbes,
  createArchiveProbeSequenceGuard,
  verifyArchivePointResponse,
} from "../src/lib/archiveProbe";

function outcome(responseUrl: string, requestedStartEpochS: number): ArchiveProbeOutcome {
  return {
    label: "Archive",
    daysBack: 1,
    ok: true,
    depthVerified: false,
    requestedStartEpochS,
    requestUrl: "https://provider.example/archive",
    responseUrl,
    latencyMs: 100,
    error: null,
  };
}

describe("archive probe cancellation", () => {
  it("invalidates the guard shared by a multi-channel probe sequence", async () => {
    const sequenceIsCurrent = createArchiveProbeSequenceGuard();

    expect(sequenceIsCurrent()).toBe(true);
    await cancelArchiveProbes();
    expect(sequenceIsCurrent()).toBe(false);
  });
});

describe("archive response verification", () => {
  it("recognizes Xtream date timestamps in archive URLs", () => {
    const startEpochS = Date.UTC(2026, 7, 28, 20, 0) / 1000;

    expect(
      verifyArchivePointResponse(
        outcome(
          "https://provider.example/timeshift/user/pass/60/2026-08-28:20-00/42.m3u8",
          startEpochS,
        ),
      ),
    ).toMatchObject({ depthVerified: true, depthUnknown: false });
  });
});
