import { describe, expect, test } from "bun:test";
import {
  formatPlaylistOpenError,
  formatSourceReloadError,
  redactUrlCredentials,
} from "../src/lib/errors";

describe("user-facing source errors", () => {
  test("redacts Xtream query credentials", () => {
    const error =
      "request failed for url (https://example.com/get.php?username=alice&password=secret&type=m3u_plus)";

    const message = formatPlaylistOpenError(error);

    expect(message).not.toContain("alice");
    expect(message).not.toContain("secret");
    expect(message).toContain("username=***");
    expect(message).toContain("password=***");
  });

  test("redacts URL userinfo and credential values containing whitespace", () => {
    expect(
      redactUrlCredentials(
        "https://first%20last:p%20ass@example.com/get.php?username=user name&password=secret phrase&type=m3u_plus",
      ),
    ).toBe(
      "https://***@example.com/get.php?username=***&password=***&type=m3u_plus",
    );
  });

  test("redacts embedded URL userinfo in formatted errors", () => {
    const message = formatPlaylistOpenError(
      "request failed for url (https://alice:secret@example.com/get.php)",
    );

    expect(message).not.toContain("alice");
    expect(message).not.toContain("secret");
    expect(message).toContain("https://***@example.com/get.php");
  });

  test("reload errors normalize an existing playlist prefix", () => {
    expect(
      formatSourceReloadError("Failed to open playlist: connection refused"),
    ).toBe("Failed to reload source: connection refused");
    expect(
      formatSourceReloadError(
        "Failed to open playlist: Failed to reload source: connection refused",
      ),
    ).toBe("Failed to reload source: connection refused");
  });

  test("nullish errors use the contextual fallback", () => {
    expect(formatPlaylistOpenError(null)).toBe(
      "Failed to open playlist. Please verify the file path and playlist format.",
    );
    expect(formatSourceReloadError(undefined)).toBe(
      "Failed to reload source. Please verify the source settings and filter.",
    );
  });

  test("near-match prefixes are not mistaken for canonical prefixes", () => {
    expect(formatSourceReloadError("Failed to reload source code 7")).toBe(
      "Failed to reload source: Failed to reload source code 7",
    );
  });
});
