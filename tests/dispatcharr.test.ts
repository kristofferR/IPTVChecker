import { describe, expect, it } from "bun:test";
import {
  addedStreamRow,
  apiKeyFingerprint,
  dispatcharrChannelRows,
  dispatcharrLinkedIndices,
  dispatcharrServerOfProxyPlaylist,
  failureCause,
  fixPreferencesFrom,
  getDispatcharrView,
  normalizeDispatcharrServer,
  parseDispatcharrIds,
  proposeFixOrder,
  unlinkedStreams,
} from "../src/lib/dispatcharr";
import { planFix } from "../src/lib/dispatcharrEdits";
import type { ChannelResult, PlaylistPreview } from "../src/lib/types";

function extinf(
  channel: number,
  stream: number,
  order: number,
  count: number,
  name: string,
  streamName?: string,
) {
  const streamAttr = streamName ? ` x-dispatcharr-stream-name="${streamName}"` : "";
  return `#EXTINF:-1 group-title="News" x-dispatcharr-channel-id="${channel}" x-dispatcharr-stream-id="${stream}" x-dispatcharr-stream-order="${order}" x-dispatcharr-stream-count="${count}"${streamAttr} x-dispatcharr-account="Provider \\"A\\"",${name}`;
}

function makeResult(
  index: number,
  extinfLine: string,
  name: string,
  overrides: Partial<ChannelResult> = {},
): ChannelResult {
  return {
    index,
    playlist: "fixture.m3u8",
    name,
    group: "News",
    language: null,
    tvg_id: null,
    tvg_name: null,
    tvg_logo: null,
    tvg_chno: null,
    url: `http://provider.example/live/${index}.ts`,
    content_type: "live",
    status: "alive",
    codec: null,
    resolution: null,
    width: null,
    height: null,
    fps: null,
    latency_ms: null,
    hdr_format: null,
    video_bitrate: null,
    audio_bitrate: null,
    audio_codec: null,
    audio_channel_layout: null,
    audio_only: false,
    screenshot_path: null,
    screenshot_error_reason: null,
    label_mismatches: [],
    low_framerate: false,
    error_message: null,
    channel_id: String(index),
    extinf_line: extinfLine,
    metadata_lines: [],
    stream_url: null,
    retry_count: null,
    error_reason: null,
    drm_system: null,
    ...overrides,
  };
}

/** One row per stream of channel `channel`, in the given failover order. */
function channelRows(
  channel: number,
  name: string,
  streams: Array<{
    id: number;
    status?: ChannelResult["status"];
    height?: number;
    fps?: number;
    kbps?: number;
    latency?: number;
  }>,
  firstIndex = 0,
): ChannelResult[] {
  return streams.map((stream, order) => {
    return makeResult(
      firstIndex + order,
      extinf(channel, stream.id, order, streams.length, name, `Feed ${stream.id}`),
      name,
      {
        status: stream.status ?? "alive",
        height: stream.height ?? null,
        fps: stream.fps ?? null,
        video_bitrate: stream.kbps == null ? null : `${stream.kbps} kbps`,
        latency_ms: stream.latency ?? null,
      },
    );
  });
}

const ids = (order: { kind: string; order?: number[] }) => order.order;

