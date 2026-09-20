/**
 * ADR 0009 D9 / 计划 H7：`MCP_SERVERS_JSON` → 每台服务器一条 `dsh-mcp-client`。
 *
 * 最重要的一条是**密钥不进文件**：patch YAML 是生成物、会进版本库，
 * 明文一旦写进去就再也拿不回来了。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_MCP_RECONNECT_MAX_ATTEMPTS,
  buildMcpPatchEntries,
  buildMcpRuntimePatches,
  readMcpServersFromEnv,
} from '../../src/runtime/plugins/mcp-entries.js';
import { renderPatchYaml } from '../../src/runtime/plugins/render.js';

test('H7.2 密钥只以 process.env 占位符出现，明文永不进 YAML', () => {
  const entries = buildMcpPatchEntries([
    { serverId: 'github', command: 'npx', args: ['-y', 'srv'], envRefs: { GITHUB_TOKEN: 'GH_PAT' } },
    { serverId: 'exa', url: 'https://mcp.exa.ai/mcp', authTokenRef: 'EXA_MCP_TOKEN' },
  ]);
  const yaml = renderPatchYaml(entries);

  assert.match(yaml, /GITHUB_TOKEN: !!js process\.env\.GH_PAT/);
  assert.match(yaml, /Authorization: !!js `Bearer \$\{process\.env\.EXA_MCP_TOKEN\}`/);
  // 引用的是**变量名**，不是值。这里塞一个像密钥的字符串进去，断言它不会被写出来。
  const secretish = 'sk-live-0123456789abcdef';
  const withSecret = renderPatchYaml(
    buildMcpPatchEntries([{ serverId: 'x', url: 'https://x/mcp', authTokenRef: 'TOK' }]),
  );
  assert.equal(withSecret.includes(secretish), false);
});

test('H7.2 env 引用名被约束字符集——它会被原样拼进生成的 JS 表达式', () => {
  assert.throws(
    () =>
      renderPatchYaml(
        buildMcpPatchEntries([
          { serverId: 'x', command: 'c', envRefs: { A: 'BAD;process.exit(1);//' } },
        ]),
      ),
    /must match/,
    '一个被写错或被污染的 MCP_SERVERS_JSON 不该能往 patch 里注入代码',
  );
});

test('H7.1 transport 由字段推断，缺了必填项就 fail-closed', () => {
  const [stdio] = buildMcpPatchEntries([{ serverId: 'a', command: 'npx' }]);
  assert.equal((stdio?.config as Record<string, unknown>)['transport'], 'stdio');
  const [http] = buildMcpPatchEntries([{ serverId: 'b', url: 'https://h/mcp' }]);
  assert.equal((http?.config as Record<string, unknown>)['transport'], 'streamable-http');

  assert.throws(
    () => buildMcpPatchEntries([{ serverId: 'c', transport: 'stdio' }]),
    /no command/,
  );
  assert.throws(
    () => buildMcpPatchEntries([{ serverId: 'd', transport: 'streamable-http' }]),
    /no url/,
  );
});

test('H7.1 serverId 与出厂 serverName 的字符集不一样时直接拒，不静默转换', () => {
  // 我们的 serverId 允许 `.`，出厂 serverName 只认 [A-Za-z0-9_-]{1,32}。
  // 静默把 `a.b` 转成 `a-b` 会让两台服务器的工具挤进同一个命名空间，
  // 而症状只是「工具莫名其妙少了几个」。
  assert.throws(() => buildMcpPatchEntries([{ serverId: 'a.b', url: 'https://x/mcp' }]), /must match/);
  assert.throws(
    () => buildMcpPatchEntries([{ serverId: 'x', url: 'https://x/mcp' }, { serverId: 'x', url: 'https://y/mcp' }]),
    /duplicate/,
  );
});

test('H7.1 显式停用的服务器不进 patch（boot 时不该去连它）', () => {
  assert.deepEqual(buildMcpPatchEntries([{ serverId: 'off', url: 'https://x/mcp', enabled: false }]), []);
});

test('H7.1 MCP_SERVERS_JSON 解析 fail-closed', () => {
  assert.deepEqual(readMcpServersFromEnv({} as NodeJS.ProcessEnv), []);
  assert.deepEqual(readMcpServersFromEnv({ MCP_SERVERS_JSON: '' } as never), []);
  assert.throws(() => readMcpServersFromEnv({ MCP_SERVERS_JSON: '{not json' } as never), /Invalid/);
  assert.throws(() => readMcpServersFromEnv({ MCP_SERVERS_JSON: '{}' } as never), /must be an array/);
});

test('boot 时按环境叠 MCP patch，密钥换成真实值而不是 YAML 占位符', () => {
  const env = {
    MCP_SERVERS_JSON: JSON.stringify([
      { serverId: 'exa', url: 'https://mcp.exa.ai/mcp', authTokenRef: 'EXA_MCP_TOKEN' },
    ]),
    EXA_MCP_TOKEN: 'tok-live',
  } as NodeJS.ProcessEnv;
  const [layer] = buildMcpRuntimePatches(env);
  const inserted = layer?.insert?.[0];
  assert.equal(inserted?.name, '@deepseek-ai/dsh-mcp-client');
  const config = inserted?.config as Record<string, unknown>;
  assert.equal(config['url'], 'https://mcp.exa.ai/mcp');
  assert.deepEqual(config['headers'], { Authorization: 'Bearer tok-live' });
});

test('boot 时缺密钥的 MCP 服务器被跳过，不让整个 Agent 起不来', () => {
  const env = {
    MCP_SERVERS_JSON: JSON.stringify([
      { serverId: 'exa', url: 'https://mcp.exa.ai/mcp', authTokenRef: 'EXA_MCP_TOKEN' },
    ]),
  } as NodeJS.ProcessEnv;
  assert.deepEqual(buildMcpRuntimePatches(env), []);
});

test('K2 重连默认不设次数上限：出厂 10 次预算耗尽后永不再连，/ready 会永久 503', () => {
  const [entry] = buildMcpPatchEntries([{ serverId: 'exa', url: 'https://mcp.exa.ai/mcp' }]);
  assert.deepEqual((entry?.config as Record<string, unknown>)['reconnect'], {
    maxAttempts: DEFAULT_MCP_RECONNECT_MAX_ATTEMPTS,
  });
  assert.equal(DEFAULT_MCP_RECONNECT_MAX_ATTEMPTS, Number.MAX_SAFE_INTEGER);
});

test('K2 reconnect 可按服务器覆盖，非法值启动即拒', () => {
  const [entry] = buildMcpPatchEntries([
    { serverId: 'loop', command: 'node', args: ['x.mjs'], reconnect: { maxAttempts: 3, initialDelayMs: 100 } },
  ]);
  assert.deepEqual((entry?.config as Record<string, unknown>)['reconnect'], {
    maxAttempts: 3,
    initialDelayMs: 100,
  });
  const bad = (reconnect: unknown) => () =>
    buildMcpPatchEntries([{ serverId: 's', url: 'https://x/mcp', reconnect }]);
  assert.throws(bad('forever'), /reconnect must be an object/);
  assert.throws(bad({ retries: 3 }), /reconnect\.retries is not a reconnect option/);
  assert.throws(bad({ maxAttempts: 0 }), /reconnect\.maxAttempts/);
  assert.throws(bad({ maxDelayMs: 1.5 }), /reconnect\.maxDelayMs/);
  assert.throws(bad({ enabled: 'yes' }), /reconnect\.enabled/);
});
