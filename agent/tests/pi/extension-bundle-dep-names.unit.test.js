/**
 * The container and the extension bundle must agree on dep names.
 *
 * This is the guard for a whole bug class that shipped once already: the
 * container passed `subagentSpawnPort`, the extension read `deps.spawnPort`,
 * and the feature was inert with every test green — because nothing ever
 * exercised the seam between the two files.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSandboxBridgeExtensionBundleFactory } from '../../src/infrastructure/sandbox/sandbox-bridge-http-transport.js';
import { REQUIRED_EXTENSION_NAMES } from '../../src/extensions/index.js';

const SRC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src',
);

/**
 * Names the container puts on the extension bundle deps. Each must exist on
 * both sides of the seam; adding a dep means adding it here.
 */
const BUNDLE_DEP_NAMES = Object.freeze([
  'toolRiskPolicy',
  'skillManagerFactory',
  'subagentSpawnPort',
  'taskStateStore',
  'otel',
  'deltaTruncateLimit',
  'thinkingTruncateLimit',
]);

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

function collectTools(factory) {
  const tools = new Map();
  factory({ registerTool: (d) => tools.set(d.name, d), on: () => {} });
  return tools;
}

describe('container ↔ extension bundle dep names', () => {
  it('every container-supplied dep name is read by the bundle', () => {
    const container = readFileSync(
      path.join(SRC, 'bootstrap/container-run-executor.js'),
      'utf8',
    );
    const bundle = readFileSync(path.join(SRC, 'extensions/index.js'), 'utf8');
    for (const name of BUNDLE_DEP_NAMES) {
      assert.ok(
        new RegExp(`\\b${name}\\b`).test(container),
        `${name} is no longer supplied by container-run-executor.js`,
      );
      assert.ok(
        bundle.includes(`deps.${name}`),
        `createEnterpriseExtensionBundle never reads deps.${name}, so the container is wiring a dead key`,
      );
    }
  });

  it('carries those deps through the sandbox-bridge factory to live tools', async () => {
    const spawned = [];
    const stored = [];
    const extensionBundleFactory = createSandboxBridgeExtensionBundleFactory({
      sandboxTransport: {},
      // Exactly the shape container-run-executor.js builds.
      extraDeps: {
        toolRiskPolicy: undefined,
        skillManagerFactory: undefined,
        subagentSpawnPort: {
          spawn: async (input) => {
            spawned.push(input);
            return { runId: '01K0G2PAV8FPMVC9QHJG7JPN60' };
          },
          getStatuses: async () => [],
        },
        taskStateStore: {
          replaceTodos: async (input) => {
            stored.push(input);
            return [];
          },
          getTodos: async () => [],
          appendMemory: async () => ({ memoryId: 'm1' }),
          searchMemory: async () => [],
        },
        otel: true,
        deltaTruncateLimit: 512,
        thinkingTruncateLimit: 2048,
      },
    });

    const factories = extensionBundleFactory(RUN_CTX, {
      extensions: [
        ...REQUIRED_EXTENSION_NAMES,
        'subagent-spawn',
        'task-state',
      ],
      recorder: { record: async () => ({}) },
    });

    const subagent = factories.find((f) => f.extensionName === 'subagent-spawn');
    const taskState = factories.find((f) => f.extensionName === 'task-state');
    assert.ok(subagent, 'subagent-spawn must be built from the container deps');
    assert.ok(taskState, 'task-state must be built from the container deps');

    await collectTools(subagent)
      .get('spawn_subagent')
      .execute('call-1', { task: 'work' });
    await collectTools(taskState)
      .get('todo_write')
      .execute('call-2', { items: [{ content: 'plan' }] });

    assert.equal(spawned.length, 1, 'spawn port reached from the container path');
    assert.equal(stored.length, 1, 'task state store reached from the container path');
  });
});
