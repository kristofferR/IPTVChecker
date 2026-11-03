import { describe, expect, it } from "bun:test";
import type { ChannelResult } from "../src/lib/types";
import { countRefusedChannels } from "../src/lib/xtreamAccount";

type Row = Pick<ChannelResult, "status" | "error_reason">;

describe("countRefusedChannels", () => {
  it("counts checked channels the server refused with 401 or 403", () => {
    const rows: Row[] = [
      { status: "pending", error_reason: null },
      { status: "checking", error_reason: null },
      { status: "dead", error_reason: "HTTP 401" },
      { status: "geoblocked", error_reason: "HTTP 403" },
      { status: "dead", error_reason: "HTTP 404" },
      { status: "dead", error_reason: "Timeout" },
      // A retry's reason can linger on a channel that came alive.
      { status: "alive", error_reason: "HTTP 403" },
    ];
    expect(countRefusedChannels(rows)).toEqual({ checked: 5, refused: 2 });
  });
});
