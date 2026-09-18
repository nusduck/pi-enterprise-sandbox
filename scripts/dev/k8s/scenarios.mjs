// K8s 多副本演练的场景驱动（宿主机 Node 22 运行；先 `up.sh sim`）。
//
//   node scripts/dev/k8s/scenarios.mjs [场景...]     默认按顺序全跑
//
// 场景（每个都经 frontend → BFF → Agent 的真实入口建 Run，模型是 fake-llm）：
//   exactly-once   8 个 Run 同时提交：每个只执行一次（模型首轮 1 次、工具账本 1 行、工作区副作用 1 行），两个副本都在消费
//   capacity       6 个挂住的 Run：同时在跑的只有 2 副本 × 深度 0 的 2 槽 = 4 个，其余排队；放行后全部成功
//   kill-takeover  模型调用中 SIGKILL 所在 Worker Pod：Run 被接管、模型调用重放一次、工具只执行一次
//   freeze-fence   冻结（docker pause）所在 Worker，另一副本接管并完成；解冻后旧 Worker 不得再派发工具
//   cancel         Run 在某个副本上执行时经 BFF 取消：Run 取消、模型调用被中断、放行后不再继续
//   same-session   同一会话第一个 Run 在跑时发 follow-up：排在第一个之后执行，不会在另一个副本上并行
//   rolling-restart 在途 Run 时 rollout restart：原副本 SIGTERM 后排空完成，不重放
//   redis-outage   暂停专用 Redis：Worker 与 Agent HTTP 都摘流量，恢复后自动就绪且 Run 可用
//
// SIM_WORKERS=<n> 指定期望的 Worker 副本数（默认 2）；SIM_RESULT_FILE=<path> 把结果写成 JSON。
//
// 宿主机到 ClusterIP 不通（OrbStack 下走了局域网路由），所以 HTTP 经 kubectl port-forward；
// 账本经 docker exec 查开发栈 MySQL 的专用库 pi_k8s_sim；副作用直接看专用 exec 容器的数据根。
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { writeFileSync } from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const sh = promisify(execFile);
const NS = 'pi-sim';
const SANDBOX_CONTAINER = 'pi-k8s-sim-sandbox';
const BFF_PORT = 18080;
const LLM_PORT = 18081;
const TERMINAL = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Date.now().toString(36);

// ── 基础设施 ─────────────────────────────────────────────────
const kubectl = (...args) => sh('kubectl', ['--context', 'orbstack', '-n', NS, ...args], { maxBuffer: 16 << 20 });

function portForward(target, local, remote) {
  const child = spawn('kubectl', ['--context', 'orbstack', '-n', NS, 'port-forward', target, `${local}:${remote}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`port-forward ${target} timed out`)), 15_000);
    child.stdout.on('data', (d) => {
      if (String(d).includes('Forwarding')) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.once('exit', (code) => reject(new Error(`port-forward ${target} exited ${code}`)));
  });
}

async function workerPods() {
  const { stdout } = await kubectl('get', 'pods', '-l', 'app=agent-worker', '-o', 'json');
  return JSON.parse(stdout).items.map((p) => ({
    name: p.metadata.name,
    ip: p.status.podIP,
    phase: p.status.phase,
    deleting: Boolean(p.metadata.deletionTimestamp),
    ready: (p.status.conditions || []).some((c) => c.type === 'Ready' && c.status === 'True'),
    restarts: p.status.containerStatuses?.[0]?.restartCount ?? 0,
    containerId: String(p.status.containerStatuses?.[0]?.containerID || '').replace(/^docker:\/\//, ''),
  }));
}

/** Pod IP → Pod 名；IP 会随重建变化，所以每次查看都累积历史映射。 */
const ipNames = new Map();
async function refreshIpNames() {
  for (const p of await workerPods()) if (p.ip) ipNames.set(p.ip, p.name);
}
const podOf = (ip) => ipNames.get(ip) || ip;

async function waitWorkersReady(count = Number(process.env.SIM_WORKERS || 2), timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pods = (await workerPods()).filter((p) => !p.deleting);
    if (pods.length === count && pods.every((p) => p.ready)) {
      await refreshIpNames();
      return pods;
    }
    await sleep(2_000);
  }
  throw new Error('agent-worker replicas did not become ready');
}

function client() {
  let cookie = '';
  return async function call(method, p, body, headers = {}) {
    const r = await fetch(`http://127.0.0.1:${BFF_PORT}${p}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const sc = r.headers.getSetCookie?.() || [];
    if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
    let b = await r.text();
    try {
      b = JSON.parse(b);
    } catch {}
    return { s: r.status, b };
  };
}

const llm = {
  async log() {
    const r = await fetch(`http://127.0.0.1:${LLM_PORT}/_sim/log`);
    return r.json();
  },
  async release(id) {
    const r = await fetch(`http://127.0.0.1:${LLM_PORT}/_sim/release`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    return r.json();
  },
  async entries(id) {
    return (await this.log()).filter((e) => e.id === id);
  },
  async waitFor(predicate, timeoutMs, what) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = (await this.log()).filter(predicate);
      if (hit.length) return hit;
      await sleep(500);
    }
    throw new Error(`timed out waiting for fake-llm: ${what}`);
  },
};

