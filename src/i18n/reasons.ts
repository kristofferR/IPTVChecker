/**
 * Scan results store failure reasons as fixed English strings from Rust (they
 * are persisted, exported and compared). Translate them only for display.
 */
export function translateReason(reason: string): string {
  return reason;
}
