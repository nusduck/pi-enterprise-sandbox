/**
 * Message extract / history helpers for multi-turn agent transcript restore.
 */
import { config } from '../config.js';
import { extractMessageAttachments } from './attachment-context.js';

/** Cap restored turns to keep context bounded. */
const MAX_HISTORY_MESSAGES = 40;

/**
 * Extract plain text from a frontend or API message shape.
 */
export function extractMessageText(msg) {
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((p) => {
        if (typeof p === 'string') return p;
        if (p?.type === 'text' && p.text) return p.text;
        if (p?.text) return p.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (Array.isArray(msg.parts)) {
    return msg.parts.map((p) => p.text || '').filter(Boolean).join('\n');
  }
  return '';
}

export { extractMessageAttachments };

/**
 * Convert UI/history messages into pi-ai UserMessage / AssistantMessage shapes
 * suitable for agent.state.messages restoration.
 */
export function toAgentHistoryMessages(messages, modelId = config.MODEL_ID) {
  const out = [];
  const list = Array.isArray(messages) ? messages : [];
  for (const m of list) {
    const text = extractMessageText(m).trim();
    if (!text) continue;
    const role = m.role === 'assistant' ? 'assistant' : m.role === 'user' ? 'user' : null;
    if (!role) continue;
    const ts = typeof m.timestamp === 'number' ? m.timestamp : Date.now();
    if (role === 'user') {
      out.push({ role: 'user', content: text, timestamp: ts });
    } else {
      out.push({
        role: 'assistant',
        content: [{ type: 'text', text }],
        api: 'openai-completions',
        provider: 'llmio',
        model: modelId,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp: ts,
      });
    }
  }
  if (out.length > MAX_HISTORY_MESSAGES) {
    return out.slice(-MAX_HISTORY_MESSAGES);
  }
  return out;
}

/**
 * Normalize messages for conversation DB persistence (text + attachment metadata).
 */
export function toPersistableMessages(messages) {
  return (messages || [])
    .map((m) => {
      const role = m.role === 'assistant' ? 'assistant' : m.role === 'user' ? 'user' : null;
      if (!role) return null;
      const text = extractMessageText(m).trim();
      const attachments = extractMessageAttachments(m);
      if (!text && !attachments.length) return null;
      const row = { role, content: text || '' };
      if (attachments.length) {
        row.attachments = attachments;
      }
      return row;
    })
    .filter(Boolean)
    .slice(-100);
}
