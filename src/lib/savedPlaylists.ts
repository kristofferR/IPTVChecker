import { isolateLtr, t } from "../i18n";
import { normalizeDispatcharrServer } from "./dispatcharr";
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
      return t("saved.secondary.path", { path: isolateLtr(entry.path) });
    case "url":
      return t("saved.secondary.url", { url: isolateLtr(entry.url) });
    case "xtream": {
      const server = entry.preferred_server ?? entry.servers[0] ?? "Xtream";
      return t("saved.secondary.xtream", {
        server: isolateLtr(server),
        username: isolateLtr(entry.username),
      });
    }
    case "dispatcharr":
      return t("saved.secondary.dispatcharr", { server: isolateLtr(entry.server) });
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
  if (descriptor.kind === "dispatcharr") {
    const targetServer = normalizeDispatcharrServer(descriptor.server);
    if (!targetServer) return null;
    // The account is the API key when there is one, otherwise the login.
    const account = (source: { api_key?: string | null; username?: string | null }) => {
      const key = source.api_key?.trim();
      return key ? `key:${key}` : `user:${source.username?.trim() ?? ""}`;
    };
    const targetAccount = account(descriptor);
    return (
      savedPlaylists.find(
        (entry) =>
          entry.kind === "dispatcharr" &&
          normalizeDispatcharrServer(entry.server) === targetServer &&
          account(entry) === targetAccount,
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
    case "dispatcharr":
      return {
        id: existingId ?? undefined,
        kind: "dispatcharr",
        display_name: displayName,
        server: descriptor.server,
        username: descriptor.username ?? null,
        password: descriptor.password ?? null,
        api_key: descriptor.api_key ?? null,
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
    case "dispatcharr":
      if (!entry.api_key && !(entry.username && entry.password)) {
        return null;
      }
      return {
        kind: "dispatcharr",
        server: entry.server,
        username: entry.username,
        password: entry.password,
        api_key: entry.api_key,
      };
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
    case "dispatcharr":
      return {
        kind: "dispatcharr",
        server: descriptor.server,
        username: descriptor.username ?? null,
        api_key: descriptor.api_key ?? null,
      };
    case "saved":
    case "stalker":
      return null;
  }
}
