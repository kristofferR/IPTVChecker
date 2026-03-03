import { useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

export function useScreenshot() {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const screenshotUrl = selectedPath ? convertFileSrc(selectedPath) : null;

  return { selectedPath, setSelectedPath, screenshotUrl };
}
