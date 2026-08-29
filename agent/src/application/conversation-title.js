const DEFAULT_CONVERSATION_TITLE = 'New chat';
const MAX_CONVERSATION_TITLE_CHARS = 500;
const ATTACHMENTS_BLOCK_MARKER = '\n\n[Attachments]\n';

function messageText(message) {
  if (!message || typeof message !== 'object') return '';
  let raw =
    message.content ??
    message.text ??
    message.contentJson ??
    message.content_json ??
    '';

  if (
    raw &&
    typeof raw === 'object' &&
    !Array.isArray(raw)
  ) {
    if (typeof raw.text === 'string') {
      raw = raw.text;
    } else if (Array.isArray(raw.content)) {
      raw = raw.content;
    } else if (Array.isArray(raw.messages)) {
      return conversationTitleFromMessages(raw.messages);
    }
  }

  if (typeof raw === 'string') return raw;
  if (!Array.isArray(raw)) return '';
  return raw
    .map((part) => {
      if (typeof part === 'string') return part;
      return part && typeof part === 'object' && typeof part.text === 'string'
        ? part.text
        : '';
    })
    .filter(Boolean)
    .join('');
}

function normalizeConversationTitle(text) {
  if (text.startsWith('[Attachments]\n')) {
    return '';
  }
  const attachmentMarkerIndex = text.indexOf(ATTACHMENTS_BLOCK_MARKER);
  const userText =
    attachmentMarkerIndex >= 0 ? text.slice(0, attachmentMarkerIndex) : text;
  const normalized = userText.trim().replace(/\s+/g, ' ');
  return normalized.slice(0, MAX_CONVERSATION_TITLE_CHARS);
}

/**
 * Use the first non-empty user-authored text as a conversation title.
 * Generated attachment manifests are intentionally excluded.
 *
 * Supports both API message shapes and durable Message rows.
 *
 * @param {unknown[]} messages
 * @returns {string}
 */
export function conversationTitleFromMessages(messages) {
  if (!Array.isArray(messages)) return DEFAULT_CONVERSATION_TITLE;
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const rec = /** @type {Record<string, unknown>} */ (message);
    if (rec.role !== 'user' && rec.role != null) {
      continue;
    }
    const title = normalizeConversationTitle(messageText(message));
    if (title) return title;
  }
  return DEFAULT_CONVERSATION_TITLE;
}

export function isPlaceholderConversationTitle(title) {
  const normalized = typeof title === 'string' ? title.trim().toLowerCase() : '';
  return (
    !normalized ||
    normalized === 'new chat' ||
    normalized === 'new conversation'
  );
}
