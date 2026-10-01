import { describe, expect, it } from "bun:test";

import {
  buildRenameDescriptor,
  buildSavedPlaylistDraftFromSource,
  findSavedPlaylistForCurrentSource,
  normalizeUrlIdentity,
  normalizeXtreamServer,
  savedEntryToSourceDescriptor,
  savedPlaylistSecondaryLabel,
} from "../src/lib/savedPlaylists";
import type { CurrentSourceDescriptor, SavedPlaylistEntry } from "../src/lib/types";

const savedPlaylists: SavedPlaylistEntry[] = [
  {
    id: "file-1",
    kind: "file",
    display_name: "Local File",
    path: "/tmp/demo.m3u",
  },
  {
    id: "url-1",
    kind: "url",
    display_name: "Remote URL",
    url: "https://example.com/playlist.m3u#fragment",
  },
  {
    id: "xtream-1",
    kind: "xtream",
    display_name: "Xtream Alpha",
    servers: ["https://alpha.example.com/get.php/", "https://beta.example.com"],
    preferred_server: "https://beta.example.com",
    username: "alice",
    password: "secret",
  },
];

describe("saved playlist helpers", () => {
  it("normalizes URL identities and strips default ports and fragments", () => {
    expect(normalizeUrlIdentity("https://example.com:443/playlist.m3u#part")).toBe(
      "https://example.com/playlist.m3u",
    );
    expect(normalizeUrlIdentity("ftp://example.com/playlist.m3u")).toBeNull();
  });

  it("normalizes Xtream servers and strips trailing get.php paths", () => {
    expect(normalizeXtreamServer("https://alpha.example.com/get.php/")).toBe(
      "https://alpha.example.com",
    );
    expect(normalizeXtreamServer("https://alpha.example.com/panel/get.php")).toBe(
      "https://alpha.example.com/panel",
    );
    expect(normalizeXtreamServer("https://user:pass@alpha.example.com")).toBeNull();
    expect(normalizeXtreamServer("https://alpha.example.com?x=1")).toBeNull();
  });

  it("builds readable secondary labels with left-to-right isolated values", () => {
    expect(savedPlaylistSecondaryLabel(savedPlaylists[0]!)).toBe(
      "Path - \u2066/tmp/demo.m3u\u2069",
    );
    expect(savedPlaylistSecondaryLabel(savedPlaylists[1]!)).toBe(
      "URL - \u2066https://example.com/playlist.m3u#fragment\u2069",
    );
    expect(savedPlaylistSecondaryLabel(savedPlaylists[2]!)).toBe(
      "Xtream - \u2066https://beta.example.com\u2069 (\u2066alice\u2069)",
    );
  });

  it("finds saved playlists by saved id, normalized URL, and Xtream server", () => {
    expect(
      findSavedPlaylistForCurrentSource(
        savedPlaylists,
        { kind: "path", path: "/tmp/demo.m3u" },
        "file-1",
      )?.id,
    ).toBe("file-1");

    expect(
      findSavedPlaylistForCurrentSource(savedPlaylists, {
        kind: "url",
        url: "https://example.com:443/playlist.m3u",
      })?.id,
    ).toBe("url-1");

    expect(
      findSavedPlaylistForCurrentSource(savedPlaylists, {
        kind: "xtream",
        server: "https://alpha.example.com",
        username: "alice",
        password: "ignored",
      })?.id,
    ).toBe("xtream-1");

    expect(
      findSavedPlaylistForCurrentSource(savedPlaylists, {
        kind: "xtream",
        server: "https://alpha.example.com",
        username: "bob",
        password: "ignored",
      }),
    ).toBeNull();
  });

  it("builds save drafts from supported current sources", () => {
    expect(
      buildSavedPlaylistDraftFromSource({ kind: "path", path: "/tmp/demo.m3u" }, "My Local File"),
    ).toEqual({
      kind: "file",
      display_name: "My Local File",
      path: "/tmp/demo.m3u",
    });

    expect(
      buildSavedPlaylistDraftFromSource(
        {
          kind: "xtream",
          server: "https://alpha.example.com",
          username: "alice",
          password: "secret",
        },
        "My Xtream",
        "xtream-1",
      ),
    ).toEqual({
      id: "xtream-1",
      kind: "xtream",
      display_name: "My Xtream",
      servers: ["https://alpha.example.com"],
      preferred_server: "https://alpha.example.com",
      username: "alice",
      password: "secret",
    });
  });

  it("returns null save drafts for unsupported descriptor kinds", () => {
    const unsupported: CurrentSourceDescriptor[] = [
      { kind: "saved", id: "abc" },
      { kind: "stalker", portal: "https://portal.example.com", mac: "00:11:22:33:44:55" },
    ];

    for (const descriptor of unsupported) {
      expect(buildSavedPlaylistDraftFromSource(descriptor, "Ignored")).toBeNull();
      expect(buildRenameDescriptor(descriptor)).toBeNull();
    }
  });

  it("builds rename descriptors without Xtream passwords", () => {
    expect(
      buildRenameDescriptor({
        kind: "path",
        path: "/tmp/demo.m3u",
      }),
    ).toEqual({
      kind: "path",
      path: "/tmp/demo.m3u",
    });

    expect(
      buildRenameDescriptor({
        kind: "xtream",
        server: "https://alpha.example.com",
        username: "alice",
        password: "secret",
      }),
    ).toEqual({
      kind: "xtream",
      server: "https://alpha.example.com",
      username: "alice",
    });
  });

  it("rebuilds concrete source descriptors from saved playlists", () => {
    expect(savedEntryToSourceDescriptor(savedPlaylists[0]!)).toEqual({
      kind: "path",
      path: "/tmp/demo.m3u",
    });

    expect(savedEntryToSourceDescriptor(savedPlaylists[1]!)).toEqual({
      kind: "url",
      url: "https://example.com/playlist.m3u#fragment",
    });

    expect(savedEntryToSourceDescriptor(savedPlaylists[2]!)).toEqual({
      kind: "xtream",
      server: "https://beta.example.com",
      username: "alice",
      password: "secret",
    });
  });
});

describe("Dispatcharr saved sources", () => {
  const entry = (id: string, api_key: string): SavedPlaylistEntry => ({
    id,
    kind: "dispatcharr",
    display_name: id,
    server: "http://dvr.example:9191",
    username: null,
    password: null,
    api_key,
  });

  it("matches the saved source with the same API key", () => {
    const descriptor: CurrentSourceDescriptor = {
      kind: "dispatcharr",
      server: "http://dvr.example:9191/",
      api_key: "second",
    };
    expect(
      findSavedPlaylistForCurrentSource([entry("a", "first"), entry("b", "second")], descriptor)
        ?.id,
    ).toBe("b");
  });
});
