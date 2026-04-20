import { getScreenshotErrorReason } from "./channelResults";
import { isScanActive, type ScanState } from "./scanState";
import type { ChannelResult } from "./types";

type ThumbnailStateResult = Pick<
  ChannelResult,
  "status" | "screenshot_path" | "screenshot_error_reason"
>;

export interface ThumbnailDisplayStateInput {
  result: ThumbnailStateResult;
  screenshotUrl: string | null;
  screenshotLoading: boolean;
  screenshotLoadError: boolean;
  screenshotsEnabled: boolean;
  scanState: ScanState;
}

export interface ThumbnailDisplayState {
  waitingForScanResult: boolean;
  showUnscannedPlaceholder: boolean;
  showQuickCheckSpinner: boolean;
  showLoadingPlaceholder: boolean;
  showStoredScreenshotLoadError: boolean;
  showCaptureError: boolean;
  showDrmPlaceholder: boolean;
  showNoThumbnailCaptured: boolean;
  showScreenshotsDisabled: boolean;
  screenshotErrorReason: string | null;
}

export function getThumbnailDisplayState(
  input: ThumbnailDisplayStateInput,
): ThumbnailDisplayState {
  const {
    result,
    screenshotUrl,
    screenshotLoading,
    screenshotLoadError,
    screenshotsEnabled,
    scanState,
  } = input;

  const scanActive = isScanActive(scanState);
  const waitingForScanResult =
    scanActive && (result.status === "pending" || result.status === "checking");
  const showUnscannedPlaceholder = !scanActive && result.status === "pending";
  const showQuickCheckSpinner = !scanActive && result.status === "checking";
  const loadingStoredScreenshot =
    screenshotLoading || (!!result.screenshot_path && !screenshotUrl && !screenshotLoadError);
  const showLoadingPlaceholder =
    showQuickCheckSpinner ||
    (screenshotsEnabled && (waitingForScanResult || loadingStoredScreenshot));
  const showStoredScreenshotLoadError =
    screenshotsEnabled &&
    !showLoadingPlaceholder &&
    !screenshotUrl &&
    !!result.screenshot_path &&
    screenshotLoadError;
  const screenshotErrorReason = getScreenshotErrorReason(result);
  const showCaptureError =
    screenshotsEnabled &&
    !showLoadingPlaceholder &&
    !showStoredScreenshotLoadError &&
    !screenshotUrl &&
    !result.screenshot_path &&
    !!screenshotErrorReason;
  const showDrmPlaceholder =
    result.status === "drm" &&
    !screenshotUrl &&
    !showLoadingPlaceholder &&
    !showStoredScreenshotLoadError &&
    !showCaptureError;
  const showNoThumbnailCaptured =
    screenshotsEnabled &&
    !showLoadingPlaceholder &&
    !showStoredScreenshotLoadError &&
    !showCaptureError &&
    !screenshotUrl &&
    result.status === "alive" &&
    !result.screenshot_path;
  const showScreenshotsDisabled =
    !screenshotsEnabled &&
    result.status === "alive" &&
    !screenshotUrl;

  return {
    waitingForScanResult,
    showUnscannedPlaceholder,
    showQuickCheckSpinner,
    showLoadingPlaceholder,
    showStoredScreenshotLoadError,
    showCaptureError,
    showDrmPlaceholder,
    showNoThumbnailCaptured,
    showScreenshotsDisabled,
    screenshotErrorReason,
  };
}
