import { useEffect, useMemo, useRef, useState } from "react";
import { useFixPreferences } from "../hooks/useFixPreferences";
import { formatCount, t } from "../i18n";
import { type DispatcharrView, isUntestedStatus } from "../lib/dispatcharr";
import { applyFixPlan, planFix } from "../lib/dispatcharrEdits";
import type { ChannelResult } from "../lib/types";

interface DispatcharrFixAllProps {
  view: DispatcharrView;
  /** Primaries of the channels the current filter shows: the fix scope. */
  visiblePrimaries: ChannelResult[];
  /** A filter narrows the scope, so the button says "shown", not "all". */
  filtered: boolean;
  disabled: boolean;
}

/** "Fix all" for the filtered channels, confirmed with counts before writing. */
export function DispatcharrFixAll({
  view,
  visiblePrimaries,
  filtered,
  disabled,
}: DispatcharrFixAllProps) {
  const [open, setOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const preferences = useFixPreferences();
  const plan = useMemo(
    () =>
      planFix(
        view,
        visiblePrimaries.flatMap((primary) => {
          const channel = view.byPrimaryIndex.get(primary.index);
          return channel ? [channel.channelId] : [];
        }),
        preferences,
      ),
    [view, visiblePrimaries, preferences],
  );
  const count = plan.changes.length;
  const moveToEnd = preferences.deadStreams === "move_to_end";
  // Why the button is unavailable. Disabled buttons do not reliably show a
  // tooltip, so the wrapper carries it.
  const unavailableReason = useMemo(() => {
    if (disabled) return t("dispatcharr.availableAfterScan");
    if (count > 0) return undefined;
    const scanned = visiblePrimaries.some((primary) =>
      view.byPrimaryIndex
        .get(primary.index)
        ?.streams.some((entry) => !isUntestedStatus(entry.result.status)),
    );
    return scanned ? t("dispatcharr.fixAll.alreadyInOrder") : t("dispatcharr.fixAll.scanFirst");
  }, [disabled, count, visiblePrimaries, view]);

  // A scan starting while the confirm is open would change the plan under it.
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const handleConfirm = async () => {
    if (disabled) return;
    setApplying(true);
    try {
      await applyFixPlan(plan);
    } finally {
      setApplying(false);
      setOpen(false);
    }
  };

  return (
    <div ref={rootRef} className="relative shrink-0" title={unavailableReason}>
      <button
        type="button"
        disabled={disabled || count === 0 || applying}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={`h-7 rounded-md border border-border-app px-2.5 text-[12px] text-text-primary hover:bg-btn-hover disabled:cursor-not-allowed disabled:opacity-50 ${
          open ? "bg-btn-hover" : "bg-btn"
        }`}
      >
        {applying
          ? t("dispatcharr.fixAll.fixing")
          : filtered
            ? t("dispatcharr.fixAll.fixShown", { count })
            : t("dispatcharr.fixAll.fixAll", { count })}
      </button>
      {open && (
        <div className="macos-popover absolute end-0 top-full z-50 mt-1 w-72 rounded-lg border border-border-app bg-dropdown p-3 text-[12px] text-text-secondary shadow-xl">
          <p className="mb-2 text-[13px] font-semibold text-text-primary">
            {t("dispatcharr.fixAll.confirmTitle", { count })}
          </p>
          <dl className="space-y-1">
            <div className="flex justify-between">
              <dt>{t("dispatcharr.fixAll.reordered")}</dt>
              <dd className="text-text-primary tabular-nums">
                {t("common.channels", { count: plan.reordered })}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt>
                {moveToEnd
                  ? t("dispatcharr.fixAll.deadMovedToEnd")
                  : t("dispatcharr.fixAll.deadRemoved")}
              </dt>
              <dd className={`tabular-nums ${moveToEnd ? "text-text-primary" : "text-red-400"}`}>
                {formatCount(plan.dead)}
              </dd>
            </div>
            {preferences.lowQualityAsDead && (
              <div className="flex justify-between">
                <dt>
                  {moveToEnd
                    ? t("dispatcharr.fixAll.lowQualityMovedToEnd")
                    : t("dispatcharr.fixAll.lowQualityRemoved")}
                </dt>
                <dd className={`tabular-nums ${moveToEnd ? "text-text-primary" : "text-red-400"}`}>
                  {formatCount(plan.lowQuality)}
                </dd>
              </div>
            )}
            {plan.skippedAllDead > 0 && (
              <div className="flex justify-between">
                <dt>{t("dispatcharr.fixAll.skippedAllDead")}</dt>
                <dd className="text-yellow-400 tabular-nums">
                  {t("common.channels", { count: plan.skippedAllDead })}
                </dd>
              </div>
            )}
          </dl>
          <p className="mt-2 text-text-tertiary">{t("dispatcharr.fixAll.writesNow")}</p>
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md bg-btn px-2.5 py-1 text-text-primary hover:bg-btn-hover"
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              disabled={applying || disabled}
              onClick={() => void handleConfirm()}
              className="rounded-md bg-blue-600 px-2.5 py-1 font-medium text-white hover:bg-blue-500 disabled:opacity-50"
            >
              {applying
                ? t("dispatcharr.fixAll.fixing")
                : t("dispatcharr.fixAll.confirm", { count })}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
