/**
 * Real pi-mcp-adapter integration: Pi Jiti loads the installed TypeScript
 * extension, which discovers and invokes a stdio MCP server process.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PiRuntimeFactory,
  PINNED_PI_SDK_VERSION,
} from '../../src/infrastructure/pi/pi-runtime-factory.js';
import { PiSessionAdapter } from '../../src/infrastructure/pi/pi-session-adapter.js';
import {
  createPiMcpResolver,
} from '../../src/infrastructure/mcp/pi-mcp-adapter-factory.js';

const SESSION_ID = '01K0G2PAV8FPMVC9QHJG7JPN52';
const VERSION_ID = '01K0G2PAV8FPMVC9QHJG7JPN5C';
const fixture = fileURLToPath(
  new URL('../fixtures/mock-mcp-stdio-server.js', import.meta.url),
);

function testModel() {
  return {
    id: 'mcp-integration-model',
    name: 'MCP Integration Model',
    api: 'openai-completions',
    provider: 'openai',
    baseUrl: 'http://127.0.0.1:1/v1',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
  };
}

describe('real pi-mcp-adapter runtime', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pi-mcp-integration-'));
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR;

  before(async () => {
    const agentDir = path.join(root, 'agent-home');
    await fs.mkdir(agentDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  after(async () => {
    if (priorAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  it('registers and invokes an allowlisted MCP tool through stdio', async () => {
    const agentDir = path.join(root, 'agent-home');
    const workspace = path.join(root, 'workspace');
    await fs.mkdir(workspace, { recursive: true });
    const sessionAdapter = new PiSessionAdapter({
      runtimeRoot: path.join(root, 'sessions'),
    });
    const mcpResolver = createPiMcpResolver({
      runtimeRoot: path.join(root, 'mcp-runtime'),
      serverRegistry: [
        {
          id: 'mock',
          command: process.execPath,
          args: [fixture],
        },
      ],
    });
    const factory = new PiRuntimeFactory({
      agentDir,
      sessionAdapter,
      mcpResolver,
    });

    const managed = await factory.create({
      agentVersion: {
        agentVersionId: VERSION_ID,
        piSdkVersion: PINNED_PI_SDK_VERSION,
        configJson: {
          systemPrompt: '',
          mcpServers: [
            {
              serverId: 'mock',
              enabledTools: ['echo'],
              timeoutSec: 10,
              toolPolicy: { default: 'allow' },
            },
          ],
        },
      },
      agentSession: { agentSessionId: SESSION_ID },
      cwd: workspace,
      model: testModel(),
      context: {
        traceId: '0123456789abcdef0123456789abcdef',
      },
    });

    const privateConfigPath = managed.mcpBinding.configPath;
    try {
      const names = managed.session.getAllTools().map((tool) => tool.name);
      assert.ok(names.includes('mcp__mock__echo'));
      assert.equal(names.includes('mcp'), false, 'vendor proxy must remain hidden');

      const tool = managed.session.getToolDefinition('mcp__mock__echo');
      assert.equal(typeof tool?.execute, 'function');
      const result = await tool.execute(
        'mcp-call-1',
        { value: 'hello' },
        new AbortController().signal,
        () => {},
      );
      assert.equal(result.content[0].text, 'mock:hello');
      assert.equal(result.details.server, 'mock');
      assert.equal(result.details.tool, 'echo');
    } finally {
      await managed.dispose();
      await assert.rejects(() => fs.access(privateConfigPath));
      await sessionAdapter.dispose();
    }
  });
});
