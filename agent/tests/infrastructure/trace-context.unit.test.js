import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertW3cTraceId,
  createTraceHeaders,
  createW3cTraceparent,
} from '../../src/infrastructure/sandbox/trace-context.js';

const TRACE_ID = '0123456789abcdef0123456789abcdef';

describe('sandbox W3C trace context', () => {
  it('creates a valid non-zero child span and preserves the durable trace id', () => {
    const headers = createTraceHeaders(TRACE_ID, {
      randomBytes: () => Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]),
    });
    assert.equal(headers['X-Trace-Id'], TRACE_ID);
    assert.equal(
      headers.traceparent,
      `00-${TRACE_ID}-0102030405060708-01`,
    );
    assert.match(
      headers.traceparent,
      /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/,
    );
  });

  it('rejects zero/malformed trace ids and an all-zero span', () => {
    assert.throws(() => assertW3cTraceId('0'.repeat(32)));
    assert.throws(() => createW3cTraceparent('not-a-trace'));
    assert.throws(() =>
      createW3cTraceparent(TRACE_ID, {
        randomBytes: () => new Uint8Array(8),
      }),
    );
  });
});

