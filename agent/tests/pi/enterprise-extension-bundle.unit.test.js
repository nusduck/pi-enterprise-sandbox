/**
 * Enterprise extension bundle offline tests (PR-06 slice 1).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SANDBOX_TRANSPORT_METHODS } from '../../src/extensions/sandbox-bridge/transport.js';
import {
  REQUIRED_EXTENSION_NAMES,
  createEnterpriseExtensionBundle,
  assertEnterpriseRunContext,
  assertEnterpriseExtensions,
  extensionFactoryNames,
} from '../../src/extensions/index.js';
import { extractUsageSummary } from '../../src/extensions/observability/index.js';

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

describe('createEnterpriseExtensionBundle', () => {
  it('returns every required factory in fixed load order with metadata', () => {
    const factories = createEnterpriseExtensionBundle(RUN_CTX);
    assert.equal(factories.length, REQUIRED_EXTENSION_NAMES.length);
    assert.deepEqual(extensionFactoryNames(factories), [
      ...REQUIRED_EXTENSION_NAMES,
    ]);
    // Core pipeline holds positions 0..2 so added extensions never reshuffle it.
    assert.equal(factories[0].extensionMetadata.name, 'sandbox-bridge');
    assert.equal(factories[0].extensionMetadata.toolsRegistered, true);
    assert.equal(factories[1].extensionMetadata.name, 'enterprise-policy');
    assert.equal(factories[2].extensionMetadata.name, 'observability');
    assert.equal(factories[2].extensionMetadata.ownsModelRequestEvents, true);
  });

  it('loads user-interaction so ask_user survives the policy split', () => {
    const names = extensionFactoryNames(
      createEnterpriseExtensionBundle(RUN_CTX),
    );
    assert.ok(names.includes('user-interaction'));
  });

  it('an AgentVersion listing the legacy three still gets user-interaction', () => {
    const names = extensionFactoryNames(
      createEnterpriseExtensionBundle(RUN_CTX, {
        extensions: ['sandbox-bridge', 'enterprise-policy', 'observability'],
      }),
    );
    assert.deepEqual(names, [...REQUIRED_EXTENSION_NAMES]);
  });

  it('rejects selecting an unregistered extension', () => {
    assert.throws(
      () =>
        createEnterpriseExtensionBundle(RUN_CTX, {
          extensions: [...REQUIRED_EXTENSION_NAMES, 'attacker-supplied'],
        }),
      /unregistered extension/,
    );
  });

  it('rejects missing required context fields', () => {
    assert.throws(() => createEnterpriseExtensionBundle(null), /runContext/);
    assert.throws(
      () =>
        createEnterpriseExtensionBundle({
          ...RUN_CTX,
          orgId: '',
        }),
      /orgId/,
    );
    assert.throws(
      () => {
        const { sandboxSessionId: _s, ...rest } = RUN_CTX;
        createEnterpriseExtensionBundle(rest);
      },
      /sandboxSessionId/,
    );
    assert.throws(
      () =>
        createEnterpriseExtensionBundle({
          ...RUN_CTX,
          runId: undefined,
        }),
      /runId/,
    );
  });

  it('rejects null sandboxSessionId when sandbox-bridge is enabled', () => {
    assert.throws(
      () =>
        createEnterpriseExtensionBundle({
          ...RUN_CTX,
          sandboxSessionId: null,
        }),
      /RUN_IDENTITY_REQUIRED|sandboxSessionId/,
    );
  });

  it('rejects legacy sandboxClient dependency', () => {
    assert.throws(
      () =>
        createEnterpriseExtensionBundle(RUN_CTX, {
          sandboxClient: { readFile: async () => ({}) },
        }),
      /SANDBOX_CLIENT_REJECTED/,
    );
  });

  it('rejects caller-supplied extension factories', () => {
    // Extensions run inside the trust boundary, so callers may only select
    // registered names — never hand in a factory function.
    for (const key of ['extraFactories', 'factories']) {
      assert.throws(
        () =>
          createEnterpriseExtensionBundle(RUN_CTX, {
            [key]: [() => {}],
          }),
        /caller-supplied extension factories/,
        `deps.${key} must be refused`,
      );
    }
  });

  it('isolates run context per bundle (no shared mutable process state)', () => {
    const a = createEnterpriseExtensionBundle({
      ...RUN_CTX,
      runId: '01K0G2PAV8FPMVC9QHJG7JPN5A',
    });
    const b = createEnterpriseExtensionBundle({
      ...RUN_CTX,
      runId: '01K0G2PAV8FPMVC9QHJG7JPN5B',
    });
    assert.notEqual(a[0], b[0]);
    assert.notEqual(a[2], b[2]);
  });

  it('forwards the executor-owned durable interaction predicate to observability', async () => {
    const pending = new Set(['ask-user-1']);
    const ended = [];
    const factories = createEnterpriseExtensionBundle(RUN_CTX, {
      isDurableInteractionPending: (toolCallId) => pending.has(toolCallId),
      governanceRecorder: {
        async recordToolEnded(input) {
          ended.push(input);
        },
      },
    });
    const handlers = new Map();
    await factories[2]({
      on(event, handler) {
        if (!handlers.has(event)) handlers.set(event, []);
        handlers.get(event).push(handler);
      },
    });

    for (const handler of handlers.get('tool_execution_end') || []) {
      await handler({
        toolCallId: 'ask-user-1',
        toolName: 'ask_user',
        isError: true,
        result: { content: [], details: {} },
      });
      await handler({
        toolCallId: 'ask-user-ordinary',
        toolName: 'ask_user',
        isError: true,
        result: { content: [], details: {} },
      });
    }

    assert.deepEqual(
      ended.map((call) => call.toolCallId),
      ['ask-user-ordinary'],
    );
  });
});

describe('assertEnterpriseExtensions', () => {
  it('accepts empty, and the required set in any order', () => {
    assert.equal(assertEnterpriseExtensions([]).empty, true);
    const r = assertEnterpriseExtensions([...REQUIRED_EXTENSION_NAMES].reverse());
    // Always returned in deterministic load order, not caller order.
    assert.deepEqual([...r.names], [...REQUIRED_EXTENSION_NAMES]);
  });

  it('accepts the legacy required three and implies user-interaction', () => {
    const r = assertEnterpriseExtensions([
      'observability',
      'sandbox-bridge',
      'enterprise-policy',
    ]);
    assert.deepEqual([...r.names], [...REQUIRED_EXTENSION_NAMES]);
  });

  it('rejects legacy 12 names, unregistered names, and partial sets', () => {
    assert.throws(
      () => assertEnterpriseExtensions(['sandbox-tools']),
      /legacy|unregistered/,
    );
    assert.throws(
      () => assertEnterpriseExtensions(['sandbox-bridge']),
      /must include every required extension/,
    );
    assert.throws(
      () => assertEnterpriseExtensions([...REQUIRED_EXTENSION_NAMES, 'mcp']),
      /legacy/,
    );
    assert.throws(
      () =>
        assertEnterpriseExtensions([
          ...REQUIRED_EXTENSION_NAMES,
          'not-a-real-extension',
        ]),
      /unregistered extension/,
    );
  });

  it('rejects duplicates and non-array input', () => {
    assert.throws(
      () =>
        assertEnterpriseExtensions([
          ...REQUIRED_EXTENSION_NAMES,
          'sandbox-bridge',
        ]),
      /duplicates/,
    );
    assert.throws(
      () => assertEnterpriseExtensions('sandbox-bridge'),
      /must be an array/,
    );
  });
});

describe('assertEnterpriseRunContext', () => {
  it('freezes identity fields including numeric executionFenceToken', () => {
    const frozen = assertEnterpriseRunContext(RUN_CTX);
    assert.ok(Object.isFrozen(frozen));
    assert.equal(frozen.runId, RUN_CTX.runId);
    assert.equal(frozen.executionFenceToken, 3);
    assert.equal(typeof frozen.executionFenceToken, 'number');
  });

  it('requires positive finite integer executionFenceToken (no coercion)', () => {
    assert.throws(
      () => {
        const { executionFenceToken: _f, ...rest } = RUN_CTX;
        assertEnterpriseRunContext(rest);
      },
      /executionFenceToken/,
    );
    for (const bad of [0, -1, 1.5, NaN, Infinity, '3', null, undefined]) {
      assert.throws(
        () =>
          assertEnterpriseRunContext({
            ...RUN_CTX,
            executionFenceToken: bad,
          }),
        /executionFenceToken/,
        `should reject fence=${String(bad)}`,
      );
    }
  });
});

describe('extractUsageSummary', () => {
  it('extracts known usage fields only (no invention)', () => {
    assert.equal(extractUsageSummary(null), null);
    assert.equal(extractUsageSummary({ role: 'assistant' }), null);
    const s = extractUsageSummary({
      role: 'assistant',
      usage: {
        input: 10,
        output: 20,
        totalTokens: 30,
        madeUp: 99,
        cost: { total: 0.01, invent: 1 },
      },
    });
    assert.equal(s.input, 10);
    assert.equal(s.output, 20);
    assert.equal(s.totalTokens, 30);
    assert.equal(s.madeUp, undefined);
    assert.equal(s.cost.total, 0.01);
    assert.equal(s.cost.invent, undefined);
  });
});

describe('observability provider hooks (unit, fake ExtensionAPI)', () => {
  it('maps before/after provider to started/completed pairs; ignores agent_start/end', async () => {
    /** @type {Array<{ type: string, data: object }>} */
    const recorded = [];
    const recorder = {
      async record(input) {
        recorded.push({ type: input.type, data: input.data });
        return { type: input.type };
      },
    };
    const factories = createEnterpriseExtensionBundle(RUN_CTX, {
      recorder,
      observability: { modelId: 'test-model', provider: 'test-provider' },
    });
    const obs = factories[2];
    /** @type {Map<string, Function[]>} */
    const handlers = new Map();
    const pi = {
      on(event, handler) {
        if (!handlers.has(event)) handlers.set(event, []);
        handlers.get(event).push(handler);
      },
    };
    await obs(pi);

    // agent_start must not produce model.request.*
    for (const h of handlers.get('agent_start') || []) await h({});
    for (const h of handlers.get('agent_end') || []) await h({ messages: [] });
    assert.equal(
      recorded.filter((r) => r.type.startsWith('model.request.')).length,
      0,
    );

    // Two sequential provider calls → two started/completed pairs
    for (const h of handlers.get('before_provider_request') || []) {
      await h({ payload: { secret: 'sk-should-not-persist' } });
    }
    for (const h of handlers.get('after_provider_response') || []) {
      await h({ status: 200, headers: { authorization: 'Bearer x' } });
    }
    for (const h of handlers.get('before_provider_request') || []) {
      await h({ payload: {} });
    }
    for (const h of handlers.get('after_provider_response') || []) {
      await h({ status: 500, headers: {} });
    }

    const modelEvents = recorded.filter((r) =>
      r.type.startsWith('model.request.'),
    );
    assert.deepEqual(
      modelEvents.map((e) => e.type),
      [
        'model.request.started',
        'model.request.completed',
        'model.request.started',
        'model.request.failed',
      ],
    );
    for (const e of modelEvents) {
      assert.equal(e.data.payload, undefined);
      assert.equal(e.data.headers, undefined);
      assert.ok(e.data.correlationId);
      assert.equal(e.data.modelId, 'test-model');
      assert.equal(e.data.provider, 'test-provider');
    }
  });

  it('session_start can be triggered via registered handler', async () => {
    let started = 0;
    // Built from the production list so a new transport method cannot make
    // this fake silently stale.
    const transport = Object.fromEntries(
      SANDBOX_TRANSPORT_METHODS.map((m) => [m, async () => ({})]),
    );
    const factories = createEnterpriseExtensionBundle(RUN_CTX, {
      sandboxTransport: transport,
      sandboxBridge: {
        onSessionStart: async () => {
          started += 1;
        },
      },
    });
    const handlers = new Map();
    const pi = {
      registerTool() {},
      on(event, handler) {
        if (!handlers.has(event)) handlers.set(event, []);
        handlers.get(event).push(handler);
      },
    };
    await factories[0](pi);
    for (const h of handlers.get('session_start') || []) {
      await h({ reason: 'startup' });
    }
    assert.equal(started, 1);
  });

  it('observability session_start does not durable-write invented session.started', async () => {
    /** @type {string[]} */
    const types = [];
    const recorder = {
      async record(input) {
        types.push(input.type);
        return { type: input.type };
      },
    };
    const factories = createEnterpriseExtensionBundle(RUN_CTX, { recorder });
    const handlers = new Map();
    const pi = {
      on(event, handler) {
        if (!handlers.has(event)) handlers.set(event, []);
        handlers.get(event).push(handler);
      },
    };
    await factories[2](pi);
    for (const h of handlers.get('session_start') || []) {
      await h({ reason: 'startup' });
    }
    assert.equal(types.includes('session.started'), false);
    assert.equal(types.length, 0);
  });

  it('observability message.completed dedupe does not collide across two assistants', async () => {
    /** @type {string[]} */
    const keys = [];
    const recorder = {
      async record(input) {
        if (input.dedupeKey) keys.push(input.dedupeKey);
        return { type: input.type };
      },
    };
    const factories = createEnterpriseExtensionBundle(RUN_CTX, { recorder });
    const handlers = new Map();
    const pi = {
      on(event, handler) {
        if (!handlers.has(event)) handlers.set(event, []);
        handlers.get(event).push(handler);
      },
    };
    await factories[2](pi);
    for (const h of handlers.get('message_end') || []) {
      await h({ message: { role: 'assistant', content: [{ type: 'text', text: 'a' }] } });
      await h({ message: { role: 'assistant', content: [{ type: 'text', text: 'b' }] } });
    }
    const msgKeys = keys.filter((k) => k.startsWith('message.completed:'));
    assert.equal(msgKeys.length, 2);
    assert.notEqual(msgKeys[0], msgKeys[1]);
  });
});
