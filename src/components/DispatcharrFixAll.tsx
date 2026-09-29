import { useEffect, useMemo, useRef, useState } from "react";
import type { DispatcharrView } from "../lib/dispatcharr";
import { applyFixPlan, planFix } from "../lib/dispatcharrEdits";
import type { ChannelResult } from "../lib/types";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

interface DispatcharrFixAllProps {
  view: DispatcharrView;
  /** Primaries of the channels the current filter shows: the fix scope. */
  visiblePrimaries: ChannelResult[];
  disabled: boolean;
}

/** "Fix all" for the filtered channels, confirmed with counts before writing. */
export function DispatcharrFixAll({ view, visiblePrimaries, disabled }: DispatcharrFixAllProps) {
  const [open, setOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const plan = useMemo(
    () =>
      planFix(
        view,
        visiblePrimaries.flatMap((primary) => {
          const channel = view.byPrimaryIndex.get(primary.index);
          return channel ? [channel.channelId] : [];
        }),
      ),
    [view, visiblePrimaries],
  );
  const count = plan.changes.length;

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
    setApplying(true);
    try {
      await applyFixPlan(plan);
    } finally {
      setApplying(false);
      setOpen(false);
    }
  };

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        disabled={disabled || count === 0 || applying}
        aria-expanded={open}
        title={disabled ? "Available when the scan finishes" : undefined}
        onClick={() => setOpen((value) => !value)}
        className={`h-7 rounded-md border border-border-app px-2.5 text-[12px] text-text-primary hover:bg-btn-hover disabled:cursor-not-allowed disabled:opacity-50 ${
          open ? "bg-btn-hover" : "bg-btn"
        }`}
      >
        {applying ? "Fixing..." : `Fix all (${count})`}
      </button>
      {open && (
        <div className="macos-popover absolute right-0 top-full z-50 mt-1 w-72 rounded-lg border border-border-app bg-dropdown p-3 text-[12px] text-text-secondary shadow-xl">
          <p className="mb-2 text-[13px] font-semibold text-text-primary">
            Fix {plural(count, "channel")}?
          </p>
          <dl className="space-y-1">
            <div className="flex justify-between">
              <dt>Reordered</dt>
              <dd className="text-text-primary tabular-nums">
                {plural(plan.reordered, "channel")}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt>Dead streams removed</dt>
              <dd className="text-red-400 tabular-nums">{plan.removed}</dd>
            </div>
            {plan.skippedAllDead > 0 && (
              <div className="flex justify-between">
                <dt>Skipped, all streams dead</dt>
                <dd className="text-yellow-400 tabular-nums">
                  {plural(plan.skippedAllDead, "channel")}
                </dd>
              </div>
            )}
          </dl>
          <p className="mt-2 text-text-tertiary">
            Writes to Dispatcharr now. Undo restores the previous order.
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md bg-btn px-2.5 py-1 text-text-primary hover:bg-btn-hover"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={applying}
              onClick={() => void handleConfirm()}
              className="rounded-md bg-blue-600 px-2.5 py-1 font-medium text-white hover:bg-blue-500 disabled:opacity-50"
            >
              {applying ? "Fixing..." : `Fix ${plural(count, "channel")}`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
