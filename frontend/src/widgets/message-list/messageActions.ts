/**
 * Pure helpers behind the message-bubble action row (copy / regenerate) and
 * the scroll-to-bottom affordance. Framework-free so node:test can cover
 * them without a DOM.
 */
import type { ChatMessage } from '../../shared/state/types';

/** Default distance (px) from the bottom beyond which the jump button shows. */
export const NEAR_BOTTOM_THRESHOLD_PX = 120;

/** Join all text parts of a message — what "Copy" puts on the clipboard. */
export function messagePlainText(message: ChatMessage): string {
  return message.content
    .filter((part) => part.type === 'text' && 'text' in part)
    .map((part) => String((part as { text?: unknown }).text || ''))
    .join('');
}

/** Index of the last assistant bubble, or -1 when none exists. */
export function lastAssistantIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'assistant') return i;
  }
  return -1;
}

/**
 * The user text a "Regenerate" should re-send for the assistant bubble at
 * `assistantIndex`: the nearest preceding user turn with non-empty text.
 * Returns null when no such turn exists.
 */
export function findRegenerateSource(
  messages: ChatMessage[],
  assistantIndex: number,
): string | null {
  for (let i = assistantIndex - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;
    const text = messagePlainText(msg).trim();
    if (text) return text;
  }
  return null;
}

/** True when the scroll container is far enough from the bottom to offer a jump. */
export function shouldShowJumpToBottom(
  distanceFromBottomPx: number,
  opts: { threshold?: number; hasMessages?: boolean } = {},
): boolean {
  if (opts.hasMessages === false) return false;
  return distanceFromBottomPx > (opts.threshold ?? NEAR_BOTTOM_THRESHOLD_PX);
}

/**
 * Cheap semantic fingerprint of a bubble's rendered content.
 *
 * Projection layers rebuild ChatMessage objects on every entity-store tick,
 * so object identity cannot drive React.memo. Two fingerprints being equal
 * means the bubble would render identically and the re-render can be skipped.
 */
export function messageFingerprint(message: ChatMessage): string {
  const attachmentIds = (message.attachments || [])
    .map((a) =>
      String(a.attachment_id || a.path || a.filename || a.name || ''),
    )
    .join(',');
  return [
    message.role || '',
    messagePlainText(message),
    message.thinking ? `T${message.thinking.length}` : '',
    message.thinkingStatus || '',
    message.interrupted ? 'I' : '',
    message._fileLinks?.length ? `L${message._fileLinks.length}` : '',
    attachmentIds,
  ].join('|');
}
