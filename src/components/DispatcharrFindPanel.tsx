import { listen } from "@tauri-apps/api/event";
import { Check, ChevronRight, Radar, Search, TextSearch, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatCount, t } from "../i18n";
import { translateReason } from "../i18n/reasons";
import {
  type DispatcharrChannelView,
  type DispatcharrView,
  dispatcharrStatusLabel,
  dispatcharrTarget,
  getDispatcharrView,
  isUntestedStatus,
  parseDispatcharrIds,
  unlinkedStreams,
} from "../lib/dispatcharr";
import { linkStreams } from "../lib/dispatcharrEdits";
import { errorToString } from "../lib/errors";
import { isSingleConnectionPlaylist } from "../lib/playback";
import { isScanActive } from "../lib/scanState";
import {
  cancelQuickCheck,
  type DispatcharrCandidate,
  dispatcharrFindStreams,
  dispatcharrProbeStreams,
} from "../lib/tauri";
import type { Channel, ChannelResult } from "../lib/types";
import { useAppStore } from "../store";

const getStore = () => useAppStore.getState();

const PANEL_WIDTH = 440;

/** A stream offered for the channel: a found provider stream, or one the
 *  session unlinked from it. */
interface Candidate {
  streamId: number;
  account: string;
  name: string;
  tag: { kind: "epg" } | { kind: "name"; similarity: number } | { kind: "was" };
  otherCountry: string | null;
  /** What to probe. */
  channel: Channel;
  /** Known result: probed here, or the loaded row's scan result. */
  result: ChannelResult | null;
}

type SearchState =
  | { kind: "loading" }
  | { kind: "failed"; error: string }
  | { kind: "done"; found: DispatcharrCandidate[] };

function candidateOf(found: DispatcharrCandidate): Omit<Candidate, "result"> {
  const ref = parseDispatcharrIds(found.channel.extinf_line);
  return {
    streamId: found.stream_id,
    account: ref?.account ?? t("dispatcharr.provider"),
    name: ref?.streamName ?? found.channel.name,
    tag: found.epg ? { kind: "epg" } : { kind: "name", similarity: found.similarity },
    otherCountry: found.other_country,
    channel: found.channel,
  };
}

function Tag({ tag }: { tag: Candidate["tag"] }) {
  if (tag.kind === "epg")
    return (
      <span className="shrink-0 rounded bg-green-500/15 px-1.5 text-[10.5px] text-green-300">
        {t("dispatcharr.find.epgMatch")}
      </span>
    );
  if (tag.kind === "was")
    return (
      <span className="shrink-0 rounded bg-blue-500/15 px-1.5 text-[10.5px] text-blue-300">
        {t("dispatcharr.find.wasLinked")}
      </span>
    );
  return (
    <span className="shrink-0 rounded bg-btn px-1.5 text-[10.5px] text-text-secondary">
      {t("dispatcharr.find.similarity", { value: formatCount(tag.similarity) })}
    </span>
  );
}

const DOT: Partial<Record<ChannelResult["status"], string>> = {
  alive: "bg-green-500",
  dead: "bg-red-500",
  checking: "bg-blue-400",
};

function Outcome({ result, probing }: { result: ChannelResult | null; probing: boolean }) {
  if (!result)
    return (
      <span className="text-text-tertiary">
        {probing ? t("dispatcharr.find.scanning") : t("dispatcharr.find.outcomeNotScanned")}
      </span>
    );
  if (result.status === "alive")
    return (
      <span className="flex gap-3 tabular-nums text-text-secondary">
        <span>{result.resolution ?? "–"}</span>
        <span>{result.fps ?? "–"}</span>
        <span>{result.video_bitrate?.replace(" kbps", "") ?? "–"}</span>
        <span className={(result.latency_ms ?? 0) < 500 ? "text-green-400" : "text-yellow-400"}>
          {result.latency_ms ?? "–"} ms
        </span>
      </span>
    );
  if (result.status === "dead")
    return <span className="text-red-400">{t("dispatcharr.find.outcomeDead")}</span>;
  if (result.error_reason === "Account busy")
    return <span className="text-text-tertiary">{translateReason(result.error_reason)}</span>;
  return <span className="text-text-tertiary">{dispatcharrStatusLabel(result.status)}</span>;
}

