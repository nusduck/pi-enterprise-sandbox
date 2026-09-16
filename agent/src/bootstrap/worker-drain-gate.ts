/**
 * Worker 启动的**缩深 / 回滚闸门**（ADR 0012）。
 *
 * 换回旧拓扑或调小 `AGENT_SUBAGENT_MAX_DEPTH` 之后，本配置不再服务的深度
 * 没有消费者。这里在启动时确认那些深度**已经收敛**，否则 fail-closed 拒启，
 * 并点名是哪一层、还剩多少。
 *
 * 2026-09-16 修复后复核发现第一版的两个缺口，本文件是对它们的修复：
 *
 * - **F2：读失败 ≠ 空。** 第一版把 Redis 异常一律当 0，理由是「额外保护不该
 *   成为新故障点」。但闸门只在启动时跑一次：跳过之后 Redis 恢复、依赖探针
 *   变绿，没有任何东西会重做这次检查，遗留层就永远没人消费。所以现在只有
 *   key 不存在（`none`）才算 0；连接/权限/读取异常以及不认识的 key 类型都拒启，
 *   交给编排器重启重试。
 * - **F3：Redis 空 ≠ 收敛。** 子 Run 停在 WAITING_APPROVAL / WAITING_INPUT 时，
 *   原作业已经完成并删除，队列里什么都没有，但 MySQL 里它仍是非终态；审批或
 *   应答之后恢复入队会被 `routeRunToQueue` 以越界拒绝。所以还要查权威账本：
 *   `runs` 里超出目标深度的**全部**非终态 Run（含入队失败后停在 QUEUED 的）。
 *
 * 顺序上它必须先于恢复扫描、cron、outbox 与消费者：拒启时不能已经产生副作用。
 *
 * 局限（写进 deployment.md）：这是**新镜像**的闸门。换回没有这道闸门的旧镜像时，
 * 必须在切换前由运维在外部做同样的两项检查，不能用「旧镜像启动不报错」代替。
 */

import { NON_TERMINAL_RUN_STATUSES } from '../domain/run/run-status.js';
import {
  assertNoStrandedLayers,
  MAX_PROBE_DEPTH,
  queueNamesToProbe,
  type RunQueueTopology,
} from '../infrastructure/redis/run-queue-topology.js';
import { RedisConfigError } from '../infrastructure/redis/errors.js';
import { resolveRunQueuePrefix } from '../infrastructure/redis/run-queue.js';

/** 过渡期宽松类型：redis / knex 是容器里的 JS 句柄。 */
type Loose = any;

/** BullMQ 会留下待消费作业的状态 key。 */
const PENDING_STATES = ['wait', 'paused', 'active', 'delayed', 'prioritized'] as const;

export class WorkerDrainGateError extends Error {
  readonly code = 'WORKER_DRAIN_GATE_REFUSED';
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'WorkerDrainGateError';
  }
}

/**
 * 数一个状态 key 里的作业。BullMQ 各状态的底层类型不同（wait/paused/active 是
 * list，delayed/prioritized 是 zset），而且跨版本改过，所以按实际类型来数。
 * 只有 `none`（key 不存在）算 0；其余一律抛错——**不能证明为空就不放行**。
 */
async function countStateKey(redis: Loose, queueName: string, key: string): Promise<number> {
  let type: string;
  let count: number;
  try {
    type = String(await redis.type(key));
    if (type === 'none') return 0;
    if (type === 'list') count = Number(await redis.llen(key));
    else if (type === 'zset') count = Number(await redis.zcard(key));
    else count = Number.NaN;
  } catch (err) {
    throw new WorkerDrainGateError(
      `refusing to start: cannot verify that Run queue ${queueName} is drained ` +
        `(Redis read failed: ${err instanceof Error ? err.message : String(err)})`,
      { cause: err },
    );
  }
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new WorkerDrainGateError(
      `refusing to start: cannot verify that Run queue ${queueName} is drained ` +
        `(unexpected Redis key type ${type} for ${key})`,
    );
  }
  return count;
}

/** 本拓扑**不服务**的队列 → 待消费作业数。读失败抛 {@link WorkerDrainGateError}。 */
export async function readUnservedQueueCounts(
  redis: Loose,
  topology: RunQueueTopology,
  rawPrefix?: string | null,
): Promise<Record<string, number>> {
  const prefix = resolveRunQueuePrefix(rawPrefix);
  const served = new Set(topology.layers.map((l) => l.queueName));
  const base = topology.layers.find((l) => l.depth === 0)?.queueName;
  const counts: Record<string, number> = {};
  for (const queueName of queueNamesToProbe(MAX_PROBE_DEPTH, base)) {
    if (served.has(queueName)) continue;
    let total = 0;
    for (const state of PENDING_STATES) {
      total += await countStateKey(redis, queueName, `${prefix}:${queueName}:${state}`);
    }
    counts[queueName] = total;
  }
  return counts;
}

/**
 * 权威账本里超出目标深度的非终态 Run，按深度计数。走 `idx_runs_status`，
 * 不按租户过滤——闸门关心的是整个 Worker 拓扑，不是某个 owner。
 */
export async function readStrandedRunCounts(
  knex: Loose,
  maxDepth: number,
): Promise<Record<number, number>> {
  let rows: Loose[];
  try {
    rows = await knex('runs')
      .whereIn('status', [...NON_TERMINAL_RUN_STATUSES])
      .where('subagent_depth', '>', maxDepth)
      .groupBy('subagent_depth')
      .select('subagent_depth')
      .count({ n: '*' });
  } catch (err) {
    throw new WorkerDrainGateError(
      `refusing to start: cannot verify that no non-terminal runs deeper than ${maxDepth} remain ` +
        `(MySQL read failed: ${err instanceof Error ? err.message : String(err)})`,
      { cause: err },
    );
  }
  const counts: Record<number, number> = {};
  for (const row of rows ?? []) {
    const depth = Number(row?.subagent_depth);
    const n = Number(row?.n);
    if (Number.isInteger(depth) && Number.isFinite(n) && n > 0) counts[depth] = n;
  }
  return counts;
}

/**
 * 两项检查都过才放行。先查账本再查队列无所谓先后；两边的存量一起报，
 * 让运维一次看清还要等什么。
 */
export async function assertWorkerTopologyDrained(deps: {
  readonly redis: Loose;
  readonly knex: Loose;
  readonly topology: RunQueueTopology;
  readonly queuePrefix?: string | null;
}): Promise<void> {
  const { topology } = deps;
  const queueCounts = await readUnservedQueueCounts(deps.redis, topology, deps.queuePrefix);
  const runCounts = await readStrandedRunCounts(deps.knex, topology.maxDepth);

  const runProblems = Object.entries(runCounts).map(([depth, n]) => `depth ${depth}=${n}`);
  let queueProblem: string | null = null;
  try {
    assertNoStrandedLayers(topology, queueCounts);
  } catch (err) {
    if (!(err instanceof RedisConfigError)) throw err;
    queueProblem = err.message;
  }
  if (runProblems.length === 0 && queueProblem === null) return;

  const parts: string[] = [];
  if (queueProblem !== null) parts.push(queueProblem);
  if (runProblems.length > 0) {
    parts.push(
      `refusing to start: non-terminal runs deeper than AGENT_SUBAGENT_MAX_DEPTH=${topology.maxDepth} ` +
        `still exist in MySQL: ${runProblems.join(', ')} (e.g. WAITING_APPROVAL / WAITING_INPUT children ` +
        'would be rejected when they resume). Let them finish or restore the previous depth first.',
    );
  }
  throw new WorkerDrainGateError(parts.join(' '));
}
