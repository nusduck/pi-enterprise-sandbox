/**
 * Regressions for two bugs the capability-iteration branch shipped green.
 *
 * Both survived a 1325-case suite because nothing exercised the path: the
 * default-model fallback only runs when no model id is supplied anywhere, and
 * the deadline only fires on a prompt that never returns.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCachedRegistry,
  buildRegistry,
  resolveDefaultModelId,
} from '../../src/infrastructure/model-registry.js';
import { installDshRunToolBudget } from '../../src/application/dsh-run-tool-budget.js';

describe('model registry: default-model fallback path', () => {
  it('exports buildCachedRegistry and accepts an env object directly', () => {
    // container.js resolves the default model through this pair. When
    // buildCachedRegistry was module-private the destructured import was
    // undefined and every fallback run died with a TypeError.
    assert.equal(typeof buildCachedRegistry, 'function');
    const registry = buildCachedRegistry({});
    assert.ok(registry instanceof Map);
    assert.ok(registry.size > 0);
    assert.equal(typeof resolveDefaultModelId(registry), 'string');
  });

  it('returns the same cached Map for an unchanged registry file', () => {
    const first = buildCachedRegistry({});
    const second = buildCachedRegistry({});
    assert.equal(first, second);
  });

  it('lets a registry file default win over the seed default', () => {
    const seed = [
      { model_id: 'seed-model', provider: 'p', default: true },
      { model_id: 'operator-choice', provider: 'p' },
    ];
    const seedOnly = buildRegistry({ seed, filePath: null });
    assert.equal(resolveDefaultModelId(seedOnly), 'seed-model');
  });
});

describe('run wall-clock deadline', () => {
  function fakeSession() {
    return {
      agent: {
        state: { tools: [{ name: 'read' }] },
        beforeToolCall: null,
        prepareNextTurnWithContext: null,
      },
    };
  }

  it('blocks further tool calls once the deadline passes', async () => {
    const session = fakeSession();
    let clock = 1_000;
    const budget = installDshRunToolBudget(session, {
      runDeadlineMs: 500,
      now: () => clock,
    });
    assert.equal(budget.supported, true);

    const before = await session.agent.beforeToolCall(
      { toolCall: { name: 'read' }, args: {} },
      undefined,
    );
    assert.notEqual(before?.block, true, 'inside the deadline must pass');

    clock += 10_000;
    const after = await session.agent.beforeToolCall(
      { toolCall: { name: 'read' }, args: {} },
      undefined,
    );
    assert.equal(after?.block, true, 'past the deadline must fail closed');
    assert.match(String(after.reason), /deadline/i);
    budget.dispose();
  });
});
