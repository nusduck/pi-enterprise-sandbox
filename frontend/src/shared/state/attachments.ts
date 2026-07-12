import type {
  AttachmentDraft,
  AttachmentLimits,
  AttachmentManifestItem,
  ChatMessage,
} from './types';

/** Attachment draft statuses (composer, pre-send). */
export const ATTACHMENT_STATUSES = Object.freeze([
  'queued',
  'uploading',
  'uploaded',
  'failed',
  'removed',
] as const);

/** Defaults aligned with parent task P-00F1. */
export const ATTACHMENT_LIMITS: AttachmentLimits = Object.freeze({
  maxCount: 10,
  maxFileBytes: 50 * 1024 * 1024,
  maxTurnBytes: 200 * 1024 * 1024,
});

/**
 * Client-side extension allowlist (mirrors sandbox attachment_manager).
 * Server remains authoritative; this is layered UX/pre-check only.
 */
const ALLOWED_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.xml',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.log', '.env',
  '.py', '.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs', '.java', '.go', '.rs',
  '.rb', '.php', '.c', '.h', '.cpp', '.cc', '.hpp', '.cs', '.swift', '.kt',
  '.scala', '.sh', '.bash', '.zsh', '.ps1', '.sql', '.r', '.m', '.mm',
  '.html', '.htm', '.css', '.scss', '.less', '.vue', '.svelte', '.lua',
  '.pl', '.pm', '.ex', '.exs', '.erl', '.hs', '.clj', '.dockerfile',
  '.ipynb', '.graphql', '.gql', '.proto', '.tf', '.hcl',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico',
  '.tif', '.tiff',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.odt', '.ods', '.odp', '.rtf', '.epub',
  // archives stored as-is (never auto-extracted)
  '.zip', '.tar', '.gz', '.tgz', '.tar.gz',
]);

const COMPOUND_SUFFIXES = ['.tar.gz', '.tar.bz2', '.tar.xz'];

export function extensionOf(filename: string): string {
  const lower = String(filename || '').toLowerCase().trim();
  for (const compound of COMPOUND_SUFFIXES) {
    if (lower.endsWith(compound)) return compound;
  }
  const i = lower.lastIndexOf('.');
  return i >= 0 ? lower.slice(i) : '';
}

export function isAllowedAttachmentName(filename: string): boolean {
  const ext = extensionOf(filename);
  return Boolean(ext) && ALLOWED_EXTENSIONS.has(ext);
}

let attachmentSeq = 0;

type FileLike = File | Blob | { name?: string; size?: number; type?: string };

/**
 * Create a new attachment draft (queued). Same display names are independent.
 */
export function createAttachmentDraft(
  file: FileLike,
  opts: { localId?: string; idempotencyKey?: string } = {},
): AttachmentDraft {
  attachmentSeq += 1;
  const name = (file as { name?: string })?.name || 'upload';
  const size = typeof (file as { size?: number })?.size === 'number'
    ? (file as { size: number }).size
    : 0;
  return {
    localId: opts.localId || `local_${Date.now()}_${attachmentSeq}`,
    status: 'queued',
    name,
    size,
    mimeType: (file as { type?: string })?.type || '',
    file: file || null,
    attachmentId: null,
    path: null,
    idempotencyKey:
      opts.idempotencyKey ||
      `idem_${Date.now()}_${attachmentSeq}_${Math.random().toString(36).slice(2, 10)}`,
    error: null,
    errorCode: null,
    traceId: null,
    progress: 0,
    abortCtrl: null,
  };
}

/** Active (non-removed) drafts. */
export function activeAttachments(attachments: AttachmentDraft[] | null | undefined): AttachmentDraft[] {
  return (attachments || []).filter((a) => a && a.status !== 'removed');
}

/**
 * Whether the composer may send: no uploading/queued/failed drafts remain.
 * Empty attachment list is allowed (text-only send).
 */
export function canSendAttachments(attachments: AttachmentDraft[] | null | undefined): boolean {
  const active = activeAttachments(attachments);
  for (const a of active) {
    if (a.status === 'queued' || a.status === 'uploading' || a.status === 'failed') {
      return false;
    }
  }
  return true;
}

