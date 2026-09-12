const STORAGE_KEY = "archive-remux-channels-v1";
const MAX_CHANNELS = 200;

/** Use the live channel URL, not the changing programme/seek URL or list index.
 * Hash it so this preference does not store provider credentials. */
export async function archiveChannelKey(url: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readChannels(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (Array.isArray(value)) {
      return value
        .filter((key): key is string => typeof key === "string" && /^[a-f0-9]{64}$/.test(key))
        .slice(-MAX_CHANNELS);
    }
  } catch {}
  return [];
}

export function prefersArchiveRemux(key: string): boolean {
  return readChannels().includes(key);
}

/** Learn only from successful playback; forget a preference when it fails. */
export function rememberArchiveRemux(key: string, preferred: boolean): void {
  const channels = readChannels().filter((entry) => entry !== key);
  if (preferred) channels.push(key);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(channels.slice(-MAX_CHANNELS)));
  } catch {
    // Unavailable storage must not prevent playback.
  }
}
