/**
 * 分层 Run 队列的装配与路由（ADR 0012 / 审查 R3）。
 *
 * 从 `container.ts` 抽出来，不是为了「模块更多」，而是因为这一块有自己的
 * 完整职责：**决定一个 Run 该进哪个队列**。判定规则只有一条——按 MySQL 里
 * 的权威 `subagent_depth` 选层；调用方（包括模型）给的队列名一律不看。
 *
 * 唯一 enqueue 入口的意义：普通创建、cron、子任务、审批/交互恢复、失败恢复
 * 五条路径全都经过 `ServiceContainer.createRunQueueAdapter()`，所以规则写在
 * 这一处就覆盖了全部；`runs.queue_name` 也从同一个函数取，账本记的和实际
 * 投递的目的地不会分叉。
 */

import {
  layerForDepth,
  routeRunToQueue,
  type RunQueueTopology,
} from '../infrastructure/redis/run-queue-topology.js';
import { MAX_SUBAGENT_DEPTH } from '../infrastructure/dsh/subagent-constants.js';

/** 过渡期宽松类型：容器装配的对象几乎都还是 JS。 */
type Loose = any;

type EnvLike = NodeJS.ProcessEnv | Record<string, string | undefined>;

/** Worker 默认并发总预算。分层之后它是**全部层之和**，不是每层各一份。 */
export const DEFAULT_AGENT_WORKER_CONCURRENCY = 4;

function positiveInt(raw: unknown, fallback: number): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** `AGENT_SUBAGENT_MAX_DEPTH`；与 `SubagentSpawnService` 读同一个变量、同一个默认值。 */
export function resolveSubagentMaxDepth(env: EnvLike): number {
  const raw = Number(env.AGENT_SUBAGENT_MAX_DEPTH);
  return Number.isInteger(raw) && raw >= 0 ? raw : MAX_SUBAGENT_DEPTH;
}

/** `AGENT_WORKER_CONCURRENCY`——分层之后这是总预算。 */
export function resolveWorkerConcurrency(env: EnvLike): number {
  return positiveInt(env.AGENT_WORKER_CONCURRENCY, DEFAULT_AGENT_WORKER_CONCURRENCY);
}

/**
 * 读这个 Run 的权威深度。
 *
 * 为什么要多打一次库：enqueue 的调用方（recovery、approval、interaction）
 * 手上只有 `{ runId, orgId, traceId }`，没有深度。与其让五条路径各自去补一个
 * 可能过期、可能被伪造的字段，不如在唯一的投递点读一次权威值——enqueue 是
 * 低频操作（每个 Run 生命周期里个位数次），一条按主键的 SELECT 不是热点。
 *
 * 查不到行时**不默认 0**：那会把一个未知的 Run 投进根队列，抢走根任务的槽。
 */
export async function resolveRunDepth(
  knex: Loose,
  ref: { runId?: unknown; orgId?: unknown },
): Promise<number> {
  const runId = String(ref?.runId ?? '');
  const orgId = String(ref?.orgId ?? '');
  if (!runId || !orgId) {
    throw new Error('run queue routing requires runId and orgId');
  }
  if (!knex) throw new Error('ServiceContainer MySQL not started');
  const row = await knex('tbl_agsvc_runs')
    .select('subagent_depth')
    .where({ run_id: runId, org_id: orgId })
    .first();
  if (!row) {
    throw new Error(`run ${runId} not found; refusing to guess its queue depth`);
  }
  const depth = Number(row.subagent_depth ?? 0);
  if (!Number.isInteger(depth) || depth < 0) {
    throw new Error(`run ${runId} has an invalid subagent_depth`);
  }
  return depth;
}

export interface RunQueueAdapter {
  readonly topology: RunQueueTopology;
  queueNameFor(ref: { runId?: unknown; orgId?: unknown }): Promise<string>;
  enqueue(ref: Loose, options?: Loose): Promise<unknown>;
}

/**
 * 建投递适配器。`handles` 是 `depth -> { queue }`，由容器在启动时按拓扑建好。
 */
export function buildRunQueueAdapter(deps: {
  handles: Map<number, Loose>;
  topology: RunQueueTopology;
  knex: Loose;
  enqueueRunJob?: (queue: Loose, ref: Loose, options?: Loose) => Promise<unknown>;
}): RunQueueAdapter {
  const { handles, topology, knex } = deps;
  const queueFor = (depth: number): Loose => {
    // 越界深度在这里抛错，不夹到最深那层——见 routeRunToQueue 的注释。
    routeRunToQueue(topology, depth);
    const layer = layerForDepth(topology, depth);
    const handle = layer === undefined ? undefined : handles.get(layer.depth);
    if (!handle?.queue) {
      throw new Error(`ServiceContainer has no run queue for subagent depth ${depth}`);
    }
    return handle.queue;
  };
  return {
    topology,
    async queueNameFor(ref) {
      return routeRunToQueue(topology, await resolveRunDepth(knex, ref));
    },
    async enqueue(ref, options) {
      const enqueueRunJob =
        deps.enqueueRunJob ??
        (await import('../infrastructure/redis/run-queue.js')).enqueueRunJob;
      const queue = queueFor(await resolveRunDepth(knex, ref));
      return enqueueRunJob(queue, ref, options);
    },
  };
}

/** 从环境算出**路由**拓扑，并按拓扑建每一层的 BullMQ Queue 句柄。 */
export function startLayeredRunQueues(deps: {
  env: EnvLike;
  createRunQueue: Loose;
  planRunQueueTopology: (input: Loose) => RunQueueTopology;
  redisUrl: string;
  password?: string | undefined;
}): { topology: RunQueueTopology; handles: Map<number, Loose> } {
  const { env } = deps;
  const base = env.AGENT_RUNS_QUEUE_NAME;
  const prefix = env.AGENT_RUN_QUEUE_PREFIX || undefined;
  // 只算**路由**拓扑：有哪些层、叫什么。并发预算是消费者侧的事，
  // 由 `agent-worker` 用 `allocateReservedSlots()` 另外算——HTTP 进程只投递，
  // 不该因为一个它用不上的变量而起不来。
  const topology = deps.planRunQueueTopology({
    maxDepth: resolveSubagentMaxDepth(env),
    ...(base ? { baseQueueName: base } : {}),
  });
  const handles = new Map<number, Loose>();
  for (const layer of topology.layers) {
    handles.set(
      layer.depth,
      deps.createRunQueue(deps.redisUrl, {
        queueName: layer.queueName,
        ...(prefix !== undefined ? { prefix } : {}),
        ...(deps.password !== undefined ? { password: deps.password } : {}),
      }),
    );
  }
  return { topology, handles };
}

/**
 * 关掉每一层的队列句柄。逐个尽力而为，一个失败不阻断其余——与容器里其它
 * 依赖的拆卸纪律一致：拆卸阶段收集错误，最后一起报。
 */
export async function destroyLayeredRunQueues(
  handles: Map<number, Loose>,
  destroy: (handle: Loose) => Promise<unknown>,
): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const handle of handles.values()) {
    try {
      await destroy(handle);
    } catch (err) {
      errors.push(err);
    }
  }
  handles.clear();
  return errors;
}
