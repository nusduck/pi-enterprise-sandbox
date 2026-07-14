import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createExtensionHostAdapter,
  emitExtensionDiagnostics,
} from '../runtime/extension-host-adapter.js';
import { buildAgentSessionOptions } from '../runtime/agent-session-factory.js';

describe('Extension Host Adapter', () => {
  it('implements the RPC UI surface and projects serializable events', async () => {
    const events = [];
    const adapter = createExtensionHostAdapter({
      runId: 'run_1',
      conversationId: 'conv_1',
      workspaceId: 'ws_1',
      emit: (event) => events.push(event),
      interactionManager: {
        async select(request) {
          assert.equal(request.run_id, 'run_1');
          return request.options[0];
        },
        async confirm() {
          return true;
        },
        async input() {
          return 'answer';
        },
      },
    });

    assert.equal(adapter.mode, 'rpc');
    assert.equal(await adapter.uiContext.select('Choose', ['a', 'b']), 'a');
    assert.equal(await adapter.uiContext.confirm('Confirm', 'Continue?'), true);
    assert.equal(await adapter.uiContext.input('Input'), 'answer');

    adapter.uiContext.notify('ready');
    adapter.uiContext.setStatus('demo', 'running');
    adapter.uiContext.setWidget('plan', ['one', 'two']);
    adapter.uiContext.setWorkingMessage('working');
    adapter.uiContext.setWorkingVisible(true);
    adapter.uiContext.setWorkingIndicator({ frames: ['.'] });
    adapter.uiContext.setHiddenThinkingLabel('Reasoning');
    adapter.uiContext.setTitle('Agent');
    adapter.uiContext.setEditorText('hello');
    adapter.uiContext.pasteToEditor(' world');
    assert.equal(adapter.uiContext.getEditorText(), 'hello world');
    adapter.uiContext.setToolsExpanded(true);
    assert.equal(adapter.uiContext.getToolsExpanded(), true);
    assert.equal(typeof adapter.uiContext.onTerminalInput(() => {}), 'function');
    assert.deepEqual(adapter.uiContext.getAllThemes(), []);
    assert.equal(adapter.uiContext.setTheme('x').success, false);

    const types = events.map((event) => event.type);
    assert.ok(types.includes('extension_notification'));
    assert.ok(types.includes('extension_status'));
    assert.ok(types.includes('extension_widget'));
    assert.ok(types.includes('extension_working_message'));
    assert.ok(types.includes('extension_editor_text'));
    assert.ok(events.every((event) => event.run_id === 'run_1'));
  });

  it('fails closed for unavailable dialog hosts without hanging', async () => {
    const events = [];
    const adapter = createExtensionHostAdapter({ emit: (event) => events.push(event) });
    assert.equal(await adapter.uiContext.select('x', ['a']), undefined);
    assert.equal(await adapter.uiContext.confirm('x', 'y'), false);
    assert.equal(await adapter.uiContext.input('x'), undefined);
    assert.equal(events.filter((event) => event.type === 'interaction_requested').length, 3);
  });

  it('maps extension errors and loader diagnostics', () => {
    const events = [];
    const emit = (event) => events.push(event);
    const adapter = createExtensionHostAdapter({ runId: 'r', emit });
    adapter.onError({ extensionPath: '/ext/a.js', event: 'turn_start', error: 'boom' });
    emitExtensionDiagnostics(
      {
        extensions: [{ path: '/ext/a.js', resolvedPath: '/real/a.js' }],
        errors: [{ path: '/ext/b.js', error: 'load boom' }],
      },
      emit,
      { run_id: 'r' },
    );
    assert.deepEqual(
      events.map((event) => event.type),
      ['extension_error', 'extension_loaded', 'extension_error'],
    );
  });
});

describe('Agent Session Factory options', () => {
  it('pins cwd and session start metadata', () => {
    const options = buildAgentSessionOptions({
      sessionCwd: '/home/sandbox/workspace',
      model: { id: 'm' },
      tools: ['read'],
      customTools: [],
      sessionManager: {},
      authStorage: {},
      modelRegistry: {},
      resourceLoader: {},
      settingsManager: {},
      sessionStartEvent: { type: 'session_start', reason: 'resume' },
    });
    assert.equal(options.cwd, '/home/sandbox/workspace');
    assert.equal(options.sessionStartEvent.reason, 'resume');
  });
});
