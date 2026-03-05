import type { ChannelResult } from "./types";

function isValidScheme(value: string): boolean {
  if (value.length === 0) return false;
  if (!/[A-Za-z]/.test(value[0])) return false;
  return /^[A-Za-z][A-Za-z0-9+.-]*$/.test(value);
}

export function detectStreamProtocol(url: string | null | undefined): string | null {
  const trimmed = url?.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    const protocol = parsed.protocol.replace(/:$/, "").toLowerCase();
    if (isValidScheme(protocol)) {
      return protocol;
    }
  } catch {
    // Fallback for non-URL values with scheme prefixes.
  }

  const scheme = trimmed.split("://")[0]?.trim().toLowerCase();
  if (!scheme || !isValidScheme(scheme)) {
    return null;
  }
  return scheme;
}

export function detectChannelProtocol(result: ChannelResult): string | null {
  return detectStreamProtocol(result.stream_url ?? result.url);
}
