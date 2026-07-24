import { resultAtIndex } from "../hooks/useScan.helpers";
import type { ChannelResult } from "../lib/types";
import type { AppStore } from "./types";

export { useAppStore } from "./store";
export type { AppStore } from "./types";

/** The scan result for a channel index, or null if it has not been checked
 *  yet. Results live only in `flatResults`; `resultPositions` says where. */
export function selectResultByIndex(state: AppStore, index: number): ChannelResult | null {
  return resultAtIndex({ flatResults: state.flatResults, positions: state.resultPositions }, index);
}
