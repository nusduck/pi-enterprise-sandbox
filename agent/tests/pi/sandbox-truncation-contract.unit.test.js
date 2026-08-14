/**
 * sandbox-bridge bounds its tool output itself, because execution happens in
 * another service and Pi's file/bash tools never run. That leaves two questions
 * a test has to answer, not a comment:
 *
 *   1. Are the budgets still Pi's? (they must track the SDK, not a copy)
 *   2. Where the two truncators are supposed to agree, do they?
 *
 * The one deliberate divergence — a single over-wide line — is pinned here too,
 * so it reads as a decision rather than a bug someone should "fix" by swapping
 * in truncateHead.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  truncateLine,
} from '@earendil-works/pi-coding-agent';

import {
  DEFAULT_TOOL_OUTPUT_BYTES,
  DEFAULT_TOOL_OUTPUT_LINES,
  truncateToolOutput,
} from '../../src/extensions/sandbox-bridge/result.js';
import {
  MAX_EXEC_RESULT_BYTES,
  MAX_EXEC_STREAM_BYTES,
  MAX_EXEC_STREAM_LINES,
} from '../../src/extensions/sandbox-bridge/constants.js';
import { formatReadContentWithGutter } from '../../src/extensions/sandbox-bridge/tools/index.js';

describe('sandbox-bridge output budgets follow the SDK', () => {
  it('takes its per-result budget from Pi rather than a copied number', () => {
    assert.equal(DEFAULT_TOOL_OUTPUT_BYTES, DEFAULT_MAX_BYTES);
    assert.equal(DEFAULT_TOOL_OUTPUT_LINES, DEFAULT_MAX_LINES);
  });

  it('takes its per-stream budget from Pi too', () => {
    assert.equal(MAX_EXEC_STREAM_BYTES, DEFAULT_MAX_BYTES);
    assert.equal(MAX_EXEC_STREAM_LINES, DEFAULT_MAX_LINES);
  });

  it('keeps the exec envelope wide enough for two full streams', () => {
    // bash/python return stdout and stderr in one JSON result. If the envelope
    // is not bigger than both streams together, a noisy command collapses into
    // the result_bytes fallback and the model loses the actual output.
    assert.ok(
      MAX_EXEC_RESULT_BYTES > MAX_EXEC_STREAM_BYTES * 2,
      `${MAX_EXEC_RESULT_BYTES} must exceed 2x${MAX_EXEC_STREAM_BYTES}`,
    );
  });
});

describe('sandbox truncation agrees with Pi where it should', () => {
  /** @param {string} content @param {object} opts */
  function bothWays(content, opts) {
    return {
      ours: truncateToolOutput(content, opts),
      sdk: truncateHead(content, opts),
    };
  }

  it('leaves content under budget untouched', () => {
    const content = 'alpha\nbeta\ngamma';
    const { ours, sdk } = bothWays(content, { maxLines: 10, maxBytes: 1000 });
    assert.equal(ours.text, content);
    assert.equal(sdk.content, content);
    assert.equal(ours.truncated, false);
    assert.equal(sdk.truncated, false);
  });

  it('cuts at the same place on a line-count limit', () => {
    const content = Array.from({ length: 20 }, (_, i) => `line-${i}`).join('\n');
    const { ours, sdk } = bothWays(content, { maxLines: 5, maxBytes: 100_000 });
    assert.equal(ours.text, sdk.content);
    assert.equal(ours.truncatedBy, 'lines');
    assert.equal(sdk.truncatedBy, 'lines');
    assert.equal(ours.outputLines, sdk.outputLines);
  });

  it('cuts at the same place on a byte limit that lands on a line boundary', () => {
    const content = ['aaaa', 'bbbb', 'cccc', 'dddd'].join('\n');
    // 'aaaa\nbbbb' is exactly 9 bytes.
    const { ours, sdk } = bothWays(content, { maxLines: 100, maxBytes: 9 });
    assert.equal(ours.text, sdk.content);
    assert.equal(ours.truncatedBy, 'bytes');
    assert.equal(sdk.truncatedBy, 'bytes');
  });

  it('reports the same totals', () => {
    const content = 'one\ntwo\nthree';
    const { ours, sdk } = bothWays(content, { maxLines: 1, maxBytes: 100 });
    assert.equal(ours.totalBytes, sdk.totalBytes);
    assert.equal(ours.totalLines, sdk.totalLines);
  });

  it('DIVERGES on a single over-wide line, on purpose', () => {
    // A minified bundle or one-line CSV is normal in a workspace. Pi hands the
    // model nothing for it; we hand back the prefix that fits and say so, and
    // report completedLines=0 so read pagination cannot skip the unread rest.
    const content = 'x'.repeat(100);
    const ours = truncateToolOutput(content, { maxLines: 10, maxBytes: 20 });
    const sdk = truncateHead(content, { maxLines: 10, maxBytes: 20 });

    assert.equal(sdk.content, '', 'SDK behaviour: empty');
    assert.equal(sdk.firstLineExceedsLimit, true);

    assert.equal(ours.text, 'x'.repeat(20), 'ours: the prefix that fits');
    assert.equal(ours.partialLine, true);
    assert.equal(
      ours.completedLines,
      0,
      'a partial line must not advance the read offset',
    );
  });

  it('never splits a multi-byte character when it diverges', () => {
    const content = '€'.repeat(10); // 3 bytes each
    const ours = truncateToolOutput(content, { maxLines: 10, maxBytes: 7 });
    assert.equal(ours.text, '€€', 'two whole characters fit in 7 bytes');
    assert.equal(Buffer.byteLength(ours.text, 'utf8'), 6);
  });
});

describe('read gutter uses the SDK line clamp', () => {
  it('marks an over-wide line exactly the way Pi does', () => {
    const long = 'y'.repeat(50);
    const rendered = formatReadContentWithGutter(long, 0, 10);
    const expected = truncateLine(long, 10).text;
    assert.equal(rendered, `1|${expected}`);
    assert.match(rendered, /\.\.\. \[truncated\]$/);
  });

  it('numbers lines from the 0-based page offset', () => {
    const rendered = formatReadContentWithGutter('a\nb', 41, 100);
    assert.equal(rendered, '42|a\n43|b');
  });
});
