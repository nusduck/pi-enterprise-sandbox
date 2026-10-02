/**
 * Zod schema validation for typed API client.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ConversationListSchema,
  EnsureSessionSchema,
  AuthResponseSchema,
  ArtifactImportResponseSchema,
  ArtifactListSchema,
  parseApi,
} from '../src/shared/schemas/api.ts';

describe('API schemas', () => {
  // 会话列表响应在 §2.4 之后是 `{ conversations, next_cursor }`，不再是裸数组。
  // 这里用 `parse` 而不是 `parseApi`：软失败会把原始 body 原样放行，形状断言就失去意义。
  it('parses conversation list', () => {
    const data = ConversationListSchema.parse({
      conversations: [{ id: 'c1', title: 'Hello', sandbox_session_id: 's1' }],
      next_cursor: 'cur_2',
    });
    assert.equal(data.conversations.length, 1);
    assert.equal(data.conversations[0].id, 'c1');
    assert.equal(data.next_cursor, 'cur_2');
  });

  it('treats a conversation page with next_cursor null as the last page', () => {
    const data = ConversationListSchema.parse({
      conversations: [{ id: 'c1' }],
      next_cursor: null,
    });
    assert.equal(data.next_cursor, null);
  });

  it('defaults a missing next_cursor to null, never to undefined', () => {
    // `next_cursor` 是「还有没有下一页」的唯一信号：缺字段只能读成「到底」，
    // 读成 undefined 会让 `!== null` 的判断以为还能翻页。
    const data = ConversationListSchema.parse({ conversations: [] });
    assert.equal(data.next_cursor, null);
  });

  it('keeps the server-bound Agent version and fixed model policy', () => {
    const data = ConversationListSchema.parse({
      conversations: [{
        id: 'c1',
        agent_id: 'agent-1',
        agent_version_id: 'version-2',
        agent_version_no: 2,
        model_policy: { fixed_model_id: 'deepseek-v4-pro' },
      }],
      next_cursor: null,
    });
    assert.equal(data.conversations[0].agent_version_id, 'version-2');
    assert.equal(data.conversations[0].agent_version_no, 2);
    assert.equal(data.conversations[0].model_policy?.fixed_model_id, 'deepseek-v4-pro');
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

  it('parses auth response without exposing a token', () => {
    const data = parseApi(
      AuthResponseSchema,
      { token: 'abc', user: { username: 'alice' } },
      'auth',
    );
    assert.equal('token' in data, false);
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

  it('parses an Artifact import workspace input', () => {
    const parsed = ArtifactImportResponseSchema.parse({
      import_id: 'import_1',
      artifact_id: 'artifact_1',
      target_session_id: 'session_2',
      target_conversation_id: 'conversation_2',
      workspace_file: {
        name: 'report.pdf',
        path: 'imports/import_1/report.pdf',
        mime_type: 'application/pdf',
        size: 42,
        sha256: 'a'.repeat(64),
      },
    });
    assert.equal(parsed.workspace_file.path, 'imports/import_1/report.pdf');
  });
});
