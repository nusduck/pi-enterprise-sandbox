/**
 * B1 session persistence: materialize/open, multi-turn restore, compaction,
 * tool call/result, fail-closed restore.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import {
  SessionRestoreError,
  buildJsonlFromResume,
  collectNewEntries,
  createNewPersistedSession,
  mapSdkEntryType,
  materializeSessionFile,
  openSessionFromResume,
  normalizeSessionHeaderCwd,
  toPersistableEntries,
  isForceInMemory,
} from '../services/session-persistence.js';

function assistantWithTool(text, toolId = 'tc1') {
  return {
    role: 'assistant',
    content: [
      { type: 'text', text },
      { type: 'toolCall', id: toolId, name: 'bash', arguments: { command: 'ls' } },
    ],
    timestamp: Date.now(),
    api: 'openai-completions',
    provider: 'test',
    model: 'test-model',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'toolUse',
  };
}

function toolResult(toolId = 'tc1', text = 'ok') {
  return {
    role: 'toolResult',
    toolCallId: toolId,
    toolName: 'bash',
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: Date.now(),
  };
}

describe('mapSdkEntryType', () => {
  it('maps message roles and special entry types', () => {
    assert.equal(
      mapSdkEntryType({ type: 'message', message: { role: 'user' } }),
      'user_message',
    );
    assert.equal(
      mapSdkEntryType({ type: 'message', message: { role: 'assistant' } }),
      'assistant_message',
    );
    assert.equal(
      mapSdkEntryType({ type: 'message', message: { role: 'toolResult' } }),
      'tool_result',
    );
    assert.equal(mapSdkEntryType({ type: 'compaction' }), 'compaction');
    assert.equal(mapSdkEntryType({ type: 'branch_summary' }), 'branch');
    assert.equal(mapSdkEntryType({ type: 'model_change' }), 'model_change');
    assert.equal(mapSdkEntryType({ type: 'custom', customType: 'x' }), 'custom');
  });
});

describe('materialize + openSessionFromResume', () => {
  /** @type {string} */
  let workDir;
  /** @type {ReturnType<typeof createNewPersistedSession>} */
  let created;

  before(() => {
    workDir = mkdtempSync(join(tmpdir(), 'b1-sess-test-'));
  });

  after(() => {
    if (created?.cleanup) created.cleanup();
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('round-trips multi-turn tool call/result via JSONL materialize', () => {
    created = createNewPersistedSession({ cwd: '/tmp' });
    const sm = created.sessionManager;
    sm.appendMessage({ role: 'user', content: 'turn1', timestamp: Date.now() });
    sm.appendMessage(assistantWithTool('calling tool'));
    sm.appendMessage(toolResult('tc1', 'file.txt'));
    sm.appendMessage({ role: 'user', content: 'turn2', timestamp: Date.now() });
    sm.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
      timestamp: Date.now(),
      api: 'openai-completions',
      provider: 'test',
      model: 'test-model',
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
    });

    const entries = sm.getEntries();
    const header = sm.getHeader();
    assert.ok(header);
    assert.ok(entries.length >= 5);

    const persistable = toPersistableEntries(entries);
    assert.equal(persistable[0].entry_type, 'user_message');
    assert.ok(persistable.some((e) => e.entry_type === 'tool_result'));
    assert.ok(persistable.some((e) => e.entry_type === 'assistant_message'));

    // Simulate DB resume payload
    const resume = {
      session: {
        id: 'asess_test',
        conversation_id: 'conv1',
        header_payload: header,
        sdk_session_id: sm.getSessionId(),
      },
      entries: persistable.map((e, i) => ({
        id: e.id,
        sequence: i + 1,
        entry_type: e.entry_type,
        entry_payload: e.entry_payload,
      })),
    };

    const opened = openSessionFromResume(resume, { conversationId: 'conv1' });
    try {
      const restored = opened.sessionManager.getEntries();
      assert.equal(restored.length, entries.length);

      const ctx = opened.sessionManager.buildSessionContext();
      const roles = ctx.messages.map((m) => m.role);
      assert.ok(roles.includes('user'));
      assert.ok(roles.includes('assistant') || roles.includes('toolResult'));

      // Tool call + result present in restored tree
      const toolResults = restored.filter(
        (e) => e.type === 'message' && e.message?.role === 'toolResult',
      );
      assert.equal(toolResults.length, 1);
      assert.equal(toolResults[0].message.toolCallId, 'tc1');
      assert.equal(toolResults[0].message.content[0].text, 'file.txt');

      const assistants = restored.filter(
        (e) => e.type === 'message' && e.message?.role === 'assistant',
      );
      const hasToolCall = assistants.some((e) =>
        (e.message.content || []).some((c) => c.type === 'toolCall'),
      );
      assert.ok(hasToolCall, 'assistant toolCall must survive restore');
    } finally {
      opened.cleanup();
    }
  });

  it('restores compaction entry after restart-style rematerialize', () => {
    const sm = SessionManager.create('/tmp', workDir);
    sm.appendMessage({ role: 'user', content: 'long history', timestamp: Date.now() });
    sm.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'a1' }],
      timestamp: Date.now(),
      api: 'openai-completions',
      provider: 'test',
      model: 'm',
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
    });
    const leaf = sm.getLeafId();
    sm.appendCompaction('summary of prior work', leaf, 999);

    const resume = {
      session: {
        id: 'asess_comp',
        header_payload: sm.getHeader(),
        sdk_session_id: sm.getSessionId(),
      },
      entries: toPersistableEntries(sm.getEntries()).map((e, i) => ({
        ...e,
        sequence: i + 1,
      })),
      jsonl: buildJsonlFromResume({
        header: sm.getHeader(),
        entries: toPersistableEntries(sm.getEntries()).map((e) => ({
          entry_payload: e.entry_payload,
        })),
      }),
    };

    const opened = openSessionFromResume(resume);
    try {
      const types = opened.sessionManager.getEntries().map((e) => e.type);
      assert.ok(types.includes('compaction'));
      const ctx = opened.sessionManager.buildSessionContext();
      // Compaction summary participates in context
      assert.ok(
        ctx.messages.some(
          (m) => m.role === 'compactionSummary' || m.role === 'assistant' || m.role === 'user',
        ),
      );
    } finally {
      opened.cleanup();
    }
  });

  it('fail-closed: empty JSONL throws SessionRestoreError (no silent empty session)', () => {
    assert.throws(
      () => openSessionFromResume({ session: { id: 'x' }, entries: [], jsonl: '' }),
      (err) => err instanceof SessionRestoreError,
    );
  });

  it('fail-closed: corrupt JSONL throws SessionRestoreError', () => {
    const dir = mkdtempSync(join(tmpdir(), 'b1-bad-'));
    const file = join(dir, 'bad.jsonl');
    writeFileSync(file, 'not-json\n', 'utf8');
    try {
      assert.throws(
        () => {
          // open via materialize path with invalid content that is non-empty
          const resume = {
            session: { id: 'bad' },
            jsonl: 'this is not a valid session header\n',
          };
          openSessionFromResume(resume);
        },
        (err) => err instanceof SessionRestoreError,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('materializeSessionFile rejects empty content', () => {
    assert.throws(
      () => materializeSessionFile(''),
      (err) => err instanceof SessionRestoreError,
    );
  });

  it('collectNewEntries diffs by already-persisted count', () => {
    const handle = createNewPersistedSession({ cwd: '/tmp' });
    try {
      handle.sessionManager.appendMessage({
        role: 'user',
        content: 'u1',
        timestamp: Date.now(),
      });
      const first = collectNewEntries(handle.sessionManager, 0);
      assert.equal(first.entries.length, 1);
      handle.sessionManager.appendMessage({
        role: 'user',
        content: 'u2',
        timestamp: Date.now(),
      });
      const second = collectNewEntries(handle.sessionManager, first.totalCount);
      assert.equal(second.entries.length, 1);
      assert.equal(second.entries[0].entry_payload.message.content, 'u2');
    } finally {
      handle.cleanup();
    }
  });

  it('same conversation logical session: create then reopen keeps one sdk session id', () => {
    const handle = createNewPersistedSession({ cwd: '/tmp' });
    try {
      const sdkId = handle.sessionManager.getSessionId();
      handle.sessionManager.appendMessage({
        role: 'user',
        content: 't1',
        timestamp: Date.now(),
      });
      handle.sessionManager.appendMessage(assistantWithTool('a1'));
      handle.sessionManager.appendMessage(toolResult());

      const resume = {
        session: {
          id: 'asess_one',
          header_payload: handle.sessionManager.getHeader(),
          sdk_session_id: sdkId,
        },
        entries: toPersistableEntries(handle.sessionManager.getEntries()).map(
          (e, i) => ({ ...e, sequence: i + 1 }),
        ),
      };
      const opened = openSessionFromResume(resume);
      try {
        assert.equal(opened.sessionManager.getSessionId(), sdkId);
        // Second turn appends on same session
        opened.sessionManager.appendMessage({
          role: 'user',
          content: 't2',
          timestamp: Date.now(),
        });
        assert.equal(opened.sessionManager.getSessionId(), sdkId);
        assert.ok(opened.sessionManager.getEntries().length >= 4);
      } finally {
        opened.cleanup();
      }
    } finally {
      handle.cleanup();
    }
  });
});

describe('isForceInMemory', () => {
  it('reads env flag', () => {
    assert.equal(isForceInMemory({}), false);
    assert.equal(isForceInMemory({ AGENT_FORCE_INMEMORY: 'true' }), true);
    assert.equal(isForceInMemory({ AGENT_FORCE_INMEMORY: '1' }), true);
    assert.equal(isForceInMemory({ AGENT_FORCE_INMEMORY: 'false' }), false);
  });
});

describe('buildJsonlFromResume', () => {
  it('prefers jsonl field when present', () => {
    const j = buildJsonlFromResume({ jsonl: '{"type":"session"}\n' });
    assert.ok(j.includes('session'));
  });

  it('normalizes the materialized header cwd without changing entries', () => {
    const input = [
      JSON.stringify({ type: 'session', id: 'x', version: 3, cwd: '/tmp' }),
      JSON.stringify({ type: 'message', id: 'm1', message: { role: 'user' } }),
      '',
    ].join('\n');
    const normalized = normalizeSessionHeaderCwd(
      input,
      '/home/sandbox/workspace',
    );
    const lines = normalized.trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(lines[0].cwd, '/home/sandbox/workspace');
    assert.deepEqual(lines[1], JSON.parse(input.trim().split('\n')[1]));
  });

  it('builds from header + entries', () => {
    const j = buildJsonlFromResume({
      header: { type: 'session', id: 'x', version: 3, timestamp: 't', cwd: '/tmp' },
      entries: [
        {
          entry_payload: {
            type: 'message',
            id: '1',
            parentId: null,
            message: { role: 'user', content: 'hi' },
          },
        },
      ],
    });
    const lines = j.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).id, 'x');
  });
});
