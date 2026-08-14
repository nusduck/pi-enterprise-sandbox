/**
 * The per-Run tool budget rides on two pi-agent-core Agent fields —
 * `beforeToolCall` and `prepareNextTurnWithContext` — that are not part of
 * `@earendil-works/pi-coding-agent`'s public export surface.
 *
 * The failure mode this suite exists for is silence: if a Pi upgrade renames
 * those fields, makes them read-only, or turns them into handler arrays, the
 * budget stops applying while every functional test keeps passing, and a Run
 * quietly regains an unbounded tool loop.
 *
 * So this asserts the *shape the patch depends on*, against a session built by
 * the installed SDK. Break here, and P1-C in the review says what to do: move
 * the budget onto the public `tool_call` extension event.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AuthStorage,
  SessionManager,
  createAgentSessionServices,
  createAgentSessionFromServices,
} from '@earendil-works/pi-coding-agent';
import { installPiRunToolBudget } from '../../src/application/pi-run-tool-budget.js';

const model = Object.freeze({
  id: 'test-model',
  name: 'Test',
  api: 'openai-completions',
  provider: 'test',
  baseUrl: 'http://localhost',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4096,
});

describe('Agent hook points the run tool budget depends on', () => {
  /** @type {string} */ let cwd;
  /** @type {string} */ let agentDir;
  /** @type {object[]} */ const sessions = [];

  before(() => {
    cwd = mkdtempSync(join(tmpdir(), 'pi-hooks-cwd-'));
    agentDir = mkdtempSync(join(tmpdir(), 'pi-hooks-agent-'));
  });

  after(() => {
    for (const session of sessions) {
      try {
        session.dispose();
      } catch {
        /* best-effort */
      }
    }
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });

  async function buildSession() {
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      authStorage: AuthStorage.inMemory({
        test: { type: 'api_key', key: 'not-used' },
      }),
      resourceLoaderOptions: { systemPrompt: 'test', noExtensions: true },
    });
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(cwd),
      model,
    });
    sessions.push(session);
    return session;
  }

  it('exposes agent.beforeToolCall and prepareNextTurnWithContext as writable functions', async () => {
    const session = await buildSession();
    const agent = session.agent;
    assert.ok(agent, 'AgentSession must expose the underlying Agent');

    for (const hook of ['beforeToolCall', 'prepareNextTurnWithContext']) {
      assert.equal(
        typeof agent[hook],
        'function',
        `Agent.${hook} must be an installed function (AgentSession installs its own)`,
      );
      const descriptor =
        Object.getOwnPropertyDescriptor(agent, hook) ??
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(agent), hook);
      assert.ok(descriptor, `Agent.${hook} must be an own or inherited property`);
      assert.notEqual(
        descriptor.writable === false && descriptor.set === undefined,
        true,
        `Agent.${hook} must stay assignable for the run tool budget to chain onto it`,
      );
    }
  });

  it('agent.state.tools is the array the budget empties to force convergence', async () => {
    const session = await buildSession();
    assert.ok(
      Array.isArray(session.agent?.state?.tools),
      'the budget detects support by this shape and silently no-ops without it',
    );
  });

  it('installPiRunToolBudget reports supported and actually intercepts', async () => {
    const session = await buildSession();
    const guard = installPiRunToolBudget(session, {
      maxToolCalls: 1,
      maxIdenticalToolCalls: 1,
      maxModelTurns: 5,
    });
    assert.equal(
      guard.supported,
      true,
      'unsupported means the budget degraded to a no-op against this SDK',
    );

    try {
      const call = (name) =>
        session.agent.beforeToolCall({ toolCall: { name }, args: {} }, undefined);

      // First call is allowed and consumes the single-call budget.
      const first = await call('read');
      assert.notEqual(first?.block, true, 'the first call must pass through');

      // Second is refused: the SDK's hook really is the one being chained.
      const second = await call('read');
      assert.equal(second?.block, true, 'the budget must block past its limit');
      assert.match(String(second.reason), /RUN_TOOL_(BUDGET_EXHAUSTED|REPEAT_LIMIT)/);

      assert.equal(guard.snapshot().exhausted, true);
    } finally {
      guard.dispose();
    }
  });

  it('dispose restores the SDK hooks it replaced', async () => {
    const session = await buildSession();
    const before = session.agent.beforeToolCall;
    const beforeNextTurn = session.agent.prepareNextTurnWithContext;

    const guard = installPiRunToolBudget(session, { maxToolCalls: 1 });
    assert.notEqual(session.agent.beforeToolCall, before, 'the patch must apply');
    guard.dispose();

    assert.equal(
      session.agent.beforeToolCall,
      before,
      'a leaked budget would carry one Run limit into the next',
    );
    assert.equal(session.agent.prepareNextTurnWithContext, beforeNextTurn);
  });
});
