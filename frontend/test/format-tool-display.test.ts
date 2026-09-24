import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatToolResultDisplay } from '../src/widgets/message-list/formatToolDisplay.ts';

test('tool result display unwraps structured stdout/stderr instead of [object Object]', () => {
  const text = formatToolResultDisplay({
    exitCode: 0,
    stdout: { text: 'REGRESSION_OK\n', truncated: false },
    stderr: { text: '', truncated: false },
  });
  assert.match(text, /REGRESSION_OK/);
  assert.doesNotMatch(text, /\[object Object\]/);
});
