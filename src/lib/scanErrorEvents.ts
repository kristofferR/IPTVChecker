import type { ScanErrorPayload, ScanEvent } from "./types";

export function runScopedScanErrorMessage(
  activeRunId: string | null,
  event: ScanEvent<ScanErrorPayload>,
): string | null {
  if (!activeRunId || event.run_id !== activeRunId) {
    return null;
  }
  return event.payload.message;
}

export function pendingScanErrorMessageForRun(
  pendingEvent: ScanEvent<ScanErrorPayload> | null,
  runId: string,
): string | null {
  if (!pendingEvent || pendingEvent.run_id !== runId) {
    return null;
  }
  return pendingEvent.payload.message;
}
