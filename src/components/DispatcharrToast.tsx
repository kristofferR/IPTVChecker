import { X } from "lucide-react";
import { useState } from "react";
import { t } from "../i18n";
import { reverseChanges } from "../lib/dispatcharrEdits";
import { isScanActive } from "../lib/scanState";
import { useAppStore } from "../store";

const getStore = () => useAppStore.getState();

/** Outcome of a bulk fix. Stays until dismissed so Undo all remains reachable. */
export function DispatcharrToast() {
  const toast = useAppStore((s) => s.dispatcharrToast);
  const setToast = useAppStore((s) => s.setDispatcharrToast);
  // Like every other edit, undo waits for the scan it would invalidate.
  const scanning = useAppStore((s) => isScanActive(s.scanState));
  const [undoing, setUndoing] = useState(false);
  if (!toast) return null;

  const handleUndoAll = async () => {
    if (isScanActive(getStore().scanState)) return;
    setUndoing(true);
    try {
      const { failed } = await reverseChanges(toast.changes);
      // A newer bulk fix may have replaced this toast while undo ran.
      if (getStore().dispatcharrToast !== toast) return;
      if (failed === 0) {
        setToast(null);
      } else {
        // Failed channels show their error inline; keep them undoable here.
        const orders = getStore().dispatcharrOrders;
        const remaining = toast.changes.filter((change) => {
          const current = orders[change.channelId];
          return !current || current.join() !== change.from.join();
        });
        setToast(remaining.length === 0 ? null : { ...toast, changes: remaining });
      }
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
        {t("dispatcharr.toast.fixed", { count: toast.fixed })}
        {toast.removed > 0 &&
          ` · ${t("dispatcharr.toast.streamsRemoved", { count: toast.removed })}`}
      </span>
      {toast.failed > 0 && (
        <span className="text-red-400">
          {t("dispatcharr.toast.failed", { count: toast.failed })}
        </span>
      )}
      {toast.changes.length > 0 && (
        <button
          type="button"
          disabled={undoing || scanning}
          title={scanning ? t("dispatcharr.availableAfterScan") : undefined}
          onClick={() => void handleUndoAll()}
          className="text-blue-400 hover:text-blue-300 disabled:opacity-50"
        >
          {undoing ? t("dispatcharr.toast.undoing") : t("dispatcharr.toast.undoAll")}
        </button>
      )}
      <button
        type="button"
        aria-label={t("common.dismiss")}
        onClick={() => setToast(null)}
        className="rounded p-0.5 text-text-tertiary hover:text-text-primary"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
