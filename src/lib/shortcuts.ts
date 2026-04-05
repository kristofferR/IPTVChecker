interface ShortcutModifierState {
  metaKey: boolean;
  ctrlKey: boolean;
}

export function isInputLikeTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return (
    target.isContentEditable ||
    target.closest(
      "input, textarea, select, [contenteditable='true'], [role='textbox']",
    ) !== null
  );
}

export function isPrimaryModifierPressed(
  state: ShortcutModifierState,
  isMac: boolean,
): boolean {
  if (isMac) {
    return state.metaKey && !state.ctrlKey;
  }
  return state.ctrlKey && !state.metaKey;
}
