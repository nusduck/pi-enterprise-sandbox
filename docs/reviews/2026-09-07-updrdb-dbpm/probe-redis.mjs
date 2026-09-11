#!/usr/bin/env node
/**
 * 公司改造版 Redis 兼容性探针（阶段 0 用，一次性）。
 *
 * 回答的是"我们的代码到底能不能跑在这台 Redis 上"，而不是"版本号是多少"。
 * 只读探测 + 一个隔离 key 前缀下的最小写入，跑完自己清理。
 *
 * 用法（**在 agent/ 目录下跑** —— ioredis / bullmq 从当前工作目录的
 * node_modules 解析，脚本本身放在 docs/ 里不需要自带依赖）：
 *   cd agent && node ../docs/reviews/2026-09-07-updrdb-dbpm/probe-redis.mjs "redis://:pwd@host:6379/0"
 *   cd agent && REDIS_URL=... node ../docs/reviews/2026-09-07-updrdb-dbpm/probe-redis.mjs
 *
 * 退出码：0 = 全部关键项通过；1 = 有 BLOCKER；2 = 连不上。
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// 脚本住在 docs/ 下，但依赖要从 **cwd**（agent/）的 node_modules 解析，
// 否则 ESM 会去 docs/ 旁边找 ioredis 然后 ERR_MODULE_NOT_FOUND。
const requireFromCwd = createRequire(pathToFileURL(`${process.cwd()}/`));
let Redis;
try {
  Redis = requireFromCwd('ioredis');
  Redis = Redis.default ?? Redis;
} catch {
  console.error('找不到 ioredis —— 请在 agent/ 或 exec/ 目录下运行本脚本。');
  process.exit(2);
}

const url = process.argv[2] || process.env.REDIS_URL;
if (!url) {
  console.error('用法: probe-redis.mjs <redis-url>   (或设 REDIS_URL)');
  process.exit(2);
}

const STAMP = Date.now();
const PREFIX = `__probe:${STAMP}:`;

// BullMQ 的 stalled-check 定时器会在后台抛未捕获的 rejection（EVAL 被禁时必然发生）。
// 不拦住的话进程直接崩，报告都印不出来 —— 探针的价值就没了。
const background = [];
process.on('unhandledRejection', (e) => background.push(String(e?.message ?? e)));
process.on('uncaughtException', (e) => background.push(String(e?.message ?? e)));
// BullMQ 拒绝队列名里出现 ':'（它自己用冒号拼 key），所以另起一个名字。
const QUEUE_NAME = `__probe_q_${STAMP}`;
const results = [];
let luaOk = true;
const add = (level, name, detail) => results.push({ level, name, detail });

/** 区分"命令被 rename 掉"、"被 ACL 拒"、"参数错" —— 三者的处置完全不同。 */
function classify(err) {
  const m = String(err && err.message || err);
  if (/unknown command/i.test(m)) return ['BLOCKER', `命令不存在（多半被 rename-command 摘掉）: ${m}`];
  if (/NOPERM|no permissions/i.test(m)) return ['BLOCKER', `被 ACL 拒绝: ${m}`];
  if (/not allowed/i.test(m)) return ['BLOCKER', `命令被禁用: ${m}`];
  return ['WARN', m];
}

const redis = new Redis(url, {
  connectTimeout: 5000,
  maxRetriesPerRequest: 1,
  retryStrategy: () => null,
  lazyConnect: true,
});

try {
  await redis.connect();
} catch (err) {
  console.error(`连不上: ${err.message}`);
  process.exit(2);
}

