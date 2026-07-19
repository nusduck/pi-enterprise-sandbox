/**
 * Vision helpers — load workspace images and build pi-ai ImageContent blocks.
 *
 * Used for:
 *  - current-turn attachment injection into session.prompt({ images })
 *  - enterprise `read` tool returning multimodal image content
 *
 * Depends on Model Registry `input_modalities` including "image".
 */
import { convertToPng, formatDimensionNote, resizeImage } from '@earendil-works/pi-coding-agent';
import { normalizeAttachment } from './attachment-context.js';

/** Inline vision formats after normalize / convert. */
const SUPPORTED_INLINE = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
]);

const EXT_TO_MIME = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
});

/** Skip downloading multi-megabyte blobs that will never fit provider limits. */
const MAX_RAW_IMAGE_BYTES = 25 * 1024 * 1024;

/**
 * @param {unknown} entryOrModel — registry ModelEntry or pi Model (`input` array)
 * @returns {boolean}
 */
export function modelSupportsVision(entryOrModel) {
  if (!entryOrModel || typeof entryOrModel !== 'object') return false;
  const modalities =
    entryOrModel.input_modalities ||
    entryOrModel.input ||
    null;
  if (!Array.isArray(modalities)) return false;
  return modalities.map(String).includes('image');
}

/**
 * @param {string} mime
 * @returns {string}
 */
