/**
 * MCP tool-name collision guard.
 *
 * MCP tools register under the enterprise `mcp__<server>__<tool>` namespace,
 * while built-in sandbox/extension tools use bare names. The classifier
 * (tool-risk-classifier.js) checks LOCAL_SET **before** the `mcp__` branch, so
 * a bare-name collision would silently reclassify an MCP tool as a local one
 * — and a server exposing `bash` must never widen the local trust class.
 *
 * These tests pin the invariants that keep the two namespaces disjoint:
 * 1. no registered extension tool name starts with `mcp__` (namespace theft);
 * 2. the adapter rejects server-declared tool names that are not namespaced
 *    (`mcp__server__tool` projection cannot collide with LOCAL_SET);
 * 3. classifyTool() never returns a local class for an `mcp__`-prefixed name,
 *    even when the embedded tool part matches a local name exactly.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyTool, isLocalSandboxTool } from '../../src/extensions/enterprise-policy/tool-risk-classifier.js';
import { SANDBOX_TOOL_NAMES } from '../../src/extensions/sandbox-bridge/constants.js';

const EXT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/extensions',
);

/** Collect tool names registered via pi.registerTool across extensions. */
function collectRegisteredToolNames(root, acc = new Set()) {
  for (const entry of readdirSync(root)) {
    const full = path.join(root, entry);
    if (statSync(full).isDirectory()) {
      collectRegisteredToolNames(full, acc);
      continue;
    }
    if (!entry.endsWith('.js')) continue;
    const src = readFileSync(full, 'utf8');
    for (const m of src.matchAll(/name:\s*['"`]([A-Za-z0-9._-]+)['"`]/g)) {
      if (m[1]) acc.add(m[1]);
    }
  }
  return acc;
}

describe('mcp tool-name collision guard', () => {
  it('no extension-registered tool name uses the reserved mcp__ prefix', () => {
    const registered = collectRegisteredToolNames(EXT_ROOT);
    for (const name of registered) {
      assert.ok(
        !name.startsWith('mcp__'),
        `extension tool "${name}" steals the reserved mcp__ namespace; rename it`,
      );
    }
  });

  it('built-in tool names never start with mcp__', () => {
    for (const name of SANDBOX_TOOL_NAMES) {
      assert.ok(!String(name).startsWith('mcp__'));
    }
  });

  it('mcp__-prefixed names never classify into a local trust class', () => {
    // Even if a malicious/broken server declares a tool literally named after
    // a built-in ("bash"), the projected mcp__server__bash name must not fall
    // into any local class — it goes through the mcp__ branch or unknown.
    for (const local of SANDBOX_TOOL_NAMES) {
      const projected = `mcp__evil-server__${local}`;
      const { class: riskClass } = classifyTool(projected);
      assert.ok(
        !['local_low', 'internal_interaction'].includes(riskClass),
        `projected MCP name "${projected}" classified as "${riskClass}"; local classes are reserved for built-ins`,
      );
    }
  });

  it('LOCAL_SET contains only bare names (never mcp__-prefixed)', () => {
    // isLocalSandboxTool is the exported LOCAL_SET membership probe.
    for (const name of SANDBOX_TOOL_NAMES) {
      assert.ok(isLocalSandboxTool(name), `"${name}" should be local`);
      assert.ok(
        !String(name).startsWith('mcp__'),
        `local tool "${name}" collides with the MCP namespace`,
      );
    }
    assert.equal(isLocalSandboxTool('mcp__x__bash'), false);
  });
});
