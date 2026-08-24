/**
 * Inline image results for the sandbox read tool.
 *
 * Pi's own read tool sends images as attachments rather than exposing a
 * separate vision tool, and this mirrors that: the model asks for a file, and
 * if the bytes are an image it gets an ImageContent block alongside the text
 * note. Without it the only way to "look at" a chart the run had just rendered
 * was to OCR it.
 *
 * Normalisation and resizing come from the SDK (`convertToPng`, `resizeImage`,
 * `formatDimensionNote`) so this stays aligned with what Pi will actually put
 * on the wire instead of re-deriving its budgets.
 */

import {
  convertToPng,
  formatDimensionNote,
  resizeImage,
} from '@earendil-works/pi-coding-agent';

/** Types a provider accepts inline; anything else is converted to PNG first. */
const NATIVE_INLINE_MIME_TYPES = Object.freeze([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

/**
 * Note appended when the selected model cannot see the image.
 *
 * Deliberately not an error: a text-only model asked to read a file still gets
 * a working read, and the note tells it why it cannot describe the picture.
 * Failing the call instead would end the run over a model-capability mismatch
 * the model itself could route around.
 *
 * @param {{ input?: unknown } | null | undefined} model
 */
export function nonVisionImageNote(model) {
  const input = model && Array.isArray(model.input) ? model.input : null;
  // An unknown model is not assumed blind: the provider rejects what it cannot
  // take, and a spurious note would teach the model a false limit.
  if (!input || input.includes('image')) return null;
  return '[Current model does not support images. The image will be omitted from this request.]';
}

/**
 * Build the model-facing result for a read that returned image bytes.
 *
 * @param {{ imageContent?: string, imageMimeType?: string, imageOmitted?: string, size?: number }} data
 * @param {string} path
 * @param {{ model?: object | null, maxBytes: number }} opts
 * @returns {Promise<{ content: Array<object> } | null>} null when this is not an image result
 */
export async function buildReadImageResult(data, path, opts) {
  const declared = String(data?.imageMimeType || '');

  if (data?.imageOmitted === 'IMAGE_TOO_LARGE') {
    const mb = Math.floor(opts.maxBytes / (1024 * 1024));
    return {
      content: [
        {
          type: 'text',
          text:
            `Read image file [${declared || 'image'}] at ${path}\n` +
            `[Image omitted: ${data?.size ?? 'unknown'} bytes exceeds the ${mb}MB inline limit. ` +
            'Downscale it first (for example with PIL) and read the smaller file.]',
        },
      ],
    };
  }

  if (!data?.imageContent || !declared) return null;

  const note = nonVisionImageNote(opts.model);
  const processed = await normalizeInlineImage(data.imageContent, declared);
  if (!processed) {
    return {
      content: [
        {
          type: 'text',
          text:
            `Read image file [${declared}] at ${path}\n` +
            '[Image omitted: could not be converted to a supported inline image format.]' +
            (note ? `\n${note}` : ''),
        },
      ],
    };
  }

  const hints = processed.hints.length ? `\n${processed.hints.join('\n')}` : '';
  const text = `Read image file [${processed.mimeType}] at ${path}${hints}${note ? `\n${note}` : ''}`;

  // A model that cannot take images must not be sent one: the note above
  // already tells it what happened, and the provider would reject the block.
  if (note) return { content: [{ type: 'text', text }] };

  return {
    content: [
      { type: 'text', text },
      { type: 'image', data: processed.data, mimeType: processed.mimeType },
    ],
  };
}

/**
 * Convert to a natively inlineable type, then resize to Pi's inline budget.
 *
 * @param {string} base64
 * @param {string} mimeType
 * @returns {Promise<{ data: string, mimeType: string, hints: string[] } | null>}
 */
async function normalizeInlineImage(base64, mimeType) {
  const hints = [];
  let data = base64;
  let type = mimeType;

  if (!NATIVE_INLINE_MIME_TYPES.includes(type)) {
    const converted = await convertToPng(data, type);
    if (!converted) return null;
    hints.push(`[Image converted from ${type} to ${converted.mimeType}.]`);
    data = converted.data;
    type = converted.mimeType;
  }

  const resized = await resizeImage(Buffer.from(data, 'base64'), type);
  if (!resized) {
    // Resizing is a best-effort improvement, not a gate: an image already
    // within budget is still worth sending unresized.
    return { data, mimeType: type, hints };
  }
  const dimensionNote = formatDimensionNote(resized);
  if (dimensionNote) hints.push(dimensionNote);
  return { data: resized.data, mimeType: resized.mimeType, hints };
}