describe("dispatcharr helpers", () => {
  it("parses embedded IDs and unescapes attribute values", () => {
    expect(parseDispatcharrIds(extinf(10, 101, 1, 3, "News One [2/3] Feed B"))).toEqual({
      channelId: 10,
      streamId: 101,
      streamOrder: 1,
      streamCount: 3,
      channelUuid: null,
      account: 'Provider "A"',
      accountId: null,
      added: false,
      streamName: null,
      channelStreams: null,
    });
    expect(parseDispatcharrIds('#EXTINF:-1 tvg-id="a",Plain')).toBeNull();
  });

  it("builds one channel per Dispatcharr channel, in failover order", () => {
    const results = [
      ...channelRows(10, "News One", [{ id: 101, status: "dead" }, { id: 102 }]),
      ...channelRows(20, "Sports 2", [{ id: 201 }], 2),
    ];
    const view = getDispatcharrView(results, {});
    expect(view?.channels.map((channel) => [channel.channelId, channel.name])).toEqual([
      [10, "News One"],
      [20, "Sports 2"],
    ]);
    const news = view?.byChannelId.get(10);
    expect(news?.primary.index).toBe(0);
    expect([news?.primaryDead, news?.hasDead, news?.allDead, news?.alive]).toEqual([
      true,
      true,
      false,
      1,
    ]);
    expect(getDispatcharrView([makeResult(0, "#EXTINF:-1,Plain", "Plain")], {})).toBeNull();
    // A mixed playlist keeps its plain table rather than hiding other rows.
    expect(
      getDispatcharrView([...results, makeResult(9, "#EXTINF:-1,Plain", "Plain")], {}),
    ).toBeNull();
  });

  it("applies written orders: removed streams disappear and the primary follows", () => {
    const results = channelRows(10, "News One", [{ id: 101, status: "dead" }, { id: 102 }]);
    const news = getDispatcharrView(results, { 10: [102] })?.byChannelId.get(10);
    expect(news?.streams.map((entry) => entry.ref.streamId)).toEqual([102]);
    expect(news?.primary.index).toBe(1);
    expect(news?.primaryDead).toBe(false);
    // The unlinked row still maps to its channel, so a selection can follow it.
    expect(getDispatcharrView(results, { 10: [102] })?.byStreamIndex.get(0)?.channelId).toBe(10);
  });

  it("orders working streams by resolution, then untested, then others; drops dead", () => {
    const results = channelRows(10, "News One", [
      { id: 1, status: "dead" },
      { id: 2, status: "alive", height: 720 },
      { id: 3, status: "pending" },
      { id: 4, status: "geoblocked" },
      { id: 5, status: "alive", height: 1080 },
      { id: 6, status: "alive", height: 720 },
    ]);
    const channel = getDispatcharrView(results, {})?.byChannelId.get(10);
    if (!channel) throw new Error("missing channel");
    expect(ids(proposeFixOrder(channel))).toEqual([5, 2, 6, 3, 4]);
  });

  it("leaves all-dead and already-ordered channels alone", () => {
    const view = getDispatcharrView(
      [
        ...channelRows(10, "News One", [
          { id: 1, status: "dead" },
          { id: 2, status: "dead" },
        ]),
        ...channelRows(
          20,
          "Sports 2",
          [
            { id: 3, height: 1080 },
            { id: 4, height: 720 },
          ],
          2,
        ),
      ],
      {},
    );
    if (!view) throw new Error("missing view");
    const [news, sports] = view.channels;
    expect(proposeFixOrder(news).kind).toBe("all_dead");
    expect(proposeFixOrder(sports).kind).toBe("none");
  });

  it("plans a bulk fix with separate reorder, removal, and skip counts", () => {
    const view = getDispatcharrView(
      [
        // Only a dead stream to drop: removal without reordering.
        ...channelRows(10, "News One", [{ id: 1 }, { id: 2, status: "dead" }]),
        // A better stream behind the primary: reordered.
        ...channelRows(
          20,
          "Sports 2",
          [
            { id: 3, height: 720 },
            { id: 4, height: 1080 },
          ],
          2,
        ),
        ...channelRows(30, "Movies", [{ id: 5, status: "dead" }], 4),
      ],
      {},
    );
    if (!view) throw new Error("missing view");
    const plan = planFix(view, [10, 20, 30]);
    expect(plan.changes.map((change) => [change.channelId, change.to])).toEqual([
      [10, [1]],
      [20, [4, 3]],
    ]);
    expect([plan.reordered, plan.removed, plan.skippedAllDead]).toEqual([1, 1, 1]);
  });

  it("reduces pasted Dispatcharr links to the server, keeping a path prefix", () => {
    expect(normalizeDispatcharrServer("http://dvr.example:9191/proxy/ts/stream/abc")).toBe(
      "http://dvr.example:9191",
    );
    expect(normalizeDispatcharrServer("https://example.com/dispatcharr/output/m3u?x=1")).toBe(
      "https://example.com/dispatcharr",
    );
    expect(normalizeDispatcharrServer("https://example.com/dispatcharr/api")).toBe(
      "https://example.com/dispatcharr",
    );
    expect(
      normalizeDispatcharrServer("https://example.com/api/dispatcharr/proxy/ts/stream/abc"),
    ).toBe("https://example.com/api/dispatcharr");
    expect(normalizeDispatcharrServer("https://example.com/api/dispatcharr")).toBe(
      "https://example.com/api/dispatcharr",
    );
    expect(normalizeDispatcharrServer("ftp://example.com")).toBeNull();
  });

  it("recognizes a Dispatcharr M3U export by its proxy stream URLs", () => {
    const preview = (urls: string[]) =>
      ({
        channels: urls.map((url, index) => ({
          ...makeResult(index, "#EXTINF:-1,Channel", "Channel"),
          url,
        })),
      }) as unknown as PlaylistPreview;
    expect(
      dispatcharrServerOfProxyPlaylist(
        preview([
          "http://dvr.example:9191/proxy/ts/stream/a",
          "http://dvr.example:9191/proxy/ts/stream/b",
        ]),
      ),
    ).toBe("http://dvr.example:9191");
    expect(
      dispatcharrServerOfProxyPlaylist(preview(["http://provider.example/live/1.ts"])),
    ).toBeNull();
    // The proxy path must be the URL path, not text in the query.
    expect(
      dispatcharrServerOfProxyPlaylist(
        preview(["http://dvr.example/player?next=/proxy/ts/stream/a"]),
      ),
    ).toBeNull();
    // Mixed playlists would lose channels on conversion, so they get no offer.
    expect(
      dispatcharrServerOfProxyPlaylist(
        preview([
          "http://dvr.example:9191/proxy/ts/stream/a",
          "http://other.example:9191/proxy/ts/stream/b",
        ]),
      ),
    ).toBeNull();
    expect(
      dispatcharrServerOfProxyPlaylist(
        preview(["http://dvr.example:9191/proxy/ts/stream/a", "http://provider.example/live/1.ts"]),
      ),
    ).toBeNull();
  });

  it("keeps streams without a row in the order it checks and writes", () => {
    // Stream 9 has no row (no URL) but is part of the channel in Dispatcharr.
    const rows = channelRows(10, "News One", [{ id: 1, status: "dead" }, { id: 2 }]).map(
      (result) => ({
        ...result,
        extinf_line: result.extinf_line.replace(
          " x-dispatcharr-account",
          ' x-dispatcharr-channel-streams="1,9,2" x-dispatcharr-account',
        ),
      }),
    );
    const view = getDispatcharrView(rows, {});
    if (!view) throw new Error("missing view");
    expect(view.channels[0].order).toEqual([1, 9, 2]);
    const [change] = planFix(view, [10]).changes;
    expect(change).toEqual({ channelId: 10, from: [1, 9, 2], to: [2, 9] });
  });

  it("limits full rescans to streams still linked after edits", () => {
    const results = channelRows(10, "News One", [{ id: 1, status: "dead" }, { id: 2 }]);
    expect(dispatcharrLinkedIndices(results, {})).toBeNull();
    expect(dispatcharrLinkedIndices(results, { 10: [2] })).toEqual([1]);
  });

  it("exports a channel's streams in the written order with matching titles", () => {
    const results = channelRows(10, "News One", [{ id: 1 }, { id: 2 }, { id: 3 }]);
    const channel = getDispatcharrView(results, { 10: [3, 1] })?.byChannelId.get(10);
    if (!channel) throw new Error("missing channel");
    const rows = dispatcharrChannelRows(channel);
    expect(rows.map((row) => row.name)).toEqual(["News One [1/2] Feed 3", "News One [2/2] Feed 1"]);
    expect(parseDispatcharrIds(rows[0].extinf_line)).toMatchObject({
      streamId: 3,
      streamOrder: 0,
      streamCount: 2,
    });
    expect(rows[0].extinf_line.endsWith(",News One [1/2] Feed 3")).toBe(true);
  });

  it("fingerprints API keys like the backend", async () => {
    expect(await apiKeyFingerprint("key")).toBe("2c70e12b7a06");
  });

  it("breaks resolution ties by frame rate", () => {
    const results = channelRows(10, "News One", [
      { id: 1, height: 1080, fps: 30 },
      { id: 2, height: 1080, fps: 60 },
      { id: 3, height: 720, fps: 60 },
    ]);
    const channel = getDispatcharrView(results, {})?.byChannelId.get(10);
    if (!channel) throw new Error("missing channel");
    expect(ids(proposeFixOrder(channel))).toEqual([2, 1, 3]);
  });

  it("ranks by the preferred signals and can keep dead streams at the end", () => {
    const results = channelRows(10, "News One", [
      { id: 1, status: "dead" },
      { id: 2, height: 1080, kbps: 3000, latency: 900 },
      { id: 3, height: 720, kbps: 8000, latency: 100 },
      { id: 4, height: 1080, kbps: 3200, latency: 100 },
    ]);
    const channel = getDispatcharrView(results, {})?.byChannelId.get(10);
    if (!channel) throw new Error("missing channel");
    // Bitrate first: 8000 beats both 1080p streams; 3000 and 3200 share a
    // 500 kbps step, so latency (after resolution and frame rate) decides.
    const bitrateFirst = fixPreferencesFrom({
      dispatcharr_rank_order: ["bitrate", "latency"],
      dispatcharr_dead_streams: "move_to_end",
    });
    expect(bitrateFirst.rankOrder).toEqual(["bitrate", "latency", "resolution", "frame_rate"]);
    expect(ids(proposeFixOrder(channel, bitrateFirst))).toEqual([3, 4, 2, 1]);
    // Defaults: resolution first, dead stream unlinked.
    expect(ids(proposeFixOrder(channel))).toEqual([4, 2, 3]);
  });

  it("treats a provider whose streams all failed the same way as down, not dead", () => {
    const onAccount = (result: ChannelResult, accountId: number) => {
      const line = result.extinf_line;
      const title = line.lastIndexOf(",");
      return {
        ...result,
        extinf_line: `${line.slice(0, title)} x-dispatcharr-account-id="${accountId}"${line.slice(title)}`,
      };
    };
    const down = { status: "dead" as const };
    const [first, second, third] = channelRows(10, "News One", [
      { id: 1, ...down },
      { id: 2, height: 720 },
      { id: 3, ...down },
    ]);
    const others = channelRows(
      20,
      "Sports 2",
      [1, 2, 3, 4].map((n) => ({ id: 10 + n, ...down })),
      3,
    );
    const results = [
      onAccount({ ...first, error_reason: "HTTP 502" }, 7),
      onAccount(second, 8),
      onAccount({ ...third, error_reason: "HTTP 404" }, 8),
      ...others.map((row) => onAccount({ ...row, error_reason: "HTTP 502 Bad Gateway" }, 7)),
    ];
    const view = getDispatcharrView(results, {});
    if (!view) throw new Error("missing view");
    expect(view.downAccounts).toEqual([
      { accountId: 7, account: 'Provider "A"', failed: 5, scanned: 5, error: "HTTP 502" },
    ]);
    const news = view.byChannelId.get(10);
    if (!news) throw new Error("missing channel");
    expect(news.primaryDead).toBe(false);
    expect(news.primaryProviderDown).toBe(true);
    // The down provider's stream stays (as untested); the real dead one goes.
    expect(ids(proposeFixOrder(news))).toEqual([2, 1]);
    // A channel only on the down provider is not "all dead" and is left alone.
    const sports = view.byChannelId.get(20);
    if (!sports) throw new Error("missing channel");
    expect(sports.allDead).toBe(false);
    expect(proposeFixOrder(sports).kind).toBe("none");
  });

  it("groups failures by the cause a whole provider fails with", () => {
    const row = (error_reason: string) =>
      makeResult(0, extinf(1, 1, 0, 1, "N"), "N", { error_reason });
    expect(failureCause(row("HTTP 513"))).toBe("HTTP 513");
    expect(failureCause(row("operation timed out"))).toBe("timeouts");
    expect(failureCause(row("error sending request for url (http://x.invalid/)"))).toBe(
      "connection errors",
    );
    expect(failureCause(row("Not a video stream"))).toBeNull();
  });

  it("adds linked streams as rows that full rescans leave alone", () => {
    const results = channelRows(10, "News One", [{ id: 1 }, { id: 2 }]);
    const view = getDispatcharrView(results, {});
    const channel = view?.byChannelId.get(10);
    if (!channel) throw new Error("missing channel");
    const found = makeResult(0, extinf(10, 7, 0, 1, "News One", "Feed 7"), "Feed 7");
    const added = addedStreamRow(found, channel, 5);
    expect(added.index).toBe(5);
    expect(parseDispatcharrIds(added.extinf_line)?.added).toBe(true);
    // The marker lands before the title, even when the title holds a quote.
    const quoted = addedStreamRow(
      makeResult(0, extinf(10, 8, 0, 1, 'News "One"', "Feed 8"), 'News "One"'),
      channel,
      6,
    );
    expect(quoted.extinf_line.endsWith(',News "One"')).toBe(true);
    expect(parseDispatcharrIds(quoted.extinf_line)?.added).toBe(true);
    const orders = { 10: [7, 1, 2] };
    const withAdded = [...results, added];
    expect(getDispatcharrView(withAdded, orders)?.byChannelId.get(10)?.primary.index).toBe(5);
    // The added row has no source row to rescan; the loaded ones do.
    expect(dispatcharrLinkedIndices(withAdded, orders)).toEqual([0, 1]);
  });

  it("offers streams unlinked this session back to their channel", () => {
    const results = channelRows(10, "News One", [{ id: 1 }, { id: 2, status: "dead" }]);
    const channel = getDispatcharrView(results, { 10: [1] })?.byChannelId.get(10);
    if (!channel) throw new Error("missing channel");
    expect(unlinkedStreams(results, channel).map((entry) => entry.ref.streamId)).toEqual([2]);
  });

  it("counts a stream linked to several channels once when judging its provider", () => {
    const results = [1, 2, 3, 4, 5].map((channel) => {
      const row = makeResult(
        channel,
        extinf(channel, 7, 0, 1, `Channel ${channel}`),
        `Channel ${channel}`,
        { status: "dead", error_reason: "HTTP 502" },
      );
      const title = row.extinf_line.lastIndexOf(",");
      return {
        ...row,
        extinf_line: `${row.extinf_line.slice(0, title)} x-dispatcharr-account-id="7"${row.extinf_line.slice(title)}`,
      };
    });
    expect(getDispatcharrView(results, {})?.downAccounts).toEqual([]);
  });

  it("keeps exports from different sources out of channel-first mode", () => {
    const [first] = channelRows(10, "News One", [{ id: 1 }]);
    const [second] = channelRows(10, "Other One", [{ id: 1 }], 1);
    expect(getDispatcharrView([first, { ...second, playlist: "other.m3u8" }], {})).toBeNull();
  });
});