// 账本经 docker exec 进开发栈 MySQL 容器查询（宿主 127.0.0.1:3306 可能被本机 mysqld 占用）。
async function query(sql) {
  const { stdout } = await sh('docker', [
    'compose', '--project-directory', ROOT, 'exec', '-T', 'mysql', 'sh', '-c',
    'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot -N -B pi_k8s_sim -e "$1"', '_', sql,
  ]);
  return stdout.split('\n').filter(Boolean).map((l) => l.split('\t'));
}
const ulid = (v) => {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(String(v))) throw new Error(`not a ULID: ${v}`);
  return v;
};
async function toolRows(runId) {
  const rows = await query(
    `SELECT tool_name, status, execution_fence_token FROM tool_executions WHERE run_id = '${ulid(runId)}' ORDER BY created_at`,
  );
  return rows.map(([name, status, fence]) => `${name}:${status}:fence${fence}`);
}
async function runRow(runId) {
  const [row] = await query(`SELECT status, status_reason, attempt FROM runs WHERE run_id = '${ulid(runId)}'`);
  return row ? { status: row[0], reason: row[1], attempt: Number(row[2]) } : null;
}

async function sideEffectLines(id) {
  const { stdout } = await sh('docker', [
    'exec', SANDBOX_CONTAINER, 'sh', '-c',
    'find /var/sandbox/workspaces -name "$1" -exec cat {} +', '_', `sim-${id}.log`,
  ]);
  return stdout.split('\n').filter(Boolean).length;
}

// ── 业务动作 ─────────────────────────────────────────────────
async function newUser(name) {
  const c = client();
  const reg = await c('POST', '/api/auth/register', { username: `${name}${tag}`, password: 'k8s-sim-pass-123' });
  if (reg.s !== 200) throw new Error(`register ${name}: ${reg.s} ${JSON.stringify(reg.b)}`);
  return c;
}
async function newConversation(c) {
  const conv = await c('POST', '/api/conversations', {});
  if (conv.s !== 201) throw new Error(`conversation: ${conv.s} ${JSON.stringify(conv.b)}`);
  return conv.b.id;
}
async function submit(c, convId, id, mode) {
  const r = await c(
    'POST',
    `/api/conversations/${convId}/runs`,
    { messages: [{ role: 'user', content: `[[SIM id=${id} mode=${mode}]] 按系统安排执行。` }] },
    { 'Idempotency-Key': `sim-${id}` },
  );
  return { status: r.s, runId: r.b?.run_id || r.b?.runId, body: r.b };
}
async function runStatus(c, runId) {
  const r = await c('GET', `/api/runs/${runId}`);
  return String(r.b?.status || r.b?.run?.status || '');
}
async function waitTerminal(c, runId, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let st = '';
  while (Date.now() < deadline) {
    st = await runStatus(c, runId);
    if (TERMINAL.includes(st)) return st;
    await sleep(1_000);
  }
  return st || 'TIMEOUT';
}

