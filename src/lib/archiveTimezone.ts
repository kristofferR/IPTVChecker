// Dependency-free so the pure archive helpers (and their tests) can import it.
// The app registers a resolver at startup that reads the current playlist's
// Xtream panel timezone from the store; unregistered, everything is UTC.
let resolver: () => string | null = () => null;

export function registerArchiveTimezoneResolver(next: () => string | null): void {
  resolver = next;
}

/** Timezone an Xtream panel expects timeshift start times in, if known. */
export function currentArchiveTimezone(): string | null {
  try {
    return resolver() || null;
  } catch {
    return null;
  }
}
