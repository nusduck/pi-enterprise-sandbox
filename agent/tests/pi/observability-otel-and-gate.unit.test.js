/**
 * observability: OTel tool spans + the provider gate hookup.
 *
 * The span code and the gate both existed before and did nothing, for the same
 * class of reason: the bundle never forwarded the dep that switches them on,
 * and nothing released what the gate acquired. These tests pin the wiring, not
 * the exporter.
 */

import { describe, it, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

import {
  createEnterpriseExtensionBundle,
  createObservabilityExtension,
  REQUIRED_EXTENSION_NAMES,
} from '../../src/extensions/index.js';

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

/** Collect the handlers an extension registers. */
function mount(factory) {
  /** @type {Map<string, Function>} */
  const handlers = new Map();
  factory({ registerTool: () => {}, on: (event, fn) => handlers.set(event, fn) });
  return {
    emit: (event, payload) => handlers.get(event)?.(payload, {}),
    has: (event) => handlers.has(event),
  };
}

function recordingGate() {
  const events = [];
  return {
    events,
    acquire: async (key) => {
      events.push({ type: 'acquire', key });
      let released = false;
      return () => {
        if (released) return;
        released = true;
        events.push({ type: 'release', key });
      };
    },
    observe: (key, status) => events.push({ type: 'observe', key, status }),
  };
}

/** Minimal recorder: the extension writes events through it. */
const noopRecorder = { record: async () => ({}) };

describe('observability provider gate hookup', () => {
  it('acquires before the request and releases after the response', async () => {
    const gate = recordingGate();
    const ext = mount(
      createObservabilityExtension({
        runContext: RUN_CTX,
        deps: {
          recorder: noopRecorder,
          providerGate: gate,
          modelId: 'deepseek-v4-flash',
        },
      }),
    );

    await ext.emit('before_provider_request', {});
    assert.deepEqual(gate.events, [
      { type: 'acquire', key: 'deepseek-v4-flash' },
    ]);

    await ext.emit('after_provider_response', { status: 200 });
    assert.deepEqual(
      gate.events.map((e) => e.type),
      ['acquire', 'release', 'observe'],
    );
    assert.equal(gate.events.at(-1).status, 200);
  });

  it('releases a slot orphaned by an aborted run', async () => {
    const gate = recordingGate();
    const ext = mount(
      createObservabilityExtension({
        runContext: RUN_CTX,
        deps: { recorder: noopRecorder, providerGate: gate, provider: 'llmio' },
      }),
    );

    // Cancel/deadline: the response event never arrives.
    await ext.emit('before_provider_request', {});
    await ext.emit('session_shutdown', {});
    assert.deepEqual(
      gate.events.map((e) => e.type),
      ['acquire', 'release'],
      'a leaked slot would shrink the process cap for every later Run',
    );
  });

  it('reports 429 so the cooldown can engage', async () => {
    const gate = recordingGate();
    const ext = mount(
      createObservabilityExtension({
        runContext: RUN_CTX,
        deps: { recorder: noopRecorder, providerGate: gate },
      }),
    );
    await ext.emit('before_provider_request', {});
    await ext.emit('after_provider_response', { status: 429 });
    assert.deepEqual(gate.events.at(-1), {
      type: 'observe',
      key: 'default',
      status: 429,
    });
  });
});

describe('observability OTel tool spans', () => {
  const exporter = new InMemorySpanExporter();
  /** @type {BasicTracerProvider} */
  let provider;

  before(() => {
    // A real in-memory tracer: without a registered provider the OTel API
    // hands back a no-op tracer and the test would prove nothing.
    provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(provider);
  });
  after(async () => {
    await provider.shutdown();
    trace.disable();
  });

  /**
   * @param {object} deps
   * @param {{ isError?: boolean, result?: object, endIt?: boolean }} [outcome]
   */
  async function runToolCycle(deps, outcome = {}) {
    exporter.reset();
    const emitted = [];
    const ext = mount(
      createObservabilityExtension({
        runContext: RUN_CTX,
        deps: {
          recorder: {
            record: async (input) => {
              emitted.push(input.type);
              return {};
            },
          },
          ...deps,
        },
      }),
    );
    await ext.emit('tool_execution_start', {
      toolCallId: 'tc-1',
      toolName: 'bash',
      args: {},
    });
    if (outcome.endIt !== false) {
      await ext.emit('tool_execution_end', {
        toolCallId: 'tc-1',
        toolName: 'bash',
        isError: outcome.isError === true,
        result: outcome.result ?? { content: [] },
      });
    }
    return { emitted, ext, spans: () => exporter.getFinishedSpans() };
  }

  it('emits one CLIENT span per tool execution when enabled', async () => {
    const { emitted, spans } = await runToolCycle({ otel: true });
    assert.deepEqual(emitted, [
      'tool.execution.started',
      'tool.execution.completed',
    ]);
    const [span] = spans();
    assert.equal(spans().length, 1);
    assert.equal(span.name, 'agent.tool.bash');
    assert.equal(span.attributes['agent.tool.name'], 'bash');
    assert.equal(span.attributes['agent.tool.call_id'], 'tc-1');
    assert.equal(span.attributes['agent.run.id'], RUN_CTX.runId);
    assert.equal(span.status.code, 1, 'a clean tool run is an OK span');
  });

  it('emits no span at all when the container did not enable OTel', async () => {
    const { emitted, spans } = await runToolCycle({ otel: false });
    assert.deepEqual(emitted, [
      'tool.execution.started',
      'tool.execution.completed',
    ]);
    assert.equal(spans().length, 0);
  });

  it('marks a failed tool span with the result code, never its output', async () => {
    const { spans } = await runToolCycle(
      { otel: true },
      {
        isError: true,
        result: {
          details: { code: 'BASH_FAILED' },
          content: [{ type: 'text', text: 'secret output' }],
        },
      },
    );
    const [span] = spans();
    assert.equal(span.status.code, 2, 'error status');
    assert.equal(span.status.message, 'BASH_FAILED');
    const recorded = JSON.stringify({
      attributes: span.attributes,
      events: span.events,
      status: span.status,
    });
    assert.equal(
      recorded.includes('secret output'),
      false,
      'tool output must not travel into the trace',
    );
  });

  it('closes a span orphaned by an aborted run instead of leaking it', async () => {
    const { ext, spans } = await runToolCycle({ otel: true }, { endIt: false });
    assert.equal(spans().length, 0);
    await ext.emit('session_shutdown', {});
    assert.equal(spans().length, 1);
    assert.equal(spans()[0].status.message, 'RUN_ENDED_BEFORE_TOOL_RESULT');
  });
});

describe('bundle forwards the observability switches', () => {
  /**
   * `deps.otel` reaching the extension is the whole fix for the OTel row: the
   * span code shipped, but createEnterpriseExtensionBundle dropped the flag.
   */
  it('passes otel and the provider gate through to observability', async () => {
    const gate = recordingGate();
    const factories = createEnterpriseExtensionBundle(RUN_CTX, {
      extensions: [...REQUIRED_EXTENSION_NAMES],
      sandboxTransport: {},
      recorder: noopRecorder,
      otel: true,
      providerGate: gate,
    });
    assert.ok(factories.length > 0);

    // The gate arriving is observable through a provider cycle.
    const observability = factories.find(
      (f) => f.extensionName === 'observability',
    );
    const ext = mount(observability);
    await ext.emit('before_provider_request', {});
    await ext.emit('after_provider_response', { status: 200 });
    assert.deepEqual(
      gate.events.map((e) => e.type),
      ['acquire', 'release', 'observe'],
    );
  });

  it('leaves the switches off when the container did not set them', async () => {
    const factories = createEnterpriseExtensionBundle(RUN_CTX, {
      extensions: [...REQUIRED_EXTENSION_NAMES],
      sandboxTransport: {},
      recorder: noopRecorder,
    });
    const observability = factories.find(
      (f) => f.extensionName === 'observability',
    );
    const ext = mount(observability);
    // No injected gate: the process gate is used and nothing throws.
    await ext.emit('before_provider_request', {});
    await ext.emit('after_provider_response', { status: 200 });
    assert.ok(ext.has('tool_execution_start'));
  });
});
