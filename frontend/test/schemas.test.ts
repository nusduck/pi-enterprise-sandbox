/**
 * Zod schema validation for typed API client.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ConversationListSchema,
  EnsureSessionSchema,
  AuthResponseSchema,
  ArtifactListSchema,
  parseApi,
  SSEEventSchema,
} from '../src/shared/schemas/api.ts';

describe('API schemas', () => {
  it('parses conversation list', () => {
    const data = parseApi(
      ConversationListSchema,
      [{ id: 'c1', title: 'Hello', sandbox_session_id: 's1' }],
      'list',
    );
    assert.equal(data.length, 1);
    assert.equal(data[0].id, 'c1');
  });

  it('parses ensure session', () => {
    const data = parseApi(
      EnsureSessionSchema,
      {
        conversation_id: 'c1',
        session_id: 'sess_1',
        trace_id: 't1',
      },
      'ensure',
    );
    assert.equal(data.conversation_id, 'c1');
    assert.equal(data.session_id, 'sess_1');
  });

  it('parses auth response with token', () => {
    const data = parseApi(
      AuthResponseSchema,
      { token: 'abc', user: { username: 'alice' } },
      'auth',
    );
    assert.equal(data.token, 'abc');
    assert.equal(data.user?.username, 'alice');
  });

  it('parses artifact list object and array shapes', () => {
    const arr = parseApi(ArtifactListSchema, [{ artifact_id: 'a1', name: 'x' }], 'arts');
    assert.ok(Array.isArray(arr));
    const obj = parseApi(
      ArtifactListSchema,
      { artifacts: [{ id: 'a2' }], total: 1 },
      'arts-obj',
    );
    assert.ok(!Array.isArray(obj));
    assert.equal(obj.total, 1);
  });

  it('SSE event schema requires type', () => {
    const ok = SSEEventSchema.safeParse({ type: 'token', text: 'hi' });
    assert.equal(ok.success, true);
    const bad = SSEEventSchema.safeParse({ text: 'no type' });
    assert.equal(bad.success, false);
  });
});
