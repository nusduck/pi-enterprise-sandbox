/**
 * Image fields on a binary read result are re-checked on arrival.
 *
 * The sandbox enforces the inline budget, but it is a separate service across
 * a network boundary: an unbounded or malformed `imageContent` would otherwise
 * flow straight into a provider request as image content.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { filterFilesReadSuccessResult } from '../../src/infrastructure/sandbox/internal-files-read-result.js';
import { READ_IMAGE_MAX_BYTES } from '../../src/infrastructure/sandbox/internal-files-read-constants.js';

const COMMAND = {
  path: '/home/sandbox/workspace/chart.png',
  offset: 0,
  limit: 100,
  maxBytes: 256 * 1024,
};

function binaryResult(extra = {}) {
  return {
    path: COMMAND.path,
    binary: true,
    size: 1024,
    mimeType: 'image/png',
    ...extra,
  };
}

describe('binary read results with image fields', () => {
  it('passes a well-formed image through', () => {
    const out = filterFilesReadSuccessResult(
      binaryResult({ imageMimeType: 'image/png', imageContent: 'aGVsbG8=' }),
      COMMAND,
    );
    assert.equal(out.imageMimeType, 'image/png');
    assert.equal(out.imageContent, 'aGVsbG8=');
  });

  it('leaves a plain binary result untouched', () => {
    const out = filterFilesReadSuccessResult(binaryResult(), COMMAND);
    assert.deepEqual(Object.keys(out).sort(), ['binary', 'mimeType', 'path', 'size']);
  });

  it('passes a declared omission through', () => {
    const out = filterFilesReadSuccessResult(
      binaryResult({ imageMimeType: 'image/png', imageOmitted: 'IMAGE_TOO_LARGE' }),
      COMMAND,
    );
    assert.equal(out.imageOmitted, 'IMAGE_TOO_LARGE');
    assert.equal('imageContent' in out, false);
  });

  it('rejects content past the image budget', () => {
    // 4/3 expansion: this base64 decodes to more than the budget allows.
    const oversize = 'A'.repeat(Math.ceil((READ_IMAGE_MAX_BYTES + 1024) * 4) / 3);
    assert.throws(
      () =>
        filterFilesReadSuccessResult(
          binaryResult({ imageMimeType: 'image/png', imageContent: oversize }),
          COMMAND,
        ),
      /exceeds image budget/,
    );
  });

  it('rejects content that is not base64', () => {
    assert.throws(
      () =>
        filterFilesReadSuccessResult(
          binaryResult({ imageMimeType: 'image/png', imageContent: 'not base64!!' }),
          COMMAND,
        ),
      /not base64/,
    );
  });

  it('rejects an unsupported image type', () => {
    assert.throws(
      () =>
        filterFilesReadSuccessResult(
          binaryResult({ imageMimeType: 'image/svg+xml', imageContent: 'aGk=' }),
          COMMAND,
        ),
      /imageMimeType unsupported/,
    );
  });

  it('rejects an unknown omission reason', () => {
    assert.throws(
      () =>
        filterFilesReadSuccessResult(
          binaryResult({ imageMimeType: 'image/png', imageOmitted: 'BECAUSE' }),
          COMMAND,
        ),
      /imageOmitted reason unknown/,
    );
  });

  it('rejects carrying and omitting at once', () => {
    assert.throws(
      () =>
        filterFilesReadSuccessResult(
          binaryResult({
            imageMimeType: 'image/png',
            imageContent: 'aGk=',
            imageOmitted: 'IMAGE_TOO_LARGE',
          }),
          COMMAND,
        ),
      /both carry and omit/,
    );
  });

  it('rejects a type with no image behind it', () => {
    assert.throws(
      () =>
        filterFilesReadSuccessResult(
          binaryResult({ imageMimeType: 'image/png' }),
          COMMAND,
        ),
      /imageMimeType without an image/,
    );
  });
});
