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

  // patch 是生成物，MCP 条目在生成时求值——所以要先按这个 MCP_SERVERS_JSON 重生成。
  execFileSync('npm', ['run', 'gen:patch'], { cwd: agentDir, env, encoding: 'utf8' });

  let out: string;
  try {
    out = execFileSync('npx', ['tsx', join(agentDir, 'scripts/probe-mcp-live.ts')], {
      cwd: agentDir,
      env,
      encoding: 'utf8',
      timeout: 120_000,
    });
  } finally {
    // 把仓库里的 YAML 还原成「无 MCP」的形态，否则这条用例会把一个本地夹具
    // 路径写进版本库（`plugins.test.ts` 会因此变红，而且那条路径在别人机器上不存在）。
    execFileSync('npm', ['run', 'gen:patch'], {
      cwd: agentDir,
      env: { ...process.env, MCP_SERVERS_JSON: '' },
      encoding: 'utf8',
    });
  }

  assert.match(out, /mcp__echo__echo/, '工具必须以 mcp__<serverName>__<rawName> 注册');
  assert.match(
    out,
    /echo:hello-from-h7-8/,
    '必须真的调通并把结果带回来——只看到名字不算，那只能证明 tools/list 成功了',
  );
  assert.match(out, /^OK: /m);
});
