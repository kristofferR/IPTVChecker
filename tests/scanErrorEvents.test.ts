import { describe, expect, it } from "bun:test";
import {
  pendingScanErrorMessageForRun,
  runScopedScanErrorMessage,
} from "../src/lib/scanErrorEvents";
import type { ScanErrorPayload, ScanEvent } from "../src/lib/types";

function event(runId: string, message: string): ScanEvent<ScanErrorPayload> {
  return {
    run_id: runId,
    payload: { message },
  };
}

describe("scan error event run scoping", () => {
  it("accepts only errors from the active scan run", () => {
    expect(runScopedScanErrorMessage("scan-run-2", event("scan-run-2", "boom"))).toBe(
      "boom",
    );
    expect(runScopedScanErrorMessage("scan-run-2", event("scan-run-1", "stale"))).toBeNull();
  });

  it("resolves pending startup errors only for the matching run", () => {
    const pending = event("scan-run-3", "setup failed");
    expect(pendingScanErrorMessageForRun(pending, "scan-run-3")).toBe("setup failed");
    expect(pendingScanErrorMessageForRun(pending, "scan-run-4")).toBeNull();
  });
});
