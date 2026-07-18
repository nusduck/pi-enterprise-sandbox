/**
 * sandbox-bridge 10 tools + transport identity (PR-06 B1).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createEnterpriseExtensionBundle,
  SANDBOX_TOOL_NAMES,
  ENTERPRISE_DEFAULT_TOOLS,
  createSandboxBridgeToolDefinitions,
} from '../../src/extensions/index.js';

const RUN_A = Object.freeze({
  orgId: '01K0G2PAV8FPMVC9QHJG7JPN4Z',
  userId: '01K0G2PAV8FPMVC9QHJG7JPN50',
  conversationId: '01K0G2PAV8FPMVC9QHJG7JPN51',
  agentSessionId: '01K0G2PAV8FPMVC9QHJG7JPN52',
  runId: '01K0G2PAV8FPMVC9QHJG7JPN5H',
  sandboxSessionId: '01K0G2PAV8FPMVC9QHJG7JPN5F',
  traceId: 'b'.repeat(32),
  executionFenceToken: 7,
});

const RUN_B = Object.freeze({
  ...RUN_A,
  runId: '01K0G2PAV8FPMVC9QHJG7JPN5A',
  sandboxSessionId: '01K0G2PAV8FPMVC9QHJG7JPN5B',
  executionFenceToken: 11,
});

const TE_BASE = '01K0G2PAV8FPMVC9QHJG7JPN7';

/**
 * Fake sandboxRequestBinder for bridge tests (PR-07B batch 2B).
 * @param {Array<object>} [binds]
 */
function createFakeBinder(binds = []) {
  let n = 0;
  return {
    async bindSandboxRequest(input) {
      n += 1;
      const toolExecutionId = `${TE_BASE}${String(n).padStart(1, '0')}`.slice(0, 26);
      const rec = {
        toolCallId: input.toolCallId,
        requestHash: input.requestHash,
        requestHashVersion: input.requestHashVersion,
        toolExecutionId,
      };
      binds.push(rec);
      return {
        toolExecutionId,
        requestHash: input.requestHash,
        requestHashVersion: input.requestHashVersion,
        bound: true,
      };
    },
  };
}

function createFakeTransport(calls) {
  const methods = [
    'readFile',
    'writeFile',
    'editFile',
    'bash',
    'python',
    'processStart',
    'processStatus',
    'processRead',
    'processKill',
    'submitArtifact',
  ];
  /** @type {Record<string, Function>} */
  const t = {};
  for (const m of methods) {
    t[m] = async (payload) => {
      calls.push({ method: m, payload });
      if (m === 'readFile') {
        return { content: 'hello', offset: 0, size: 5 };
      }
      if (m === 'writeFile') return { size: 3 };
      if (m === 'editFile') return { hash: 'abc', version: '2' };
      if (m === 'bash' || m === 'python') {
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      }
      if (m === 'processStart') {
        return {
          processId: '01K0G2PAV8FPMVC9QHJG7JPN5C',
          status: 'RUNNING',
          stdoutCursor: '0-0',
          stderrCursor: '0-0',
        };
      }
      if (m === 'processStatus') {
        return { processId: payload.processId, status: 'RUNNING', exitCode: null };
      }
      if (m === 'processRead') {
        return { data: 'line\n', nextCursor: '0-1', stream: 'stdout' };
      }
      if (m === 'processKill') return { status: 'SIGNALED' };
      if (m === 'submitArtifact') {
        return {
          artifactId: '01K0G2PAV8FPMVC9QHJG7JPN5D',
          sha256: 'a'.repeat(64),
          size: 10,
          mimeType: 'text/plain',
        };
      }
      return {};
    };
  }
  return t;
}

function capturePiApi() {
  /** @type {Array<object>} */
  const tools = [];
  const handlers = new Map();
  return {
    tools,
    handlers,
    pi: {
      registerTool(def) {
        tools.push(def);
      },
      on(event, handler) {
        if (!handlers.has(event)) handlers.set(event, []);
        handlers.get(event).push(handler);
      },
    },
  };
}

