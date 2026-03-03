import {
  HapticFeedbackPattern,
  PerformanceTime,
  isSupported,
  perform,
} from "tauri-plugin-macos-haptics-api";

let supportChecked = false;
let supportCached = false;

async function canUseHaptics(): Promise<boolean> {
  if (supportChecked) {
    return supportCached;
  }

  if (!navigator.platform.toUpperCase().includes("MAC")) {
    supportChecked = true;
    supportCached = false;
    return false;
  }

  supportCached = await isSupported();
  supportChecked = true;
  return supportCached;
}

export async function triggerHaptic(
  pattern: HapticFeedbackPattern = HapticFeedbackPattern.Generic,
  performanceTime: PerformanceTime = PerformanceTime.Now,
): Promise<void> {
  if (!(await canUseHaptics())) {
    return;
  }

  await perform(pattern, performanceTime);
}

export { HapticFeedbackPattern, PerformanceTime };
