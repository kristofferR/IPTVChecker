function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

/** Convert an original stream URL to a proxy URL that goes through the Tauri backend. */
export function toProxyUrl(originalUrl: string): string {
  const encoded = bytesToBase64(new TextEncoder().encode(originalUrl))
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
    const base64 = encoded
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(encoded.length / 4) * 4, "=");
    return new TextDecoder().decode(base64ToBytes(base64));
  } catch {
    return null;
  }
}
