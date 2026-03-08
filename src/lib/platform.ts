import { platform } from "@tauri-apps/plugin-os";

export type Platform = "macos" | "windows" | "linux";

export function inferPlatformFromNavigator(): Platform {
  const platformName = navigator.platform.toLowerCase();
  if (platformName.includes("mac")) return "macos";
  if (platformName.includes("win")) return "windows";
  return "linux";
}

export async function detectPlatform(): Promise<Platform> {
  const p = await platform();
  if (p === "macos") return "macos";
  if (p === "windows") return "windows";
  return "linux";
}
