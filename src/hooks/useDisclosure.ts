import { useState } from "react";

/** Persist a sidebar disclosure preference, while keeping its contents mounted. */
export function useDisclosure(key: string, defaultOpen = false) {
  const [open, setOpen] = useState(() => {
    try {
      const saved = localStorage.getItem(key);
      return saved === null ? defaultOpen : saved === "true";
    } catch {
      return defaultOpen;
    }
  });
  return [
    open,
    (next: boolean) => {
      setOpen(next);
      try {
        localStorage.setItem(key, String(next));
      } catch {}
    },
  ] as const;
}
