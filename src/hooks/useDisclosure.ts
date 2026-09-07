import { useState } from "react";

/** Persist a sidebar disclosure preference, while keeping its contents mounted. */
export function useDisclosure(key: string) {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(key) === "true";
    } catch {
      return false;
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
