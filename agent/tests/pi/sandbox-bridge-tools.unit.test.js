/**
 * sandbox-bridge 13 tools + transport identity (PR-06 B1).
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
    'lsFiles',
    'findFiles',
    'grepFiles',
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
      if (m === 'lsFiles' || m === 'findFiles') {
        return {
          items: [{ path: 'src/app.js', name: 'app.js', type: 'file', size: 12 }],
          skipped: [],
          stats: { scanned: 1, matched: 1 },
          truncated: false,
          stop_reason: null,
        };
      }
      if (m === 'grepFiles') {
        return {
          matches: [{ path: 'src/app.js', line: 3, column: 1, text: 'const x = 1;' }],
          skipped: [],
          stats: { scanned: 1, matched: 1 },
          truncated: false,
          stop_reason: null,
        };
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
      if (m === 'processKill') return { status: 'CANCEL_REQUESTED' };
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

describe('sandbox-bridge prompt guidelines', () => {
  it('tells the model not to talk through bash and to deliver files via submit_artifact', () => {
    const defs = createSandboxBridgeToolDefinitions(RUN_A, {}, {});
    const includes = (name, snippet) => {
      const tool = defs.find((definition) => definition.name === name);
      assert.ok(tool, name);
      const guidelines = tool.promptGuidelines || [];
      assert.ok(
        guidelines.some((line) => line.includes(snippet)),
        `${name} missing guideline containing ${JSON.stringify(snippet)}`,
      );
    };
    includes('bash', 'Do not use bash to talk to the user');
    includes('submit_artifact', 'User-facing files go through this tool');
  });
});

describe('process result status contract', () => {
  it('normalizes process tool results to lowercase ProcessStatus values', async () => {
    const defs = createSandboxBridgeToolDefinitions(
      RUN_A,
      createFakeTransport([]),
      { sandboxRequestBinder: createFakeBinder() },
    );
    const start = defs.find((tool) => tool.name === 'process_start');
    const status = defs.find((tool) => tool.name === 'process_status');
    const killed = defs.find((tool) => tool.name === 'process_kill');

    const startedResult = await start.execute('tc-process-start-status', { command: 'sleep 1' });
    const statusResult = await status.execute('tc-process-status-status', {
      processId: '01K0G2PAV8FPMVC9QHJG7JPN5C',
    });
    const killedResult = await killed.execute('tc-process-kill-status', {
      processId: '01K0G2PAV8FPMVC9QHJG7JPN5C',
      signal: 'TERM',
    });

    assert.equal(JSON.parse(startedResult.content[0].text).status, 'running');
    assert.equal(JSON.parse(statusResult.content[0].text).status, 'running');
    assert.equal(JSON.parse(killedResult.content[0].text).status, 'running');
  });
});

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
  it('is exact 13 names and equals ENTERPRISE_DEFAULT_TOOLS', () => {
    assert.equal(SANDBOX_TOOL_NAMES.length, 13);
    assert.deepEqual([...ENTERPRISE_DEFAULT_TOOLS], [...SANDBOX_TOOL_NAMES]);
    assert.ok(SANDBOX_TOOL_NAMES.includes('read'));
    assert.ok(SANDBOX_TOOL_NAMES.includes('write'));
    assert.ok(SANDBOX_TOOL_NAMES.includes('edit'));
    assert.ok(SANDBOX_TOOL_NAMES.includes('bash'));
    // Sandbox-routed replacements for the SDK's local-filesystem tools, which
    // stay permanently excluded because they would read the Agent container.
    for (const name of ['ls', 'find', 'grep']) {
      assert.ok(SANDBOX_TOOL_NAMES.includes(name), name);
    }
  });
});

describe('sandbox-bridge registration', () => {
  it('registers exactly 13 tools including default read/write/edit/bash', async () => {
    const calls = [];
    const transport = createFakeTransport(calls);
    const factories = createEnterpriseExtensionBundle(RUN_A, {
      sandboxTransport: transport,
      auditSink: async () => {},
    });
    const { tools, pi } = capturePiApi();
    await factories[0](pi);
    assert.equal(tools.length, 13);
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
    // Search is read-only, so it may fan out alongside read.
    for (const name of ['ls', 'find', 'grep']) {
      assert.equal(tools.find((t) => t.name === name).executionMode, 'parallel', name);
    }
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
      ['ls', { path: '.', toolCallId: 'spoofed' }],
      ['find', { pattern: '*.js', toolCallId: 'spoofed' }],
      ['grep', { query: 'const', toolCallId: 'spoofed' }],
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

    assert.equal(calls.length, 13);
    assert.equal(binds.length, 13);
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

  it('submit_artifact returns bounded durable metadata in details', async () => {
    const calls = [];
    const defs = createSandboxBridgeToolDefinitions(
      RUN_A,
      createFakeTransport(calls),
      { sandboxRequestBinder: createFakeBinder() },
    );
    const tool = defs.find((definition) => definition.name === 'submit_artifact');
    const result = await tool.execute('tc-submit-details', {
      path: 'out/report.pdf',
      displayName: '风险分析报告.pdf',
      description: '最终分析报告',
    });

    assert.deepEqual(result.details, {
      artifactId: '01K0G2PAV8FPMVC9QHJG7JPN5D',
      displayName: '风险分析报告.pdf',
      description: '最终分析报告',
      sha256: 'a'.repeat(64),
      size: 10,
      mimeType: 'text/plain',
      downloadPath:
        '/api/files/artifact-download?session_id=01K0G2PAV8FPMVC9QHJG7JPN5F&artifact_id=01K0G2PAV8FPMVC9QHJG7JPN5D',
    });
    assert.equal(Object.hasOwn(result.details, 'path'), false);
    assert.equal(calls[0].payload.description, '最终分析报告');
  });

  it('submit_artifact preserves a 1024-character description in durable details', async () => {
    const description = '描'.repeat(1024);
    const defs = createSandboxBridgeToolDefinitions(
      RUN_A,
      createFakeTransport([]),
      { sandboxRequestBinder: createFakeBinder() },
    );
    const tool = defs.find((definition) => definition.name === 'submit_artifact');
    const result = await tool.execute('tc-submit-long-description', {
      path: 'out/report.pdf',
      description,
    });

    assert.equal(result.details.description, description);
    assert.equal(Object.hasOwn(result.details, 'description_truncated'), false);
  });

  it('rejects invalid toolCallId before transport (all 13 tools, zero calls)', async () => {
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
      ls: { path: '.' },
      find: { pattern: '*.js' },
      grep: { query: 'x' },
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

  it('allows file work in /tmp but keeps artifact submission in workspace', async () => {
    const calls = [];
    const defs = createSandboxBridgeToolDefinitions(
      RUN_A,
      createFakeTransport(calls),
      { sandboxRequestBinder: createFakeBinder() },
    );
    const read = defs.find((tool) => tool.name === 'read');
    const write = defs.find((tool) => tool.name === 'write');
    const edit = defs.find((tool) => tool.name === 'edit');
    const submitArtifact = defs.find((tool) => tool.name === 'submit_artifact');

    await read.execute('tmp-read', { path: '/tmp/report.txt' });
    await write.execute('tmp-write', { path: '/tmp/report.txt', content: 'draft' });
    await edit.execute('tmp-edit', {
      path: '/tmp/report.txt',
      oldText: 'draft',
      newText: 'revised',
      expectedVersion: '1',
    });
    const artifact = await submitArtifact.execute('tmp-artifact', {
      path: '/tmp/report.txt',
    });

    assert.deepEqual(
      calls.map((call) => [call.method, call.payload.path]),
      [
        ['readFile', '/tmp/report.txt'],
        ['writeFile', '/tmp/report.txt'],
        ['editFile', '/tmp/report.txt'],
      ],
    );
    assert.match(artifact.content[0].text, /PATH_OUTSIDE_WORKSPACE/);
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

  it('read returns a valid bounded result with a continuation offset', async () => {
    const transport = createFakeTransport([]);
    transport.readFile = async () => ({
      content: Array.from({ length: 3_000 }, () => 'x'.repeat(20)).join('\n'),
      offset: 7,
      size: 3_000 * 21,
      // This is the cursor from the sandbox's larger page. The bridge must
      // not use it after applying its own smaller output limit.
      nextOffset: 3_007,
    });
    const defs = createSandboxBridgeToolDefinitions(RUN_A, transport, {
      sandboxRequestBinder: createFakeBinder(),
    });

    const result = await defs.find((t) => t.name === 'read').execute('read-large', {
      path: 'large.txt',
    });
    const payload = JSON.parse(result.content[0].text);

    assert.equal(payload.truncated, true);
    assert.equal(payload.truncatedBy, 'lines');
    assert.equal(payload.nextOffset, 2_007);
    assert.match(payload.continuation, /offset=/);
    // Hermes-style gutter: first displayed line is 1-based (offset 7 → line 8).
    assert.match(payload.content, /^8\|x{20}/);
    // Model-facing body stays within the read char budget.
    assert.ok(payload.content.length <= 100_000);
  });

  it('read dedups identical path/offset/limit pages within a run', async () => {
    const transport = createFakeTransport([]);
    let calls = 0;
    transport.readFile = async () => {
      calls += 1;
      return { content: 'same-page\n', offset: 0, size: 10, nextOffset: null };
    };
    const defs = createSandboxBridgeToolDefinitions(RUN_A, transport, {
      sandboxRequestBinder: createFakeBinder(),
    });
    const read = defs.find((t) => t.name === 'read');

    const first = JSON.parse(
      (await read.execute('read-a', { path: 'dup.txt', offset: 0, limit: 50 }))
        .content[0].text,
    );
    assert.equal(first.content.includes('same-page'), true);
    assert.equal(first.dedup, undefined);

    const second = JSON.parse(
      (await read.execute('read-b', { path: 'dup.txt', offset: 0, limit: 50 }))
        .content[0].text,
    );
    assert.equal(second.status, 'unchanged');
    assert.equal(second.dedup, true);
    assert.equal(second.content_returned, false);

    const third = await read.execute('read-c', {
      path: 'dup.txt',
      offset: 0,
      limit: 50,
    });
    assert.match(third.content[0].text, /READ_DEDUP_BLOCKED|re-read/i);
    assert.equal(calls, 3);
  });

  it('read clamps limit to Hermes-aligned max and defaults to 500', async () => {
    const transport = createFakeTransport([]);
    /** @type {object | null} */
    let seen = null;
    transport.readFile = async (payload) => {
      seen = payload;
      return { content: 'ok', offset: payload.offset, size: 2 };
    };
    const defs = createSandboxBridgeToolDefinitions(RUN_A, transport, {
      sandboxRequestBinder: createFakeBinder(),
    });
    const read = defs.find((t) => t.name === 'read');

    await read.execute('read-default', { path: 'a.txt' });
    assert.equal(seen.limit, 500);
    assert.equal(seen.offset, 0);

    await read.execute('read-max', { path: 'a.txt', limit: 99_999 });
    assert.equal(seen.limit, 2_000);
  });

  it('bash bounds both streams without falling back to a malformed result', async () => {
    const transport = createFakeTransport([]);
    transport.bash = async () => ({
      exitCode: 0,
      stdout: 'o'.repeat(80 * 1024),
      stderr: 'e'.repeat(80 * 1024),
    });
    const defs = createSandboxBridgeToolDefinitions(RUN_A, transport, {
      sandboxRequestBinder: createFakeBinder(),
    });

    const result = await defs.find((t) => t.name === 'bash').execute('bash-large', {
      command: 'true',
    });
    const payload = JSON.parse(result.content[0].text);

    assert.equal(payload.exitCode, 0);
    assert.equal(payload.stdoutTruncated, true);
    assert.equal(payload.stderrTruncated, true);
    assert.equal(payload.stdoutTruncatedBy, 'bytes');
    assert.equal(payload.stderrTruncatedBy, 'bytes');
    assert.match(payload.stdoutContinuation, /narrower command/);
    // Dual-stream envelope must stay valid JSON (not result_bytes fallback).
    assert.equal(payload.truncatedBy, undefined);
    assert.ok(Buffer.byteLength(payload.stdout, 'utf8') <= 50 * 1024);
  });

  it('write refuses read-tool gutter content and returns bytesWritten', async () => {
    const transport = createFakeTransport([]);
    transport.writeFile = async () => ({ size: 11, hash: 'h1' });
    const defs = createSandboxBridgeToolDefinitions(RUN_A, transport, {
      sandboxRequestBinder: createFakeBinder(),
    });
    const write = defs.find((t) => t.name === 'write');

    const bad = await write.execute('w-bad', {
      path: 'out.txt',
      content: '1|hello\n2|world\n3|again\n',
    });
    assert.match(bad.content[0].text, /WRITE_LOOKS_LIKE_READ_OUTPUT/);

    const ok = JSON.parse(
      (
        await write.execute('w-ok', {
          path: 'out.txt',
          content: 'hello world',
        })
      ).content[0].text,
    );
    assert.equal(ok.ok, true);
    assert.equal(ok.bytesWritten, 11);
    assert.equal(ok.path.includes('out.txt'), true);
  });

  it('write allows non-sequential leading-digit-pipe content that only looks like a gutter', async () => {
    const transport = createFakeTransport([]);
    transport.writeFile = async () => ({ size: 42, hash: 'h1' });
    const defs = createSandboxBridgeToolDefinitions(RUN_A, transport, {
      sandboxRequestBinder: createFakeBinder(),
    });
    const write = defs.find((t) => t.name === 'write');

    // A pipe-delimited export with a leading id column: looks like
    // "NUM|..." per line, but the numbers are not `offset + i + 1`, so it is
    // not read-tool gutter output and must not be refused.
    const result = await write.execute('w-csvish', {
      path: 'ids.txt',
      content: '17|apple\n42|banana\n3|cherry\n99|date\n',
    });
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.ok, true);
  });

  it('edit requires oldText/newText and rejects gutter text', async () => {
    const transport = createFakeTransport([]);
    transport.editFile = async () => ({ hash: 'h2', version: '3' });
    const defs = createSandboxBridgeToolDefinitions(RUN_A, transport, {
      sandboxRequestBinder: createFakeBinder(),
    });
    const edit = defs.find((t) => t.name === 'edit');

    const missing = await edit.execute('e-missing', {
      path: 'a.txt',
      expectedHash: 'abc',
    });
    assert.match(missing.content[0].text, /OLD_TEXT_REQUIRED/);

    const gutter = await edit.execute('e-gutter', {
      path: 'a.txt',
      expectedHash: 'abc',
      oldText: '1|foo\n2|bar\n3|baz',
      newText: 'x',
    });
    assert.match(gutter.content[0].text, /EDIT_LOOKS_LIKE_READ_OUTPUT/);

    const ok = JSON.parse(
      (
        await edit.execute('e-ok', {
          path: 'a.txt',
          expectedHash: 'abc',
          oldText: 'foo',
          newText: 'bar',
        })
      ).content[0].text,
    );
    assert.equal(ok.ok, true);
    assert.equal(ok.hash, 'h2');
    assert.match(ok.message, /Successfully replaced/);
  });

  it('write invalidates read dedup for the same path', async () => {
    const transport = createFakeTransport([]);
    let body = 'v1\n';
    transport.readFile = async () => ({
      content: body,
      offset: 0,
      size: body.length,
    });
    transport.writeFile = async () => {
      body = 'v2\n';
      return { size: body.length };
    };
    const defs = createSandboxBridgeToolDefinitions(RUN_A, transport, {
      sandboxRequestBinder: createFakeBinder(),
    });
    const read = defs.find((t) => t.name === 'read');
    const write = defs.find((t) => t.name === 'write');

    const r1 = JSON.parse(
      (await read.execute('r1', { path: 'x.txt', offset: 0, limit: 50 }))
        .content[0].text,
    );
    assert.match(r1.content, /v1/);

    // Same page would dedup without write:
    const dedup = JSON.parse(
      (await read.execute('r2', { path: 'x.txt', offset: 0, limit: 50 }))
        .content[0].text,
    );
    assert.equal(dedup.dedup, true);

    await write.execute('w1', { path: 'x.txt', content: 'v2\n' });

    const r3 = JSON.parse(
      (await read.execute('r3', { path: 'x.txt', offset: 0, limit: 50 }))
        .content[0].text,
    );
    assert.match(r3.content, /v2/);
    assert.equal(r3.dedup, undefined);
  });
});
