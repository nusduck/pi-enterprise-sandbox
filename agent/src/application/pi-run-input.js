import { randomBytes } from 'node:crypto';

/**
 * Unique Run lease acquisition token (workerId is metadata only).
 * Format: `{workerId}:{cryptographicSuffix}` — same shape as session lock tokens.
 *
 * @param {string} workerId
 * @param {{ randomBytes?: (n: number) => Buffer | Uint8Array }} [opts]
 * @returns {string}
 */
export function generateRunLeaseOwnerToken(workerId, opts = {}) {
  const base = String(workerId ?? '').trim();
  if (!base) {
    throw new Error('workerId is required for run lease owner token');
  }
  const rnd = opts.randomBytes ?? randomBytes;
  return `${base}:${Buffer.from(rnd(16)).toString('hex')}`;
}

/**
 * Derive Pi prompt content from the durable triggering user message only.
 * Never re-sends full accumulated history into prompt.
 *
 * @param {object | null | undefined} message — mapped Message row
 * @returns {string | Array<{ type: string, text?: string, [k: string]: unknown }>}
 */
export function derivePromptFromTriggeringMessage(message) {
  if (!message) {
    throw new Error('triggering message is required');
  }
  const content = message.contentJson || {};

  // Multimodal / parts form
  if (Array.isArray(content.parts)) {
    return content.parts.map((p) => {
      if (p && typeof p === 'object') {
        if (p.type === 'text' || p.type === 'image') return p;
        if (typeof p.text === 'string') return { type: 'text', text: p.text };
      }
      return { type: 'text', text: String(p) };
    });
  }

  // CreateRun stores { messages: [{role, content}], ... }
  if (Array.isArray(content.messages) && content.messages.length) {
    const lastUser = [...content.messages]
      .reverse()
      .find((m) => m && (m.role === 'user' || !m.role));
    const raw = lastUser?.content ?? lastUser?.text ?? content.messages[0]?.content;
    if (Array.isArray(raw)) {
      return raw.map((p) => {
        if (p && typeof p === 'object' && p.type) return p;
        return { type: 'text', text: String(p?.text ?? p) };
      });
    }
    if (typeof raw === 'string') return raw;
  }

  if (typeof content.text === 'string') return content.text;
  if (typeof content.content === 'string') return content.content;

  // Fallback: single string body
  if (typeof content === 'string') return content;
  return JSON.stringify(content);
}

/**
 * Adapt durable text/image parts to AgentSession.prompt(text, { images }).
 * Pi 0.80.3 always requires the first argument to be a string.
 *
 * @param {string | Array<{ type: string, text?: string, [k: string]: unknown }>} prompt
 * @returns {{ text: string, options?: { images: object[] } }}
 */
export function toPiPromptInvocation(prompt) {
  if (typeof prompt === 'string') return { text: prompt };

  const text = prompt
    .filter((part) => part?.type === 'text')
    .map((part) => String(part.text ?? ''))
    .join('\n');
  const images = prompt
    .filter((part) => part?.type === 'image')
    .map((part) => ({ ...part }));

  return images.length > 0 ? { text, options: { images } } : { text };
}

/**
 * Replace a parked approval/interaction placeholder in live state and the
 * durable branch. `appendIfMissing` is reserved for interaction recovery from
 * an older snapshot that was checkpointed before Pi emitted a toolResult slot.
 */
export function replaceSuspendedToolResultInSession(session, replacement) {
  if (!session || !replacement?.toolCallId) return false;
  const toolCallId = String(replacement.toolCallId);
  const content = Array.isArray(replacement.content)
    ? replacement.content
    : [];
  const details =
    replacement.details && typeof replacement.details === 'object'
      ? replacement.details
      : {};
  const isError = Boolean(replacement.isError);
  let rewrote = false;
  const appendIfMissing = replacement.appendIfMissing === true;

  const messages = session.agent?.state?.messages;
  if (Array.isArray(messages)) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (
        message?.role !== 'toolResult' ||
        String(message.toolCallId || '') !== toolCallId
      ) {
        continue;
      }
      messages[i] = {
        ...message,
        toolName: replacement.toolName || message.toolName,
        content,
        details: { ...(message.details || {}), ...details },
        isError,
      };
      rewrote = true;
      break;
    }
  }

  const manager = session.sessionManager;
  if (
    manager &&
    typeof manager.getEntries === 'function' &&
    typeof manager.branch === 'function' &&
    typeof manager.appendMessage === 'function'
  ) {
    const entries = manager.getEntries() || [];
    const parked = [...entries].reverse().find(
      (entry) =>
        entry?.type === 'message' &&
        entry.message?.role === 'toolResult' &&
        String(entry.message.toolCallId || '') === toolCallId,
    );
    if (parked?.parentId) {
      manager.branch(parked.parentId);
      manager.appendMessage({
        role: 'toolResult',
        toolCallId,
        toolName:
          replacement.toolName || parked.message?.toolName || 'tool',
        content,
        details,
        isError,
        timestamp: Date.now(),
      });
      rewrote = true;
    }
  }
  if (!rewrote && appendIfMissing) {
    if (
      manager &&
      typeof manager.appendMessage === 'function'
    ) {
      manager.appendMessage({
        role: 'toolResult',
        toolCallId,
        toolName: replacement.toolName || 'tool',
        content,
        details,
        isError,
        timestamp: Date.now(),
      });
      rewrote = true;
    } else if (Array.isArray(messages)) {
      messages.push({
        role: 'toolResult',
        toolCallId,
        toolName: replacement.toolName || 'tool',
        content,
        details,
        isError,
      });
      rewrote = true;
    }
  }
  return rewrote;
}
