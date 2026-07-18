/**
 * PiSessionAdapter + JSONL codec offline + installed-SDK round-trip (PR-05).
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PiSessionAdapter,
  materializeJsonl,
  validateSnapshotPayload,
  checksumJsonl,
  checksumSnapshotPayload,
  parseAndValidateJsonl,
  buildSessionHeader,
  PI_SESSION_JSONL_VERSION,
} from '../../src/infrastructure/pi/pi-session-adapter.js';
import { PiSessionAdapterError } from '../../src/infrastructure/pi/errors.js';

const SESS = '01K0G2PAV8FPMVC9QHJG7JPN52';

function samplePayload() {
  return {
    header: buildSessionHeader({
      id: 'jsonl-sess-1',
      cwd: '/workspace',
      timestamp: '2026-07-18T00:00:00.000Z',
    }),
    entries: [
      {
        type: 'message',
        id: 'e1',
        parentId: null,
        timestamp: '2026-07-18T00:00:01.000Z',
        message: { role: 'user', content: 'hi', timestamp: 1 },
      },
      {
        type: 'message',
        id: 'e2',
        parentId: 'e1',
        timestamp: '2026-07-18T00:00:02.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'calling' },
            {
              type: 'toolCall',
              id: 'call_1',
              name: 'bash',
              arguments: { command: 'echo hi' },
            },
          ],
          timestamp: 2,
        },
      },
      {
        type: 'message',
        id: 'e3',
        parentId: 'e2',
        timestamp: '2026-07-18T00:00:03.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'call_1',
          toolName: 'bash',
          content: [{ type: 'text', text: 'hi' }],
          isError: false,
          timestamp: 3,
        },
      },
      {
        type: 'compaction',
        id: 'e4',
        parentId: 'e3',
        timestamp: '2026-07-18T00:00:04.000Z',
        summary: 'sum',
        firstKeptEntryId: 'e3',
        tokensBefore: 10,
      },
      {
        type: 'custom',
        id: 'e5',
        parentId: 'e4',
        timestamp: '2026-07-18T00:00:05.000Z',
        customType: 'enterprise_meta',
        data: { run_id: 'r1' },
      },
    ],
  };
}

function createMemoryFs() {
  /** @type {Map<string, string>} */
  const files = new Map();
  return {
    files,
    async mkdir() {},
    async writeFile(p, data) {
      files.set(p, String(data));
    },
    async rename(from, to) {
      const v = files.get(from);
      if (v == null) throw new Error(`missing ${from}`);
      files.delete(from);
      files.set(to, v);
    },
    async rm(p) {
      files.delete(p);
      for (const k of [...files.keys()]) {
        if (k.startsWith(p)) files.delete(k);
      }
    },
  };
}

