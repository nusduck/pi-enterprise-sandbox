/**
 * The `## Tools` section of the enterprise system prompt is not written by
 * hand — it is rendered from the snippets and guidelines each tool declares on
 * its own definition, and spliced in on `before_agent_start`.
 *
 * That leans on two things the installed SDK does that no functional test
 * would notice losing:
 *
 *  1. Setting `customPrompt` (which the enterprise build must, to keep Pi's
 *     default from pointing the model at node_modules docs) makes
 *     `buildSystemPrompt` return early, so the SDK renders *no* tool list of
 *     its own. That is the reason the splice exists.
 *  2. `AgentSession` still aggregates `promptSnippet` / `promptGuidelines`
 *     over the live tool registry into the build options it hands to
 *     `before_agent_start` — filtered to tools that actually exist.
 *
 * If a Pi upgrade drops that aggregate or renames its fields, `applyToolSurface`
 * finds nothing to render and silently degrades: the prompt keeps its heading,
 * loses every tool line, and every other test still passes. So assert the
 * shape here.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import {
  AuthStorage,
  SessionManager,
  createAgentSessionServices,
  createAgentSessionFromServices,
} from '@earendil-works/pi-coding-agent';
import {
  applyToolSurface,
  buildEnterpriseSystemPrompt,
} from '../../src/infrastructure/pi/enterprise-system-prompt.js';

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

const SNIPPET = 'Guard tool one-liner';
const GUIDELINE = 'Guard tool cross-call rule.';

function guardExtension(pi) {
  pi.registerTool({
    name: 'guard_tool',
    label: 'Guard tool',
    description: 'Tool registered only to observe how Pi aggregates prompt metadata.',
    promptSnippet: SNIPPET,
    promptGuidelines: [GUIDELINE],
    parameters: Type.Object({}),
    async execute() {
      return { output: 'ok' };
    },
  });
}
guardExtension.extensionName = 'sdk-compat-guard';

describe('SDK aggregate the enterprise tool surface is rendered from', () => {
  /** @type {string} */ let cwd;
  /** @type {string} */ let agentDir;
  /** @type {object[]} */ const sessions = [];

  before(() => {
    cwd = mkdtempSync(join(tmpdir(), 'pi-surface-cwd-'));
    agentDir = mkdtempSync(join(tmpdir(), 'pi-surface-agent-'));
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
      resourceLoaderOptions: {
        systemPrompt: buildEnterpriseSystemPrompt(),
        noExtensions: true,
        extensionFactories: [guardExtension],
      },
    });
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(cwd),
      model,
    });
    sessions.push(session);
    return session;
  }

  it('renders no tool list itself on the customPrompt path', async () => {
    const session = await buildSession();
    const prompt = session.agent?.state?.systemPrompt;
    assert.equal(typeof prompt, 'string');
    assert.ok(
      prompt.includes('## Tools'),
      'the enterprise contract must survive as the customPrompt',
    );
    assert.ok(
      !prompt.includes(SNIPPET),
      'customPrompt short-circuits Pi tool rendering — if this ever changes, ' +
        'the splice would duplicate the inventory and should be removed',
    );
  });

  it('aggregates promptSnippet/promptGuidelines over the live registry', async () => {
    const session = await buildSession();
    const options = session._baseSystemPromptOptions;
    assert.ok(options && typeof options === 'object', 'no build options to render from');

    assert.ok(
      Array.isArray(options.selectedTools) && options.selectedTools.includes('guard_tool'),
      'selectedTools must name the tools bound to this session',
    );
    assert.equal(options.toolSnippets?.guard_tool, SNIPPET);
    assert.ok(
      Array.isArray(options.promptGuidelines) && options.promptGuidelines.includes(GUIDELINE),
      'promptGuidelines must carry each bound tool\'s cross-call rules',
    );
    assert.ok(
      !options.selectedTools.includes('grep'),
      'selectedTools must be filtered to registered tools, not a static list',
    );
  });

  it('splices that aggregate into the prompt the model actually receives', async () => {
    const session = await buildSession();
    const applied = applyToolSurface(
      session.agent.state.systemPrompt,
      session._baseSystemPromptOptions,
    );
    assert.match(applied, new RegExp(`^- \`guard_tool\`: ${SNIPPET}$`, 'm'));
    assert.match(applied, new RegExp(`^- ${GUIDELINE}$`, 'm'));
  });
});
