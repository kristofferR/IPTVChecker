// The types that cross the IPC boundary are generated from the Rust
// definitions into ./bindings (`bun run bindings`); never edit them by hand.
// Frontend-only types follow the re-exports.

export type { AppSettings } from "./bindings/AppSettings";
export type { ArchiveDownloadProgress } from "./bindings/ArchiveDownloadProgress";
export type { ArchiveDownloadRequest } from "./bindings/ArchiveDownloadRequest";
export type { CandidateProbeEvent } from "./bindings/CandidateProbeEvent";
export type { CastMediaRequest } from "./bindings/CastMediaRequest";
export type { CastSession } from "./bindings/CastSession";
export type { CastSessionState } from "./bindings/CastSessionState";
export type { CastStreamKind } from "./bindings/CastStreamKind";
export type { Channel } from "./bindings/Channel";
export type { ChannelLogoSize } from "./bindings/ChannelLogoSize";
export type { ChannelResult } from "./bindings/ChannelResult";
export type { ChannelStatus } from "./bindings/ChannelStatus";
export type { ChromecastDevice } from "./bindings/ChromecastDevice";
export type { ContentType } from "./bindings/ContentType";
export type { DiskSpaceInfo } from "./bindings/DiskSpaceInfo";
export type { DiskSpaceTier } from "./bindings/DiskSpaceTier";
export type { DispatcharrCandidate } from "./bindings/DispatcharrCandidate";
export type { DispatcharrDeadStreams } from "./bindings/DispatcharrDeadStreams";
export type { DispatcharrItemFailure } from "./bindings/DispatcharrItemFailure";
export type { DispatcharrOpenRequest } from "./bindings/DispatcharrOpenRequest";
export type { DispatcharrRankSignal } from "./bindings/DispatcharrRankSignal";
export type { DispatcharrStatsPushReport } from "./bindings/DispatcharrStatsPushReport";
export type { EpgLoadSummary } from "./bindings/EpgLoadSummary";
export type { EpgProgramme } from "./bindings/EpgProgramme";
export type { PlaylistLoadProgress } from "./bindings/PlaylistLoadProgress";
export type { PlaylistPreview } from "./bindings/PlaylistPreview";
export type { PlaylistScore } from "./bindings/PlaylistScore";
export type { RecentPlaylistEntry } from "./bindings/RecentPlaylistEntry";
export type { RecentPlaylistKind } from "./bindings/RecentPlaylistKind";
export type { RenamePlaylistSourceInput } from "./bindings/RenamePlaylistSourceInput";
export type { RenameSourceDescriptor } from "./bindings/RenameSourceDescriptor";
export type { RetryBackoff } from "./bindings/RetryBackoff";
export type { SampleClip } from "./bindings/SampleClip";
export type { SampleClipFormat } from "./bindings/SampleClipFormat";
export type { SavedPlaylistDraft } from "./bindings/SavedPlaylistDraft";
export type { SavedPlaylistEntry } from "./bindings/SavedPlaylistEntry";
export type { SavedPlaylistKind } from "./bindings/SavedPlaylistKind";
export type { SavedPlaylistUpsertResult } from "./bindings/SavedPlaylistUpsertResult";
export type { ScanClientCapabilities } from "./bindings/ScanClientCapabilities";
export type { ScanConfig } from "./bindings/ScanConfig";
export type { ScanErrorPayload } from "./bindings/ScanErrorPayload";
export type { ScanEvent } from "./bindings/ScanEvent";
export type { ScanHistoryDiff } from "./bindings/ScanHistoryDiff";
export type { ScanHistoryItem } from "./bindings/ScanHistoryItem";
export type { ScanPresetCollection } from "./bindings/ScanPresetCollection";
export type { ScanPresetConfig } from "./bindings/ScanPresetConfig";
export type { ScanProgress } from "./bindings/ScanProgress";
export type { ScanResultBatchPayload } from "./bindings/ScanResultBatchPayload";
export type { ScanSettingsPreset } from "./bindings/ScanSettingsPreset";
export type { ScanSummary } from "./bindings/ScanSummary";
export type { ScreenshotCacheStats } from "./bindings/ScreenshotCacheStats";
export type { ScreenshotFormat } from "./bindings/ScreenshotFormat";
export type { StalkerOpenRequest } from "./bindings/StalkerOpenRequest";
export type { StreamingProxy } from "./bindings/StreamingProxy";
export type { ThemePreference } from "./bindings/ThemePreference";
export type { TitleBarPreference } from "./bindings/TitleBarPreference";
export type { UiLocale } from "./bindings/UiLocale";
export type { UpdateCheckResult } from "./bindings/UpdateCheckResult";
export type { UpdateInstallKind } from "./bindings/UpdateInstallKind";
export type { UpdateInstallMode } from "./bindings/UpdateInstallMode";
export type { XtreamAccountInfo } from "./bindings/XtreamAccountInfo";
export type { XtreamAccountState } from "./bindings/XtreamAccountState";
export type { XtreamArchiveChannelUpdate } from "./bindings/XtreamArchiveChannelUpdate";
export type { XtreamArchiveEnrichment } from "./bindings/XtreamArchiveEnrichment";
export type { XtreamChannelProbe } from "./bindings/XtreamChannelProbe";
export type { XtreamOpenRequest } from "./bindings/XtreamOpenRequest";
export type { XtreamServerTestReport } from "./bindings/XtreamServerTestReport";
export type { XtreamServerTestResult } from "./bindings/XtreamServerTestResult";

import type { DispatcharrOpenRequest } from "./bindings/DispatcharrOpenRequest";
import type { StalkerOpenRequest } from "./bindings/StalkerOpenRequest";
import type { XtreamOpenRequest } from "./bindings/XtreamOpenRequest";

export type CurrentSourceDescriptor =
  | {
      kind: "path";
      path: string;
    }
  | {
      kind: "url";
      url: string;
    }
  | {
      kind: "saved";
      id: string;
    }
  | ({
      kind: "xtream";
    } & XtreamOpenRequest)
  | ({
      kind: "stalker";
    } & StalkerOpenRequest)
  | ({
      kind: "dispatcharr";
    } & DispatcharrOpenRequest);

export interface XtreamRecentSource {
  server: string;
  username: string;
  password?: string;
}

export interface DispatcharrTarget {
  sourceIdentity: string;
  connection: string;
}
