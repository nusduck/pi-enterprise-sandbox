/**
 * Image-field bounding for binary read results.
 *
 * The sandbox decides which files are images and enforces the inline budget,
 * but it is a separate service across a network boundary. These checks are this
 * side's own: an unbounded or malformed `imageContent` would otherwise flow
 * straight into a provider request as image content.
 */

import {
  READ_IMAGE_MAX_BYTES,
  READ_IMAGE_MIME_TYPES,
  READ_IMAGE_OMITTED_REASONS,
} from './internal-files-read-constants.js';
import { fail } from './internal-sandbox-transport-error.js';

/** Binary-result fields that are present only for a sniffed inline image. */
export const OPTIONAL_BINARY_KEYS = new Set([
  'imageMimeType',
  'imageContent',
  'imageOmitted',
]);

/** Base64 with canonical padding — rejects whitespace and stray characters. */
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Bound the image fields of a binary read result.
 *
 * @param {Record<string, unknown>} out
 */
export function validateBinaryImageFields(out) {
  const hasContent = 'imageContent' in out;
  const hasOmitted = 'imageOmitted' in out;

  if (hasContent && hasOmitted) {
    fail(
      'SANDBOX_RESPONSE_INVALID',
      'binary result cannot both carry and omit image content',
    );
  }
  if (!hasContent && !hasOmitted) {
    if ('imageMimeType' in out) {
      fail('SANDBOX_RESPONSE_INVALID', 'binary imageMimeType without an image');
    }
    return;
  }
  if (!READ_IMAGE_MIME_TYPES.includes(/** @type {string} */ (out.imageMimeType))) {
    fail('SANDBOX_RESPONSE_INVALID', 'binary imageMimeType unsupported');
  }
  if (hasOmitted) {
    if (
      !READ_IMAGE_OMITTED_REASONS.includes(
        /** @type {string} */ (out.imageOmitted),
      )
    ) {
      fail('SANDBOX_RESPONSE_INVALID', 'binary imageOmitted reason unknown');
    }
    return;
  }
  const content = out.imageContent;
  if (typeof content !== 'string' || !BASE64_RE.test(content)) {
    fail('SANDBOX_RESPONSE_INVALID', 'binary imageContent is not base64');
  }
  // Compare decoded length against the budget, not the base64 length: the
  // budget is a statement about bytes handed to a provider.
  const decodedBytes = Math.floor((/** @type {string} */ (content).length * 3) / 4);
  if (decodedBytes > READ_IMAGE_MAX_BYTES) {
    fail('SANDBOX_RESPONSE_INVALID', 'binary imageContent exceeds image budget');
  }
}
