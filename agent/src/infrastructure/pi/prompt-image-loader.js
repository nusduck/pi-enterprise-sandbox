/** Secure attachment-id → Pi ImageContent adapter. */

import { createHash } from 'node:crypto';

export const SUPPORTED_PROMPT_IMAGE_MIME_TYPES = Object.freeze([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);
export const DEFAULT_MAX_PROMPT_IMAGES = 4;
export const DEFAULT_MAX_PROMPT_IMAGE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAX_PROMPT_IMAGE_TOTAL_BYTES = 20 * 1024 * 1024;

function positiveLimit(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

/** Determine the supported image type from file signatures, not metadata. */
export function detectPromptImageMime(bytes) {
  if (!Buffer.isBuffer(bytes)) return null;
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) return 'image/webp';
  if (
    bytes.length >= 6 &&
    (bytes.subarray(0, 6).toString('ascii') === 'GIF87a' ||
      bytes.subarray(0, 6).toString('ascii') === 'GIF89a')
  ) return 'image/gif';
  return null;
}

/**
 * @param {{
 *   attachmentStore: { download: Function },
 *   sandboxSessionId: string,
 *   attachments: Array<{ attachmentId: string, mimeType: string, size?: number|null }>,
 *   signal?: AbortSignal,
 *   maxImages?: number,
 *   maxImageBytes?: number,
 *   maxTotalBytes?: number,
 * }} input
 * @returns {Promise<Array<{ type: 'image', data: string, mimeType: string }>>}
 */
export async function loadPromptImagesFromAttachmentStore(input) {
  const maxImages = positiveLimit(input.maxImages, DEFAULT_MAX_PROMPT_IMAGES);
  const maxImageBytes = positiveLimit(
    input.maxImageBytes,
    DEFAULT_MAX_PROMPT_IMAGE_BYTES,
  );
  const maxTotalBytes = positiveLimit(
    input.maxTotalBytes,
    DEFAULT_MAX_PROMPT_IMAGE_TOTAL_BYTES,
  );
  const attachments = Array.isArray(input.attachments) ? input.attachments : [];
  if (attachments.length > maxImages) {
    throw new Error(`At most ${maxImages} image attachments are allowed per turn`);
  }

  let totalBytes = 0;
  const images = [];
  for (const attachment of attachments) {
    const declaredMime = String(attachment?.mimeType || '').toLowerCase();
    if (!SUPPORTED_PROMPT_IMAGE_MIME_TYPES.includes(declaredMime)) {
      throw new Error(`Unsupported prompt image type: ${declaredMime || 'unknown'}`);
    }
    if (Number(attachment?.size) > maxImageBytes) {
      throw new Error(`Prompt image exceeds ${maxImageBytes} byte limit`);
    }
    const response = await input.attachmentStore.download({
      attachmentId: String(attachment.attachmentId),
      sandboxSessionId: input.sandboxSessionId,
      signal: input.signal,
    });
    const responseMime = String(response.headers?.get?.('content-type') || '')
      .split(';', 1)[0]
      .trim()
      .toLowerCase();
    if (responseMime && responseMime !== declaredMime) {
      throw new Error(
        `Prompt image MIME mismatch: declared ${declaredMime}, received ${responseMime}`,
      );
    }
    const contentLength = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maxImageBytes) {
      throw new Error(`Prompt image exceeds ${maxImageBytes} byte limit`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxImageBytes) {
      throw new Error(`Prompt image exceeds ${maxImageBytes} byte limit`);
    }
    const detectedMime = detectPromptImageMime(bytes);
    if (detectedMime !== declaredMime) {
      throw new Error(
        `Prompt image bytes do not match declared type ${declaredMime}`,
      );
    }
    totalBytes += bytes.length;
    if (totalBytes > maxTotalBytes) {
      throw new Error(`Prompt images exceed ${maxTotalBytes} byte total limit`);
    }
    const expectedSha256 = String(
      response.headers?.get?.('x-dataset-sha256') || '',
    ).trim().toLowerCase();
    if (expectedSha256) {
      const actualSha256 = createHash('sha256').update(bytes).digest('hex');
      if (actualSha256 !== expectedSha256) {
        throw new Error('Prompt image content hash no longer matches its attachment id');
      }
    }
    images.push({
      type: 'image',
      data: bytes.toString('base64'),
      mimeType: declaredMime,
    });
  }
  return images;
}
