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
  createMcpExtensionsOverride,
  createEnvironmentSecretResolver,
  loadMcpServerRegistry,
  PiMcpAdapterError,
  PI_MCP_ADAPTER_PACKAGE,
  PINNED_PI_MCP_ADAPTER_VERSION,
  resolvePiMcpAdapterPackage,
} from '../../src/infrastructure/mcp/pi-mcp-adapter-factory.js';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const TRACE_ID = '0123456789abcdef0123456789abcdef';

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
  it('zero MCP config does not resolve or materialize the adapter', async () => {
    let packageResolves = 0;
    const result = await createPiMcpAdapter({
      mcpServers: [],
      packageResolver: async () => {
        packageResolves += 1;
        throw new Error('must not run');
      },
    });
    assert.equal(result.enabled, false);
    assert.equal(packageResolves, 0);
    assert.equal(result.extensionPath, null);
    assert.equal(result.configPath, null);
  });

  it('missing pinned adapter fails closed', async () => {
    await assert.rejects(
      () =>
        createPiMcpAdapter({
          agentSessionId: '01K0G2PAV8FPMVC9QHJG7JPN52',
          context: { traceId: TRACE_ID },
          mcpServers: [{ serverId: 'db', enabledTools: ['query'] }],
          serverRegistry: [{ id: 'db', command: 'mock-mcp' }],
          packageResolver: async () => {
            throw new Error('Cannot find package');
          },
        }),
      (err) =>
        err instanceof Error && /Cannot find package/.test(err.message),
    );
  });

  it('validates deployment registry and environment secret refs', async () => {
    assert.throws(
      () => loadMcpServerRegistry([{ id: 'db', url: 'https://mcp.test', token: 'plain' }]),
      (err) => err.code === 'MCP_PLAINTEXT_SECRET_FORBIDDEN',
    );
    assert.throws(
      () => loadMcpServerRegistry([{ id: 'db', url: 'https://mcp.test', command: 'x' }]),
      (err) => err.code === 'MCP_SERVER_REGISTRY_INVALID',
    );
    const resolveSecret = createEnvironmentSecretResolver({ MCP_DB_TOKEN: 'secret-value' });
    assert.equal(await resolveSecret('MCP_DB_TOKEN'), 'secret-value');
    await assert.rejects(
      () => resolveSecret('vault://not-supported'),
      (err) => err.code === 'MCP_SECRET_REF_UNSUPPORTED',
    );
  });

  it('materializes 0600 config, registers exact wrappers, and cleans secrets', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mcp-binding-test-'));
    const extensionPath = path.join(root, 'index.ts');
    await fs.writeFile(extensionPath, 'export default () => {}', 'utf8');
    const binding = await createPiMcpAdapter({
      agentSessionId: '01K0G2PAV8FPMVC9QHJG7JPN52',
      runtimeRoot: path.join(root, 'runtime'),
      mcpServers: [
        {
          serverId: 'db',
          enabledTools: ['query'],
          secretRef: 'MCP_DB_TOKEN',
        },
      ],
      serverRegistry: [
        {
          id: 'db',
          url: 'https://mcp.test/rpc',
          authTokenRef: 'MCP_DB_TOKEN',
        },
      ],
      secretResolver: createEnvironmentSecretResolver({
        MCP_DB_TOKEN: 'resolved-secret-value',
      }),
      context: { traceId: TRACE_ID },
      spanRandomBytes: () => Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]),
      packageResolver: async () => ({
        version: PINNED_PI_MCP_ADAPTER_VERSION,
        extensionPath,
      }),
    });

    assert.equal(binding.enabled, true);
    assert.equal(binding.tools[0].name, 'mcp__db__query');
    assert.equal(statSync(binding.configPath).mode & 0o777, 0o600);
    const materialized = readFileSync(binding.configPath, 'utf8');
    assert.match(materialized, /resolved-secret-value/);
    assert.match(materialized, new RegExp(`00-${TRACE_ID}-0102030405060708-01`));
    assert.match(materialized, /X-Trace-Id/);
    assert.equal(JSON.stringify(binding.config).includes('resolved-secret-value'), false);

    let proxyParams = null;
    const extension = {
      resolvedPath: extensionPath,
      sourceInfo: { source: 'test' },
      tools: new Map([
        [
          'mcp',
          {
            definition: {
              name: 'mcp',
              execute: async (_id, params) => {
                proxyParams = params;
                return { content: [{ type: 'text', text: 'ok' }] };
              },
            },
            sourceInfo: { source: 'vendor' },
          },
        ],
        ['ambient_direct_tool', { definition: { name: 'ambient_direct_tool' } }],
      ]),
    };
    binding.extensionsOverride({ extensions: [extension], errors: [] });
    assert.deepEqual([...extension.tools.keys()], ['mcp__db__query']);
    const result = await extension.tools
      .get('mcp__db__query')
      .definition.execute('tc-1', { sql: 'select 1' });
    assert.equal(result.content[0].text, 'ok');
    assert.deepEqual(proxyParams, {
      server: 'db',
      tool: 'query',
      args: '{"sql":"select 1"}',
    });

    const configPath = binding.configPath;
    await binding.cleanup();
    await assert.rejects(() => fs.access(configPath));
    await fs.rm(root, { recursive: true, force: true });
  });

  it('redacts untrusted MCP results and progress before Pi sees them', async () => {
    const extensionPath = '/tmp/pi-enterprise-mcp-redaction/index.ts';
    let projectedUpdate = null;
    const extension = {
      resolvedPath: extensionPath,
      sourceInfo: { source: 'test' },
      tools: new Map([
        [
          'mcp',
          {
            definition: {
              name: 'mcp',
              async execute(_id, _params, _signal, onUpdate) {
                onUpdate?.({
                  content: [
                    {
                      type: 'text',
                      text: 'redis://:progress-password@cache.internal/0',
                    },
                  ],
                });
                return {
                  content: [
                    {
                      type: 'text',
                      text: 'mysql://reader:result-password@db.internal/prod',
                    },
                  ],
                  details: { token: 'opaque-result-token' },
                };
              },
            },
            sourceInfo: { source: 'vendor' },
          },
        ],
      ]),
    };
    const override = createMcpExtensionsOverride({
      extensionPath,
      tools: [
        {
          serverId: 'db',
          toolName: 'query',
          name: 'mcp__db__query',
        },
      ],
    });
    override({ extensions: [extension], errors: [] });

    const result = await extension.tools
      .get('mcp__db__query')
      .definition.execute(
        'tc-secret',
        { sql: 'select 1' },
        new AbortController().signal,
        (update) => {
          projectedUpdate = update;
        },
      );

    assert.doesNotMatch(
      JSON.stringify({ result, projectedUpdate }),
      /progress-password|result-password|opaque-result-token/,
    );
    assert.equal(result.details.token, '[redacted]');
  });

  it('rejects registry attempts to override runtime trace propagation', async () => {
    await assert.rejects(
      () => createPiMcpAdapter({
        agentSessionId: '01K0G2PAV8FPMVC9QHJG7JPN52',
        context: { traceId: TRACE_ID },
        mcpServers: [{ serverId: 'db', enabledTools: ['query'] }],
        serverRegistry: [
          { id: 'db', url: 'https://mcp.test', headerRefs: { Traceparent: 'TOKEN_REF' } },
        ],
        secretResolver: async () => 'should-not-resolve',
        packageResolver: async () => ({
          version: PINNED_PI_MCP_ADAPTER_VERSION,
          extensionPath: '/tmp/index.ts',
        }),
      }),
      (error) => error.code === 'MCP_TRACE_BINDING_RESERVED',
    );
  });

  it('propagates a run-scoped trace to stdio MCP children through controlled env', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mcp-stdio-trace-test-'));
    const extensionPath = path.join(root, 'index.ts');
    await fs.writeFile(extensionPath, 'export default () => {}', 'utf8');
    const binding = await createPiMcpAdapter({
      agentSessionId: '01K0G2PAV8FPMVC9QHJG7JPN52',
      runtimeRoot: path.join(root, 'runtime'),
      context: { traceId: TRACE_ID },
      spanRandomBytes: () => Uint8Array.from([8, 7, 6, 5, 4, 3, 2, 1]),
      mcpServers: [{ serverId: 'mock', enabledTools: ['echo'] }],
      serverRegistry: [{ id: 'mock', command: 'mock-server' }],
      packageResolver: async () => ({
        version: PINNED_PI_MCP_ADAPTER_VERSION,
        extensionPath,
      }),
    });
    try {
      const materialized = JSON.parse(readFileSync(binding.configPath, 'utf8'));
      const env = materialized.mcpServers.mock.env;
      assert.equal(env.TRACE_ID, TRACE_ID);
      assert.equal(env.TRACEPARENT, `00-${TRACE_ID}-0807060504030201-01`);
    } finally {
      await binding.cleanup();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('verifies the installed package pin and declared Pi extension', async () => {
    const resolved = await resolvePiMcpAdapterPackage();
    assert.equal(resolved.version, PINNED_PI_MCP_ADAPTER_VERSION);
    assert.match(resolved.extensionPath, /pi-mcp-adapter\/index\.ts$/);
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
