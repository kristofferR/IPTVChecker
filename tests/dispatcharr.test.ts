import { describe, expect, it } from "bun:test";
import {
  dispatcharrChannelRows,
  dispatcharrLinkedIndices,
  dispatcharrServerOfProxyPlaylist,
  getDispatcharrView,
  normalizeDispatcharrServer,
  parseDispatcharrIds,
  proposeFixOrder,
} from "../src/lib/dispatcharr";
import { planFix } from "../src/lib/dispatcharrEdits";
import type { ChannelResult, PlaylistPreview } from "../src/lib/types";

function extinf(channel: number, stream: number, order: number, count: number, name: string) {
  return `#EXTINF:-1 group-title="News" x-dispatcharr-channel-id="${channel}" x-dispatcharr-stream-id="${stream}" x-dispatcharr-stream-order="${order}" x-dispatcharr-stream-count="${count}" x-dispatcharr-account="Provider \\"A\\"",${name}`;
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
  streams: Array<{ id: number; status?: ChannelResult["status"]; height?: number }>,
  firstIndex = 0,
): ChannelResult[] {
  return streams.map((stream, order) => {
    const title =
      streams.length > 1 ? `${name} [${order + 1}/${streams.length}] Feed ${stream.id}` : name;
    return makeResult(
      firstIndex + order,
      extinf(channel, stream.id, order, streams.length, title),
      title,
      { status: stream.status ?? "alive", height: stream.height ?? null },
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
      channelStreams: null,
    });
    expect(parseDispatcharrIds('#EXTINF:-1 tvg-id="a",Plain')).toBeNull();
  });

  it("builds one channel per Dispatcharr channel, in failover order", () => {
    const results = [
      ...channelRows(10, "News One", [{ id: 101, status: "dead" }, { id: 102 }]),
      ...channelRows(20, "Sports 2", [{ id: 201 }], 2),
      makeResult(3, "#EXTINF:-1,Plain", "Plain"),
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
  });

  it("applies written orders: removed streams disappear and the primary follows", () => {
    const results = channelRows(10, "News One", [{ id: 101, status: "dead" }, { id: 102 }]);
    const news = getDispatcharrView(results, { 10: [102] })?.byChannelId.get(10);
    expect(news?.streams.map((entry) => entry.ref.streamId)).toEqual([102]);
    expect(news?.primary.index).toBe(1);
    expect(news?.primaryDead).toBe(false);
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
});
