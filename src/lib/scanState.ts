export type ScanState = "idle" | "scanning" | "paused" | "cancelling" | "complete" | "cancelled";

export function isScanActive(scanState: ScanState | null | undefined): boolean {
  return scanState === "scanning" || scanState === "paused" || scanState === "cancelling";
}