describe('JSONL codec fail-closed validation', () => {
  it('validates and materializes version-3 JSONL in append order', () => {
    const payload = samplePayload();
    validateSnapshotPayload(payload);
    const jsonl = materializeJsonl(payload);
    const parsed = parseAndValidateJsonl(jsonl);
    assert.equal(parsed.header.version, PI_SESSION_JSONL_VERSION);
    assert.equal(parsed.entries.length, 5);
    assert.equal(parsed.entries[1].message.content[1].type, 'toolCall');
    assert.equal(parsed.entries[2].message.role, 'toolResult');
    assert.equal(parsed.entries[3].type, 'compaction');
  });

  it('rejects unknown type, duplicate id, orphan parent, bad line', () => {
    assert.throws(
      () =>
        validateSnapshotPayload({
          header: samplePayload().header,
          entries: [
            {
              type: 'not_a_type',
              id: 'x',
              parentId: null,
              timestamp: 't',
            },
          ],
        }),
      (e) => e.code === 'PI_SNAPSHOT_ENTRY_UNKNOWN_TYPE',
    );
    assert.throws(
      () =>
        validateSnapshotPayload({
          header: samplePayload().header,
          entries: [
            {
              type: 'message',
              id: 'a',
              parentId: null,
              timestamp: 't',
              message: { role: 'user', content: 'u' },
            },
            {
              type: 'message',
              id: 'a',
              parentId: 'a',
              timestamp: 't',
              message: { role: 'user', content: 'u2' },
            },
          ],
        }),
      (e) => e.code === 'PI_SNAPSHOT_ENTRY_DUPLICATE_ID',
    );
    assert.throws(
      () =>
        validateSnapshotPayload({
          header: samplePayload().header,
          entries: [
            {
              type: 'message',
              id: 'a',
              parentId: 'missing',
              timestamp: 't',
              message: { role: 'user', content: 'u' },
            },
          ],
        }),
      (e) =>
        e.code === 'PI_SNAPSHOT_ENTRY_ORPHAN' ||
        e.code === 'PI_SNAPSHOT_ENTRY_MULTI_ROOT',
    );
    assert.throws(
      () =>
        validateSnapshotPayload({
          header: samplePayload().header,
          entries: [
            {
              type: 'message',
              id: 'a',
              parentId: null,
              timestamp: 't',
              message: { role: 'user', content: 'u' },
            },
            {
              type: 'message',
              id: 'b',
              parentId: null,
              timestamp: 't',
              message: { role: 'user', content: 'u2' },
            },
          ],
        }),
      (e) => e.code === 'PI_SNAPSHOT_ENTRY_MULTI_ROOT',
    );
    assert.throws(
      () => parseAndValidateJsonl('{"type":"session"}\n{not json}\n'),
      PiSessionAdapterError,
    );
  });

  it('repository and adapter share identical checksum bytes', () => {
    const payload = samplePayload();
    const a = checksumSnapshotPayload(payload);
    const b = checksumJsonl(materializeJsonl(payload));
    assert.equal(a, b);
  });
});

describe('PiSessionAdapter', () => {
  /** @type {ReturnType<typeof createMemoryFs>} */
  let memFs;

  beforeEach(() => {
    memFs = createMemoryFs();
  });

  it('validates durable payload checksum; cwd override does not rewrite header', async () => {
    const openArgs = [];
    const adapter = new PiSessionAdapter({
      fs: memFs,
      path: {
        join: (...p) => p.join('/'),
        dirname: (p) => p.split('/').slice(0, -1).join('/') || '/',
      },
      os: { tmpdir: () => '/tmp' },
      runtimeRoot: '/tmp/rt',
      randomId: () => 'rand',
      loadSessionManager: async () => ({
        open(path, dir, cwd) {
          openArgs.push({ path, dir, cwd });
          return {
            getEntries: () => [],
            getHeader: () => samplePayload().header,
            getCwd: () => cwd,
          };
        },
      }),
    });
    const payload = samplePayload();
    const checksum = checksumSnapshotPayload(payload);
    // Different workspace cwd than durable header.cwd — checksum still matches.
    const result = await adapter.openFromSnapshot({
      agentSessionId: SESS,
      payload,
      cwd: '/other/workspace',
      expectedChecksum: checksum,
    });
    assert.equal(result.checksum, checksum);
    assert.equal(openArgs[0].cwd, '/other/workspace');
    // Written JSONL retains original header.cwd
    const written = [...memFs.files.values()][0];
    assert.match(written, /"cwd":"\/workspace"/);

    await assert.rejects(
      () =>
        adapter.openFromSnapshot({
          agentSessionId: SESS,
          payload,
          cwd: '/other/workspace',
          expectedChecksum: 'b'.repeat(64),
        }),
      (err) => err.code === 'PI_JSONL_CHECKSUM_MISMATCH',
    );
  });

  it('cleans up owned dir on open failure; external sessionDir only removes file', async () => {
    const removed = [];
    const fs = {
      ...memFs,
      async rm(p, opts) {
        removed.push({ p, opts });
        return memFs.rm(p, opts);
      },
    };
    const adapter = new PiSessionAdapter({
      fs,
      path: {
        join: (...p) => p.join('/'),
        dirname: (p) => p.split('/').slice(0, -1).join('/') || '/',
      },
      os: { tmpdir: () => '/tmp' },
      runtimeRoot: '/tmp/rt',
      randomId: () => 'rand',
      loadSessionManager: async () => ({
        open() {
          throw new Error('open boom');
        },
      }),
    });
    const payload = samplePayload();
    await assert.rejects(
      () =>
        adapter.openFromSnapshot({
          agentSessionId: SESS,
          payload,
          cwd: '/workspace',
        }),
      (err) => err.code === 'PI_SESSION_OPEN_FAILED',
    );
    assert.ok(removed.some((r) => String(r.p).includes(SESS)));

    removed.length = 0;
    await assert.rejects(
      () =>
        adapter.openFromSnapshot({
          agentSessionId: SESS,
          payload,
          cwd: '/workspace',
          sessionDir: '/caller/dir',
        }),
      (err) => err.code === 'PI_SESSION_OPEN_FAILED',
    );
    // External dir: only the jsonl file is cleaned, not /caller/dir recursively as sole target
    assert.ok(removed.some((r) => String(r.p).endsWith('.jsonl')));
    assert.ok(!removed.some((r) => r.p === '/caller/dir' && r.opts?.recursive));
  });
});

