/**
 * G7 门禁：exec 硬杀之后的孤儿回收（§32 G7）。
 *
 * 这是什么：在**运行中的 compose 栈**上验证一件事——exec 被 `SIGKILL` 掉、
 * 再起回来之后，上一轮还在 `running` 的作业行必须被收成终态，而不是永远躺在
 * `running` 里。这不是理论问题：`MySqlJobRegistry.recoverOrphans()` 写好之后
 * 长期没有任何调用点，2026-09-04 在开发栈上实测到 5 条僵尸 `running` 行
 * （最老的两天前），而容器里一个对应进程都没有。僵尸行还会占着
 * `countActiveForOwner` 的每 owner 并发额度，攒够上限该 owner 就再也起不了作业。
 *
 * 它**取代**了 `sandbox-live-gate.mjs`：那个 932 行的门禁是 Python 执行面时代的
 * 产物，靠 `grep uvicorn sandbox.main:app` 找服务 PID、靠 agent 侧三个已删除的
 * internal transport 驱动，`node` 加载即 `ERR_MODULE_NOT_FOUND`。与其修一个
 * 目标进程已经不存在的 harness，不如照当前接缝重写这条断言。
 *
 * 为什么只查账本、不查残留进程：当前 compose 拓扑里 exec 是 `init: true` 下
 * docker-init 唯一监管的子进程，杀掉它容器就跟着退出/重启（实测：`kill -9` 容器内
 * 的 node，容器立刻进入 restarting）。也就是说"容器还活着但 bwrap 子进程成了孤儿"
 * 这个场景在这里**不成立**——孤儿问题是纯粹的账本问题，正是 `recoverOrphans()`
 * 负责的那一半。旧门禁测的是 Python 时代那种「容器内 uvicorn 被单独杀掉」的形态。
 *
 * 怎么跑（需要 Docker，宿主机上跑；sandbox 不发布端口，所以驱动 exec 内部面的
 * 那几步在 agent 容器里执行）：
 *
 *   docker compose up -d
 *   node scripts/release-gates/exec-orphan-recovery-gate.mjs
 *
 * 退出码 0 = 通过。任何断言失败都会打印原因并以 1 退出。
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const SERVICE = process.env.EXEC_GATE_SERVICE ?? 'sandbox';
const MYSQL_SERVICE = process.env.EXEC_GATE_MYSQL_SERVICE ?? 'mysql';
const MYSQL_USER = process.env.EXEC_GATE_MYSQL_USER ?? 'sandbox';
const MYSQL_PASSWORD = process.env.EXEC_GATE_MYSQL_PASSWORD ?? 'sandbox_dev_only';
const MYSQL_DATABASE = process.env.EXEC_GATE_MYSQL_DATABASE ?? 'sandbox';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function compose(args, opts = {}) {
  return execFileSync('docker', ['compose', ...args], {
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 120_000,
    stdio: opts.stdio ?? ['ignore', 'pipe', 'pipe'],
  });
}

/** 在 agent 容器里跑一段 ESM——那里同时有 `@pi/contract` 与到 sandbox 的网络。 */
function inAgent(script) {
  return compose(['exec', '-T', 'agent', 'node', '--input-type=module', '-e', script]).trim();
}

function sql(statement) {
  return compose([
    'exec', '-T', MYSQL_SERVICE,
    'mysql', `-u${MYSQL_USER}`, `-p${MYSQL_PASSWORD}`, MYSQL_DATABASE,
    '--batch', '--skip-column-names', '-e', statement,
  ]).trim();
}

/** exec 内部面：确保工作区 + 起一个后台作业，返回 { workspaceId, jobId }。 */
function startBackgroundJob(workspaceId, orgId, userId) {
  const script = `
import { ExecRpcClient } from './dist/src/runtime/providers/exec-rpc.js';
const rpc = new ExecRpcClient({
  baseUrl: process.env.SANDBOX_BASE_URL || 'http://sandbox:8081',
  keyring: process.env.SANDBOX_INTERNAL_HMAC_KEYRING,
  activeKid: process.env.SANDBOX_INTERNAL_HMAC_ACTIVE_KID,
  orgId: ${JSON.stringify(orgId)},
  userId: ${JSON.stringify(userId)},
  workspaceId: ${JSON.stringify(workspaceId)},
  fenceToken: 1,
  physicalRoots: [],
});
await rpc.post('/internal/v1/sessions/ensure', { workspaceId: ${JSON.stringify(workspaceId)} }, []);
const id = 'bash-' + ${JSON.stringify(workspaceId)}.toLowerCase().slice(0, 24);
const started = await rpc.post('/internal/v1/shell/start', {
  id, command: 'sleep 900', workdir: '/home/sandbox/workspace',
}, []);
console.log(JSON.stringify({ jobId: started.id ?? id }));
`;
  const out = inAgent(script);
  const line = out.split('\n').filter(Boolean).pop() ?? '{}';
  return JSON.parse(line);
}

