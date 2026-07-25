/** Types and pure presentation logic for the in-app updater. The effectful
 *  parts (IPC, listeners, cooldowns) live in `hooks/useUpdateCheck.ts`. */

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
  if (phase === "installing") return "Installing…";
  if (isManualInstall(notice.installMode)) {
    return notice.installMode.buttonLabel ?? "How to update";
  }
  return `Install v${notice.version}`;
}

/** Banner text. Manual installs append the package-manager instructions,
 *  because for them the action only opens a page. */
export function updateBannerMessage(notice: UpdateNotice, currentVersion: string): string {
  const current = currentVersion ? ` (current v${currentVersion})` : "";
  const base = `Update available: v${notice.version}${current}.`;
  const instructions = notice.installMode.instructions;
  return instructions ? `${base} ${instructions}` : base;
}

/** Confirmation shown before an install replaces the running app. */
export function updateConfirmMessage(notice: UpdateNotice): string {
  return isManualInstall(notice.installMode)
    ? `IPTV Checker ${notice.version} is available. Open the update instructions?`
    : `Install IPTV Checker ${notice.version} now? The app will restart.`;
}

/** Trims a backend error into a single line suitable for the banner. */
export function updateFailureDetail(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, 240);
}
