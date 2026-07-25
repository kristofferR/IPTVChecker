import type {
  CurrentSourceDescriptor,
  RenameSourceDescriptor,
  SavedPlaylistDraft,
  SavedPlaylistEntry,
} from "./types";

export function normalizeUrlIdentity(value: string): string | null {
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    if (!parsed.hostname) {
      return null;
    }
    parsed.hash = "";
    if (
      (parsed.protocol === "http:" && parsed.port === "80") ||
      (parsed.protocol === "https:" && parsed.port === "443")
    ) {
      parsed.port = "";
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

export function normalizeXtreamServer(value: string): string | null {
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    if (!parsed.hostname || parsed.username || parsed.password) {
      return null;
    }
    if (parsed.search || parsed.hash) {
      return null;
    }

    let path = parsed.pathname.replace(/\/+$/, "");
    if (!path || path === "/get.php") {
      path = "/";
    } else if (path.toLowerCase().endsWith("/get.php")) {
      path = path.slice(0, -"/get.php".length) || "/";
    }
    parsed.pathname = path;
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function savedPlaylistSecondaryLabel(entry: SavedPlaylistEntry): string {
  switch (entry.kind) {
    case "file":
      return `Path - ${entry.path}`;
    case "url":
      return `URL - ${entry.url}`;
    case "xtream": {
      const primary = entry.preferred_server ?? entry.servers[0] ?? "Xtream";
      return `Xtream - ${primary} (${entry.username})`;
    }
  }
}

export function findSavedPlaylistForCurrentSource(
  savedPlaylists: SavedPlaylistEntry[],
  descriptor: CurrentSourceDescriptor | null,
  currentSavedPlaylistId?: string | null,
): SavedPlaylistEntry | null {
  if (currentSavedPlaylistId) {
    return savedPlaylists.find((entry) => entry.id === currentSavedPlaylistId) ?? null;
  }
  if (!descriptor) {
    return null;
  }
  if (descriptor.kind === "saved") {
    return savedPlaylists.find((entry) => entry.id === descriptor.id) ?? null;
  }
  if (descriptor.kind === "path") {
    return (
      savedPlaylists.find(
        (entry) => entry.kind === "file" && entry.path.trim() === descriptor.path.trim(),
      ) ?? null
    );
  }
  if (descriptor.kind === "url") {
    const target = normalizeUrlIdentity(descriptor.url);
    if (!target) return null;
    return (
      savedPlaylists.find(
        (entry) => entry.kind === "url" && normalizeUrlIdentity(entry.url) === target,
      ) ?? null
    );
  }
  if (descriptor.kind === "xtream") {
    const targetServer = normalizeXtreamServer(descriptor.server);
    if (!targetServer) return null;
    return (
      savedPlaylists.find(
        (entry) =>
          entry.kind === "xtream" &&
          entry.username.trim() === descriptor.username.trim() &&
          entry.servers.some((server) => normalizeXtreamServer(server) === targetServer),
      ) ?? null
    );
  }
  return null;
}

export function buildSavedPlaylistDraftFromSource(
  descriptor: CurrentSourceDescriptor | null,
  displayName: string,
  existingId?: string | null,
): SavedPlaylistDraft | null {
  if (!descriptor) {
    return null;
  }
  switch (descriptor.kind) {
    case "saved":
    case "stalker":
      return null;
    case "path":
      return {
        id: existingId ?? undefined,
        kind: "file",
        display_name: displayName,
        path: descriptor.path,
      };
    case "url":
      return {
        id: existingId ?? undefined,
        kind: "url",
        display_name: displayName,
        url: descriptor.url,
      };
    case "xtream":
      return {
        id: existingId ?? undefined,
        kind: "xtream",
        display_name: displayName,
        servers: [descriptor.server],
        preferred_server: descriptor.server,
        username: descriptor.username,
        password: descriptor.password,
      };
  }
}

export function savedEntryToSourceDescriptor(
  entry: SavedPlaylistEntry,
): CurrentSourceDescriptor | null {
  switch (entry.kind) {
    case "file":
      return {
        kind: "path",
        path: entry.path,
      };
    case "url":
      return {
        kind: "url",
        url: entry.url,
      };
    case "xtream": {
      const server = entry.preferred_server ?? entry.servers[0] ?? null;
      if (!server || !entry.password) {
        return null;
      }
      return {
        kind: "xtream",
        server,
        username: entry.username,
        password: entry.password,
      };
    }
  }
}

export function buildRenameDescriptor(
  descriptor: CurrentSourceDescriptor | null,
): RenameSourceDescriptor | null {
  if (!descriptor) {
    return null;
  }
  switch (descriptor.kind) {
    case "path":
      return { kind: "path", path: descriptor.path };
    case "url":
      return { kind: "url", url: descriptor.url };
    case "xtream":
      return {
        kind: "xtream",
        server: descriptor.server,
        username: descriptor.username,
      };
    case "saved":
    case "stalker":
      return null;
  }
}
