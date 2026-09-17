/**
 * Live MCP readiness projects snake_case (`server_id` / `tools` /
 * `connection_status`). The capabilities catalog must accept that shape or it
 * silently falls back to "configured, zero tools".
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getExtensionDiagnostics } from '../src/application/extension-diagnostics-service.js';

test('snake_case live MCP readiness surfaces tool names in the catalog', () => {
  const diagnostics = getExtensionDiagnostics({
    mcpServers: [
      {
        serverId: 'demo',
        command: 'node',
        args: ['demo-server.js'],
        enabled: true,
      },
    ],
    mcpDiscovery: {
      ready: true,
      servers: [
        {
          server_id: 'demo',
          connection_status: 'connected',
          tools: ['ping', 'echo'],
        },
      ],
    },
  });

  const server = diagnostics.mcp_servers.find((entry) => entry.server_id === 'demo');
  assert.ok(server);
  assert.equal(server.connection_status, 'connected');
  assert.equal(server.tool_count, 2);
  assert.deepEqual(server.tools, ['ping', 'echo']);

  const toolNames = diagnostics.tools
    .filter((tool) => tool.source === 'mcp')
    .map((tool) => tool.name)
    .sort();
  assert.deepEqual(toolNames, ['mcp__demo__echo', 'mcp__demo__ping']);
});

test('camelCase discovery shape still works for AgentVersion-style callers', () => {
  const diagnostics = getExtensionDiagnostics({
    mcpServers: [{ serverId: 'demo', url: 'https://example.test/mcp', enabled: true }],
    mcpDiscovery: {
      ready: true,
      servers: [
        {
          serverId: 'demo',
          status: 'connected',
          toolNames: ['lookup'],
        },
      ],
    },
  });

  const server = diagnostics.mcp_servers.find((entry) => entry.server_id === 'demo');
  assert.equal(server.tool_count, 1);
  assert.deepEqual(server.tools, ['lookup']);
});
