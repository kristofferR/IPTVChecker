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

/** Window event the channel table answers by selecting every visible row. */
export const SELECT_ALL_ROWS_EVENT = "app:select-all-rows";

/** Edit > Select All: text fields keep their native select-all, anything
 *  else selects every visible table row. */
export function handleSelectAllCommand(): void {
  if (isInputLikeTarget(document.activeElement)) {
    document.execCommand("selectAll");
    return;
  }
  window.dispatchEvent(new Event(SELECT_ALL_ROWS_EVENT));
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