export function baseMimeType(mime) {
  return String(mime || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
}

/**
 * @param {string} [filename]
 * @returns {string|null}
 */
export function mimeFromFilename(filename) {
  const lower = String(filename || '').toLowerCase().trim();
  if (!lower) return null;
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return null;
  return EXT_TO_MIME[lower.slice(dot)] || null;
}

/**
 * Resolve a candidate image mime from attachment metadata or path.
 * @param {{ mime_type?: string, filename?: string, path?: string, workspace_path?: string }|null|undefined} item
 * @returns {string|null} null when clearly not an image
 */
export function resolveImageMime(item) {
  if (!item || typeof item !== 'object') return null;
  const raw = baseMimeType(item.mime_type || item.mimeType || '');
  if (raw.startsWith('image/')) return raw === 'image/jpg' ? 'image/jpeg' : raw;
  const name = item.filename || item.name || item.path || item.workspace_path || '';
  return mimeFromFilename(name);
}

/**
 * @param {object|null|undefined} attachment
 * @returns {boolean}
 */
export function isImageAttachment(attachment) {
  return Boolean(resolveImageMime(attachment));
}

/**
 * Normalize mime to a format resizeImage / providers accept, converting when needed.
 * @param {Uint8Array|Buffer} bytes
 * @param {string} mimeType
 * @returns {Promise<{ bytes: Uint8Array, mimeType: string, convertedFrom?: string }|null>}
 */
export async function normalizeImageBytes(bytes, mimeType) {
  const mime = baseMimeType(mimeType);
  const normalized = mime === 'image/jpg' ? 'image/jpeg' : mime;
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (SUPPORTED_INLINE.has(normalized)) {
    return {
      bytes: u8,
      mimeType: normalized === 'image/jpg' ? 'image/jpeg' : normalized,
    };
  }
  // convertToPng(base64, mime) — converts via Photon when available (bmp/tiff/…)
  try {
    const b64 = Buffer.from(u8).toString('base64');
    const png = await convertToPng(b64, normalized || 'application/octet-stream');
    if (png?.data) {
      return {
        bytes: new Uint8Array(Buffer.from(png.data, 'base64')),
        mimeType: png.mimeType || 'image/png',
        convertedFrom: normalized || 'unknown',
      };
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Build a pi-ai ImageContent block (base64 data + mimeType).
 * @param {Uint8Array|Buffer} bytes
 * @param {string} mimeType
 * @param {{ autoResize?: boolean }} [opts]
 * @returns {Promise<{ ok: true, image: { type: 'image', data: string, mimeType: string }, hints: string[] }|{ ok: false, message: string }>}
 */
export async function prepareImageContent(bytes, mimeType, opts = {}) {
  const autoResize = opts.autoResize !== false;
  if (!bytes || !bytes.length) {
    return { ok: false, message: '[Image omitted: empty file.]' };
  }
  if (bytes.length > MAX_RAW_IMAGE_BYTES) {
    return {
      ok: false,
      message: `[Image omitted: raw size ${bytes.length} exceeds ${MAX_RAW_IMAGE_BYTES} byte limit.]`,
    };
  }

  const normalized = await normalizeImageBytes(bytes, mimeType);
  if (!normalized) {
    return {
      ok: false,
      message: '[Image omitted: could not convert to a supported inline image format.]',
    };
  }

  const hints = [];
  if (normalized.convertedFrom && normalized.convertedFrom !== normalized.mimeType) {
    hints.push(
      `[Image converted from ${normalized.convertedFrom} to ${normalized.mimeType}.]`,
    );
  }

  if (autoResize) {
    try {
      const resized = await resizeImage(normalized.bytes, normalized.mimeType);
      if (!resized || !resized.data) {
        return {
          ok: false,
          message: '[Image omitted: could not resize below the inline image size limit.]',
        };
      }
      const note = formatDimensionNote?.(resized);
      if (note) hints.push(note);
      return {
        ok: true,
        image: {
          type: 'image',
          data: resized.data,
          mimeType: resized.mimeType || normalized.mimeType,
        },
        hints,
      };
    } catch (err) {
      return {
        ok: false,
        message: `[Image omitted: resize failed: ${err?.message || err}]`,
      };
    }
  }

  return {
    ok: true,
    image: {
      type: 'image',
      data: Buffer.from(normalized.bytes).toString('base64'),
      mimeType: normalized.mimeType,
    },
    hints,
  };
}

/**
 * Download raw bytes from sandbox workspace path.
 * @param {{ downloadFileStream: Function }} client
 * @param {string} sessionId
 * @param {string} path
 * @returns {Promise<Uint8Array>}
 */
export async function downloadSandboxFileBytes(client, sessionId, path) {
  if (!client?.downloadFileStream) {
    throw new Error('sandbox client missing downloadFileStream');
  }
  if (!sessionId) throw new Error('session_id required for image download');
  if (!path) throw new Error('path required for image download');
  const resp = await client.downloadFileStream(sessionId, path);
  if (!resp || typeof resp.arrayBuffer !== 'function') {
    throw new Error('invalid download response');
  }
  if (resp.ok === false) {
    throw new Error(`download failed: ${resp.status || 'unknown'}`);
  }
  const buf = new Uint8Array(await resp.arrayBuffer());
  return buf;
}

/**
 * Load image attachments for the current user turn as ImageContent[].
 *
 * @param {object} opts
 * @param {{ downloadFileStream: Function }} opts.client
 * @param {string} opts.sessionId
 * @param {object[]|null|undefined} opts.attachments
 * @param {boolean} opts.visionEnabled — modelSupportsVision
 * @param {(msg: string, meta?: object) => void} [opts.onWarn]
 * @returns {Promise<{ images: Array<{ type: 'image', data: string, mimeType: string }>, notes: string[], loaded: number, skipped: number }>}
 */
export async function loadTurnAttachmentImages(opts) {
  const {
    client,
    sessionId,
    attachments,
    visionEnabled,
    onWarn,
  } = opts || {};
  const notes = [];
  const images = [];
  let loaded = 0;
  let skipped = 0;

  if (!visionEnabled) {
    return { images, notes, loaded, skipped };
  }

  const list = (attachments || [])
    .map((a) => normalizeAttachment(a))
    .filter(Boolean)
    .filter((a) => isImageAttachment(a));

  for (const att of list) {
    const path = att.path || att.workspace_path;
    const mime = resolveImageMime(att);
    if (!path || !mime) {
      skipped += 1;
      continue;
    }
    try {
      const bytes = await downloadSandboxFileBytes(client, sessionId, path);
      const prepared = await prepareImageContent(bytes, mime);
      if (!prepared.ok) {
        skipped += 1;
        notes.push(`${att.filename}: ${prepared.message}`);
        onWarn?.(prepared.message, { path, filename: att.filename });
        continue;
      }
      images.push(prepared.image);
      loaded += 1;
      if (prepared.hints?.length) {
        notes.push(`${att.filename}: ${prepared.hints.join(' ')}`);
      }
    } catch (err) {
      skipped += 1;
      const msg = `Failed to load image ${att.filename}: ${err?.message || err}`;
      notes.push(msg);
      onWarn?.(msg, { path, filename: att.filename });
    }
  }

  return { images, notes, loaded, skipped };
}

/**
 * Build tool-result content for an image file read.
 *
 * @param {object} opts
 * @param {{ downloadFileStream: Function }} opts.client
 * @param {string} opts.sessionId
 * @param {string} opts.path
 * @param {string} [opts.mimeType]
 * @param {boolean} opts.visionEnabled
 * @returns {Promise<{ content: object[], details: object }>}
 */
export async function readImageAsToolResult(opts) {
  const {
    client,
    sessionId,
    path,
    mimeType,
    visionEnabled,
  } = opts || {};
  const mime = resolveImageMime({ mime_type: mimeType, path }) || mimeType || 'image/png';
  const bytes = await downloadSandboxFileBytes(client, sessionId, path);
  const prepared = await prepareImageContent(bytes, mime);

  if (!prepared.ok) {
    return {
      content: [{ type: 'text', text: `Read image file [${mime}]\n${prepared.message}` }],
      details: { path, mime_type: mime, size: bytes.length, isError: true },
      isError: true,
    };
  }

  let textNote = `Read image file [${prepared.image.mimeType}]`;
  if (prepared.hints?.length) textNote += `\n${prepared.hints.join('\n')}`;
  if (!visionEnabled) {
    textNote +=
      '\n[Current model does not support images. The image will be omitted from this request.]';
    return {
      content: [{ type: 'text', text: textNote }],
      details: {
        path,
        mime_type: prepared.image.mimeType,
        size: bytes.length,
        vision: false,
      },
    };
  }

  return {
    content: [
      { type: 'text', text: textNote },
      prepared.image,
    ],
    details: {
      path,
      mime_type: prepared.image.mimeType,
      size: bytes.length,
      vision: true,
    },
  };
}
