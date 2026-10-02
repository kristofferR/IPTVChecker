function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Convert an original stream URL to a proxy URL that goes through the Tauri
 * backend. The proxy key lets a stream on a private host (a LAN server) load.
 */
export function toProxyUrl(originalUrl: string, key: string | null): string {
  const encoded = bytesToBase64(new TextEncoder().encode(originalUrl))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `streamproxy://localhost/${key ? `${key}/` : ""}${encoded}`;
}