describe('SANDBOX_TOOL_NAMES / allowlist', () => {
  it('is exact 10 names and equals ENTERPRISE_DEFAULT_TOOLS', () => {
    assert.equal(SANDBOX_TOOL_NAMES.length, 10);
    assert.deepEqual([...ENTERPRISE_DEFAULT_TOOLS], [...SANDBOX_TOOL_NAMES]);
    assert.ok(SANDBOX_TOOL_NAMES.includes('read'));
    assert.ok(SANDBOX_TOOL_NAMES.includes('write'));
    assert.ok(SANDBOX_TOOL_NAMES.includes('edit'));
    assert.ok(SANDBOX_TOOL_NAMES.includes('bash'));
  });
});

describe('sandbox-bridge registration', () => {
  it('registers exactly 10 tools including default read/write/edit/bash', async () => {
    const calls = [];
    const transport = createFakeTransport(calls);
    const factories = createEnterpriseExtensionBundle(RUN_A, {
      sandboxTransport: transport,
      auditSink: async () => {},
    });
    const { tools, pi } = capturePiApi();
    await factories[0](pi);
    assert.equal(tools.length, 10);
    assert.deepEqual(
      tools.map((t) => t.name),
      [...SANDBOX_TOOL_NAMES],
    );
    for (const name of ['read', 'write', 'edit', 'bash']) {
      assert.ok(tools.some((t) => t.name === name));
    }
    // executionMode: reads parallel, writes sequential
    assert.equal(tools.find((t) => t.name === 'read').executionMode, 'parallel');
    assert.equal(tools.find((t) => t.name === 'bash').executionMode, 'sequential');
  });

  it('each tool hits transport once with frozen identity + exact toolCallId (model cannot override)', async () => {
    const calls = [];
    const binds = [];
    const transport = createFakeTransport(calls);
    const defs = createSandboxBridgeToolDefinitions(RUN_A, transport, {
      sandboxRequestBinder: createFakeBinder(binds),
    });

    const invocations = [
      [
        'read',
        {
          path: 'data/a.txt',
          orgId: 'EVIL',
          sandboxSessionId: 'EVIL',
          executionFenceToken: 999,
          toolCallId: 'spoofed',
          identity: { orgId: 'EVIL' },
        },
      ],
      [
        'write',
        {
          path: 'out.txt',
          content: 'hi',
          runId: 'EVIL',
          toolCallId: 'spoofed',
          executionFenceToken: 0,
        },
      ],
      [
        'edit',
        {
          path: 'out.txt',
          oldText: 'a',
          newText: 'b',
          expectedHash: 'h1',
          userId: 'EVIL',
          toolCallId: 'spoofed',
        },
      ],
      ['bash', { command: 'echo hi', timeoutSeconds: 10, toolCallId: 'spoofed' }],
      ['python', { code: 'print(1)', toolCallId: 'spoofed' }],
      ['process_start', { command: 'sleep 1', toolCallId: 'spoofed' }],
      [
        'process_status',
        {
          processId: '01K0G2PAV8FPMVC9QHJG7JPN5C',
          toolCallId: 'spoofed',
        },
      ],
      [
        'process_read',
        {
          processId: '01K0G2PAV8FPMVC9QHJG7JPN5C',
          cursor: '0-0',
          toolCallId: 'spoofed',
        },
      ],
      [
        'process_kill',
        {
          processId: '01K0G2PAV8FPMVC9QHJG7JPN5C',
          signal: 'TERM',
          toolCallId: 'spoofed',
        },
      ],
      [
        'submit_artifact',
        { path: 'out/report.pdf', displayName: 'r', toolCallId: 'spoofed' },
      ],
    ];

    for (let i = 0; i < invocations.length; i += 1) {
      const [name, params] = invocations[i];
      const tool = defs.find((t) => t.name === name);
      assert.ok(tool, name);
      const exactId = `tc-exact-${name}-${i}`;
      const result = await tool.execute(
        exactId,
        params,
        undefined,
        undefined,
        {},
      );
      assert.ok(result.content?.[0]?.text);
      assert.equal(
        result.content[0].text.includes('Error'),
        false,
        `${name} should succeed: ${result.content[0].text}`,
      );
    }

    assert.equal(calls.length, 10);
    assert.equal(binds.length, 10);
    for (let i = 0; i < calls.length; i += 1) {
      const c = calls[i];
      const [name] = invocations[i];
      const exactId = `tc-exact-${name}-${i}`;
      assert.equal(c.payload.identity.sandboxSessionId, RUN_A.sandboxSessionId);
      assert.equal(c.payload.identity.orgId, RUN_A.orgId);
      assert.equal(c.payload.identity.userId, RUN_A.userId);
      assert.equal(c.payload.identity.runId, RUN_A.runId);
      assert.equal(c.payload.identity.traceId, RUN_A.traceId);
      assert.equal(c.payload.identity.executionFenceToken, RUN_A.executionFenceToken);
      assert.equal(typeof c.payload.identity.executionFenceToken, 'number');
      assert.equal(c.payload.toolCallId, exactId);
      assert.equal(typeof c.payload.toolExecutionId, 'string');
      assert.equal(c.payload.requestHash, binds[i].requestHash);
      assert.equal(c.payload.requestHashVersion, 1);
      assert.match(c.payload.requestHash, /^[0-9a-f]{64}$/);
      // model-supplied identity/fence/toolCallId must not override
      assert.notEqual(c.payload.identity.orgId, 'EVIL');
      assert.notEqual(c.payload.identity.sandboxSessionId, 'EVIL');
      assert.notEqual(c.payload.identity.executionFenceToken, 999);
      assert.notEqual(c.payload.toolCallId, 'spoofed');
    }
  });

  it('skill-read path carries same fence and exact toolCallId', async () => {
    const calls = [];
    const binds = [];
    const transport = createFakeTransport(calls);
    transport.readSkill = async (payload) => {
      calls.push({ method: 'readSkill', payload });
      return { content: 'skill-body', offset: 0, size: 10 };
    };
    const defs = createSandboxBridgeToolDefinitions(RUN_A, transport, {
      sandboxRequestBinder: createFakeBinder(binds),
    });
    const tool = defs.find((t) => t.name === 'read');
    const exactId = 'tc-skill-read-1';
    const result = await tool.execute(exactId, {
      path: '/home/sandbox/skill/docs/README.md',
      toolCallId: 'spoofed-skill',
      executionFenceToken: 1,
      identity: { executionFenceToken: 1 },
      toolExecutionId: 'spoofed-te',
      requestHash: 'f'.repeat(64),
      requestHashVersion: 99,
    });
    assert.equal(result.content[0].text.includes('Error'), false);
    assert.equal(calls.length, 1);
    assert.equal(binds.length, 1);
    assert.equal(calls[0].method, 'readSkill');
    assert.equal(calls[0].payload.toolCallId, exactId);
    assert.equal(
      calls[0].payload.identity.executionFenceToken,
      RUN_A.executionFenceToken,
    );
    assert.equal(typeof calls[0].payload.identity.executionFenceToken, 'number');
    assert.notEqual(calls[0].payload.toolCallId, 'spoofed-skill');
    assert.equal(calls[0].payload.toolExecutionId, binds[0].toolExecutionId);
    assert.equal(calls[0].payload.requestHash, binds[0].requestHash);
    assert.equal(calls[0].payload.requestHashVersion, 1);
    assert.notEqual(calls[0].payload.toolExecutionId, 'spoofed-te');
    assert.notEqual(calls[0].payload.requestHash, 'f'.repeat(64));
  });

  it('rejects invalid toolCallId before transport (all 10 tools, zero calls)', async () => {
    const badIds = [
      '',
      '  leading',
      'trailing  ',
      ' both ',
      42,
      null,
      undefined,
      'x'.repeat(256),
    ];
    const baseParams = {
      read: { path: 'a.txt' },
      write: { path: 'a.txt', content: 'x' },
      edit: { path: 'a.txt', oldText: 'a', newText: 'b', expectedHash: 'h' },
      bash: { command: 'true' },
      python: { code: 'print(1)' },
      process_start: { command: 'sleep 1' },
      process_status: { processId: '01K0G2PAV8FPMVC9QHJG7JPN5C' },
      process_read: { processId: '01K0G2PAV8FPMVC9QHJG7JPN5C' },
      process_kill: { processId: '01K0G2PAV8FPMVC9QHJG7JPN5C' },
      submit_artifact: { path: 'out/r.pdf' },
    };

    for (const bad of badIds) {
      const calls = [];
      const defs = createSandboxBridgeToolDefinitions(
        RUN_A,
        createFakeTransport(calls),
      );
      for (const name of SANDBOX_TOOL_NAMES) {
        const tool = defs.find((t) => t.name === name);
        const result = await tool.execute(bad, baseParams[name]);
        assert.match(
          result.content[0].text,
          /TOOL_CALL_ID_INVALID/,
          `${name} badId=${JSON.stringify(bad)}`,
        );
      }
      assert.equal(
        calls.length,
        0,
        `transport must not be called for bad toolCallId=${JSON.stringify(bad)}`,
      );
    }
  });

  it('buildTransportIdentity requires positive finite integer fence as number', async () => {
    const { buildTransportIdentity } = await import(
      '../../src/extensions/index.js'
    );
    const frozen = buildTransportIdentity(RUN_A);
    assert.ok(Object.isFrozen(frozen));
    assert.equal(frozen.executionFenceToken, 7);
    assert.equal(typeof frozen.executionFenceToken, 'number');

    for (const bad of [
      undefined,
      null,
      0,
      -1,
      1.5,
      NaN,
      Infinity,
      '7',
      true,
    ]) {
      assert.throws(
        () =>
          buildTransportIdentity({
            ...RUN_A,
            executionFenceToken: bad,
          }),
        (err) =>
          err &&
          (err.code === 'RUN_IDENTITY_REQUIRED' ||
            err.code === 'RUN_IDENTITY_INVALID' ||
            /executionFenceToken|RUN_IDENTITY/.test(String(err.message))),
        `fence=${String(bad)}`,
      );
    }
    assert.throws(
      () => {
        const { executionFenceToken: _f, ...rest } = RUN_A;
        buildTransportIdentity(rest);
      },
      (err) => err?.code === 'RUN_IDENTITY_REQUIRED',
    );
  });

  it('MCP-style tool is not a sandbox tool (no transport for mcp__)', async () => {
    const calls = [];
    const transport = createFakeTransport(calls);
    const defs = createSandboxBridgeToolDefinitions(RUN_A, transport);
    assert.equal(
      defs.some((t) => t.name.startsWith('mcp__')),
      false,
    );
    assert.equal(calls.length, 0);
  });

  it('isolates transport identity across runs', async () => {
    const callsA = [];
    const callsB = [];
    const defsA = createSandboxBridgeToolDefinitions(
      RUN_A,
      createFakeTransport(callsA),
      { sandboxRequestBinder: createFakeBinder() },
    );
    const defsB = createSandboxBridgeToolDefinitions(
      RUN_B,
      createFakeTransport(callsB),
      { sandboxRequestBinder: createFakeBinder() },
    );
    await defsA.find((t) => t.name === 'bash').execute(
      '1',
      { command: 'true' },
      undefined,
      undefined,
      {},
    );
    await defsB.find((t) => t.name === 'bash').execute(
      '1',
      { command: 'true' },
      undefined,
      undefined,
      {},
    );
    assert.equal(callsA[0].payload.identity.runId, RUN_A.runId);
    assert.equal(callsB[0].payload.identity.runId, RUN_B.runId);
    assert.notEqual(
      callsA[0].payload.identity.sandboxSessionId,
      callsB[0].payload.identity.sandboxSessionId,
    );
  });

  it('edit without expectedHash/version fails closed', async () => {
    const defs = createSandboxBridgeToolDefinitions(
      RUN_A,
      createFakeTransport([]),
    );
    const r = await defs
      .find((t) => t.name === 'edit')
      .execute('1', { path: 'a.txt', oldText: 'x', newText: 'y' });
    assert.match(r.content[0].text, /FILE_VERSION_PRECONDITION_REQUIRED/);
  });

  it('skill write denied at tool layer', async () => {
    const defs = createSandboxBridgeToolDefinitions(
      RUN_A,
      createFakeTransport([]),
    );
    const r = await defs.find((t) => t.name === 'write').execute('1', {
      path: '/home/sandbox/skill/x.py',
      content: 'x',
    });
    assert.match(r.content[0].text, /PATH_SKILL_WRITE_DENIED|skill/i);
  });

  it('missing transport fails at extension load (not deferred to execute)', async () => {
    const factories = createEnterpriseExtensionBundle(RUN_A, {
      sandboxTransport: null,
      auditSink: async () => {},
    });
    const { pi } = capturePiApi();
    await assert.rejects(
      async () => factories[0](pi),
      (err) =>
        err &&
        (err.code === 'SANDBOX_TRANSPORT_UNAVAILABLE' ||
          /SANDBOX_TRANSPORT_UNAVAILABLE/.test(String(err.message))),
    );
  });

  it('partial transport fails at extension load', async () => {
    const partial = {
      readFile: async () => ({ content: 'x' }),
      // others missing
    };
    const factories = createEnterpriseExtensionBundle(RUN_A, {
      sandboxTransport: partial,
      auditSink: async () => {},
    });
    const { pi } = capturePiApi();
    await assert.rejects(
      async () => factories[0](pi),
      /SANDBOX_TRANSPORT_UNAVAILABLE|missing methods/,
    );
  });

  it('buildTransportIdentity / tool defs fail closed on missing identity', async () => {
    const { buildTransportIdentity, createSandboxBridgeToolDefinitions } =
      await import('../../src/extensions/index.js');
    assert.throws(
      () => buildTransportIdentity({ ...RUN_A, sandboxSessionId: null }),
      (err) => err.code === 'RUN_IDENTITY_REQUIRED',
    );
    assert.throws(
      () => buildTransportIdentity({ ...RUN_A, sandboxSessionId: 'null' }),
      (err) => err.code === 'RUN_IDENTITY_REQUIRED',
    );
    assert.throws(
      () => {
        const { orgId: _o, ...rest } = RUN_A;
        buildTransportIdentity(rest);
      },
      (err) => err.code === 'RUN_IDENTITY_REQUIRED',
    );
    assert.throws(
      () =>
        createSandboxBridgeToolDefinitions(
          { ...RUN_A, runId: undefined },
          createFakeTransport([]),
        ),
      /RUN_IDENTITY/,
    );
  });

  it('results are bounded/redacted (no host path leakage in errors)', async () => {
    const transport = createFakeTransport([]);
    transport.bash = async () => {
      throw new Error('failed under /Users/eddie/secret and Bearer tok_abc');
    };
    const defs = createSandboxBridgeToolDefinitions(RUN_A, transport, {
      sandboxRequestBinder: createFakeBinder(),
    });
    const r = await defs
      .find((t) => t.name === 'bash')
      .execute('1', { command: 'true' });
    assert.match(r.content[0].text, /Error/);
    assert.equal(r.content[0].text.includes('/Users/eddie'), false);
    assert.equal(r.content[0].text.includes('tok_abc'), false);
  });
});