// ── 1. 版本与模式 ─────────────────────────────────────────────
try {
  const info = await redis.info('server');
  const ver = /redis_version:(.+)/.exec(info)?.[1]?.trim() ?? '(未返回)';
  const mode = /redis_mode:(.+)/.exec(info)?.[1]?.trim() ?? '(未返回)';
  add('OK', 'INFO server', `redis_version=${ver} redis_mode=${mode}`);
  // BullMQ 启动时就是靠这里读版本做门禁；读不到直接抛错起不来。
  if (ver === '(未返回)') add('BLOCKER', 'INFO 无 redis_version', 'BullMQ 启动即失败');
  if (mode === 'cluster') {
    add('BLOCKER', 'Cluster 模式', 'BullMQ 需要 key 带 hash tag，现有 prefix 不带花括号 → CROSSSLOT');
  }
} catch (err) {
  const [level, detail] = classify(err);
  add(level === 'WARN' ? 'BLOCKER' : level, 'INFO', `${detail}（BullMQ 靠 INFO 读版本，禁用=起不来）`);
}

// ── 2. Lua：本次改造的生死线 ──────────────────────────────────
try {
  const v = await redis.eval('return 1', 0);
  add(v === 1 ? 'OK' : 'WARN', 'EVAL', `返回 ${v}`);
} catch (err) {
  const [, detail] = classify(err);
  luaOk = false;
  add('BLOCKER', 'EVAL', `${detail} → BullMQ 作业状态机 + 三处分布式锁 CAS 全部失效`);
}

// BullMQ 实际走的是 SCRIPT LOAD + EVALSHA（ioredis defineCommand），要单独验。
try {
  const sha = await redis.script('LOAD', 'return 2');
  const v = await redis.evalsha(sha, 0);
  add(v === 2 ? 'OK' : 'WARN', 'SCRIPT LOAD + EVALSHA', `sha=${String(sha).slice(0, 12)}…`);
} catch (err) {
  const [, detail] = classify(err);
  luaOk = false;
  add('BLOCKER', 'SCRIPT LOAD / EVALSHA', `${detail} → BullMQ 的 defineCommand 路径不可用`);
}

// 我们自己的锁用的是 GET+比较+DEL/PEXPIRE 的 CAS 脚本，形状照抄一份验证。
try {
  const k = `${PREFIX}lock`;
  await redis.set(k, 'owner-1', 'PX', 5000, 'NX');
  const released = await redis.eval(
    'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) end return 0',
    1, k, 'owner-1',
  );
  add(released === 1 ? 'OK' : 'BLOCKER', 'CAS 释放锁脚本', `返回 ${released}（期望 1）`);
} catch (err) {
  const [, detail] = classify(err);
  add('BLOCKER', 'CAS 释放锁脚本', detail);
}

// ── 3. 驱逐策略：配错会静默丢 Run ────────────────────────────
try {
  const [, policy] = await redis.config('GET', 'maxmemory-policy');
  add(policy === 'noeviction' ? 'OK' : 'BLOCKER', 'maxmemory-policy', `${policy}（BullMQ 要求 noeviction，否则作业数据被静默驱逐）`);
} catch (err) {
  const [, detail] = classify(err);
  add('WARN', 'CONFIG GET maxmemory-policy', `${detail} → 读不到就必须让运维书面确认是 noeviction`);
}

// ── 4. ACL / 身份 ────────────────────────────────────────────
try {
  const who = await redis.acl('WHOAMI');
  add('OK', 'ACL WHOAMI', `当前用户=${who}${who === 'default' ? '' : ' → DSN 需要写成 redis://user:pass@host'}`);
} catch (err) {
  add('INFO', 'ACL WHOAMI', `不可用（${String(err.message).slice(0, 60)}）—— 6.0 以下或被禁，不一定是问题`);
}