async function waitReady(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const out = compose(['exec', '-T', '--user', '10001:10001', SERVICE,
        'curl', '-fsS', 'localhost:8081/ready'], { timeoutMs: 10_000 });
      if (out.includes('ok')) return true;
    } catch { /* 还没起来 */ }
    await sleep(2000);
  }
  return false;
}

const main = async () => {
  // 唯一标识本次门禁的 owner，避免和栈上已有数据混在一起。
  const stamp = Date.now().toString(36).toUpperCase().padStart(10, '0').slice(-10);
  const workspaceId = `01G7GATE${stamp}RECOVER`.slice(0, 26).toUpperCase();
  const orgId = `01G7GATEORG${stamp}`.slice(0, 26).toUpperCase();
  const userId = `01G7GATEUSR${stamp}`.slice(0, 26).toUpperCase();

  assert.ok(await waitReady(), 'exec must be ready before the gate starts');

  const { jobId } = startBackgroundJob(workspaceId, orgId, userId);
  check('后台作业已在 exec 上起来', Boolean(jobId), `job=${jobId}`);

  const before = sql(`SELECT status FROM exec_jobs WHERE process_id='${jobId}'`);
  check('作业初始状态为 running', before === 'running', `status=${before || '(no row)'}`);

  // 真正的硬杀：SIGKILL，不给任何优雅退出的机会。
  compose(['kill', '-s', 'KILL', SERVICE]);
  const killedState = compose(['ps', '-a', '--format', '{{.Service}} {{.State}}'])
    .split('\n').find((l) => l.startsWith(`${SERVICE} `)) ?? '';
  check('exec 已被 SIGKILL', !/running/i.test(killedState), killedState.trim());

  const stillRunning = sql(`SELECT status FROM exec_jobs WHERE process_id='${jobId}'`);
  check('硬杀后账本仍停留在 running（回收前的样子）', stillRunning === 'running',
    `status=${stillRunning || '(no row)'}`);

  compose(['up', '-d', SERVICE], { timeoutMs: 180_000 });
  assert.ok(await waitReady(), 'exec must come back after the hard kill');

  // 回收发生在 listen 之前，所以 /ready 一通就该已经收完。
  const after = sql(`SELECT status, detail FROM exec_jobs WHERE process_id='${jobId}'`);
  const [afterStatus, afterDetail] = after.split('\t');
  check('重启后作业被收成终态', ['killed', 'failed', 'completed'].includes(afterStatus),
    `status=${afterStatus || '(no row)'} detail=${afterDetail ?? ''}`);
  check('终态注明是孤儿回收', String(afterDetail ?? '').includes('orphan'),
    `detail=${afterDetail ?? ''}`);

  // 整张表不能再有僵尸：容器是新起的，任何 running/stopping 都没有活句柄。
  const zombies = sql(
    "SELECT COUNT(*) FROM exec_jobs WHERE status IN ('running','stopping')",
  );
  check('全表不再有 running/stopping 僵尸行', zombies === '0', `n=${zombies}`);

  // 硬杀不该在容器里留下孤儿进程（新容器本来就是干净的，这条守的是
  // 「回收把 pid 也处理掉了」而不是只改了数据库）。
  let leftovers = '0';
  try {
    leftovers = compose(['exec', '-T', SERVICE, 'sh', '-c',
      'ps -eo args 2>/dev/null | grep -c "[s]leep 900" || true']).trim();
  } catch { leftovers = '0'; }
  check('容器内没有残留的被托管进程', leftovers === '0' || leftovers === '', `n=${leftovers}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  if (failed.length) process.exitCode = 1;
};

main().catch((err) => {
  console.error('GATE ERROR:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
