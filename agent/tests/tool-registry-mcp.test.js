/**
 * B5 — ToolRegistry + MCP tool formatting.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createToolRegistry,
  TOOL_CATEGORY,
  TOOL_REGISTRY_VERSION,
  BUILTIN_TOOLS,
  categoryForBuiltin,
} from '../tool-registry.js';
import { formatMcpToolResult } from '../mcp-tools.js';
import { BASE_TOOL_NAMES, resolveToolAllowlist } from '../chat-runner.js';

describe('tool registry (B5)', () => {
  it('seeds all categories and version', () => {
    const reg = createToolRegistry();
    assert.equal(reg.version, TOOL_REGISTRY_VERSION);
    const tree = reg.tree();
    assert.ok(tree[TOOL_CATEGORY.SANDBOX].includes('read'));
    assert.ok(tree[TOOL_CATEGORY.PROCESS].includes('process_start'));
    assert.ok(tree[TOOL_CATEGORY.ARTIFACT].includes('submit_artifact'));
    assert.ok(tree[TOOL_CATEGORY.SKILL].includes('skill_install'));
  });

  it('register MCP tools and include in allowlist', () => {
    const reg = createToolRegistry();
    reg.register({
      name: 'mcp_demo_echo',
      category: TOOL_CATEGORY.MCP,
      description: 'echo',
      execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    });
    assert.equal(reg.has('mcp_demo_echo'), true);
    assert.ok(reg.allowlist({ includeMcp: true }).includes('mcp_demo_echo'));
    assert.ok(!reg.allowlist({ includeMcp: false }).includes('mcp_demo_echo'));
    assert.equal(reg.customTools().length, 1);
  });

  it('BASE_TOOL_NAMES covers sandbox + process + artifact', () => {
    for (const n of BUILTIN_TOOLS[TOOL_CATEGORY.SANDBOX]) {
      assert.ok(BASE_TOOL_NAMES.includes(n), n);
    }
    for (const n of BUILTIN_TOOLS[TOOL_CATEGORY.PROCESS]) {
      assert.ok(BASE_TOOL_NAMES.includes(n), n);
    }
    assert.ok(BASE_TOOL_NAMES.includes('submit_artifact'));
  });

  it('resolveToolAllowlist appends MCP extras', () => {
    const al = resolveToolAllowlist('readonly', ['mcp_sandbox_read_file']);
    assert.ok(al.includes('read'));
    assert.ok(al.includes('mcp_sandbox_read_file'));
    assert.ok(!al.includes('skill_install'));
  });

  it('categoryForBuiltin classifies mcp_ prefix', () => {
    assert.equal(categoryForBuiltin('read'), TOOL_CATEGORY.SANDBOX);
    assert.equal(categoryForBuiltin('process_start'), TOOL_CATEGORY.PROCESS);
    assert.equal(categoryForBuiltin('mcp_x_y'), TOOL_CATEGORY.MCP);
  });
});

describe('formatMcpToolResult', () => {
  it('formats ok envelope', () => {
    const r = formatMcpToolResult({
      status: 'ok',
      content: { hello: 1 },
      server_id: 'demo',
      tool_name: 'mcp_demo_echo',
      normalized: true,
      duration_ms: 3,
    });
    assert.equal(r.isError, false);
    assert.match(r.content[0].text, /hello/);
    assert.equal(r.details.server_id, 'demo');
  });

  it('formats error envelope', () => {
    const r = formatMcpToolResult({
      status: 'denied',
      error: 'not authorized',
      normalized: true,
    });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /not authorized/);
  });
});
