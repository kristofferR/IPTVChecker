export type ScanState = "idle" | "scanning" | "paused" | "complete" | "cancelled";

export function isScanActive(scanState: ScanState | null | undefined): boolean {
  return scanState === "scanning" || scanState === "paused";
}
