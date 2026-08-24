/**
 * Success-shape validation for internal-plane read results.
 *
 * The sandbox is a separate service, so a 200 is not a promise about shape.
 * Every field the Agent goes on to use is copied through a fixed allowlist and
 * bounded here — unknown keys are dropped rather than forwarded, and a text
 * result is re-checked against the `maxBytes` the request asked for.
 */

import {
  SUCCESS_BINARY_KEYS,
  SUCCESS_TEXT_KEYS,
} from './internal-files-read-constants.js';
import {
  OPTIONAL_BINARY_KEYS,
  validateBinaryImageFields,
} from './internal-files-read-image.js';
import { fail } from './internal-sandbox-transport-error.js';
import { isPlainObject } from './internal-files-read-payload.js';

/**
 * @param {unknown} raw
 * @param {{ path: string, offset: number, limit: number, maxBytes: number }} command
 * @returns {Record<string, unknown>}
 */
export function filterFilesReadSuccessResult(raw, command) {
  if (!isPlainObject(raw)) {
    fail('SANDBOX_RESPONSE_INVALID', 'success result must be a JSON object');
  }
  const binary = raw.binary;
  if (binary === true) {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const k of SUCCESS_BINARY_KEYS) {
      if (!(k in raw)) {
        // Image fields ride along only when the content sniffed as one; every
        // other binary file keeps the original four-field shape.
        if (OPTIONAL_BINARY_KEYS.has(k)) continue;
        fail('SANDBOX_RESPONSE_INVALID', `missing binary result field ${k}`);
      }
      out[k] = raw[k];
    }
    if (typeof out.path !== 'string' || out.path !== command.path) {
      fail('SANDBOX_RESPONSE_INVALID', 'binary path must equal request path');
    }
    if (
      typeof out.size !== 'number' ||
      !Number.isSafeInteger(out.size) ||
      out.size < 0
    ) {
      fail('SANDBOX_RESPONSE_INVALID', 'binary size invalid');
    }
    if (typeof out.mimeType !== 'string') {
      fail('SANDBOX_RESPONSE_INVALID', 'binary mimeType invalid');
    }
    validateBinaryImageFields(out);
    return out;
  }
  if (binary === false) {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const k of SUCCESS_TEXT_KEYS) {
      if (!(k in raw)) {
        fail('SANDBOX_RESPONSE_INVALID', `missing text result field ${k}`);
      }
      out[k] = raw[k];
    }
    if (typeof out.path !== 'string' || out.path !== command.path) {
      fail('SANDBOX_RESPONSE_INVALID', 'text path must equal request path');
    }
    if (typeof out.content !== 'string') {
      fail('SANDBOX_RESPONSE_INVALID', 'text content invalid');
    }
    if (typeof out.truncated !== 'boolean') {
      fail('SANDBOX_RESPONSE_INVALID', 'text truncated invalid');
    }
    if (
      typeof out.offset !== 'number' ||
      !Number.isSafeInteger(out.offset) ||
      out.offset !== command.offset
    ) {
      fail('SANDBOX_RESPONSE_INVALID', 'text offset must equal request offset');
    }
    if (
      typeof out.limit !== 'number' ||
      !Number.isSafeInteger(out.limit) ||
      out.limit !== command.limit
    ) {
      fail('SANDBOX_RESPONSE_INVALID', 'text limit must equal request limit');
    }
    if (
      typeof out.size !== 'number' ||
      !Number.isSafeInteger(out.size) ||
      out.size < 0
    ) {
      fail('SANDBOX_RESPONSE_INVALID', 'text size invalid');
    }
    if (
      typeof out.returnedLines !== 'number' ||
      !Number.isSafeInteger(out.returnedLines) ||
      out.returnedLines < 0 ||
      out.returnedLines > command.limit
    ) {
      fail('SANDBOX_RESPONSE_INVALID', 'text returnedLines out of range');
    }
    const no = out.nextOffset;
    if (no !== null) {
      if (
        typeof no !== 'number' ||
        !Number.isSafeInteger(no) ||
        no < command.offset
      ) {
        fail('SANDBOX_RESPONSE_INVALID', 'text nextOffset invalid');
      }
    }
    if (typeof out.mimeType !== 'string') {
      fail('SANDBOX_RESPONSE_INVALID', 'text mimeType invalid');
    }
    let contentBytes;
    try {
      contentBytes = Buffer.byteLength(/** @type {string} */ (out.content), 'utf8');
    } catch {
      fail('SANDBOX_RESPONSE_INVALID', 'text content is not UTF-8 encodable');
    }
    if (contentBytes > command.maxBytes) {
      fail('SANDBOX_RESPONSE_INVALID', 'text content exceeds maxBytes');
    }
    return out;
  }
  fail('SANDBOX_RESPONSE_INVALID', 'result binary flag must be strict bool');
}
