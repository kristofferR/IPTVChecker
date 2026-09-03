import { describe, expect, it } from "bun:test";
import { cancelArchiveProbes, createArchiveProbeSequenceGuard } from "../src/lib/archiveProbe";

describe("archive probe cancellation", () => {
  it("invalidates the guard shared by a multi-channel probe sequence", async () => {
    const sequenceIsCurrent = createArchiveProbeSequenceGuard();

    expect(sequenceIsCurrent()).toBe(true);
    await cancelArchiveProbes();
    expect(sequenceIsCurrent()).toBe(false);
  });
});
