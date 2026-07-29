/**
 * Extension registry guards.
 *
 * The bundle is no longer pinned to exactly three extensions, so these tests
 * hold the invariants that replaced that constraint:
 *   1. only compiled-in first-party extensions can load,
 *   2. every tool an extension registers must be classifiable, otherwise the
 *      policy engine denies it as UNKNOWN_TOOL_DENIED,
 *   3. required extensions always load.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXTENSION_LOAD_ORDER,
  OPTIONAL_EXTENSION_NAMES,
  REGISTERED_EXTENSION_NAMES,
  REQUIRED_EXTENSION_NAMES,
  createEnterpriseExtensionBundle,
  extensionFactoryNames,
} from '../../src/extensions/index.js';
import { classifyTool } from '../../src/extensions/enterprise-policy/tool-risk-classifier.js';

const EXT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/extensions',
);

const RUN_CTX = Object.freeze({
  orgId: '01K0G2PAV8FPMVC9QHJG7JPN4Z',
  userId: '01K0G2PAV8FPMVC9QHJG7JPN50',
  conversationId: '01K0G2PAV8FPMVC9QHJG7JPN51',
  agentSessionId: '01K0G2PAV8FPMVC9QHJG7JPN52',
  runId: '01K0G2PAV8FPMVC9QHJG7JPN5H',
  sandboxSessionId: '01K0G2PAV8FPMVC9QHJG7JPN5F',
  traceId: 'b'.repeat(32),
  executionFenceToken: 3,
});

/** Collect `name: '<tool>'` literals passed to pi.registerTool across a dir. */
function collectRegisteredToolNames(dir) {
  /** @type {Set<string>} */
  const names = new Set();
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      const full = path.join(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith('.js')) continue;
      const src = readFileSync(full, 'utf8');
      if (!src.includes('registerTool')) continue;
      for (const m of src.matchAll(/name:\s*['"]([a-z0-9_]+)['"]/gi)) {
        names.add(m[1]);
      }
    }
  };
  walk(dir);
  return names;
}

describe('extension registry', () => {
  it('load order is exactly the registered required set', () => {
    assert.deepEqual([...EXTENSION_LOAD_ORDER], [...REQUIRED_EXTENSION_NAMES]);
    for (const name of REQUIRED_EXTENSION_NAMES) {
      assert.ok(
        REGISTERED_EXTENSION_NAMES.includes(name),
        `${name} must be registered`,
      );
    }
  });

  it('optional extensions are registered and not also required', () => {
    for (const name of OPTIONAL_EXTENSION_NAMES) {
      assert.ok(REGISTERED_EXTENSION_NAMES.includes(name));
      assert.ok(
        !REQUIRED_EXTENSION_NAMES.includes(name),
        `${name} cannot be both optional and required`,
      );
    }
  });

  it('every registered extension name has a real source directory', () => {
    const dirs = new Set(
      readdirSync(EXT_ROOT).filter((entry) =>
        statSync(path.join(EXT_ROOT, entry)).isDirectory(),
      ),
    );
    for (const name of REGISTERED_EXTENSION_NAMES) {
      assert.ok(dirs.has(name), `missing src/extensions/${name}`);
    }
  });

  it('the bundle builds a factory for every required extension', () => {
    const names = extensionFactoryNames(
      createEnterpriseExtensionBundle(RUN_CTX),
    );
    assert.deepEqual(names, [...REQUIRED_EXTENSION_NAMES]);
  });

  it('every extension-registered tool is classifiable (never UNKNOWN_TOOL_DENIED)', () => {
    // A new extension that registers a tool without adding a classifier entry
    // would ship a tool the policy engine always denies. Catch that here
    // rather than at runtime.
    const registered = collectRegisteredToolNames(EXT_ROOT);
    assert.ok(registered.size > 0, 'expected to find registered tools');
    assert.ok(registered.has('ask_user'), 'ask_user must still be registered');

    for (const tool of registered) {
      const { class: riskClass } = classifyTool(tool);
      assert.notEqual(
        riskClass,
        'unknown',
        `tool "${tool}" is registered by an extension but classifyTool() returns 'unknown', so the policy engine denies it as UNKNOWN_TOOL_DENIED; add it to tool-risk-classifier.js`,
      );
    }
  });
});
