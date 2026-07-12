/**
 * Structured attachment context for agent turns (ADR 0002 §4.5).
 *
 * Message schema carries:
 *   attachment_id, filename, path (workspace), mime_type, size, upload_time
 *
 * The agent must use this explicit list — never scan uploads/ to guess files.
 */

/**
 * Normalize one attachment object from frontend / API shapes.
 * @param {object | null | undefined} item
 * @returns {object | null}
 */
export function normalizeAttachment(item) {
  if (!item || typeof item !== 'object') return null;
  const attachment_id =
    item.attachment_id || item.attachmentId || item.id || null;
  const path = item.path || item.workspace_path || item.workspacePath || null;
  const filename =
    item.filename ||
    item.name ||
    item.sanitized_name ||
    (path ? String(path).split('/').pop() : null) ||
    'upload';
  if (!attachment_id && !path) return null;
  let size = 0;
  if (typeof item.size === 'number' && Number.isFinite(item.size)) {
    size = item.size;
  } else if (item.size != null) {
    const n = Number(item.size);
    size = Number.isFinite(n) ? n : 0;
  }
  return {
    attachment_id: attachment_id ? String(attachment_id) : null,
    filename: String(filename),
    path: path ? String(path) : null,
    workspace_path: path ? String(path) : null,
    mime_type: String(
      item.mime_type || item.mimeType || 'application/octet-stream',
    ),
    size,
    upload_time:
      item.upload_time || item.uploadTime || item.created_at || null,
  };
}

/**
 * Extract attachment list from a user message object.
 * @param {object | null | undefined} msg
 * @returns {object[]}
 */
export function extractMessageAttachments(msg) {
  if (!msg || typeof msg !== 'object') return [];
  const raw = msg.attachments || msg.attachment_manifest || [];
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    const n = normalizeAttachment(item);
    if (n) out.push(n);
  }
  return out;
}

/**
 * Build the explicit current-turn attachment prompt block.
 * @param {object[] | null | undefined} attachments
 * @returns {string} empty string when no attachments
 */
export function formatAttachmentPromptBlock(attachments) {
  const list = (attachments || [])
    .map((a) => normalizeAttachment(a))
    .filter(Boolean);
  if (!list.length) return '';

  const lines = [
    '## Current-turn attachments',
    '',
    'The user attached the following file(s) for **this turn only**.',
    'Use the listed workspace paths with the `read` tool. '
      + 'Do **not** scan or list the entire `uploads/` directory to guess attachments.',
    '',
  ];
  list.forEach((a, i) => {
    lines.push(
      `${i + 1}. **${a.filename}**`
        + ` — path=\`${a.path || a.workspace_path}\``
        + ` | mime=\`${a.mime_type}\``
        + ` | size=${a.size}`
        + ` | attachment_id=\`${a.attachment_id || 'n/a'}\``
        + ` | upload_time=\`${a.upload_time || 'n/a'}\``,
    );
  });
  lines.push('');
  return lines.join('\n');
}

/**
 * Merge attachment context into the user prompt text for the current turn.
 * Prefers structured message.attachments over any inline [Attachments] blob.
 *
 * @param {string} text — user text (may already include a frontend manifest)
 * @param {object[] | null | undefined} attachments
 * @returns {string}
 */
export function injectAttachmentContext(text, attachments) {
  const block = formatAttachmentPromptBlock(attachments);
  if (!block) return text || '';
  const base = (text || '').trim();
  // Strip a frontend-injected [Attachments] section so we don't double-list
  const stripped = base
    .replace(/\n\n\[Attachments\][\s\S]*$/m, '')
    .replace(/^\[Attachments\][\s\S]*$/m, '')
    .trim();
  if (!stripped) return block.trimEnd();
  return `${stripped}\n\n${block}`.trimEnd();
}
