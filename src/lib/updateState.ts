/** Types and pure presentation logic for the in-app updater. The effectful
 *  parts (IPC, listeners, cooldowns) live in `hooks/useUpdateCheck.ts`. */

import { t } from "../i18n";
import type { UpdateInstallMode } from "./types";

export type { UpdateInstallKind, UpdateInstallMode } from "./types";

export interface UpdateNotice {
  version: string;
  notes: string | null;
  installMode: UpdateInstallMode;
}

export type UpdatePhase = "idle" | "checking" | "installing";

export function isManualInstall(mode: UpdateInstallMode): boolean {
  return mode.kind === "manual";
}

/** Label for the banner's primary action. Manual installs use the label the
 *  backend supplied, since only it knows which package manager owns this copy. */
export function updateActionLabel(notice: UpdateNotice, phase: UpdatePhase): string {
  if (phase === "installing") return t("banners.update.installing");
  if (isManualInstall(notice.installMode)) {
    return notice.installMode.buttonLabel ?? t("banners.update.howToUpdate");
  }
  return t("banners.update.install", { version: notice.version });
}

/** Banner text. Manual installs append the package-manager instructions,
 *  because for them the action only opens a page. */
export function updateBannerMessage(notice: UpdateNotice, currentVersion: string): string {
  const base = currentVersion
    ? t("banners.update.availableWithCurrent", {
        version: notice.version,
        current: currentVersion,
      })
    : t("banners.update.available", { version: notice.version });
  const instructions = notice.installMode.instructions;
  return instructions ? `${base} ${instructions}` : base;
}

/** Confirmation shown before an install replaces the running app. */
export function updateConfirmMessage(notice: UpdateNotice): string {
  return isManualInstall(notice.installMode)
    ? t("banners.update.confirmManual", { version: notice.version })
    : t("banners.update.confirmInstall", { version: notice.version });
}

/** Trims a backend error into a single line suitable for the banner. */
export function updateFailureDetail(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, 240);
}