// ── 记录 ─────────────────────────────────────────────────────
const results = [];
function record(scenario, name, ok, detail) {
  results.push({ scenario, name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} [${scenario}] ${name} ${JSON.stringify(detail).slice(0, 600)}`);
}

// ── 场景 ─────────────────────────────────────────────────────
const scenarios = {
  async 'exactly-once'(S) {
    const c = await newUser('once');
    const ids = Array.from({ length: 8 }, (_, i) => `once-${tag}-${i}`);
    const convs = await Promise.all(ids.map(() => newConversation(c)));
    const runs = await Promise.all(ids.map((id, i) => submit(c, convs[i], id, 'tool')));
    record(S, 'all_accepted', runs.every((r) => r.status === 202 && r.runId), runs.map((r) => r.status));
    const finals = await Promise.all(runs.map((r) => waitTerminal(c, r.runId)));
    record(S, 'all_succeeded', finals.every((s) => s === 'SUCCEEDED'), finals);
    const log = await llm.log();
    await refreshIpNames();
    const per = [];
    for (const [i, id] of ids.entries()) {
      const first = log.filter((e) => e.id === id && e.turn === 1);
      per.push({
        id: i,
        firstTurns: first.length,
        tools: await toolRows(runs[i].runId),
        lines: await sideEffectLines(id),
        pod: podOf(first[0]?.remote),
      });
    }
    record(
      S,
      'each_run_executed_once',
      per.every((p) => p.firstTurns === 1 && p.tools.length === 1 && /SUCCEEDED/.test(p.tools[0]) && p.lines === 1),
      per.map(({ id, firstTurns, tools, lines }) => ({ id, firstTurns, tools, lines })),
    );
    const byPod = per.reduce((m, p) => ({ ...m, [p.pod]: (m[p.pod] || 0) + 1 }), {});
    record(S, 'both_replicas_consumed', Object.keys(byPod).length === 2, byPod);
  },

  async capacity(S) {
    const c = await newUser('cap');
    const ids = Array.from({ length: 6 }, (_, i) => `cap-${tag}-${i}`);
    const convs = await Promise.all(ids.map(() => newConversation(c)));
    const runs = await Promise.all(ids.map((id, i) => submit(c, convs[i], id, 'hold-text')));
    await llm.waitFor((e) => ids.includes(e.id) && e.state === 'held', 30_000, 'first held request');
    await sleep(12_000);
    await refreshIpNames();
    const held = (await llm.log()).filter((e) => ids.includes(e.id) && e.state === 'held');
    const byPod = held.reduce((m, e) => ({ ...m, [podOf(e.remote)]: (m[podOf(e.remote)] || 0) + 1 }), {});
    const statuses = await Promise.all(runs.map((r) => runRow(r.runId).then((x) => x?.status)));
    record(
      S,
      'concurrency_is_2_per_replica',
      held.length === 4 && Object.values(byPod).every((n) => n === 2),
      { held: held.length, byPod, statuses },
    );
    // 放行：先放行的 4 个结束后，排队的 2 个才会到模型，循环放行直到全部结束。
    const deadline = Date.now() + 120_000;
    let finals = [];
    while (Date.now() < deadline) {
      for (const id of ids) await llm.release(id);
      finals = await Promise.all(runs.map((r) => runStatus(c, r.runId)));
      if (finals.every((s) => TERMINAL.includes(s))) break;
      await sleep(1_000);
    }
    record(S, 'all_succeeded_after_release', finals.every((s) => s === 'SUCCEEDED'), finals);
  },

  async 'kill-takeover'(S) {
    const c = await newUser('kill');
    const id = `kill-${tag}`;
    const run = await submit(c, await newConversation(c), id, 'hold-tool');
    const [first] = await llm.waitFor((e) => e.id === id && e.state === 'held', 30_000, 'held model call');
    await refreshIpNames();
    const victim = podOf(first.remote);
    await kubectl('delete', 'pod', victim, '--grace-period=0', '--force', '--wait=false');
    const t0 = Date.now();
    const replays = await llm.waitFor(
      (e) => e.id === id && e.turn === 1 && e.seq !== first.seq,
      120_000,
      'replayed model call after SIGKILL',
    );
    await refreshIpNames();
    record(S, 'run_taken_over', true, {
      victim,
      takeoverBy: podOf(replays[0].remote),
      afterMs: Date.now() - t0,
      firstState: (await llm.entries(id)).find((e) => e.seq === first.seq)?.state,
    });
    await llm.release(id);
    const final = await waitTerminal(c, run.runId);
    const entries = await llm.entries(id);
    const detail = {
      final,
      firstTurns: entries.filter((e) => e.turn === 1).length,
      tools: await toolRows(run.runId),
      lines: await sideEffectLines(id),
      run: await runRow(run.runId),
    };
    record(
      S,
      'replayed_once_tool_once',
      final === 'SUCCEEDED' && detail.firstTurns === 2 && detail.tools.length === 1 && detail.lines === 1,
      detail,
    );
    await waitWorkersReady();
  },

  async 'freeze-fence'(S) {
    const c = await newUser('frz');
    const id = `frz-${tag}`;
    const run = await submit(c, await newConversation(c), id, 'hold-tool');
    const [first] = await llm.waitFor((e) => e.id === id && e.state === 'held', 30_000, 'held model call');
    await refreshIpNames();
    const frozen = (await workerPods()).find((p) => p.ip === first.remote);
    await sh('docker', ['pause', frozen.containerId]);
    const t0 = Date.now();
    let takeover;
    try {
      [takeover] = await llm.waitFor(
        (e) => e.id === id && e.turn === 1 && e.seq !== first.seq,
        50_000,
        'takeover by the other replica while frozen',
      );
    } catch (error) {
      await sh('docker', ['unpause', frozen.containerId]);
      throw error;
    }
    record(S, 'taken_over_while_frozen', takeover.remote !== first.remote, {
      frozen: frozen.name,
      takeoverBy: podOf(takeover.remote),
      afterMs: Date.now() - t0,
    });
    // 两个挂住的模型调用都放行：冻结的那份响应留在内核缓冲里，解冻后旧 Worker 才读到工具调用。
    await llm.release(id);
    const final = await waitTerminal(c, run.runId);
    const before = { tools: await toolRows(run.runId), lines: await sideEffectLines(id) };
    await sh('docker', ['unpause', frozen.containerId]);
    const frozenMs = Date.now() - t0;
    await sleep(20_000);
    const after = {
      final: await runStatus(c, run.runId),
      tools: await toolRows(run.runId),
      lines: await sideEffectLines(id),
      run: await runRow(run.runId),
      turns: (await llm.entries(id)).map((e) => ({ turn: e.turn, pod: podOf(e.remote), state: e.state })),
    };
    const pod = (await workerPods()).find((p) => p.name === frozen.name);
    const { stdout: logs } = await kubectl('logs', frozen.name, '--since=90s').catch(() => ({ stdout: '' }));
    const fenceLog = logs.split('\n').filter((l) => /fence|lease|stale|superseded/i.test(l)).slice(-5);
    record(
      S,
      'stale_worker_did_not_dispatch',
      final === 'SUCCEEDED' && after.final === 'SUCCEEDED' && after.tools.length === 1 && after.lines === 1,
      { final, frozenMs, before, after, frozenPod: pod && { ready: pod.ready, restarts: pod.restarts }, fenceLog },
    );
    await waitWorkersReady();
  },

  async cancel(S) {
    const c = await newUser('cxl');
    const id = `cxl-${tag}`;
    const run = await submit(c, await newConversation(c), id, 'hold-text');
    const [first] = await llm.waitFor((e) => e.id === id && e.state === 'held', 30_000, 'held model call');
    await refreshIpNames();
    const r = await c('POST', `/api/runs/${run.runId}/cancel`, {}, { 'Idempotency-Key': `cxl-${id}` });
    const final = await waitTerminal(c, run.runId, 60_000);
    await sleep(2_000);
    const state = (await llm.entries(id)).find((e) => e.seq === first.seq)?.state;
    record(S, 'cancelled_across_replicas', r.s < 300 && final === 'CANCELLED' && state === 'aborted', {
      cancelHttp: r.s,
      final,
      modelCallState: state,
      executingPod: podOf(first.remote),
    });
    await llm.release(id);
    await sleep(5_000);
    const after = { status: await runStatus(c, run.runId), turns: (await llm.entries(id)).length, tools: await toolRows(run.runId) };
    record(S, 'no_progress_after_cancel', after.status === 'CANCELLED' && after.turns === 1 && after.tools.length === 0, after);
  },

  async 'rolling-restart'(S) {
    const c = await newUser('roll');
    const id = `roll-${tag}`;
    const run = await submit(c, await newConversation(c), id, 'hold-tool');
    const [first] = await llm.waitFor((e) => e.id === id && e.state === 'held', 30_000, 'held model call');
    await refreshIpNames();
    const draining = podOf(first.remote);
    await kubectl('rollout', 'restart', 'deployment/agent-worker');
    // SIGTERM 后给在途 Run 一点时间，再放行模型调用：优雅排空应由原副本完成，不重放。
    await sleep(5_000);
    const phaseAfterSigterm = (await workerPods()).find((p) => p.name === draining);
    await llm.release(id);
    const final = await waitTerminal(c, run.runId);
    await kubectl('rollout', 'status', 'deployment/agent-worker', '--timeout=180s');
    const entries = await llm.entries(id);
    const detail = {
      final,
      draining,
      drainingPodAfterSigterm: phaseAfterSigterm && { deleting: phaseAfterSigterm.deleting, ready: phaseAfterSigterm.ready },
      turns: entries.map((e) => ({ turn: e.turn, pod: podOf(e.remote), state: e.state })),
      tools: await toolRows(run.runId),
      lines: await sideEffectLines(id),
      run: await runRow(run.runId),
    };
    record(
      S,
      'in_flight_run_drained_without_replay',
      final === 'SUCCEEDED' && entries.filter((e) => e.turn === 1).length === 1 &&
        detail.tools.length === 1 && detail.lines === 1,
      detail,
    );
    await waitWorkersReady();
  },

  async 'redis-outage'(S) {
    const readiness = async () => {
      const { stdout } = await kubectl('get', 'pods', '-l', 'app in (agent,agent-worker)', '-o', 'json');
      return JSON.parse(stdout).items
        .filter((p) => !p.metadata.deletionTimestamp)
        .map((p) => ({
          app: p.metadata.labels.app,
          ready: (p.status.conditions || []).some((x) => x.type === 'Ready' && x.status === 'True'),
          restarts: p.status.containerStatuses?.[0]?.restartCount ?? 0,
        }));
    };
    const before = await readiness();
    await sh('docker', ['pause', 'pi-k8s-sim-redis']);
    let during;
    try {
      const deadline = Date.now() + 60_000;
      do {
        await sleep(3_000);
        during = await readiness();
      } while (Date.now() < deadline && during.some((p) => p.ready));
    } finally {
      await sh('docker', ['unpause', 'pi-k8s-sim-redis']);
    }
    const workers = during.filter((p) => p.app === 'agent-worker');
    const agents = during.filter((p) => p.app === 'agent');
    record(S, 'workers_unready_during_outage', workers.every((p) => !p.ready), { before, during: workers });
    // Agent HTTP /ready 也要 ping MySQL / Redis（2026-09-18 演练发现此前只看客户端对象，已修）。
    record(S, 'agent_http_unready_during_outage', agents.every((p) => !p.ready), { during: agents });
    const deadline = Date.now() + 90_000;
    let after;
    do {
      await sleep(3_000);
      after = await readiness();
    } while (Date.now() < deadline && !after.every((p) => p.ready));
    record(S, 'ready_again_after_recovery', after.every((p) => p.ready), after);
    const c = await newUser('rds');
    const id = `rds-${tag}`;
    const run = await submit(c, await newConversation(c), id, 'tool');
    const final = await waitTerminal(c, run.runId);
    record(S, 'runs_work_after_recovery', final === 'SUCCEEDED' && (await sideEffectLines(id)) === 1, { final });
  },

  async 'same-session'(S) {
    const c = await newUser('ses');
    const conv = await newConversation(c);
    const id1 = `ses1-${tag}`;
    const id2 = `ses2-${tag}`;
    const r1 = await submit(c, conv, id1, 'hold-text');
    await llm.waitFor((e) => e.id === id1 && e.state === 'held', 30_000, 'first run held');
    // 计划 §12：Run 执行期间用户再发消息走 follow-up，等当前 Run 完成后自动执行。
    const fu = await c(
      'POST',
      `/api/conversations/${conv}/follow-ups`,
      { text: `[[SIM id=${id2} mode=text]] 追问。` },
      { 'Idempotency-Key': `sim-${id2}` },
    );
    const r2 = { status: fu.s, runId: fu.b?.run_id || fu.b?.runId, body: fu.b };
    if (r2.status !== 202) {
      record(S, 'second_run_rejected_while_first_active', r2.status === 409, { status: r2.status, body: r2.body });
      await llm.release(id1);
      await waitTerminal(c, r1.runId);
      return;
    }
    await sleep(10_000);
    const early = await llm.entries(id2);
    const releasedAt = Date.now();
    await llm.release(id1);
    const finals = [await waitTerminal(c, r1.runId), await waitTerminal(c, r2.runId)];
    const second = await llm.entries(id2);
    record(
      S,
      'serialized_within_session',
      early.length === 0 && finals.every((s) => s === 'SUCCEEDED') && Date.parse(second[0]?.at) >= releasedAt - 1_000,
      { r2: r2.status, secondRunModelCallsWhileFirstActive: early.length, finals, second: await runRow(r2.runId) },
    );
  },
};

// ── 主流程 ───────────────────────────────────────────────────
const selected = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(scenarios);
const forwards = [await portForward('svc/frontend', BFF_PORT, 80), await portForward('svc/fake-llm', LLM_PORT, 8080)];
try {
  await waitWorkersReady();
  // 预热：全新库上组织的默认 Agent 在第一次建会话时惰性创建，并发首建会撞唯一键返回 409
  // （2026-09-18 演练发现，与副本数无关，单独跟踪）。先串行建一个会话，别让它干扰多副本场景。
  await newConversation(await newUser('warm'));
  for (const name of selected) {
    if (!scenarios[name]) throw new Error(`unknown scenario ${name}`);
    console.log(`\n=== ${name} ===`);
    try {
      await scenarios[name](name);
    } catch (error) {
      record(name, 'scenario_error', false, String(error?.stack || error).slice(0, 800));
    }
  }
} finally {
  for (const f of forwards) f.kill();
}
const failed = results.filter((r) => !r.ok).length;
const out = process.env.SIM_RESULT_FILE;
if (out) writeFileSync(out, JSON.stringify({ tag, results }, null, 2));
console.log(`\nSUMMARY ${results.length - failed}/${results.length} passed (tag ${tag})`);
process.exit(failed ? 1 : 0);
