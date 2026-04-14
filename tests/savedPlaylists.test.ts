import { describe, expect, it } from "bun:test";

import {
  buildRenameDescriptor,
  buildSavedPlaylistDraftFromSource,
  findSavedPlaylistForCurrentSource,
  normalizeUrlIdentity,
  normalizeXtreamServer,
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

  it("builds readable secondary labels", () => {
    expect(savedPlaylistSecondaryLabel(savedPlaylists[0]!)).toBe("Path - /tmp/demo.m3u");
    expect(savedPlaylistSecondaryLabel(savedPlaylists[1]!)).toBe(
      "URL - https://example.com/playlist.m3u#fragment",
    );
    expect(savedPlaylistSecondaryLabel(savedPlaylists[2]!)).toBe(
      "Xtream - https://beta.example.com (alice)",
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
      buildSavedPlaylistDraftFromSource(
        { kind: "path", path: "/tmp/demo.m3u" },
        "My Local File",
      ),
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
});
