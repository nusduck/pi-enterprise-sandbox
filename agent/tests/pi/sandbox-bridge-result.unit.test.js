import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  toolResultJson,
  truncateToolOutput,
} from '../../src/extensions/sandbox-bridge/result.js';

describe('sandbox bridge model-facing output bounds', () => {
  it('keeps a byte-truncated UTF-8 result valid and explicit', () => {
    const result = truncateToolOutput('你'.repeat(100), { maxBytes: 31, maxLines: 20 });

    assert.equal(result.truncated, true);
    assert.equal(result.truncatedBy, 'bytes');
    assert.ok(Buffer.byteLength(result.text, 'utf8') <= 31);
    assert.equal(result.text, '你'.repeat(10));
    assert.equal(result.totalBytes, 300);
    assert.equal(result.completedLines, 0);
    assert.equal(result.partialLine, true);
  });

  it('reports line truncation with a usable bounded prefix', () => {
    const result = truncateToolOutput('one\ntwo\nthree', { maxBytes: 1024, maxLines: 2 });

    assert.deepEqual(
      { text: result.text, truncated: result.truncated, truncatedBy: result.truncatedBy },
      { text: 'one\ntwo', truncated: true, truncatedBy: 'lines' },
    );
    assert.equal(result.totalLines, 3);
    assert.equal(result.completedLines, 2);
  });

  it('never returns malformed JSON when an unexpected payload exceeds the cap', () => {
    const text = toolResultJson({ output: 'x'.repeat(60 * 1024) });
    const parsed = JSON.parse(text);

    assert.equal(parsed.truncated, true);
    assert.equal(parsed.truncatedBy, 'result_bytes');
    assert.equal(typeof parsed.preview, 'string');
  });
});
