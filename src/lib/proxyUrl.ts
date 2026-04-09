/** Convert an original stream URL to a proxy URL that goes through the Tauri backend. */
export function toProxyUrl(originalUrl: string): string {
  const encoded = btoa(originalUrl)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `streamproxy://localhost/${encoded}`;
}

/** Decode a proxy URL back to the original stream URL, or null if invalid. */
export function fromProxyUrl(proxyUrl: string): string | null {
  const prefix = "streamproxy://localhost/";
  if (!proxyUrl.startsWith(prefix)) return null;
  const encoded = proxyUrl.slice(prefix.length);
  try {
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    return atob(base64);
  } catch {
    return null;
  }
}
