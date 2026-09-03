/**
 * A text-only model with an image attached must not kill the run.
 *
 * The executor used to return FAILED with "does not support image input",
 * throwing away the user's typed question along with the picture. The images
 * are dropped and the model is told why, mirroring the note Pi's own read tool
 * emits for a non-vision model.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { appendNonVisionImageNotice } from '../../src/application/dsh-run-input.js';

const IMAGES = [
  { attachmentId: 'a1', mimeType: 'image/png', name: 'invoice.png', size: 100 },
  { attachmentId: 'a2', mimeType: 'image/jpeg', name: 'chart.jpg', size: 200 },
];

describe('appendNonVisionImageNotice', () => {
  it('is a no-op when no images were dropped', () => {
    // The executor passes [] for a vision-capable model, so this is the
    // ordinary path, not an edge case.
    assert.equal(appendNonVisionImageNotice('hi', [], 'm1'), 'hi');
    assert.equal(appendNonVisionImageNotice('hi', null, 'm1'), 'hi');
  });

  it('appends to a string prompt without losing the user text', () => {
    const out = appendNonVisionImageNotice('what does this say?', IMAGES, 'deepseek-v4-flash');
    assert.match(out, /^what does this say\?/);
    assert.match(out, /2 image attachment\(s\) omitted/);
    assert.match(out, /deepseek-v4-flash/);
  });

  it('names the files so the model can still act on them', () => {
    const out = appendNonVisionImageNotice('x', IMAGES, 'm1');
    assert.match(out, /invoice\.png/);
    assert.match(out, /chart\.jpg/);
    assert.match(out, /readable as files/);
  });

  it('appends a text part to a structured prompt', () => {
    const out = appendNonVisionImageNotice(
      [{ type: 'text', text: 'hello' }],
      IMAGES,
      'm1',
    );
    assert.equal(out.length, 2);
    assert.equal(out[0].text, 'hello');
    assert.equal(out[1].type, 'text');
    assert.match(out[1].text, /omitted/);
  });
});