/** Find provider streams for a channel, scan them, and link the working
 *  ones. Takes the report panel's place while open. */
export function DispatcharrFindPanel() {
  const find = useAppStore((s) => s.dispatcharrFind);
  const flatResults = useAppStore((s) => s.flatResults);
  const orders = useAppStore((s) => s.dispatcharrOrders);
  const scanning = useAppStore((s) => isScanActive(s.scanState));
  // Playback uses a provider connection the probes cannot see.
  const playing = useAppStore(
    (s) =>
      isSingleConnectionPlaylist(s.playlist) &&
      (s.playIntentActive || s.castActive || s.externalPlaybackActive),
  );
  const view = useMemo(() => getDispatcharrView(flatResults, orders), [flatResults, orders]);
  const channel = find ? view?.byChannelId.get(find.channelId) : undefined;
  const stuck = useMemo(() => view?.channels.filter((entry) => entry.noWorking) ?? [], [view]);

  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<SearchState>({ kind: "loading" });
  const [account, setAccount] = useState("all");
  const [probed, setProbed] = useState<Map<number, ChannelResult>>(new Map());
  const [probing, setProbing] = useState(false);
  const [picked, setPicked] = useState<number[]>([]);
  const [position, setPosition] = useState<"primary" | "end">("primary");
  const [linking, setLinking] = useState(false);
  const requestRef = useRef<string | null>(null);
  // Searches for another channel, or an earlier query, must not land late.
  const searchRef = useRef(0);
  const channelId = channel?.channelId ?? null;

  const stopProbe = () => {
    if (requestRef.current) void cancelQuickCheck(requestRef.current);
    requestRef.current = null;
    setProbing(false);
  };

  // A new channel starts over with its own name as the search.
  useEffect(() => {
    if (channelId === null) return;
    const target = dispatcharrTarget(getStore().playlist);
    if (!target) return;
    let current = true;
    stopProbe();
    setProbed(new Map());
    setPicked([]);
    setAccount("all");
    setSearch({ kind: "loading" });
    setQuery(channel?.name ?? "");
    const search = ++searchRef.current;
    dispatcharrFindStreams(target, channelId, null)
      .then(
        (found) => current && search === searchRef.current && setSearch({ kind: "done", found }),
      )
      .catch(
        (error) =>
          current &&
          search === searchRef.current &&
          setSearch({ kind: "failed", error: errorToString(error) }),
      );
    return () => {
      current = false;
    };
    // The channel's name only seeds the search box.
  }, [channelId]);

  useEffect(() => stopProbe, []);

  // Playback starting mid-probe takes the connection back.
  useEffect(() => {
    if (playing) stopProbe();
  }, [playing]);

  useEffect(() => {
    const unlisten = listen<{ request_id: string; result: ChannelResult }>(
      "dispatcharr://probe-result",
      (event) => {
        if (event.payload.request_id !== requestRef.current) return;
        const ref = parseDispatcharrIds(event.payload.result.extinf_line);
        if (!ref) return;
        setProbed((previous) => new Map(previous).set(ref.streamId, event.payload.result));
      },
    );
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  if (!find) return null;

  const close = () => {
    stopProbe();
    getStore().setDispatcharrFind(null);
  };

  const frame = (body: React.ReactNode) => (
    <aside
      className="flex h-full shrink-0 flex-col border-s border-border-app bg-panel/70 text-[12px] backdrop-blur-sm"
      style={{ width: `${PANEL_WIDTH}px` }}
    >
      <header className="flex items-center gap-2 border-b border-border-app px-3 py-2.5">
        <h3 className="text-[13px] font-semibold text-text-primary">
          {t("dispatcharr.findStreams")}
        </h3>
        {find.queue && channel && stuck.length > 0 && (
          <span className="ms-auto flex items-center gap-1 text-text-tertiary">
            {t("dispatcharr.find.queueProgress", {
              position: formatCount(Math.max(1, stuck.indexOf(channel) + 1)),
              total: formatCount(stuck.length),
            })}
            <button
              type="button"
              aria-label={t("dispatcharr.find.nextChannel")}
              title={t("dispatcharr.find.nextChannel")}
              onClick={() => {
                const at = stuck.indexOf(channel);
                const next = stuck[(at + 1) % stuck.length];
                if (next) getStore().setDispatcharrFind({ channelId: next.channelId, queue: true });
              }}
              className="rounded bg-btn p-0.5 text-text-primary hover:bg-btn-hover"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </span>
        )}
        <button
          type="button"
          aria-label={t("dispatcharr.find.close")}
          onClick={close}
          className={`${find.queue && channel && stuck.length > 0 ? "" : "ms-auto"} rounded p-0.5 text-text-secondary hover:text-text-primary`}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </header>
      {body}
    </aside>
  );

  if (!channel) {
    return frame(
      <p className="px-3 py-10 text-center text-text-secondary">
        {find.queue ? t("dispatcharr.find.allWorking") : t("dispatcharr.find.notLoaded")}
      </p>,
    );
  }

  const found = search.kind === "done" ? search.found : [];
  const was = unlinkedStreams(flatResults, channel).map<Candidate>((entry) => ({
    streamId: entry.ref.streamId,
    account: entry.ref.account ?? t("dispatcharr.provider"),
    name: entry.ref.streamName ?? entry.result.name,
    tag: { kind: "was" },
    otherCountry: null,
    channel: entry.result,
    result: entry.result.status === "pending" ? null : entry.result,
  }));
  const candidates: Candidate[] = [
    ...was,
    ...found
      .filter((entry) => !was.some((other) => other.streamId === entry.stream_id))
      .map((entry) => ({ ...candidateOf(entry), result: probed.get(entry.stream_id) ?? null })),
  ].map((entry) => ({ ...entry, result: probed.get(entry.streamId) ?? entry.result }));
  const accounts = [...new Set(candidates.map((entry) => entry.account))].sort();
  const shown = candidates.filter((entry) => account === "all" || entry.account === account);
  // An account busy with viewers said nothing about the stream: try again.
  const unprobed = shown.filter(
    (entry) => !entry.result || entry.result.error_reason === "Account busy",
  );
  const pickable = (entry: Candidate) => entry.result?.status === "alive";
  const pickedCandidates = candidates.filter(
    (entry) => picked.includes(entry.streamId) && pickable(entry),
  );
  const alive = channel.streams.filter((entry) => entry.result.status === "alive").length;
  const unscanned = channel.streams.filter((entry) => isUntestedStatus(entry.result.status)).length;
  const scanned = channel.streams.length - unscanned;

  const runSearch = () => {
    const target = dispatcharrTarget(getStore().playlist);
    if (!target) return;
    stopProbe();
    setSearch({ kind: "loading" });
    const search = ++searchRef.current;
    dispatcharrFindStreams(target, channel.channelId, query.trim() || null)
      .then((result) => search === searchRef.current && setSearch({ kind: "done", found: result }))
      .catch(
        (error) =>
          search === searchRef.current &&
          setSearch({ kind: "failed", error: errorToString(error) }),
      );
  };

  const probe = async () => {
    const target = dispatcharrTarget(getStore().playlist);
    if (scanning || playing || unprobed.length === 0 || !target) return;
    const requestId = `find-${channel.channelId}-${Date.now()}`;
    requestRef.current = requestId;
    setProbing(true);
    try {
      await dispatcharrProbeStreams(
        requestId,
        target,
        unprobed.map((entry) => entry.channel),
      );
    } catch {
      // Cancelled, or the panel moved on; results so far stay.
    } finally {
      if (requestRef.current === requestId) {
        requestRef.current = null;
        setProbing(false);
      }
    }
  };

  const link = async (target: DispatcharrChannelView) => {
    if (scanning || pickedCandidates.length === 0) return;
    setLinking(true);
    try {
      const results = pickedCandidates.flatMap((entry) => (entry.result ? [entry.result] : []));
      const linked = await linkStreams(target, results, position);
      if (!linked) return;
      setPicked([]);
      // Working through channels with no working stream: move on once this one works.
      if (find.queue) {
        const at = stuck.indexOf(target);
        const next = [...stuck.slice(at + 1), ...stuck.slice(0, Math.max(0, at))][0];
        // No channel left: the panel says so (no channel has id -1).
        getStore().setDispatcharrFind({ channelId: next?.channelId ?? -1, queue: true });
      }
    } finally {
      setLinking(false);
    }
  };

  return frame(
    <>
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-1.5 text-[13px]">
        <span className="font-semibold text-text-primary">{channel.name}</span>
        {scanned > 0 && (
          <span className={alive > 0 ? "text-text-secondary" : "text-red-400"}>
            {t("dispatcharr.find.aliveOfScanned", {
              alive: formatCount(alive),
              scanned: formatCount(scanned),
            })}
          </span>
        )}
        {unscanned > 0 && (
          <span className="text-text-tertiary">
            {t("dispatcharr.find.notScanned", { count: unscanned })}
          </span>
        )}
        {channel.empty && <span className="text-amber-400">{t("dispatcharr.noStreams")}</span>}
      </div>
      <ol className="mx-3 rounded-md border border-border-app">
        {channel.streams.map((entry, position) => (
          <li
            key={entry.ref.streamId}
            className="flex h-6 items-center gap-2 border-b border-border-subtle px-2 last:border-b-0"
          >
            <span className="w-3 text-text-tertiary tabular-nums">{position + 1}</span>
            <i
              className={`h-1.5 w-1.5 rounded-full ${DOT[entry.result.status] ?? "bg-zinc-500"}`}
            />
            <span className="text-text-primary">
              {entry.ref.account ?? t("dispatcharr.provider")}
            </span>
            <span className="truncate text-text-tertiary">
              {entry.ref.streamName ?? entry.result.name}
            </span>
          </li>
        ))}
      </ol>
      <form
        className="grid grid-cols-[minmax(0,1fr)_130px] gap-2 px-3 pt-3 pb-2"
        onSubmit={(event) => {
          event.preventDefault();
          runSearch();
        }}
      >
        <label className="relative">
          <Search className="absolute start-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-tertiary" />
          <input
            type="search"
            aria-label={t("dispatcharr.find.searchLabel")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            spellCheck={false}
            className="native-field h-7 w-full rounded-md border border-border-app bg-input ps-7 pe-2 text-[12px] text-text-primary focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </label>
        <select
          aria-label={t("dispatcharr.find.accountLabel")}
          value={account}
          onChange={(event) => setAccount(event.target.value)}
          className="native-field h-7 rounded-md border border-border-app bg-input px-2 text-[12px] text-text-primary"
        >
          <option value="all">{t("dispatcharr.find.allAccounts")}</option>
          {accounts.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </form>
      <div className="flex justify-between px-3 py-1 text-[11px] text-text-tertiary">
        <span className="uppercase tracking-[0.06em]">{t("dispatcharr.find.candidates")}</span>
        <span>
          {search.kind === "loading"
            ? t("dispatcharr.find.searching")
            : probing
              ? t("dispatcharr.find.scanning")
              : t("dispatcharr.find.scannedOf", {
                  scanned: formatCount(shown.filter((entry) => entry.result).length),
                  count: shown.length,
                })}
        </span>
      </div>
      <ul className="min-h-0 flex-1 overflow-auto border-t border-border-app">
        {search.kind === "failed" && (
          <li className="px-3 py-6 text-center text-red-400">{search.error}</li>
        )}
        {search.kind === "done" && shown.length === 0 && (
          <li className="px-3 py-6 text-center text-text-secondary">
            {t("dispatcharr.find.noMatches")}
          </li>
        )}
        {shown.map((entry) => {
          const canPick = pickable(entry);
          const isPicked = canPick && picked.includes(entry.streamId);
          return (
            <li key={entry.streamId}>
              <button
                type="button"
                disabled={!canPick}
                aria-pressed={isPicked}
                onClick={() =>
                  setPicked((current) =>
                    current.includes(entry.streamId)
                      ? current.filter((id) => id !== entry.streamId)
                      : [...current, entry.streamId],
                  )
                }
                className={`flex h-10 w-full items-center gap-2 border-b border-border-subtle px-3 text-start ${
                  isPicked ? "bg-blue-500/15" : canPick ? "hover:bg-btn" : ""
                }`}
              >
                <span
                  className={`grid h-3.5 w-3.5 shrink-0 place-items-center rounded-[3px] border ${
                    isPicked
                      ? "border-blue-600 bg-blue-600 text-white"
                      : canPick
                        ? "border-text-tertiary"
                        : "border-border-app opacity-40"
                  }`}
                >
                  {isPicked && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
                </span>
                <i
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    (entry.result && DOT[entry.result.status]) ?? "bg-zinc-500"
                  }`}
                />
                <span className="flex min-w-0 flex-1 flex-col leading-tight">
                  <span className="font-medium text-text-primary">{entry.account}</span>
                  <span className="truncate text-[11.5px] text-text-tertiary">{entry.name}</span>
                </span>
                {entry.otherCountry && (
                  <span
                    title={t("dispatcharr.find.otherCountry")}
                    className="shrink-0 rounded bg-amber-500/15 px-1.5 text-[10.5px] text-amber-300"
                  >
                    {entry.otherCountry}
                  </span>
                )}
                <Tag tag={entry.tag} />
                <span className="w-40 shrink-0 text-end text-[11.5px]">
                  <Outcome result={entry.result} probing={probing} />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <footer className="flex items-center gap-2 border-t border-border-app px-3 py-2.5">
        {pickedCandidates.length === 0 ? (
          <>
            <span className="text-text-secondary">
              {unprobed.length > 0
                ? t("dispatcharr.find.notScanned", { count: unprobed.length })
                : t("dispatcharr.find.pickToLink")}
            </span>
            <button
              type="button"
              disabled={scanning || playing || probing || unprobed.length === 0}
              title={
                scanning
                  ? t("dispatcharr.availableAfterScan")
                  : playing
                    ? t("dispatcharr.find.stopPlaybackFirst")
                    : undefined
              }
              onClick={() => void probe()}
              className="ms-auto inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-2.5 py-1 font-medium text-white hover:bg-blue-500 disabled:opacity-40"
            >
              <Radar className="h-3.5 w-3.5" />
              {probing
                ? t("dispatcharr.find.scanning")
                : t("dispatcharr.find.scanCount", { count: unprobed.length })}
            </button>
          </>
        ) : (
          <>
            <span className="text-text-secondary">
              {t("dispatcharr.find.selected", { count: pickedCandidates.length })}
            </span>
            <select
              aria-label={t("dispatcharr.find.whereToLink")}
              value={position}
              onChange={(event) => setPosition(event.target.value === "end" ? "end" : "primary")}
              className="native-field ms-auto h-7 rounded-md border border-border-app bg-input px-2 text-[12px] text-text-primary"
            >
              <option value="primary">{t("dispatcharr.find.asPrimary")}</option>
              <option value="end">{t("dispatcharr.find.atEnd")}</option>
            </select>
            <button
              type="button"
              disabled={scanning || linking}
              title={scanning ? t("dispatcharr.availableAfterScan") : undefined}
              onClick={() => void link(channel)}
              className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-2.5 py-1 font-medium text-white hover:bg-blue-500 disabled:opacity-40"
            >
              {linking
                ? t("dispatcharr.find.linking")
                : t("dispatcharr.find.linkCount", { count: pickedCandidates.length })}
            </button>
          </>
        )}
      </footer>
    </>,
  );
}

/** Opens Find streams on the first channel with no working stream, then
 *  steps through them. Only there while such channels exist. */
export function DispatcharrFindButton({ view }: { view: DispatcharrView }) {
  const stuck = view.channels.filter((channel) => channel.noWorking);
  const open = useAppStore((s) => s.dispatcharrFind?.queue === true);
  const first = stuck[0];
  if (!first) return null;
  return (
    <button
      type="button"
      title={t("dispatcharr.find.queueButtonTitle")}
      onClick={() => getStore().setDispatcharrFind({ channelId: first.channelId, queue: true })}
      className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border-app px-2.5 text-[12px] text-text-primary hover:bg-btn-hover ${
        open ? "bg-btn-hover" : "bg-btn"
      }`}
    >
      <TextSearch className="h-3.5 w-3.5" />
      {t("dispatcharr.find.queueButton", { count: stuck.length })}
    </button>
  );
}
