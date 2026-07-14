import assert from 'node:assert/strict';
import test from 'node:test';

import {
  McpConnectionManager,
  normalizeMcpResult,
  validateJsonSchema,
} from '../infrastructure/mcp-connection-manager.js';
import { createMcpExtension } from '../packages/enterprise-agent-kit/extensions/mcp/index.js';

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
  })({ registerTool: (tool) => registered.push(tool) });

  assert.deepEqual(registered.map((tool) => tool.name), ['mcp']);
  await assert.rejects(
    registered[0].execute('call_1', {
      action: 'invoke',
      tool: 'ops:delete',
      arguments: {},
    }),
    { name: 'ApprovalSuspendedError' },
  );
  assert.equal(suspended[0].approval_id, 'approval_1');
});
