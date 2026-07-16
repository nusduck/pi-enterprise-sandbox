import assert from 'node:assert/strict';
import test from 'node:test';

import {
  McpConnectionManager,
  createEnvironmentCredentialResolver,
  normalizeMcpResult,
  validateJsonSchema,
} from '../infrastructure/mcp-connection-manager.js';
import { createMcpExtension } from '../packages/enterprise-agent-kit/extensions/mcp/index.js';
import { createCapabilityRegistry } from '../application/capability-registry-service.js';

const schema = {
  type: 'object',
  required: ['merchant_id', 'filters'],
  additionalProperties: false,
  properties: {
    merchant_id: { type: 'string', description: 'Merchant identifier' },
    filters: {
      type: 'array',
      items: { type: 'integer' },
    },
    mode: { enum: ['summary', 'full'] },
  },
};

const EXA_REMOTE_MCP = Object.freeze({
  id: 'exa',
  name: 'Exa Search',
  url: 'https://mcp.exa.ai/mcp',
  transport: 'streamable-http',
  timeoutMs: 30_000,
  retries: 1,
  enabled: true,
});

test('JSON Schema validation preserves required, nested arrays, enum and strict properties', () => {
  assert.deepEqual(validateJsonSchema(schema, {
    merchant_id: 'm1',
    filters: [1, 2],
    mode: 'summary',
  }), []);
  const errors = validateJsonSchema(schema, {
    filters: ['bad'],
    mode: 'invalid',
    extra: true,
  });
  assert.ok(errors.some((error) => error.includes('merchant_id')));
  assert.ok(errors.some((error) => error.includes('filters[0]')));
  assert.ok(errors.some((error) => error.includes('enum')));
  assert.ok(errors.some((error) => error.includes('additional property')));
});

test('MCP manager fails closed when no server allowlist is configured', async () => {
  const manager = new McpConnectionManager({
    servers: [{ id: 'unlisted', tools: [{ name: 'unsafe' }] }],
  });
  assert.deepEqual(await manager.discover(), []);
});

test('MCP manager denies all tools when allowlist is empty (fail-closed)', async () => {
  const manager = new McpConnectionManager({
    servers: [{
      id: 'risk',
      tools: [{ name: 'lookup', inputSchema: { type: 'object' } }],
    }],
    allowedServers: ['risk'],
    allowedTools: [],
  });
  assert.deepEqual(await manager.discover(), []);
});

test('MCP manager wildcard allowlist exposes all tools on allowed servers', async () => {
  const manager = new McpConnectionManager({
    servers: [{
      id: 'exa',
      tools: [
        { name: 'web_search_exa', description: 'Search' },
        { name: 'web_fetch_exa', description: 'Fetch' },
      ],
    }],
    allowedServers: ['exa'],
    allowedTools: ['*'],
  });
  const tools = await manager.discover();
  assert.equal(tools.length, 2);
});

