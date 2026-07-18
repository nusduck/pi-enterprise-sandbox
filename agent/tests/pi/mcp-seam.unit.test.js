/**
 * MCP config loader + pi-mcp-adapter factory seam (PR-06).
 * Offline — no network, no protocol implementation, no vendor export guessing.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadMcpConfig,
  loadMcpConfigFromAgentVersion,
  McpConfigError,
  mcpToolName,
  isValidMcpToolName,
  parseAgentVersionConfigJson,
} from '../../src/infrastructure/mcp/mcp-config-loader.js';
import {
  createPiMcpAdapter,
  PiMcpAdapterError,
  PI_MCP_ADAPTER_PACKAGE,
} from '../../src/infrastructure/mcp/pi-mcp-adapter-factory.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

describe('mcp-config-loader', () => {
  it('accepts logical refs with secretRef, tools, policy, timeout', () => {
    const cfg = loadMcpConfig([
      {
        serverId: 'risk_db',
        enabledTools: ['query', 'describe_table'],
        toolPolicy: { default: 'allow' },
        timeoutSec: 120,
        secretRef: 'vault://mcp/risk-db',
      },
    ]);
    assert.equal(cfg.length, 1);
    assert.equal(cfg[0].serverId, 'risk_db');
    assert.deepEqual([...cfg[0].enabledTools], ['query', 'describe_table']);
    assert.equal(cfg[0].timeoutSec, 120);
    assert.equal(cfg[0].secretRef, 'vault://mcp/risk-db');
    assert.equal(mcpToolName('risk_db', 'query'), 'mcp__risk_db__query');
    assert.ok(isValidMcpToolName('mcp__risk_db__query'));
  });

  it('rejects timeout outside 1..300', () => {
    assert.throws(
      () => loadMcpConfig([{ serverId: 'a', timeoutSec: 0 }]),
      (e) => e instanceof McpConfigError && e.code === 'MCP_TIMEOUT_INVALID',
    );
    assert.throws(
      () => loadMcpConfig([{ serverId: 'a', timeoutSec: 301 }]),
      (e) => e.code === 'MCP_TIMEOUT_INVALID',
    );
  });

  it('rejects plaintext secrets including nested toolPolicy', () => {
    assert.throws(
      () =>
        loadMcpConfig([
          { serverId: 'a', apiKey: 'sk-xxx', secretRef: 'r' },
        ]),
      (e) => e.code === 'MCP_PLAINTEXT_SECRET_FORBIDDEN',
    );
    assert.throws(
      () => loadMcpConfig([{ serverId: 'a', headers: { Authorization: 'x' } }]),
      (e) => e.code === 'MCP_PLAINTEXT_SECRET_FORBIDDEN',
    );
    assert.throws(
      () =>
        loadMcpConfig([
          {
            serverId: 'a',
            toolPolicy: { default: 'allow', apiKey: 'nested-secret' },
          },
        ]),
      (e) => e.code === 'MCP_PLAINTEXT_SECRET_FORBIDDEN',
    );
    // Error must not echo secret values
    try {
      loadMcpConfig([{ serverId: 'a', password: 'super-secret-value-xyz' }]);
      assert.fail('expected throw');
    } catch (err) {
      assert.ok(err instanceof McpConfigError);
      assert.equal(String(err.message).includes('super-secret-value-xyz'), false);
    }
  });

  it('empty config is valid', () => {
    assert.deepEqual(loadMcpConfig([]), []);
    assert.deepEqual(loadMcpConfig(null), []);
  });

  it('parses config_json string and fails closed on invalid JSON', () => {
    const ok = loadMcpConfigFromAgentVersion({
      config_json: JSON.stringify({
        mcpServers: [{ serverId: 'db', enabledTools: ['query'] }],
      }),
    });
    assert.equal(ok.length, 1);
    assert.equal(ok[0].serverId, 'db');

    assert.throws(
      () => loadMcpConfigFromAgentVersion({ config_json: '{not-json' }),
      (e) => e instanceof McpConfigError && e.code === 'MCP_CONFIG_JSON_INVALID',
    );
    assert.throws(
      () => loadMcpConfigFromAgentVersion({ configJson: '[]' }),
      (e) => e.code === 'MCP_CONFIG_JSON_INVALID',
    );
    assert.deepEqual(
      parseAgentVersionConfigJson('{"systemPrompt":"x"}').systemPrompt,
      'x',
    );
  });
});

describe('pi-mcp-adapter-factory', () => {
  it('zero MCP config does not load adapter', async () => {
    let loads = 0;
    const result = await createPiMcpAdapter({
      mcpServers: [],
      loadAdapter: async () => {
        loads += 1;
        return {};
      },
    });
    assert.equal(result.enabled, false);
    assert.equal(loads, 0);
    assert.equal(result.module, null);
  });

  it('missing adapter fail-fast with PI_MCP_ADAPTER_UNAVAILABLE', async () => {
    await assert.rejects(
      () =>
        createPiMcpAdapter({
          mcpServers: [{ serverId: 'db', secretRef: 's1' }],
          loadAdapter: async () => {
            throw new Error('Cannot find package');
          },
        }),
      (err) =>
        err instanceof PiMcpAdapterError &&
        err.code === 'PI_MCP_ADAPTER_UNAVAILABLE',
    );
  });

  it('module present without adapterBinder → PI_MCP_ADAPTER_API_UNVERIFIED', async () => {
    await assert.rejects(
      () =>
        createPiMcpAdapter({
          mcpServers: [{ serverId: 'db', enabledTools: ['query'] }],
          loadAdapter: async () => ({
            // Even with tempting exports, production must not guess them.
            createPiMcpAdapter: () => ({}),
            createAdapter: () => ({}),
            default: () => ({}),
          }),
        }),
      (err) =>
        err instanceof PiMcpAdapterError &&
        err.code === 'PI_MCP_ADAPTER_API_UNVERIFIED',
    );
  });

  it('injected adapterBinder verifies project port contract', async () => {
    const result = await createPiMcpAdapter({
      mcpServers: [{ serverId: 'db', enabledTools: ['query'] }],
      loadAdapter: async () => ({ vendorMarker: true }),
      adapterBinder: async ({ module, config }) => {
        assert.equal(module.vendorMarker, true);
        assert.equal(config[0].serverId, 'db');
        return {
          tools: [
            { name: mcpToolName(config[0].serverId, config[0].enabledTools[0]) },
          ],
          mcpResolver: { kind: 'project-port' },
          binding: { ok: true },
        };
      },
    });
    assert.equal(result.enabled, true);
    assert.equal(result.tools[0].name, 'mcp__db__query');
    assert.equal(result.mcpResolver.kind, 'project-port');
  });

  it('new MCP modules do not import legacy McpConnectionManager or call fetch', () => {
    const root = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../src/infrastructure/mcp',
    );
    for (const file of [
      'mcp-config-loader.js',
      'pi-mcp-adapter-factory.js',
      'index.js',
    ]) {
      const src = readFileSync(path.join(root, file), 'utf8');
      assert.equal(
        /import\s+.*mcp-connection-manager|from\s+['"].*mcp-connection-manager|new\s+McpConnectionManager|require\(['"].*mcp-connection-manager/.test(
          src,
        ),
        false,
        `${file} must not import legacy McpConnectionManager`,
      );
      assert.equal(
        /\bfetch\s*\(/.test(src),
        false,
        `${file} must not call fetch()`,
      );
      // Must not probe multiple guessed exports
      if (file === 'pi-mcp-adapter-factory.js') {
        assert.equal(
          /mod\.createPiMcpAdapter|mod\.createAdapter|mod\.default\?\.create/.test(
            src,
          ),
          false,
          'must not guess vendor create* exports',
        );
      }
    }
    assert.equal(PI_MCP_ADAPTER_PACKAGE, 'pi-mcp-adapter');
  });
});
