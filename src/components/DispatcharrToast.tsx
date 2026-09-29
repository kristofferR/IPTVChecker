import { X } from "lucide-react";
import { useState } from "react";
import { undoChannels } from "../lib/dispatcharrEdits";
import { useAppStore } from "../store";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** Outcome of a bulk fix. Stays until dismissed so Undo all remains reachable. */
export function DispatcharrToast() {
  const toast = useAppStore((s) => s.dispatcharrToast);
  const setToast = useAppStore((s) => s.setDispatcharrToast);
  const [undoing, setUndoing] = useState(false);
  if (!toast) return null;

  const handleUndoAll = async () => {
    setUndoing(true);
    try {
      await undoChannels(toast.channelIds);
      setToast(null);
    } finally {
      setUndoing(false);
    }
  };

  return (
    <div
      role="status"
      className="absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-border-app bg-dropdown px-4 py-2 text-[12px] text-text-primary shadow-xl"
    >
      <span>
        {plural(toast.fixed, "channel")} fixed
        {toast.removed > 0 && ` · ${plural(toast.removed, "dead stream")} removed`}
      </span>
      {toast.failed > 0 && <span className="text-red-400">{toast.failed} failed</span>}
      {toast.channelIds.length > 0 && (
        <button
          type="button"
          disabled={undoing}
          onClick={() => void handleUndoAll()}
          className="text-blue-400 hover:text-blue-300 disabled:opacity-50"
        >
          {undoing ? "Undoing..." : "Undo all"}
        </button>
      )}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => setToast(null)}
        className="rounded p-0.5 text-text-tertiary hover:text-text-primary"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
