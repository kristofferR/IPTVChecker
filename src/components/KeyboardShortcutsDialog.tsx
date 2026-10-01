import { X } from "lucide-react";
import { useEffect } from "react";
import { t } from "../i18n";

interface ShortcutEntry {
  keys: string;
  action: string;
}

interface ShortcutSection {
  title: string;
  entries: ShortcutEntry[];
}

function buildSections(modifierLabel: string): ShortcutSection[] {
  return [
    {
      title: t("shortcuts.sections.general"),
      entries: [
        { keys: `${modifierLabel} + O`, action: t("shortcuts.actions.openPlaylist") },
        { keys: `${modifierLabel} + ,`, action: t("shortcuts.actions.openSettings") },
        { keys: `${modifierLabel} + /`, action: t("shortcuts.actions.openShortcuts") },
        { keys: `Alt + ${modifierLabel} + L`, action: t("shortcuts.actions.openLog") },
        { keys: "Escape", action: t("shortcuts.actions.closeOverlays") },
      ],
    },
    {
      title: t("shortcuts.sections.tableNavigation"),
      entries: [
        { keys: "Arrow Up / Down", action: t("shortcuts.actions.moveRowFocus") },
        { keys: "Space", action: t("shortcuts.actions.toggleLightbox") },
        { keys: t("shortcuts.gestures.doubleClick"), action: t("shortcuts.actions.openInPlayer") },
      ],
    },
    {
      title: t("shortcuts.sections.selection"),
      entries: [
        { keys: t("shortcuts.gestures.click"), action: t("shortcuts.actions.selectSingle") },
        { keys: t("shortcuts.gestures.shiftClick"), action: t("shortcuts.actions.selectRange") },
        {
          keys: t("shortcuts.gestures.modifierClick", { modifier: modifierLabel }),
          action: t("shortcuts.actions.toggleRowSelection"),
        },
        { keys: `${modifierLabel} + A`, action: t("shortcuts.actions.selectAllVisible") },
      ],
    },
    {
      title: t("shortcuts.sections.scanPlayback"),
      entries: [
        { keys: "S", action: t("shortcuts.actions.toggleScan") },
        { keys: t("shortcuts.gestures.contextMenu"), action: t("shortcuts.actions.scanSelected") },
        {
          keys: t("shortcuts.gestures.doubleClickRow"),
          action: t("shortcuts.actions.openInDefaultPlayer"),
        },
      ],
    },
  ];
}

interface KeyboardShortcutsDialogProps {
  modifierLabel: "Cmd" | "Ctrl";
  onClose: () => void;
}

export default function KeyboardShortcutsDialog({
  modifierLabel,
  onClose,
}: KeyboardShortcutsDialogProps) {
  const sections = buildSections(modifierLabel);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t("shortcuts.dialogLabel")}
    >
      <div className="absolute inset-0 bg-black/45" onClick={onClose} />
      <div className="relative w-full max-w-3xl rounded-2xl border border-border-app bg-overlay shadow-2xl">
        <div className="flex items-start justify-between px-6 pt-5 pb-4 border-b border-border-app">
          <div>
            <p className="text-[11px] uppercase tracking-[0.08em] text-text-tertiary mb-1">
              {t("shortcuts.eyebrow")}
            </p>
            <h2 className="text-[18px] font-semibold text-text-primary">{t("shortcuts.title")}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("shortcuts.close")}
            className="p-1.5 rounded-md hover:bg-btn-hover transition-colors"
          >
            <X className="w-[18px] h-[18px]" />
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 p-5 max-h-[75vh] overflow-y-auto">
          {sections.map((section) => (
            <section
              key={section.title}
              className="rounded-xl border border-border-subtle bg-panel-subtle p-3"
            >
              <h3 className="text-[12px] font-semibold uppercase tracking-[0.04em] text-text-tertiary mb-2">
                {section.title}
              </h3>
              <ul className="space-y-1.5">
                {section.entries.map((entry) => (
                  <li
                    key={`${section.title}:${entry.keys}:${entry.action}`}
                    className="flex items-center justify-between gap-3 text-[13px]"
                  >
                    <span className="text-text-primary">{entry.action}</span>
                    {/* Key combos keep their order; translated gestures read in their own direction. */}
                    <kbd
                      dir="auto"
                      className="px-2 py-0.5 rounded border border-border-app bg-panel text-text-secondary text-[11px] whitespace-nowrap"
                    >
                      {entry.keys}
                    </kbd>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
