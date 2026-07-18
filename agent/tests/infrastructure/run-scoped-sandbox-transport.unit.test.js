/**
 * Per-run Sandbox transport: durable acting headers + isolated clients.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRunScopedSandboxBridgeTransport,
  createSandboxBridgeExtensionBundleFactory,
} from '../../src/infrastructure/sandbox/sandbox-bridge-http-transport.js';

const RUN_A = Object.freeze({
  orgId: '01ORGAAAAAAAAAAAAAAA0001',
  userId: '01USERAAAAAAAAAAAAAAA0001',
  conversationId: '01CONVAAAAAAAAAAAAAAA0001',
  agentSessionId: '01AGSAAAAAAAAAAAAAAAA0001',
  runId: '01RUNAAAAAAAAAAAAAAA00001',
  sandboxSessionId: '01SBXAAAAAAAAAAAAAAA0001',
  traceId: 'a'.repeat(32),
  executionFenceToken: 1,
});

const RUN_B = Object.freeze({
  orgId: '01ORGAAAAAAAAAAAAAAA0002',
  userId: '01USERAAAAAAAAAAAAAAA0002',
  conversationId: '01CONVAAAAAAAAAAAAAAA0002',
  agentSessionId: '01AGSAAAAAAAAAAAAAAAA0002',
  runId: '01RUNAAAAAAAAAAAAAAA00002',
  sandboxSessionId: '01SBXAAAAAAAAAAAAAAA0002',
  traceId: 'b'.repeat(32),
  executionFenceToken: 2,
});

describe('createRunScopedSandboxBridgeTransport', () => {
  it('injects durable acting org/user + trace; never fabricates identity', () => {
    /** @type {any[]} */
    const clientOpts = [];
    const fakeClient = {
      async readFile() {
        return { content: '' };
      },
      async writeFile() {
        return {};
      },
      async editFile() {
        return {};
      },
      async listFiles() {
        return { entries: [] };
      },
      async runPython() {
        return { exit_code: 0 };
      },
      async runCommand() {
        return { exit_code: 0 };
      },
      async runNode() {
        return { exit_code: 0 };
      },
      async startProcess() {
        return { process_id: 'p1', status: 'running' };
      },
      async getProcess() {
        return { status: 'running' };
      },
      async readProcess() {
        return { data: '', cursor: '0-0', next_cursor: '0-0' };
      },
      async signalProcess() {
        return { ok: true, status: 'SIGNALED' };
      },
      async submitArtifact() {
        return { artifact_id: 'a1' };
      },
    };
    createRunScopedSandboxBridgeTransport(RUN_A, {
      createSandboxClient: (opts) => {
        clientOpts.push(opts);
        return fakeClient;
      },
    });
    assert.equal(clientOpts.length, 1);
    assert.equal(clientOpts[0].traceId, RUN_A.traceId);
    assert.equal(clientOpts[0].auth.actingUserId, RUN_A.userId);
    assert.equal(clientOpts[0].auth.actingOrganizationId, RUN_A.orgId);
    assert.equal(clientOpts[0].auth.actingRole, 'user');
  });

  it('fails closed without durable org/user (no anonymous Sandbox client)', () => {
    assert.throws(
      () =>
        createRunScopedSandboxBridgeTransport({
          ...RUN_A,
          orgId: '',
        }),
      (e) => e?.code === 'RUN_IDENTITY_REQUIRED',
    );
    assert.throws(
      () =>
        createRunScopedSandboxBridgeTransport({
          ...RUN_A,
          userId: 'null',
        }),
      (e) => e?.code === 'RUN_IDENTITY_REQUIRED',
    );
  });

  it('isolates concurrent runs (separate clients per runContext)', () => {
    /** @type {any[]} */
    const clients = [];
    const makeClient = (opts) => {
      const c = {
        opts,
        id: clients.length,
        async readFile() {
          return { content: String(this.id) };
        },
        async writeFile() {
          return {};
        },
        async editFile() {
          return {};
        },
        async listFiles() {
          return { entries: [] };
        },
        async runPython() {
          return { exit_code: 0 };
        },
        async runCommand() {
          return { exit_code: 0 };
        },
        async runNode() {
          return { exit_code: 0 };
        },
        async startProcess() {
          return { process_id: 'p', status: 'running' };
        },
        async getProcess() {
          return { status: 'running' };
        },
        async readProcess() {
          return { data: '', cursor: '0-0', next_cursor: '0-0' };
        },
        async signalProcess() {
          return { ok: true };
        },
        async submitArtifact() {
          return {};
        },
      };
      clients.push(c);
      return c;
    };
    const t1 = createRunScopedSandboxBridgeTransport(RUN_A, {
      createSandboxClient: makeClient,
    });
    const t2 = createRunScopedSandboxBridgeTransport(RUN_B, {
      createSandboxClient: makeClient,
    });
    assert.equal(clients.length, 2);
    assert.notEqual(clients[0], clients[1]);
    assert.equal(clients[0].opts.auth.actingUserId, RUN_A.userId);
    assert.equal(clients[1].opts.auth.actingUserId, RUN_B.userId);
    assert.equal(clients[0].opts.traceId, RUN_A.traceId);
    assert.equal(clients[1].opts.traceId, RUN_B.traceId);
    assert.ok(typeof t1.readFile === 'function' && typeof t2.readFile === 'function');
  });
});

describe('createSandboxBridgeExtensionBundleFactory per-run transport', () => {
  it('builds a fresh transport per run via createTransportForRun', () => {
    /** @type {object[]} */
    const seen = [];
    const factory = createSandboxBridgeExtensionBundleFactory({
      createTransportForRun: (ctx) => {
        seen.push(ctx);
        // Minimal transport stubs for sandbox-bridge load assert
        return Object.fromEntries(
          [
            'readFile',
            'writeFile',
            'editFile',
            'listFiles',
            'bash',
            'python',
            'node',
            'processStart',
            'processRead',
            'processKill',
            'submitArtifact',
          ].map((m) => [m, async () => ({})]),
        );
      },
      createEnterpriseExtensionBundle: (runContext, deps) => {
        assert.ok(deps.sandboxTransport);
        assert.equal(typeof deps.sandboxTransport.python, 'function');
        return [{ extensionName: 'sandbox-bridge' }, { extensionName: 'enterprise-policy' }, { extensionName: 'observability' }];
      },
    });
    factory(RUN_A, {});
    factory(RUN_B, {});
    assert.equal(seen.length, 2);
    assert.equal(seen[0].runId, RUN_A.runId);
    assert.equal(seen[1].runId, RUN_B.runId);
  });

  it('fails closed when neither per-run nor static transport is configured', () => {
    const factory = createSandboxBridgeExtensionBundleFactory({
      createEnterpriseExtensionBundle: () => [],
    });
    assert.throws(() => factory(RUN_A, {}), (e) => e?.code === 'SANDBOX_TRANSPORT_REQUIRED');
  });
});
