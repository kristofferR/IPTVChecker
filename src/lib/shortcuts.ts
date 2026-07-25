interface ShortcutModifierState {
  metaKey: boolean;
  ctrlKey: boolean;
}

function resolveFocusedElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) {
    return target;
  }

  if (target instanceof Document) {
    return target.activeElement;
  }

  if (target instanceof Window) {
    return target.document.activeElement;
  }

  if (typeof document !== "undefined") {
    return document.activeElement;
  }

  return null;
}

export function isInputLikeTarget(target: EventTarget | null): boolean {
  const element = resolveFocusedElement(target);
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  return (
    element.isContentEditable ||
    element.closest("input, textarea, select, [contenteditable='true'], [role='textbox']") !== null
  );
}

export function isPrimaryModifierPressed(state: ShortcutModifierState, isMac: boolean): boolean {
  if (isMac) {
    return state.metaKey && !state.ctrlKey;
  }
  return state.ctrlKey && !state.metaKey;
}
