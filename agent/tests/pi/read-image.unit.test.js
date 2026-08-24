/**
 * Inline image reads.
 *
 * A run that renders a chart could not show it to the model: every binary file
 * came back as `{binary:true}` with no bytes, so the only way to "see" an image
 * was to OCR it. These pin the shape the model now receives, and the two ways
 * an image is withheld — over budget, or a model that cannot take one.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildReadImageResult,
  nonVisionImageNote,
} from '../../src/extensions/sandbox-bridge/tools/read-image.js';
import { MAX_READ_IMAGE_BYTES } from '../../src/extensions/sandbox-bridge/constants.js';

/** 1x1 red PNG. */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const VISION_MODEL = { id: 'deepseek-v4-flash-vision-exp', input: ['text', 'image'] };
const TEXT_MODEL = { id: 'deepseek-v4-flash', input: ['text'] };

const OPTS = { model: VISION_MODEL, maxBytes: MAX_READ_IMAGE_BYTES };

function partsOf(result) {
  return result.content.map((part) => part.type);
}

describe('nonVisionImageNote', () => {
  it('warns for a text-only model', () => {
    assert.match(String(nonVisionImageNote(TEXT_MODEL)), /does not support images/);
  });

  it('stays silent for a vision model', () => {
    assert.equal(nonVisionImageNote(VISION_MODEL), null);
  });

  it('stays silent when the model is unknown', () => {
    // Teaching the model a limit it may not have is worse than letting the
    // provider refuse: an unknown model is not assumed blind.
    assert.equal(nonVisionImageNote(null), null);
    assert.equal(nonVisionImageNote({ id: 'x' }), null);
  });
});

describe('buildReadImageResult', () => {
  it('returns null for a result carrying no image', async () => {
    // Every non-image binary keeps its existing JSON envelope.
    assert.equal(await buildReadImageResult({ binary: true, size: 12 }, '/w/a.bin', OPTS), null);
    assert.equal(await buildReadImageResult({}, '/w/a.bin', OPTS), null);
  });

  it('hands a vision model real ImageContent', async () => {
    const result = await buildReadImageResult(
      { imageContent: PNG_B64, imageMimeType: 'image/png' },
      '/home/sandbox/workspace/chart.png',
      OPTS,
    );
    assert.deepEqual(partsOf(result), ['text', 'image']);
    const image = result.content[1];
    assert.equal(image.mimeType, 'image/png');
    assert.ok(image.data.length > 0);
    assert.match(result.content[0].text, /Read image file \[image\/png\]/);
    assert.match(result.content[0].text, /chart\.png/);
  });

  it('never sends bytes to a model that cannot take them', async () => {
    const result = await buildReadImageResult(
      { imageContent: PNG_B64, imageMimeType: 'image/png' },
      '/home/sandbox/workspace/chart.png',
      { model: TEXT_MODEL, maxBytes: MAX_READ_IMAGE_BYTES },
    );
    assert.deepEqual(partsOf(result), ['text']);
    assert.match(result.content[0].text, /does not support images/);
  });

  it('reports an oversize image as actionable text, not silence', async () => {
    const result = await buildReadImageResult(
      { imageOmitted: 'IMAGE_TOO_LARGE', imageMimeType: 'image/png', size: 9_000_000 },
      '/home/sandbox/workspace/huge.png',
      OPTS,
    );
    assert.deepEqual(partsOf(result), ['text']);
    assert.match(result.content[0].text, /9000000 bytes exceeds the 2MB inline limit/);
    // The model has python in the sandbox; tell it what to do next.
    assert.match(result.content[0].text, /Downscale it first/);
  });
});
