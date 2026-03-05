import type { ChannelLogoSize } from "./types";

export function channelLogoPixels(size: ChannelLogoSize): number {
  if (size === "huge") return 48;
  if (size === "large") return 36;
  if (size === "medium") return 24;
  return 16;
}

export function channelRowHeightPixels(size: ChannelLogoSize): number {
  if (size === "huge") return 60;
  if (size === "large") return 48;
  if (size === "medium") return 38;
  return 34;
}
