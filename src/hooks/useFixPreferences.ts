import { useMemo } from "react";
import { type FixPreferences, fixPreferencesFrom } from "../lib/dispatcharr";
import { useAppStore } from "../store";

/** Fix order preferences from settings, stable while they are unchanged. */
export function useFixPreferences(): FixPreferences {
  const rankOrder = useAppStore((s) => s.settings.dispatcharr_rank_order);
  const deadStreams = useAppStore((s) => s.settings.dispatcharr_dead_streams);
  const lowQualityAsDead = useAppStore((s) => s.settings.dispatcharr_low_quality_as_dead);
  return useMemo(
    () =>
      fixPreferencesFrom({
        dispatcharr_rank_order: rankOrder,
        dispatcharr_dead_streams: deadStreams,
        dispatcharr_low_quality_as_dead: lowQualityAsDead,
      }),
    [rankOrder, deadStreams, lowQualityAsDead],
  );
}
