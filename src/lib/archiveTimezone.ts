// Dependency-free so the pure archive helpers (and their tests) can import it.
// The app registers a resolver at startup that reads the current playlist's
// Xtream panel timezone from the store; unregistered, everything is UTC.
let resolver: () => string | null = () => null;

export function registerArchiveTimezoneResolver(next: () => string | null): void {
  resolver = next;
}

/** Timezone an Xtream panel expects timeshift start times in, if known.
 *  Dispatcharr rows name their own panel's zone, since one Dispatcharr can
 *  carry several panels. */
export function currentArchiveTimezone(channel?: { extinf_line?: string }): string | null {
  const own = channel?.extinf_line?.match(/\sx-dispatcharr-timezone="([^"]+)"/)?.[1];
  if (own) return own;
  try {
    return resolver() || null;
  } catch {
    return null;
  }
}