test('MCP manager forwards trusted identity headers, retries, and sanitizes results', async () => {
  let attempt = 0;
  const calls = [];
  const manager = new McpConnectionManager({
    servers: [{
      id: 'risk',
      url: 'https://mcp.example/rpc',
      retries: 1,
      tools: [{ name: 'lookup', inputSchema: { type: 'object' } }],
    }],
    allowedServers: ['risk'],
    allowedTools: ['*'],
    context: () => ({
      user_id: 'user-1',
      tenant_id: 'tenant-1',
      conversation_id: 'conv-1',
      run_id: 'run-1',
    }),
    fetch: async (_url, init) => {
      attempt += 1;
      calls.push(init);
      if (attempt === 1) throw new Error('temporary');
      const request = JSON.parse(init.body);
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: { api_key: 'must-not-leak', conclusion: 'allowed' },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const invoked = await manager.invoke('risk:lookup', {});
  assert.equal(attempt, 2);
  assert.equal(calls[1].headers['x-user-id'], 'user-1');
  assert.equal(calls[1].headers['x-tenant-id'], 'tenant-1');
  assert.equal(invoked.result.api_key, '[REDACTED]');
  assert.match(invoked.resultRef, /^mcp_result_/);
});

test('MCP result normalization truncates oversized payloads', () => {
  const output = normalizeMcpResult({ value: 'x'.repeat(100) }, { maxBytes: 20 });
  assert.equal(output.truncated, true);
  assert.equal(output.value.result_ref, output.resultRef);
});

test('MCP manager discovers on demand, keeps schema, injects credentials outside arguments', async () => {
  const calls = [];
  const manager = new McpConnectionManager({
    servers: [{ id: 'risk', url: 'https://mcp.example/rpc', authTokenRef: 'RISK_TOKEN' }],
    allowedServers: ['risk'],
    allowedTools: ['*'],
    credentialResolver: { resolve: () => 'top-secret' },
    fetch: async (_url, init) => {
      const request = JSON.parse(init.body);
      calls.push({ request, headers: init.headers });
      const result = request.method === 'tools/list'
        ? { tools: [{ name: 'merchant_query', description: 'merchant risk', inputSchema: schema }] }
        : { content: [{ type: 'text', text: 'low risk' }] };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  const found = await manager.search('merchant risk');
  assert.equal(found[0].tool, 'risk:merchant_query');
  const described = await manager.describe('risk:merchant_query');
  assert.deepEqual(described.inputSchema, schema);
  const invoked = await manager.invoke('risk:merchant_query', {
    merchant_id: 'm1',
    filters: [1],
  });
  assert.equal(invoked.status, 'ok');
  assert.equal(calls[1].headers.authorization, 'Bearer top-secret');
  assert.equal(JSON.stringify(calls[1].request).includes('top-secret'), false);
});

test('remote Exa MCP search contract is discoverable and invokable without embedded credentials', async () => {
  const requests = [];
  const manager = new McpConnectionManager({
    servers: [EXA_REMOTE_MCP],
    allowedServers: ['exa'],
    allowedTools: ['exa:web_search_exa'],
    fetch: async (url, init) => {
      assert.equal(url, EXA_REMOTE_MCP.url);
      const request = JSON.parse(init.body);
      requests.push({ request, headers: init.headers });
      const result = request.method === 'tools/list'
        ? {
            tools: [{
              name: 'web_search_exa',
              description: 'Search the web and return grounded results',
              inputSchema: {
                type: 'object',
                required: ['query'],
                properties: { query: { type: 'string' } },
                additionalProperties: false,
              },
            }],
          }
        : { content: [{ type: 'text', text: 'search result' }] };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  const found = await manager.search('web search');
  assert.deepEqual(found.map((tool) => tool.tool), ['exa:web_search_exa']);
  const invoked = await manager.invoke('exa:web_search_exa', { query: 'remote MCP' });
  assert.equal(invoked.status, 'ok');
  assert.equal(requests[1].request.method, 'tools/call');
  assert.deepEqual(requests[1].request.params, {
    name: 'web_search_exa',
    arguments: { query: 'remote MCP' },
  });
  assert.equal(Object.hasOwn(requests[0].headers, 'authorization'), false);
});

test('single MCP extension exposes only mcp and defers side effects to durable approval', async () => {
  const registered = [];
  const suspended = [];
  createMcpExtension({
    manager: {
      invoke: async () => ({
        status: 'approval_required',
        tool: { key: 'ops:delete', riskLevel: 'high' },
      }),
    },
    createApproval: async () => ({ approval_id: 'approval_1' }),
    onApprovalSuspend: async (pending) => suspended.push(pending),
  })({
    registerTool: (tool) => registered.push(tool),
    on() {},
  });

  assert.ok(registered.map((tool) => tool.name).includes('mcp'));
  const pendingResult = await registered[0].execute('call_1', {
    action: 'invoke',
    tool: 'ops:delete',
    arguments: {},
  });
  assert.equal(pendingResult?.details?.approval_suspended, true);
  assert.equal(pendingResult?.terminate, true);
  assert.equal(pendingResult?.details?.approval_id, 'approval_1');
  assert.equal(suspended[0].approval_id, 'approval_1');
});

test('MCP approval scope follows tool-call attempts and consumes resume approval once', async () => {
  const registered = [];
  const suspended = [];
  const approvalRequests = [];
  const approvalsByKey = new Map();
  let resumeToken = null;
  let consumed = 0;
  const manager = {
    invoke: async (_tool, _args, { approved }) => {
      if (!approved) {
        return {
          status: 'approval_required',
          tool: { key: 'ops:delete', riskLevel: 'high' },
        };
      }
      return {
        status: 'ok',
        serverId: 'server-1',
        tool: { key: 'ops:delete' },
        result: { deleted: true },
        resultRef: 'mcp_result_1',
        timestamp: '2026-07-15T00:00:00Z',
        truncated: false,
      };
    },
  };
  const options = {
    manager,
    getMeta: () => ({ session_id: 'sess-mcp', run_id: 'run-mcp' }),
    createApproval: async (request) => {
      approvalRequests.push(request);
      const existing = approvalsByKey.get(request.idempotency_key);
      if (existing) return existing;
      const created = {
        approval_id: `approval_mcp_${approvalRequests.length}`,
        idempotency_key: request.idempotency_key,
      };
      approvalsByKey.set(request.idempotency_key, created);
      return created;
    },
    onApprovalSuspend: async (pending) => suspended.push(pending),
  };
  createMcpExtension(options)({ registerTool: (tool) => registered.push(tool), on() {} });
  const firstArgs = { nested: { z: 1, a: 2 }, query: 'same' };
  const reorderedArgs = { query: 'same', nested: { a: 2, z: 1 } };

  const firstSuspend = await registered[0].execute('mcp_call_1', {
    action: 'invoke',
    tool: 'ops:delete',
    arguments: firstArgs,
  });
  assert.equal(firstSuspend?.details?.approval_suspended, true);
  const secondSuspend = await registered[0].execute('mcp_call_1', {
    action: 'invoke',
    tool: 'ops:delete',
    arguments: reorderedArgs,
  });
  assert.equal(secondSuspend?.details?.approval_suspended, true);
  assert.equal(approvalRequests.length, 2);
  assert.equal(approvalRequests[0].idempotency_key, approvalRequests[1].idempotency_key);
  assert.equal(suspended[0].operation_fingerprint, suspended[1].operation_fingerprint);

  resumeToken = {
    approval_id: suspended[0].approval_id,
    idempotency_key: suspended[0].idempotency_key,
    operation_fingerprint: suspended[0].operation_fingerprint,
    tool_name: suspended[0].tool_name,
    run_id: 'run-mcp',
    sandbox_session_id: 'sess-mcp',
  };
  const resumedRegistered = [];
  createMcpExtension({
    ...options,
    getPreApprovedAttempt: () => resumeToken,
    consumePreApprovedAttempt: () => {
      consumed += 1;
      resumeToken = null;
    },
  })({ registerTool: (tool) => resumedRegistered.push(tool), on() {} });
  const resumed = await resumedRegistered[0].execute('mcp_call_2', {
    action: 'invoke',
    tool: 'ops:delete',
    arguments: reorderedArgs,
  });
  assert.equal(resumed.isError, false);
  assert.equal(consumed, 1);

  const thirdSuspend = await resumedRegistered[0].execute('mcp_call_3', {
    action: 'invoke',
    tool: 'ops:delete',
    arguments: reorderedArgs,
  });
  assert.equal(thirdSuspend?.details?.approval_suspended, true);
  assert.equal(approvalRequests.length, 3);
  assert.notEqual(approvalRequests[2].idempotency_key, approvalRequests[0].idempotency_key);
  assert.equal(consumed, 1);
});

test('search keyword miss returns full inventory instead of empty', async () => {
  const manager = new McpConnectionManager({
    servers: [{
      id: 'exa',
      tools: [
        { name: 'web_search_exa', description: 'Search the web for any topic' },
        { name: 'web_fetch_exa', description: 'Fetch a URL as markdown' },
      ],
    }],
    allowedServers: ['exa'],
    allowedTools: ['*'],
  });
  const weather = await manager.search('weather');
  assert.equal(weather.length, 2);
  assert.equal(weather[0].matched, false);
  const empty = await manager.search('');
  assert.equal(empty.length, 2);
  const named = await manager.search('web_search');
  assert.ok(named.some((t) => t.score > 0));
});

test('session_start injects first-class mcp tools via extension', async () => {
  const { toRegisteredMcpToolName, createMcpExtension } = await import(
    '../packages/enterprise-agent-kit/extensions/mcp/index.js'
  );
  const exaName = toRegisteredMcpToolName('exa:web_search_exa');
  assert.ok(exaName.startsWith('mcp_exa_web_search_exa_'));
  assert.ok(exaName.length <= 64);
  assert.match(exaName, /^mcp_[a-z0-9_]+$/);

  const manager = new McpConnectionManager({
    servers: [{
      id: 'exa',
      tools: [
        { name: 'web_search_exa', description: 'Search the web for any topic' },
      ],
    }],
    allowedServers: ['exa'],
    allowedTools: ['*'],
  });
  const registered = [];
  const events = [];
  const handlers = {};
  const pi = {
    registerTool(def) { registered.push(def.name); },
    on(event, fn) { handlers[event] = fn; },
  };
  const registry = createCapabilityRegistry({ profileId: 'coding-agent', runId: 'mcp_run' });
  createMcpExtension({
    manager,
    emit: (ev) => events.push(ev),
    approvalMode: 'auto_approve',
    getCapabilityRegistry: () => registry,
  })(pi);
  assert.ok(registered.includes('mcp'));
  assert.equal(typeof handlers.session_start, 'function');
  await handlers.session_start({ reason: 'startup' });
  assert.ok(
    registered.includes(toRegisteredMcpToolName('exa:web_search_exa')),
    `registered=${registered}`,
  );
  assert.ok(events.some((e) => e.type === 'mcp_discovered' && e.count >= 1));
  const mcpTools = registry.list({ kind: 'mcp_tool' });
  assert.equal(mcpTools.total, 1);
  assert.equal(mcpTools.items[0].status, 'active');
  assert.equal(mcpTools.items[0].metadata.server_id, 'exa');
  assert.equal(registry.get('mcp_server:exa')?.status, 'active');

  // Refresh with empty inventory replaces stale dynamic MCP tools.
  const emptyManager = new McpConnectionManager({
    servers: [{ id: 'exa', tools: [] }],
    allowedServers: ['exa'],
    allowedTools: ['*'],
  });
  const handlers2 = {};
  const pi2 = {
    registerTool() {},
    on(event, fn) { handlers2[event] = fn; },
  };
  createMcpExtension({
    manager: emptyManager,
    getCapabilityRegistry: () => registry,
  })(pi2);
  await handlers2.session_start({ reason: 'refresh' });
  assert.equal(registry.list({ kind: 'mcp_tool' }).total, 0);
});

test('MCP registry attributes zero-tool success and failures to real server IDs', async () => {
  const registry = createCapabilityRegistry({ profileId: 'coding-agent', runId: 'mcp_ids' });
  const handlers = {};
  const pi = {
    registerTool() {},
    on(event, fn) {
      handlers[event] = fn;
    },
  };

  const emptyManager = new McpConnectionManager({
    servers: [{ id: 'knowledge', tools: [] }],
    allowedServers: ['knowledge'],
    allowedTools: ['*'],
  });
  createMcpExtension({
    manager: emptyManager,
    getCapabilityRegistry: () => registry,
    configuredMcpServers: [{ id: 'knowledge', enabled: true }],
  })(pi);
  await handlers.session_start({ reason: 'startup' });

  const server = registry.get('mcp_server:knowledge');
  assert.ok(server);
  assert.equal(server.name, 'knowledge');
  assert.equal(server.status, 'active');
  assert.equal(server.metadata.tool_count, 0);
  assert.equal(server.metadata.server_id, 'knowledge');
  assert.equal(registry.list({ kind: 'mcp_tool' }).total, 0);
  assert.equal(registry.get('mcp_server:mcp'), null);

  const failRegistry = createCapabilityRegistry({
    profileId: 'coding-agent',
    runId: 'mcp_fail',
  });
  const failHandlers = {};
  const failPi = {
    registerTool() {},
    on(event, fn) {
      failHandlers[event] = fn;
    },
  };
  createMcpExtension({
    manager: {
      discoverDetailed: async () => {
        throw new Error('connection refused at /var/folders/secret/mcp');
      },
    },
    getCapabilityRegistry: () => failRegistry,
    configuredMcpServers: [{ id: 'risk-platform', enabled: true }],
  })(failPi);
  await failHandlers.session_start({ reason: 'startup' });

  const failed = failRegistry.get('mcp_server:risk-platform');
  assert.ok(failed);
  assert.equal(failed.name, 'risk-platform');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.metadata.server_id, 'risk-platform');
  assert.ok(!String(failed.metadata.error).includes('/var/folders/secret'));
  assert.match(String(failed.metadata.error), /\[redacted-path\]/);
  assert.equal(failRegistry.get('mcp_server:mcp'), null);
});

test('registered MCP tool names are key-deterministic with hash suffix for every key', async () => {
  const {
    buildRegisteredMcpToolNameMap,
    toRegisteredMcpToolName,
    createMcpExtension,
  } = await import('../packages/enterprise-agent-kit/extensions/mcp/index.js');

  const alone = toRegisteredMcpToolName('exa:web-search');
  const withPeers = buildRegisteredMcpToolNameMap([
    { key: 'exa:web-search' },
    { key: 'exa:web_search' },
  ]).get('exa:web-search');
  const subsetRefresh = buildRegisteredMcpToolNameMap([{ key: 'exa:web-search' }]).get(
    'exa:web-search',
  );
  assert.equal(alone, withPeers);
  assert.equal(alone, subsetRefresh);
  assert.notEqual(
    toRegisteredMcpToolName('exa:web-search'),
    toRegisteredMcpToolName('exa:web_search'),
  );
  assert.match(alone, /^mcp_exa_web_search_[a-f0-9]{8}$/);

  const longA =
    'srv:tool_name_with_many_segments_that_will_be_truncated_when_sanitized_to_sdk_form_aaaa';
  const longB =
    'srv:tool_name_with_many_segments_that_will_be_truncated_when_sanitized_to_sdk_form_bbbb';
  const map = buildRegisteredMcpToolNameMap([
    { key: longA },
    { key: longB },
    { key: 'exa:web-search' },
    { key: 'exa:web_search' },
  ]);
  const names = [...map.values()];
  assert.equal(names.length, 4);
  assert.equal(new Set(names).size, 4);
  for (const name of names) {
    assert.ok(name.length <= 64);
    assert.match(name, /^mcp_[a-z0-9_]+$/);
  }

  const registry = createCapabilityRegistry({ profileId: 'coding-agent', runId: 'collision' });
  const handlers = {};
  const registered = [];
  const manager = new McpConnectionManager({
    servers: [{
      id: 'srv',
      tools: [
        { name: 'alpha_lookup', description: 'Bearer secret-token-abc' },
        { name: 'beta_lookup', description: 'api_key=live' },
      ],
    }],
    allowedServers: ['srv'],
    allowedTools: ['*'],
  });
  createMcpExtension({
    manager,
    getCapabilityRegistry: () => registry,
    configuredMcpServers: [{ id: 'srv', enabled: true }],
  })({
    registerTool(def) {
      registered.push(def.name);
    },
    on(event, fn) {
      handlers[event] = fn;
    },
  });
  await handlers.session_start({ reason: 'startup' });
  assert.equal(new Set(registered.filter((n) => n.startsWith('mcp_'))).size, 2);
  const listed = registry.list({ kind: 'mcp_tool' });
  assert.equal(listed.total, 2);
  assert.equal(new Set(listed.items.map((item) => item.name)).size, 2);
  for (const item of listed.items) {
    assert.ok(!item.description.includes('Bearer'));
    assert.ok(!item.description.includes('api_key=live'));
    assert.equal(item.metadata.registered_name, item.name);
  }
});

test('discoverDetailed tolerates partial server failure and preserves successes', async () => {
  const manager = new McpConnectionManager({
    servers: [
      { id: 'good', url: 'https://good.example/rpc', tools: [{ name: 'lookup' }] },
      { id: 'bad', url: 'https://bad.example/rpc' },
    ],
    allowedServers: ['good', 'bad'],
    allowedTools: ['*'],
    fetch: async (url) => {
      if (String(url).includes('bad')) {
        throw new Error('connection refused');
      }
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: '1',
          result: { tools: [{ name: 'lookup', description: 'ok' }] },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });
  const detailed = await manager.discoverDetailed({ refresh: true });
  assert.equal(detailed.tools.length, 1);
  assert.equal(detailed.tools[0].key, 'good:lookup');
  const good = detailed.servers.find((s) => s.serverId === 'good');
  const bad = detailed.servers.find((s) => s.serverId === 'bad');
  assert.equal(good.status, 'active');
  assert.equal(good.toolCount, 1);
  assert.equal(bad.status, 'failed');
  assert.equal(bad.toolCount, 0);
});

test('extension reconciles disabled configured MCP servers without dropping them', async () => {
  const registry = createCapabilityRegistry({ profileId: 'coding-agent', runId: 'mcp_disabled' });
  const handlers = {};
  const manager = new McpConnectionManager({
    servers: [
      { id: 'active-srv', tools: [{ name: 'lookup' }] },
      { id: 'paused-srv', enabled: false, tools: [{ name: 'unused' }] },
    ],
    allowedServers: ['active-srv', 'paused-srv'],
    allowedTools: ['*'],
  });
  createMcpExtension({
    manager,
    getCapabilityRegistry: () => registry,
    configuredMcpServers: [
      { id: 'active-srv', enabled: true },
      { id: 'paused-srv', enabled: false },
    ],
  })({
    registerTool() {},
    on(event, fn) {
      handlers[event] = fn;
    },
  });
  await handlers.session_start({ reason: 'startup' });
  const active = registry.get('mcp_server:active-srv');
  const paused = registry.get('mcp_server:paused-srv');
  assert.equal(active?.status, 'active');
  assert.equal(paused?.status, 'disabled');
  assert.equal(paused?.metadata.connection_status, 'disabled');
  assert.equal(registry.list({ kind: 'mcp_tool' }).total, 1);
});

test('partial discovery via extension marks only failing server failed', async () => {
  const registry = createCapabilityRegistry({ profileId: 'coding-agent', runId: 'partial' });
  const handlers = {};
  const manager = new McpConnectionManager({
    servers: [
      { id: 'alpha', url: 'https://alpha/rpc', tools: [{ name: 'alpha_tool' }] },
      { id: 'beta', url: 'https://beta/rpc' },
    ],
    allowedServers: ['alpha', 'beta'],
    allowedTools: ['*'],
    fetch: async (url) => {
      if (String(url).includes('beta')) {
        throw new Error('beta unavailable');
      }
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: '1',
          result: { tools: [{ name: 'alpha_tool' }] },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });
  createMcpExtension({
    manager,
    getCapabilityRegistry: () => registry,
    configuredMcpServers: [
      { id: 'alpha', enabled: true },
      { id: 'beta', enabled: true },
    ],
  })({
    registerTool() {},
    on(event, fn) {
      handlers[event] = fn;
    },
  });
  await handlers.session_start({ reason: 'startup' });
  assert.equal(registry.get('mcp_server:alpha')?.status, 'active');
  assert.equal(registry.get('mcp_server:beta')?.status, 'failed');
  assert.equal(registry.list({ kind: 'mcp_tool' }).total, 1);
});

test('credential resolver errors omit secret reference names', () => {
  const resolver = createEnvironmentCredentialResolver({});
  assert.throws(
    () => resolver.resolve('RISK_TOKEN'),
    (error) =>
      error.message === 'MCP credential reference is unavailable' &&
      !error.message.includes('RISK_TOKEN'),
  );
});

test('same-extension MCP refresh deactivates stale Pi tools via setActiveTools', async () => {
  const { toRegisteredMcpToolName } = await import(
    '../packages/enterprise-agent-kit/extensions/mcp/index.js'
  );
  const nameA = toRegisteredMcpToolName('srv:tool_a');
  const nameB = toRegisteredMcpToolName('srv:tool_b');
  let activeTools = ['read', 'capabilities', nameA, nameB];
  const setActiveCalls = [];
  let discoveryTools = [
    {
      key: 'srv:tool_a',
      serverId: 'srv',
      name: 'tool_a',
      description: 'a',
      riskLevel: 'low',
      sideEffect: false,
    },
    {
      key: 'srv:tool_b',
      serverId: 'srv',
      name: 'tool_b',
      description: 'b',
      riskLevel: 'low',
      sideEffect: false,
    },
  ];
  const manager = {
    discoverDetailed: async () => ({
      tools: discoveryTools,
      servers: [{ serverId: 'srv', status: 'active', toolCount: discoveryTools.length }],
    }),
  };
  const handlers = {};
  const registered = [];
  const pi = {
    registerTool(def) {
      registered.push(def.name);
    },
    getActiveTools: () => [...activeTools],
    setActiveTools: (names) => {
      setActiveCalls.push([...names]);
      activeTools = [...names];
    },
    on(event, fn) {
      handlers[event] = fn;
    },
  };
  createMcpExtension({
    manager,
    configuredMcpServers: [{ id: 'srv', enabled: true }],
  })(pi);
  await handlers.session_start({ reason: 'first' });
  assert.ok(activeTools.includes(nameA));
  assert.ok(activeTools.includes(nameB));
  assert.ok(activeTools.includes('read'));
  assert.ok(activeTools.includes('capabilities'));

  discoveryTools = [discoveryTools[0]];
  await handlers.session_start({ reason: 'refresh' });
  const lastSet = setActiveCalls[setActiveCalls.length - 1];
  assert.ok(!lastSet.includes(nameB));
  assert.ok(lastSet.includes(nameA));
  assert.ok(lastSet.includes('read'));
  assert.ok(lastSet.includes('capabilities'));
  assert.equal(registered.filter((n) => n === nameB).length, 1);
});

test('MCP audit events sanitize bounded tool identifiers', async () => {
  const events = [];
  const registered = [];
  createMcpExtension({
    manager: {
      invoke: async () => {
        throw new Error('invoke failed');
      },
      search: async () => [
        {
          key: 'risk:lookup',
          tool: 'api_key=live-secret',
          name: 'lookup',
          description: 'Bearer sk-audit',
        },
      ],
    },
    emit: (event) => events.push(event),
  })({
    registerTool: (tool) => registered.push(tool),
    on() {},
  });

  await registered[0].execute('c1', {
    action: 'invoke',
    tool: 'api_key=live-secret',
    arguments: {},
  });
  const failed = events.find((event) => event.type === 'mcp_failed');
  assert.ok(failed);
  assert.ok(!String(failed.tool).includes('live-secret'));
  assert.match(String(failed.tool), /\[REDACTED\]/);

  await registered[0].execute('c2', { action: 'search', query: 'x' });
  const discovered = events.find(
    (event) => event.type === 'mcp_discovered' && event.query === 'x',
  );
  assert.ok(discovered);
  for (const row of discovered.tools) {
    assert.ok(!String(row.tool).includes('live-secret'));
    assert.ok(!String(row.description).includes('Bearer'));
  }
});

test('MCP meta-tool errors are sanitized in content and details', async () => {
  const registered = [];
  createMcpExtension({
    manager: {
      search: async () => {
        throw new Error('Bearer sk-bad-token api_key=leak');
      },
    },
  })({
    registerTool: (tool) => registered.push(tool),
    on() {},
  });
  const response = await registered[0].execute('c1', { action: 'search', query: 'x' });
  const payload = JSON.parse(response.content[0].text);
  assert.equal(response.details.error, payload.error);
  assert.ok(!payload.error.includes('sk-bad-token'));
  assert.match(payload.error, /\[REDACTED\]/);
});

test('extension registry uses the same hash-suffixed name after subset refresh', async () => {
  const { toRegisteredMcpToolName } = await import(
    '../packages/enterprise-agent-kit/extensions/mcp/index.js'
  );
  const expected = toRegisteredMcpToolName('exa:web-search');
  const registry = createCapabilityRegistry({ profileId: 'coding-agent', runId: 'stable_map' });
  const handlers = {};
  let toolList = [
    { name: 'web-search', description: 'a' },
    { name: 'web_search', description: 'b' },
  ];
  const manager = {
    discoverDetailed: async () => ({
      tools: toolList.map((tool) => ({
        key: `exa:${tool.name}`,
        serverId: 'exa',
        name: tool.name,
        description: tool.description,
        riskLevel: 'low',
        sideEffect: false,
      })),
      servers: [{ serverId: 'exa', status: 'active', toolCount: toolList.length, error: null }],
    }),
  };
  createMcpExtension({
    manager,
    getCapabilityRegistry: () => registry,
    configuredMcpServers: [{ id: 'exa', enabled: true }],
  })({
    registerTool() {},
    on(event, fn) {
      handlers[event] = fn;
    },
  });
  await handlers.session_start({ reason: 'first' });
  const firstName = registry.list({ kind: 'mcp_tool' }).items.find(
    (item) => item.metadata.tool_key === 'exa:web-search',
  )?.name;
  toolList = [{ name: 'web-search', description: 'a' }];
  await handlers.session_start({ reason: 'second' });
  const secondName = registry.list({ kind: 'mcp_tool' }).items.find(
    (item) => item.metadata.tool_key === 'exa:web-search',
  )?.name;
  assert.equal(firstName, expected);
  assert.equal(secondName, expected);
  assert.equal(firstName, secondName);
});

test('MCP discovery redacts secrets from remote tool descriptions', async () => {
  const manager = new McpConnectionManager({
    servers: [{
      id: 'risk',
      tools: [{
        name: 'lookup',
        description: 'Use Bearer sk-live-abc and postgres://user:pass@db.internal/prod',
        inputSchema: { type: 'object' },
      }],
    }],
    allowedServers: ['risk'],
    allowedTools: ['*'],
  });
  const tools = await manager.discover();
  assert.ok(!tools[0].description.includes('Bearer sk-live'));
  assert.ok(!tools[0].description.includes('user:pass'));
  assert.match(tools[0].description, /\[REDACTED\]/);
});