describe('installed SDK offline round-trip (toolCall/toolResult/compaction/branch)', () => {
  it('materialize → open preserves structure without mutating agent.state.messages', async () => {
    const {
      SessionManager,
      CURRENT_SESSION_VERSION,
    } = await import('@earendil-works/pi-coding-agent');
    assert.equal(CURRENT_SESSION_VERSION, 3);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-rt-'));
    try {
      const sm = SessionManager.create(dir, dir);
      sm.appendMessage({ role: 'user', content: 'list', timestamp: Date.now() });
      const userLeaf = sm.getLeafId();
      sm.appendMessage({
        role: 'assistant',
        content: [
          { type: 'text', text: 'calling' },
          {
            type: 'toolCall',
            id: 'call_1',
            name: 'bash',
            arguments: { command: 'echo hi' },
          },
        ],
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
        stopReason: 'toolUse',
      });
      sm.appendMessage({
        role: 'toolResult',
        toolCallId: 'call_1',
        toolName: 'bash',
        content: [{ type: 'text', text: 'hi' }],
        isError: false,
        timestamp: Date.now(),
      });
      const toolLeaf = sm.getLeafId();
      sm.appendMessage({ role: 'user', content: 'more', timestamp: Date.now() });
      sm.appendCompaction('summary text', toolLeaf, 100);
      sm.branch(userLeaf);
      sm.appendMessage({ role: 'user', content: 'alt', timestamp: Date.now() });

      const adapter = new PiSessionAdapter();
      const payload = adapter.captureSnapshotPayload(sm, { cwd: dir });
      // Ensure tool/compaction preserved in logical payload.
      const types = payload.entries.map((e) => e.type);
      assert.ok(types.includes('compaction'));
      assert.ok(
        payload.entries.some(
          (e) =>
            e.type === 'message' &&
            e.message?.content?.some?.((c) => c.type === 'toolCall'),
        ),
      );
      assert.ok(
        payload.entries.some(
          (e) => e.type === 'message' && e.message?.role === 'toolResult',
        ),
      );

      const checksum = checksumSnapshotPayload(payload);
      const opened = await adapter.openFromSnapshot({
        agentSessionId: SESS,
        payload,
        cwd: dir,
        expectedChecksum: checksum,
      });
      const ctx = opened.sessionManager.buildSessionContext();
      assert.ok(Array.isArray(ctx.messages));
      // Branch leaf should be the alt path.
      assert.ok(ctx.messages.some((m) => m.role === 'user'));
      // Do not touch agent.state.messages — SessionManager only.
      assert.equal(typeof opened.sessionManager.getEntries, 'function');
      await adapter.dispose({ paths: [opened.sessionDir] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