/** True when any non-removed draft is mid-upload. */
export function hasUploadingAttachments(attachments: AttachmentDraft[] | null | undefined): boolean {
  return activeAttachments(attachments).some(
    (a) => a.status === 'queued' || a.status === 'uploading',
  );
}

/** Uploaded drafts ready for the next user turn. */
export function uploadedAttachments(attachments: AttachmentDraft[] | null | undefined): AttachmentDraft[] {
  return activeAttachments(attachments).filter((a) => a.status === 'uploaded' && a.path);
}

/**
 * Patch a single draft by localId. Returns new attachments array.
 */
export function patchAttachment(
  attachments: AttachmentDraft[] | null | undefined,
  localId: string,
  patch: Partial<AttachmentDraft>,
): AttachmentDraft[] {
  return (attachments || []).map((a) =>
    a.localId === localId ? { ...a, ...patch } : a,
  );
}

/**
 * Mark draft removed (soft). Aborts any in-flight upload; does not dedupe by name.
 */
export function removeAttachment(
  attachments: AttachmentDraft[] | null | undefined,
  localId: string,
): AttachmentDraft[] {
  const list = attachments || [];
  const target = list.find((a) => a.localId === localId);
  if (target?.abortCtrl) {
    try {
      target.abortCtrl.abort();
    } catch {
      /* ignore */
    }
  }
  return patchAttachment(list, localId, {
    status: 'removed',
    file: null,
    error: null,
    abortCtrl: null,
  });
}

export type ValidateResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

/**
 * Validate adding files against count/size limits.
 */
export function validateNewAttachments(
  existing: AttachmentDraft[] | null | undefined,
  files: Array<FileLike> | FileList | null | undefined,
  limits: AttachmentLimits = ATTACHMENT_LIMITS,
): ValidateResult {
  const active = activeAttachments(existing);
  const incoming = Array.from(files || []) as FileLike[];
  if (active.length + incoming.length > limits.maxCount) {
    return {
      ok: false,
      code: 'turn_attachment_limit',
      message: `At most ${limits.maxCount} attachments per turn`,
    };
  }
  let turnBytes = active.reduce((s, a) => s + (a.size || 0), 0);
  for (const f of incoming) {
    const name = (f as { name?: string })?.name || 'upload';
    if (!isAllowedAttachmentName(name)) {
      const ext = extensionOf(name) || '(none)';
      return {
        ok: false,
        code: 'attachment_type_denied',
        message: `File type not allowed: ${ext}`,
      };
    }
    const size = (f as { size?: number })?.size || 0;
    if (size > limits.maxFileBytes) {
      return {
        ok: false,
        code: 'attachment_too_large',
        message: `"${name}" exceeds ${Math.round(limits.maxFileBytes / (1024 * 1024))}MB limit`,
      };
    }
    turnBytes += size;
  }
  if (turnBytes > limits.maxTurnBytes) {
    return {
      ok: false,
      code: 'turn_attachment_limit',
      message: `Total attachment size exceeds ${Math.round(limits.maxTurnBytes / (1024 * 1024))}MB per turn`,
    };
  }
  return { ok: true };
}

/**
 * Build user message content + attachment manifest for send.
 * Injects logical paths so the agent can read files without a separate channel.
 */
export function buildUserTurnWithAttachments(
  text: string,
  attachments: AttachmentDraft[] | null | undefined,
): ChatMessage & { attachments: AttachmentManifestItem[] } {
  const uploaded = uploadedAttachments(attachments);
  const trimmed = (text || '').trim();
  const manifest: AttachmentManifestItem[] = uploaded.map((a) => ({
    attachment_id: a.attachmentId,
    filename: a.name,
    name: a.name,
    path: a.path,
    workspace_path: a.path,
    mime_type: a.mimeType || 'application/octet-stream',
    size: a.size,
    upload_time: null,
  }));

  let body = trimmed;
  if (manifest.length) {
    // Lightweight inline hint; agent also injects structured Current-turn block
    const lines = manifest
      .map((m) => `- ${m.filename || m.name} → ${m.path} (${m.mime_type || 'unknown'})`)
      .join('\n');
    body = body
      ? `${body}\n\n[Attachments]\n${lines}`
      : `[Attachments]\n${lines}`;
  }

  return {
    role: 'user',
    content: [{ type: 'text', text: body }],
    attachments: manifest,
  };
}