// ── 5. 逐条核对代码实际用到的命令是否还在 ────────────────────
// 这份清单 = 应用直接调用 ∪ BullMQ 5.80.7 的 Lua 全集（见方案 §4.1）。
const NEEDED = [
  'get', 'set', 'del', 'exists', 'expire', 'pexpire', 'pttl', 'persist', 'rename', 'type', 'incr',
  'hset', 'hget', 'hdel', 'hexists', 'hgetall', 'hincrby', 'hlen', 'hmget', 'hmset',
  'lindex', 'llen', 'lpop', 'lpos', 'lpush', 'lrange', 'lrem', 'lset', 'ltrim', 'rpop', 'rpoplpush', 'rpush',
  'sadd', 'scard', 'sismember', 'smembers', 'srem',
  'xadd', 'xrange', 'xlen', 'xtrim',
  'zadd', 'zcard', 'zcount', 'zpopmin', 'zrange', 'zrangebyscore', 'zrem',
  'zremrangebyrank', 'zremrangebyscore', 'zrevrange', 'zrevrangebyscore', 'zscore', 'bzpopmin',
  'eval', 'evalsha', 'script', 'info',
];
try {
  const infos = await redis.command('INFO', ...NEEDED);
  const missing = NEEDED.filter((_, i) => infos[i] == null);
  add(missing.length === 0 ? 'OK' : 'BLOCKER', 'COMMAND INFO 全量核对',
    missing.length === 0 ? `${NEEDED.length} 条命令全部存在` : `缺失: ${missing.join(', ')}`);
} catch (err) {
  add('WARN', 'COMMAND INFO', `${String(err.message).slice(0, 80)} → 退回逐条实跑验证`);
}

// ── 6. 决定性验证：真起一个 BullMQ Queue + Worker ────────────
// 前面所有探测都可能漏判，这一步跑通才算数。
let bullmqNote = '';
if (!luaOk) {
  add('BLOCKER', 'BullMQ Queue→Worker 端到端',
    'Lua 不可用，跳过 —— BullMQ 的整个状态机就是 Lua，不可能通过。先解决 EVAL。');
} else try {
  const { Queue, Worker } = requireFromCwd('bullmq');
  const queueName = QUEUE_NAME;
  const conn = { url, maxRetriesPerRequest: null };
  const queue = new Queue(queueName, { connection: { ...conn } });
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('30s 内 worker 没拿到 job')), 30_000);
    const worker = new Worker(queueName, async (job) => {
      clearTimeout(timer);
      resolve(job.data);
      return 'ok';
    }, { connection: { ...conn } });
    worker.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
  const t0 = Date.now();
  await queue.add('probe', { hello: 'world' });
  const data = await done;
  bullmqNote = `端到端通过（${Date.now() - t0}ms），payload=${JSON.stringify(data)}`;
  add('OK', 'BullMQ Queue→Worker 端到端', bullmqNote);
  await queue.obliterate({ force: true }).catch(() => {});
  await queue.close();
} catch (err) {
  add('BLOCKER', 'BullMQ Queue→Worker 端到端', String(err.message).slice(0, 200));
}

// ── 清理 ─────────────────────────────────────────────────────
try {
  const keys = await redis.keys(`${PREFIX}*`);
  if (keys.length) await redis.del(...keys);
} catch { /* 清理失败不影响结论 */ }
await redis.quit().catch(() => {});

// ── 报告 ─────────────────────────────────────────────────────
const icon = { OK: '✅', WARN: '⚠️ ', BLOCKER: '❌', INFO: 'ℹ️ ' };
console.log('\n=== Redis 兼容性探针结果 ===\n');
for (const r of results) console.log(`${icon[r.level]} ${r.name}\n   ${r.detail}`);
if (background.length) {
  console.log(`\n⚠️  后台未捕获错误 ${background.length} 条（多为 BullMQ 定时任务，通常是上面某个 BLOCKER 的连锁反应）：`);
  for (const m of [...new Set(background)].slice(0, 5)) console.log(`   ${m.slice(0, 160)}`);
}
const blockers = results.filter((r) => r.level === 'BLOCKER');
console.log(`\n${blockers.length === 0 ? '✅ 未发现 BLOCKER，可以进入阶段 4。' : `❌ ${blockers.length} 个 BLOCKER，切换前必须解决。`}\n`);
process.exit(blockers.length === 0 ? 0 : 1);
