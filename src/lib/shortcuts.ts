interface ShortcutModifierState {
  metaKey: boolean;
  ctrlKey: boolean;
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
