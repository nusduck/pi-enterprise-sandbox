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
 * @param messages
 * @returns {string}
 */
export function conversationTitleFromMessages(messages: unknown[]) {
  if (!Array.isArray(messages)) return DEFAULT_CONVERSATION_TITLE;
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const rec = (message as Record<string, unknown>);
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

/**
 * 占位标题 → 从消息派生，非占位 → 原样返回。
 *
 * 收敛三处「占位检查 → 派生」：`create-run-service` 的首轮写回、
 * `conversation-service` 列表与详情的两处展示派生。`session-title-projection`
 * 的用法是另一语义（拿派生值当比较器，判断用户是否改过标题，且消息是按需
 * 拉取的），硬并会改变拉取时机，不收敛。
 */
export function ensureDerivedConversationTitle(currentTitle, messages) {
  if (!isPlaceholderConversationTitle(currentTitle)) return currentTitle;
  return conversationTitleFromMessages(messages);
}
