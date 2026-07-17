import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CALLER_TYPES,
  childSpanContext,
  createRequestContext,
  formatTraceparent,
  INTERNAL_CONTEXT_HEADERS,
  isSpanId,
  isTraceId,
  parseRequestContext,
  parseTraceparent,
  requestContextFromInternalHeaders,
  toInternalHeaders,
} from '../src/context/index.ts';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
const TRACE = 'b7e1f3a2c4d5060708090a0b0c0d0e0f';
const SPAN = '91a2b3c4d5e6f708';

describe('W3C trace fields (§6.2)', () => {
  it('validates trace-id and span-id shapes', () => {
    assert.equal(isTraceId(TRACE), true);
    assert.equal(isSpanId(SPAN), true);
    assert.equal(isTraceId('0'.repeat(32)), false);
    assert.equal(isSpanId('0'.repeat(16)), false);
    assert.equal(isTraceId('not-hex'), false);
  });

  it('parses and formats traceparent', () => {
    const raw = `00-${TRACE}-${SPAN}-01`;
    const parsed = parseTraceparent(raw);
    assert.ok(parsed);
    assert.equal(parsed?.traceId, TRACE);
    assert.equal(parsed?.spanId, SPAN);
    assert.equal(formatTraceparent({ traceId: TRACE, spanId: SPAN }), raw);
    assert.equal(parseTraceparent('01-' + TRACE + '-' + SPAN + '-01'), null);
    assert.equal(parseTraceparent('garbage'), null);
  });
});

describe('RequestContext (§6)', () => {
  it('requires org, user, trace, span, requestId, callerType', () => {
    const ok = parseRequestContext({
      orgId: ORG,
      userId: USER,
      traceId: TRACE,
      spanId: SPAN,
      requestId: '01K0G2PAV8FPMVC9QHJG7JPN70',
      callerType: 'web',
    });
    assert.equal(ok.ok, true);

    const missing = parseRequestContext({
      orgId: ORG,
      userId: USER,
      requestId: 'r1',
      callerType: 'web',
    });
    assert.equal(missing.ok, false);

    for (const callerType of CALLER_TYPES) {
      const r = parseRequestContext({
        orgId: ORG,
        userId: USER,
        traceId: TRACE,
        spanId: SPAN,
        requestId: 'req-1',
        callerType,
      });
      assert.equal(r.ok, true, callerType);
    }
  });

  it('validates optional resource ids as ULIDs', () => {
    const bad = parseRequestContext({
      orgId: ORG,
      userId: USER,
      conversationId: 'not-ulid',
      traceId: TRACE,
      spanId: SPAN,
      requestId: 'req-1',
      callerType: 'api',
    });
    assert.equal(bad.ok, false);
  });

  it('round-trips internal headers while preserving trace id', () => {
    const ctx = createRequestContext({
      orgId: ORG,
      userId: USER,
      conversationId: '01K0G2PAV8FPMVC9QHJG7JPN51',
      agentSessionId: '01K0G2PAV8FPMVC9QHJG7JPN52',
      runId: '01K0G2PAV8FPMVC9QHJG7JPN53',
      sandboxSessionId: '01K0G2PAV8FPMVC9QHJG7JPN55',
      traceId: TRACE,
      spanId: SPAN,
      requestId: '01K0G2PAV8FPMVC9QHJG7JPN70',
      callerType: 'worker',
      callerId: 'agent-worker-1',
    });

    const headers = toInternalHeaders(ctx);
    assert.equal(headers[INTERNAL_CONTEXT_HEADERS.orgId], ORG);
    assert.equal(headers[INTERNAL_CONTEXT_HEADERS.userId], USER);
    assert.equal(headers[INTERNAL_CONTEXT_HEADERS.runId], ctx.runId);
    assert.equal(
      headers[INTERNAL_CONTEXT_HEADERS.traceparent],
      `00-${TRACE}-${SPAN}-01`,
    );

    const restored = requestContextFromInternalHeaders(headers, {
      callerType: 'worker',
      callerId: 'agent-worker-1',
    });
    assert.equal(restored.ok, true);
    if (restored.ok) {
      assert.equal(restored.value.traceId, TRACE);
      assert.equal(restored.value.spanId, SPAN);
      assert.equal(restored.value.orgId, ORG);
      assert.equal(restored.value.runId, ctx.runId);
    }

    const child = childSpanContext(ctx, 'a1b2c3d4e5f60718');
    assert.equal(child.traceId, TRACE);
    assert.equal(child.spanId, 'a1b2c3d4e5f60718');
    assert.notEqual(child.spanId, ctx.spanId);
  });
});
