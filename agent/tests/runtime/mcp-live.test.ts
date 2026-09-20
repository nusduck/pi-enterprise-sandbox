/**
 * ADR 0009 D9 / 计划 H7.8：**真实** MCP 服务器端到端。
 *
 * `mcp-entries.test.ts` 证的是「生成的 patch 条目对不对」；这一条证的是
 * 「出厂 `dsh-mcp-client` 真的连得上、注册得对、调得通」。两者不能互相替代——
 * 前者用假数据也能全绿。
 *
 * 服务器是 `fixtures/mcp-echo-server.mjs`，用官方 `@modelcontextprotocol/sdk`
 * 写的真 stdio server（那个 SDK 本来就是 dsh-mcp-client 的依赖）。
 *
 * **跑在子进程里**，与 `boot.test.ts` 的组合断言同一个理由：boot 起的插件树没有
 * 便捷的 dispose 接口，留在测试进程里会让 `node:test` 挂住。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const agentDir = join(here, '../..');
const fixture = join(here, 'fixtures/mcp-echo-server.mjs');

test('H7.8 真实 MCP 服务器：连上 → 注册成 mcp__<server>__<tool> → 调得通', () => {
  const env = {
    ...process.env,
    MCP_SERVERS_JSON: JSON.stringify([
      { serverId: 'echo', command: 'node', args: [fixture] },
    ]),
    SANDBOX_INTERNAL_HMAC_KEYRING: '{"k1":"a2tra2tra2tra2tra2tra2tra2tra2tra2tra2tra2s"}',
    SANDBOX_INTERNAL_HMAC_ACTIVE_KID: 'k1',
    LLMIO_API_KEY: 'mcp-live-probe',
  };

  // MCP 在 boot 时按 MCP_SERVERS_JSON 叠进插件树，不再改仓库里的 YAML。
  const out = execFileSync('npx', ['tsx', join(agentDir, 'scripts/probe-mcp-live.ts')], {
    cwd: agentDir,
    env,
    encoding: 'utf8',
    timeout: 120_000,
  });

  assert.match(out, /mcp__echo__echo/, '工具必须以 mcp__<serverName>__<rawName> 注册');
  assert.match(
    out,
    /echo:hello-from-h7-8/,
    '必须真的调通并把结果带回来——只看到名字不算，那只能证明 tools/list 成功了',
  );
  assert.match(out, /^OK: /m);
});

test('K2 就绪投影：连不上的已启用服务器保留在清单里并使 ready=false', () => {
  const env = {
    ...process.env,
    MCP_SERVERS_JSON: JSON.stringify([
      { serverId: 'echo', command: 'node', args: [fixture] },
      // 端口 9（discard）在测试容器里没有监听：连接立即被拒。
      { serverId: 'dead', url: 'http://127.0.0.1:9/mcp' },
      { serverId: 'off', url: 'http://127.0.0.1:9/mcp', enabled: false },
    ]),
    SANDBOX_INTERNAL_HMAC_KEYRING: '{"k1":"a2tra2tra2tra2tra2tra2tra2tra2tra2tra2tra2s"}',
    SANDBOX_INTERNAL_HMAC_ACTIVE_KID: 'k1',
    LLMIO_API_KEY: 'mcp-readiness-probe',
  };

  const out = execFileSync('npx', ['tsx', join(agentDir, 'scripts/probe-mcp-readiness.ts')], {
    cwd: agentDir,
    env,
    encoding: 'utf8',
    timeout: 120_000,
  });
  const line = out.split('\n').find((l) => l.startsWith('READINESS '));
  assert.ok(line, `probe printed no READINESS line:\n${out}`);
  const readiness = JSON.parse(line.slice('READINESS '.length));

  assert.equal(readiness.ready, false, '一台已启用的服务器不可用，就绪必须为 false');
  assert.equal(readiness.serverCount, 2, '停用的服务器不计入；连不上的必须计入');
  const byId = Object.fromEntries(readiness.servers.map((s) => [s.server_id, s]));
  assert.equal(byId.dead?.connection_status, 'unavailable');
  assert.deepEqual(byId.dead?.tools, []);
  // 正对照：真 stdio 服务器照常连上并列出工具。
  assert.equal(byId.echo?.connection_status, 'connected');
  assert.ok(byId.echo.tools.includes('echo'));
  assert.equal(byId.off, undefined);
});
