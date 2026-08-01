/**
 * Per-run Sandbox transport: durable identity + isolated signed transports.
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
  it('builds each signed transport from the frozen runContext', () => {
    // Acting identity now travels inside the signed request payload (see
    // internal-files-read-http.js) rather than as mutable client headers, so
    // the run context must reach every per-run transport factory unchanged.
    const seen = [];
    createRunScopedSandboxBridgeTransport(RUN_A, {
      createInternalReadTransport: (ctx) => { seen.push(['read', ctx]); return { readFile: async () => ({}) }; },
      createInternalExecutionTransport: (ctx) => { seen.push(['exec', ctx]); return { bash: async () => ({}), python: async () => ({}) }; },
      createInternalProcessTransport: (ctx) => { seen.push(['process', ctx]); return {}; },
      createInternalFilesWriteTransport: (ctx) => { seen.push(['write', ctx]); return {}; },
      createInternalArtifactTransport: (ctx) => { seen.push(['artifact', ctx]); return {}; },
    });
    assert.deepEqual(seen.map((x) => x[0]), ['read', 'exec', 'process', 'write', 'artifact']);
    for (const [, ctx] of seen) assert.equal(ctx, RUN_A);
  });

  it('fails closed without durable org/user (no anonymous Sandbox access)', () => {
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

  it('isolates concurrent runs (separate transports per runContext)', () => {
    const built = [];
    const make = (ctx) => {
      const t = { ctx, id: built.length, readFile: async () => ({}) };
      built.push(t);
      return t;
    };
    const t1 = createRunScopedSandboxBridgeTransport(RUN_A, {
      createInternalReadTransport: make,
    });
    const t2 = createRunScopedSandboxBridgeTransport(RUN_B, {
      createInternalReadTransport: make,
    });
    assert.equal(built.length, 2);
    assert.notEqual(built[0], built[1]);
    assert.equal(built[0].ctx.runId, RUN_A.runId);
    assert.equal(built[1].ctx.runId, RUN_B.runId);
    assert.ok(typeof t1.readFile === 'function' && typeof t2.readFile === 'function');
  });

  it('forwards run-scoped formal read and execution transports to the bridge', () => {
    const formalRead = { readFile: async () => ({}) };
    const formalExecution = {
      bash: async () => ({}),
      python: async () => ({}),
    };
    let transportOptions;

    createRunScopedSandboxBridgeTransport(RUN_A, {
      createInternalReadTransport: (ctx) => {
        assert.equal(ctx, RUN_A);
        return formalRead;
      },
      createInternalExecutionTransport: (ctx) => {
        assert.equal(ctx, RUN_A);
        return formalExecution;
      },
      createTransport: (opts) => {
        transportOptions = opts;
        return {};
      },
    });

    assert.equal(transportOptions.internalReadTransport, formalRead);
    assert.equal(
      transportOptions.internalExecutionTransport,
      formalExecution,
    );
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
