/**
 * Pure composer/global keyboard-shortcut predicates.
 *
 * Kept framework-free so node:test can exercise IME composition semantics
 * without a DOM. All shortcuts accept Ctrl (Windows/Linux) and Cmd (macOS),
 * ignore Shift variants to avoid browser collisions, and never fire while an
 * IME composition is active (`isComposing: true` keydowns belong to the IME).
 */

export type ShortcutKeyInput = {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  /** React KeyboardEvent exposes this on nativeEvent; plain events carry it directly. */
  isComposing?: boolean;
};

/** True when the attach-files shortcut (Ctrl+U / Cmd+U) is pressed. */
export function isUploadShortcut(input: ShortcutKeyInput): boolean {
  if (input.isComposing || input.shiftKey) return false;
  return (
    (input.ctrlKey === true || input.metaKey === true) &&
    input.key.toLowerCase() === 'u'
  );
}

/**
 * True when the new-chat shortcut (Ctrl+L / Cmd+L) is pressed.
 * Browsers reserve the bare combination for the address bar, so this only
 * matters when the app sees the event first.
 */
export function isNewChatShortcut(input: ShortcutKeyInput): boolean {
  if (input.isComposing || input.shiftKey) return false;
  return (
    (input.ctrlKey === true || input.metaKey === true) &&
    input.key.toLowerCase() === 'l'
  );
}

/**
 * True when a composer keydown should submit.
 *
 * Plain Enter sends; Shift+Enter inserts a newline; Enter pressed to confirm
 * an IME composition (Chinese/Japanese/Korean candidates) must NOT send —
 * browsers report those keydowns with `isComposing: true`.
 */
export function isEnterSubmitKey(input: {
  key: string;
  shiftKey?: boolean;
  isComposing?: boolean;
}): boolean {
  if (input.isComposing) return false;
  return input.key === 'Enter' && !input.shiftKey;
}
