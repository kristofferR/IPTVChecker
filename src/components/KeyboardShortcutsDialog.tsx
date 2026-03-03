import { useEffect } from "react";
import { X } from "lucide-react";

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
      title: "General",
      entries: [
        { keys: `${modifierLabel} + O`, action: "Open playlist" },
        { keys: `${modifierLabel} + ,`, action: "Open settings" },
        { keys: `${modifierLabel} + /`, action: "Open this shortcuts dialog" },
        { keys: "Escape", action: "Close open dialogs and overlays" },
      ],
    },
    {
      title: "Table Navigation",
      entries: [
        { keys: "Arrow Up / Down", action: "Move row focus and selection" },
        { keys: "Double-click", action: "Open selected channel in player" },
      ],
    },
    {
      title: "Selection",
      entries: [
        { keys: "Click", action: "Select single channel" },
        { keys: "Shift + Click", action: "Select range" },
        { keys: `${modifierLabel} + Click`, action: "Toggle row selection" },
        { keys: `${modifierLabel} + A`, action: "Select all visible channels" },
      ],
    },
    {
      title: "Scan & Playback",
      entries: [
        { keys: "Scan menu", action: "Start or stop scan" },
        { keys: "Context menu", action: "Scan selected channels" },
        { keys: "Double-click row", action: "Open in default player" },
      ],
    },
  ];
}

interface KeyboardShortcutsDialogProps {
  modifierLabel: "Cmd" | "Ctrl";
  onClose: () => void;
}

export function KeyboardShortcutsDialog({
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
      <div className="absolute inset-0 bg-black/45" onClick={onClose} />
      <div className="relative w-full max-w-3xl rounded-2xl border border-border-app bg-overlay shadow-2xl">
        <div className="flex items-start justify-between px-6 pt-5 pb-4 border-b border-border-app">
          <div>
            <p className="text-[11px] uppercase tracking-[0.08em] text-text-tertiary mb-1">
              Help
            </p>
            <h2 className="text-[18px] font-semibold text-text-primary">
              Keyboard Shortcuts
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close keyboard shortcuts"
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
                    <kbd className="px-2 py-0.5 rounded border border-border-app bg-panel text-text-secondary text-[11px] whitespace-nowrap">
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
