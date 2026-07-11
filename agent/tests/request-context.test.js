/**
 * Request-scoped sandbox client + tools — concurrent chat contexts must not
 * cross-talk on traceId, sessionId, or approval notifier.
 *
 * Run: node --test agent/tests/request-context.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSandboxClient,
  setTraceId as setClientTraceId,
  getTraceId as getClientTraceId,
  ensureTraceId,
} from '../services/sandbox-client.js';
import {
  createSandboxTools,
  setSandboxSessionId,
  getSandboxSessionId,
  setApprovalNotifier,
} from '../sandbox-tools.js';

function mockClient(label) {
  const calls = [];
  const notifs = [];
  return {
    label,
    calls,
    notifs,
    getTraceId: () => label,
    async writeFile(sessionId, path, content) {
      calls.push({ op: 'writeFile', sessionId, path, content, trace: label });
      return { size: content.length, path };
    },
    async readFile(sessionId, path) {
      calls.push({ op: 'readFile', sessionId, path, trace: label });
      return { content: `content-of-${path}`, size: 10 };
    },
    async readFileWithRange(sessionId, path, offset, limit) {
      calls.push({ op: 'readFileWithRange', sessionId, path, offset, limit, trace: label });
      return { content: 'ranged', size: 6, truncated: false };
    },
    async executeCommand(sessionId, command, timeout) {
      calls.push({ op: 'executeCommand', sessionId, command, timeout, trace: label });
      return { exit_code: 0, stdout_preview: 'ok', stderr_preview: '', duration_ms: 1 };
    },
    async approvalCheck(sessionId, body) {
      calls.push({ op: 'approvalCheck', sessionId, body, trace: label });
      // Force pending path so notifier is exercised for bash
      if (body.tool_name === 'bash' && String(body.command || '').includes('need-approval')) {
        return {
          status: 'pending_approval',
          approval_id: `appr-${label}`,
          reason: 'high risk',
          risk_level: 'high',
        };
      }
      return { status: 'approved', risk_level: 'low' };
    },
    async getApproval(approvalId) {
      calls.push({ op: 'getApproval', approvalId, trace: label });
      return { status: 'approved', approval_id: approvalId };
    },
    async submitArtifact(sessionId, name, path, mime) {
      calls.push({ op: 'submitArtifact', sessionId, name, path, mime, trace: label });
      return { artifact_id: `art-${label}`, name, path, mime_type: mime, size: 1 };
    },
  };
}

describe('createSandboxClient request isolation', () => {
  it('keeps distinct trace ids on concurrent clients', async () => {
    const a = createSandboxClient({ traceId: 'trace-aaa' });
    const b = createSandboxClient({ traceId: 'trace-bbb' });
    assert.equal(a.getTraceId(), 'trace-aaa');
    assert.equal(b.getTraceId(), 'trace-bbb');

    a.setTraceId('trace-aaa-2');
    assert.equal(a.getTraceId(), 'trace-aaa-2');
    assert.equal(b.getTraceId(), 'trace-bbb');
  });

  it('module-level setTraceId does not share mutable request state', () => {
    setClientTraceId('should-not-stick');
    assert.equal(getClientTraceId(), null);
    const id = ensureTraceId('preferred-id');
    assert.equal(id, 'preferred-id');
    // still no shared module state
    assert.equal(getClientTraceId(), null);
  });
});

describe('createSandboxTools concurrent contexts', () => {
  it('routes tools and notifiers without cross-talk under overlap', async () => {
    const clientA = mockClient('A');
    const clientB = mockClient('B');
    const notifsA = [];
    const notifsB = [];

    let sessionA = 'session-a';
    let sessionB = 'session-b';

    const toolsA = createSandboxTools({
      client: clientA,
      getSessionId: () => sessionA,
      approvalNotifier: (ev) => notifsA.push(ev),
    });
    const toolsB = createSandboxTools({
      client: clientB,
      getSessionId: () => sessionB,
      approvalNotifier: (ev) => notifsB.push(ev),
    });

    const writeA = toolsA.find((t) => t.name === 'write');
    const writeB = toolsB.find((t) => t.name === 'write');
    const bashA = toolsA.find((t) => t.name === 'bash');
    const bashB = toolsB.find((t) => t.name === 'bash');
    assert.ok(writeA && writeB && bashA && bashB);

    // Overlap two contexts: concurrent writes + bash
    await Promise.all([
      writeA.execute('tc-a1', { path: 'a.txt', content: 'from-A' }),
      writeB.execute('tc-b1', { path: 'b.txt', content: 'from-B' }),
      bashA.execute('tc-a2', { command: 'echo a' }),
      bashB.execute('tc-b2', { command: 'echo b' }),
    ]);

    // Mid-flight session id change on A must not affect B
    sessionA = 'session-a-rotated';
    await Promise.all([
      writeA.execute('tc-a3', { path: 'a2.txt', content: 'A2' }),
      writeB.execute('tc-b3', { path: 'b2.txt', content: 'B2' }),
    ]);

    for (const c of clientA.calls) {
      assert.equal(c.trace, 'A', `client A saw foreign trace: ${JSON.stringify(c)}`);
      assert.match(c.sessionId, /^session-a/, `client A saw foreign session: ${c.sessionId}`);
    }
    for (const c of clientB.calls) {
      assert.equal(c.trace, 'B', `client B saw foreign trace: ${JSON.stringify(c)}`);
      assert.equal(c.sessionId, 'session-b');
    }

    assert.ok(clientA.calls.some((c) => c.op === 'writeFile' && c.content === 'from-A'));
    assert.ok(clientB.calls.some((c) => c.op === 'writeFile' && c.content === 'from-B'));
    assert.ok(clientA.calls.some((c) => c.sessionId === 'session-a-rotated'));
    assert.ok(!clientB.calls.some((c) => String(c.sessionId).includes('rotated')));

    // Legacy module setters are no-ops and do not poison per-request tools
    setSandboxSessionId('poison');
    setApprovalNotifier(() => {
      throw new Error('should not run');
    });
    assert.equal(getSandboxSessionId(), null);

    await writeA.execute('tc-a4', { path: 'a3.txt', content: 'still-A' });
    const last = clientA.calls[clientA.calls.length - 1];
    assert.equal(last.sessionId, 'session-a-rotated');
    assert.equal(notifsB.length, 0);

    // Concurrent approval paths: each notifier receives only its own approval_id
    await Promise.all([
      bashA.execute('tc-a5', { command: 'need-approval-A' }),
      bashB.execute('tc-b5', { command: 'need-approval-B' }),
    ]);
    assert.ok(
      notifsA.some((n) => n.type === 'approval_required' && n.approval_id === 'appr-A'),
      `expected notifier A to receive appr-A, got ${JSON.stringify(notifsA)}`,
    );
    assert.ok(
      notifsB.some((n) => n.type === 'approval_required' && n.approval_id === 'appr-B'),
      `expected notifier B to receive appr-B, got ${JSON.stringify(notifsB)}`,
    );
    assert.ok(!notifsA.some((n) => String(n.approval_id || '').includes('B')));
    assert.ok(!notifsB.some((n) => String(n.approval_id || '').includes('A')));
    assert.ok(clientA.calls.some((c) => c.op === 'getApproval' && c.approvalId === 'appr-A'));
    assert.ok(clientB.calls.some((c) => c.op === 'getApproval' && c.approvalId === 'appr-B'));
  });
});
