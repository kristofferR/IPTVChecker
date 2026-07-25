import { describe, expect, it } from "bun:test";
import {
  isManualInstall,
  type UpdateInstallMode,
  type UpdateNotice,
  updateActionLabel,
  updateBannerMessage,
  updateConfirmMessage,
  updateFailureDetail,
} from "../src/lib/updateState";

const builtIn: UpdateInstallMode = {
  kind: "built-in",
  buttonLabel: null,
  instructions: null,
};

const aur: UpdateInstallMode = {
  kind: "manual",
  buttonLabel: "Open IPTV Checker on AUR",
  instructions: "Run paru -S iptv-checker-gui to update.",
};

function notice(installMode: UpdateInstallMode): UpdateNotice {
  return { version: "1.7.0", notes: null, installMode };
}

describe("updateActionLabel", () => {
  it("offers to install directly when the app can replace itself", () => {
    expect(updateActionLabel(notice(builtIn), "idle")).toBe("Install v1.7.0");
  });

  it("uses the backend's label for package-manager-owned installs", () => {
    // Only the backend knows which package manager owns this copy, so the
    // label must not be reconstructed in the UI.
    expect(updateActionLabel(notice(aur), "idle")).toBe("Open IPTV Checker on AUR");
  });

  it("falls back when a manual mode arrives without a label", () => {
    const unlabelled: UpdateInstallMode = { kind: "manual", buttonLabel: null, instructions: null };
    expect(updateActionLabel(notice(unlabelled), "idle")).toBe("How to update");
  });

  it("reports progress while installing regardless of mode", () => {
    expect(updateActionLabel(notice(builtIn), "installing")).toBe("Installing…");
    expect(updateActionLabel(notice(aur), "installing")).toBe("Installing…");
  });
});

describe("updateBannerMessage", () => {
  it("names both versions when the current one is known", () => {
    expect(updateBannerMessage(notice(builtIn), "1.6.0")).toBe(
      "Update available: v1.7.0 (current v1.6.0).",
    );
  });

  it("omits the current version before it has loaded", () => {
    expect(updateBannerMessage(notice(builtIn), "")).toBe("Update available: v1.7.0.");
  });

  it("appends package-manager instructions, since the action only opens a page", () => {
    expect(updateBannerMessage(notice(aur), "1.6.0")).toBe(
      "Update available: v1.7.0 (current v1.6.0). Run paru -S iptv-checker-gui to update.",
    );
  });
});

describe("updateConfirmMessage", () => {
  it("warns about the restart for built-in installs", () => {
    expect(updateConfirmMessage(notice(builtIn))).toContain("restart");
  });

  it("does not promise a restart when it only opens a page", () => {
    expect(updateConfirmMessage(notice(aur))).not.toContain("restart");
  });
});

describe("isManualInstall", () => {
  it("distinguishes the two modes", () => {
    expect(isManualInstall(builtIn)).toBe(false);
    expect(isManualInstall(aur)).toBe(true);
  });
});

describe("updateFailureDetail", () => {
  it("collapses multi-line backend errors into one line", () => {
    expect(updateFailureDetail("update check failed:\n  network\tdown  ")).toBe(
      "update check failed: network down",
    );
  });

  it("caps runaway error text so the banner stays readable", () => {
    expect(updateFailureDetail("x".repeat(400))).toHaveLength(240);
  });
});
