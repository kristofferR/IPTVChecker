import { describe, expect, it } from "bun:test";
import { LogLevel } from "@tauri-apps/plugin-log";
import { type AppLogEntry, mergeLogEntries } from "../src/lib/logEntries";

function entry(id: number): AppLogEntry {
  return {
    id,
    timestampMs: id * 1_000,
    level: LogLevel.Info,
    message: `entry ${id}`,
  };
}

describe("log entry history", () => {
  it("merges a late history response with live entries without duplicates", () => {
    expect(mergeLogEntries([], [entry(3), entry(1), entry(2), entry(3)])).toEqual([
      entry(1),
      entry(2),
      entry(3),
    ]);
  });

  it("keeps only the newest entries at the configured limit", () => {
    expect(mergeLogEntries([entry(1), entry(2)], [entry(3), entry(4)], 3)).toEqual([
      entry(2),
      entry(3),
      entry(4),
    ]);
  });
});
