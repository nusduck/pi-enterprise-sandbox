/**
 * `mcpServers[i].toolArguments` 在 bind 时的投影与形状校验，以及
 * `MCP_SERVERS_JSON[].hostArguments` 非法时拒绝启动
 * （docs/design/mcp-per-agent-arguments.md D1/D2）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bindAgentVersionConfig } from '../../src/infrastructure/dsh/agent-version-bindings.js';

const agentDir = join(dirname(fileURLToPath(import.meta.url)), '../..');

describe('bindAgentVersionConfig mcpServers[].toolArguments', () => {
  it('projects values onto the Run authorization; absent means none', () => {
    const bound = bindAgentVersionConfig({
      agentVersionId: 'v1',
      configJson: { mcpServers: [{ serverId: 'qa', enabledTools: ['ask'], toolArguments: { kb_id: 'hr', top: 3 } }] },
    });
    assert.deepEqual(bound.authorization.mcpServers.qa?.toolArguments, { kb_id: 'hr', top: 3 });

    const none = bindAgentVersionConfig({
      agentVersionId: 'v2',
      configJson: { mcpServers: [{ serverId: 'qa', enabledTools: ['ask'] }] },
    });
    assert.deepEqual(none.authorization.mcpServers.qa?.toolArguments, {});
  });

  it('refuses malformed values and credential-looking keys instead of running with part of them', () => {
    for (const toolArguments of [{ kb_id: { nested: 1 } }, 'hr', { 'bad-key': 'x' }, { api_key: 'plaintext' }]) {
      assert.throws(
        () =>
          bindAgentVersionConfig({
            agentVersionId: 'v1',
            configJson: { mcpServers: [{ serverId: 'qa', enabledTools: ['ask'], toolArguments }] },
          }),
        JSON.stringify(toolArguments),
      );
    }
  });
});

describe('MCP_SERVERS_JSON hostArguments at startup', () => {
  const load = (servers: unknown[]) =>
    execFileSync('npx', ['tsx', '-e', "import('./config.ts').then(() => console.log('LOADED'), (e) => { console.error(String(e?.message ?? e)); process.exit(1); })"], {
      cwd: agentDir,
      env: { ...process.env, DEPLOYMENT_ENV: 'development', MCP_SERVERS_JSON: JSON.stringify(servers) },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });

  it('starts with a valid declaration', () => {
    assert.match(load([{ id: 'qa', url: 'https://qa.example/mcp', hostArguments: { kb_id: {} } }]), /LOADED/);
  });

  it('refuses to start when a declaration names a credential', () => {
    assert.throws(
      () => load([{ id: 'qa', url: 'https://qa.example/mcp', hostArguments: { api_key: {} } }]),
      (err: { stderr?: string }) => /Invalid MCP_SERVERS_JSON: .*looks like a credential/.test(String(err.stderr)),
    );
  });
});
