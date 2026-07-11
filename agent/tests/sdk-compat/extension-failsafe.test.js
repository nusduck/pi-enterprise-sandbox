/**
 * Extension tool_call / tool_result surface (block + result rewrite).
 * BFF does not load extensions today; suite pins public API fail-safe contracts
 * so upgrades cannot silently drop block/result hooks.
 * Run: node --test api-server/tests/sdk-compat/extension-failsafe.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DefaultResourceLoader,
  SettingsManager,
  getAgentDir,
  ExtensionRunner,
  SessionManager,
  AuthStorage,
  ModelRegistry,
  createExtensionRuntime,
  createEventBus,
  isToolCallEventType,
} from '@earendil-works/pi-coding-agent';

async function loadRunner(factory) {
  const settingsManager = SettingsManager.create('/tmp', getAgentDir());
  const loader = new DefaultResourceLoader({
    cwd: '/tmp',
    agentDir: getAgentDir(),
    settingsManager,
    skillsOverride: () => ({ skills: [], diagnostics: [] }),
    agentsFilesOverride: () => ({ agentsFiles: [] }),
    promptsOverride: () => ({ prompts: [], diagnostics: [] }),
    extensionFactories: [factory],
  });
  await loader.reload();
  const { extensions, runtime, errors } = loader.getExtensions();
  assert.equal(errors?.length ?? 0, 0, `extension load errors: ${JSON.stringify(errors)}`);
  assert.ok(extensions.length >= 1);

  const sm = SessionManager.inMemory('/tmp');
  const auth = AuthStorage.create();
  const registry = ModelRegistry.create(auth);
  return new ExtensionRunner(extensions, runtime, '/tmp', sm, registry);
}

describe('Extension public surface', () => {
  it('exports runner/runtime helpers used for extension integration', () => {
    assert.equal(typeof ExtensionRunner, 'function');
    assert.equal(typeof createExtensionRuntime, 'function');
    assert.equal(typeof createEventBus, 'function');
    assert.equal(typeof isToolCallEventType, 'function');
  });
});

describe('Extension tool_call fail-safe', () => {
  it('blocks tool execution when handler returns { block: true }', async () => {
    const runner = await loadRunner((pi) => {
      pi.on('tool_call', async (event) => {
        if (event.toolName === 'bash') {
          return { block: true, reason: 'blocked-for-compat-suite' };
        }
        return undefined;
      });
    });

    assert.equal(runner.hasHandlers('tool_call'), true);

    const blocked = await runner.emitToolCall({
      type: 'tool_call',
      toolName: 'bash',
      toolCallId: 'call_block',
      input: { command: 'echo hi' },
    });
    assert.deepEqual(blocked, { block: true, reason: 'blocked-for-compat-suite' });

    const allowed = await runner.emitToolCall({
      type: 'tool_call',
      toolName: 'read',
      toolCallId: 'call_ok',
      input: { path: 'a.txt' },
    });
    assert.equal(allowed, undefined);
  });

  it('propagates tool_call handler errors (caller treats as fail-safe block)', async () => {
    // AgentSession wraps emitToolCall in try/catch and rethrows so the tool does not run.
    const runner = await loadRunner((pi) => {
      pi.on('tool_call', async () => {
        throw new Error('handler boom');
      });
    });

    await assert.rejects(
      () =>
        runner.emitToolCall({
          type: 'tool_call',
          toolName: 'write',
          toolCallId: 'call_err',
          input: { path: 'x.txt', content: 'y' },
        }),
      /handler boom/,
    );
  });
});

describe('Extension tool_result rewrite', () => {
  it('allows handlers to rewrite content/details/isError', async () => {
    const runner = await loadRunner((pi) => {
      pi.on('tool_result', async () => ({
        content: [{ type: 'text', text: 'rewritten-by-extension' }],
        details: { rewritten: true },
        isError: false,
      }));
    });

    assert.equal(runner.hasHandlers('tool_result'), true);
    const out = await runner.emitToolResult({
      type: 'tool_result',
      toolName: 'read',
      toolCallId: 'call_r',
      input: { path: 'a.txt' },
      content: [{ type: 'text', text: 'original' }],
      details: {},
      isError: false,
    });
    assert.equal(out.content[0].text, 'rewritten-by-extension');
    assert.equal(out.details.rewritten, true);
    assert.equal(out.isError, false);
  });
});
