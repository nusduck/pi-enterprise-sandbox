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

/** Resolve the explicit per-Run model selection persisted by CreateRun. */
export function requestedModelIdFromTriggeringMessage(message) {
  const value = message?.contentJson?.modelId ?? message?.contentJson?.model_id;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Extract current-turn attachment identities without trusting client-provided
 * workspace paths. Sandbox re-checks session and owner when bytes are fetched.
 */
export function attachmentsFromTriggeringMessage(message) {
  const content = message?.contentJson;
  if (!content || typeof content !== 'object') return [];
  const messages = Array.isArray(content.messages) ? content.messages : [];
  const current = [...messages]
    .reverse()
    .find((item) => item && typeof item === 'object' &&
      (item.role === 'user' || item.role == null));
  const attachments = Array.isArray(current?.attachments)
    ? current.attachments
    : Array.isArray(content.attachments)
      ? content.attachments
      : [];
  return attachments.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const attachmentId = String(item.attachment_id ?? item.attachmentId ?? '').trim();
    if (!attachmentId) return [];
    const mimeType = String(item.mime_type ?? item.mimeType ?? '')
      .trim()
      .toLowerCase();
    return [{
      attachmentId,
      filename: String(
        item.filename ?? item.name ?? (mimeType.startsWith('image/') ? 'image' : 'attachment'),
      ),
      mimeType,
      size: Number(item.size) || 0,
    }];
  });
}

/** Add authoritative attachment ids to the model prompt for attachment tools. */
export function appendCurrentTurnAttachmentContext(prompt, attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return prompt;
  const lines = [
    '## Current-turn attachment identifiers',
    '',
    'These ids are valid only for files attached in this user turn.',
    'Use attachment_id for attachment-aware tools; never treat workspace paths as install sources.',
    '',
    ...attachments.map((attachment, index) =>
      `${index + 1}. filename=${JSON.stringify(attachment.filename)}` +
      ` attachment_id=${JSON.stringify(attachment.attachmentId)}` +
      ` mime=${JSON.stringify(attachment.mimeType || 'application/octet-stream')}` +
      ` size=${Number(attachment.size) || 0}`,
    ),
  ];
  const block = lines.join('\n');
  if (typeof prompt === 'string') return `${prompt}\n\n${block}`;
  if (Array.isArray(prompt)) {
    return [...prompt, { type: 'text', text: block }];
  }
  return block;
}

/**
 * Extract current-turn image attachment references without trusting a browser
 * path as bytes. The worker later resolves each id through the owner-scoped
 * attachment store and converts the exact bytes to Pi ImageContent.
 */
export function imageAttachmentsFromTriggeringMessage(message) {
  return attachmentsFromTriggeringMessage(message).flatMap((item) => {
    if (!item.mimeType.startsWith('image/')) return [];
    return [{
      attachmentId: item.attachmentId,
      mimeType: item.mimeType,
      name: item.filename,
      size: item.size || null,
    }];
  });
}

/**
 * Tell the model its images were dropped, rather than failing the run.
 *
 * A text-only model with an image attached used to fail the whole turn. The
 * user has already uploaded and sent — losing the question along with the
 * picture helps nobody, and the model can still act on the filenames and the
 * text. Mirrors the note Pi's own read tool emits for a non-vision model.
 *
 * @param {string | Array<{ type: string, text?: string, [k: string]: unknown }>} prompt
 * @param {Array<{ name?: string }>} images
 * @param {string} modelId
 */
export function appendNonVisionImageNotice(prompt, images, modelId) {
  if (!Array.isArray(images) || images.length === 0) return prompt;
  const names = images
    .map((image) => String(image?.name || 'image'))
    .join(', ');
  const block =
    `[${images.length} image attachment(s) omitted: model ${modelId || 'selected'} does not accept image input. ` +
    `Attached: ${names}. Ask the user to switch to a vision-capable model, or work from the file another way ` +
    '(the attachments are in the workspace and readable as files).]';
  if (typeof prompt === 'string') return `${prompt}\n\n${block}`;
  if (Array.isArray(prompt)) return [...prompt, { type: 'text', text: block }];
  return block;
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
 * Recover the arguments the model actually emitted for `toolCallId`.
 *
 * The ToolExecution ledger deliberately stores a *redacted* view of the
 * arguments (`$payload`), while `$integrity` commits to the original. Replaying
 * an approved tool from the ledger therefore both fails the integrity check and
 * would execute the tool with truncated arguments. The Pi session still holds
 * the assistant message that produced the call, so that — not the ledger — is
 * the authority on what to re-execute.
 *
 * @param {{ agent?: { state?: { messages?: unknown[] } }, sessionManager?: { getEntries?: Function } } | null} session
 * @param {string} toolCallId
 * @returns {{ found: true, args: Record<string, unknown> } | { found: false }}
 */
export function findToolCallArgumentsInSession(session, toolCallId) {
  const wanted = String(toolCallId || '');
  if (!session || !wanted) return { found: false };

  /** @param {unknown[]} messages */
  const scan = (messages) => {
    if (!Array.isArray(messages)) return null;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = /** @type {any} */ (messages[i]);
      if (message?.role !== 'assistant' || !Array.isArray(message.content)) {
        continue;
      }
      for (const block of message.content) {
        if (
          block?.type === 'toolCall' &&
          String(block.id || '') === wanted &&
          block.arguments !== null &&
          typeof block.arguments === 'object' &&
          !Array.isArray(block.arguments)
        ) {
          return /** @type {Record<string, unknown>} */ (block.arguments);
        }
      }
    }
    return null;
  };

  const live = scan(session.agent?.state?.messages);
  if (live) return { found: true, args: live };

  const manager = session.sessionManager;
  if (manager && typeof manager.getEntries === 'function') {
    const entries = manager.getEntries() || [];
    const messages = entries
      .filter((entry) => entry?.type === 'message' && entry.message)
      .map((entry) => entry.message);
    const durable = scan(messages);
    if (durable) return { found: true, args: durable };
  }

  return { found: false };
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
