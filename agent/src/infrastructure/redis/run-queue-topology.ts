/**
 * Run 队列的**分层拓扑**：按 `subagent_depth` 一层一个 BullMQ 队列，每层有
 * 专属的消费槽（ADR 0012）。
 *
 * 为什么需要它（2026-09-16 审查 R3）：父子 Run 以前共用同一个队列、同一批
 * 消费槽。父任务发起子任务后**前台等待**结果（`backgroundMode: 'one-shot'`
 * 的出厂行为），自己不让出槽位；于是 N 个父 Run 占满 N 个槽之后，它们的子
 * Run 只能排队，而父 Run 又在等子 Run——只能靠父任务取消/超时或临时加消费者
 * 打破。把并发从 4 调到任意有限值都有同样的饱和条件，这不是容量问题。
 *
 * 这里选的方案：**有限深度 + 每层保留槽**。理由与代价写在 ADR 0012 里，
 * 一句话是：当前只有 `WAITING_APPROVAL` / `WAITING_INPUT` 两种停泊语义，
 * 没有通用的子任务 park/replay 协议；复用前两者会污染对外状态，新增完整
 * park/replay 涉及状态迁移、持久化 continuation 与模型重放。本次先保住
 * 「队列一定能推进」这条性质。
 *
 * 不变量：
 * - 每个**允许的深度**至少有一个专属消费槽，根任务拿不到深层的保留槽；
 * - 并发总预算是**显式**的一个数字，不按层翻倍；
 * - 路由只看 MySQL 里的权威 `subagent_depth`，不看模型或调用方给的队列名。
 *
 * 这个文件是纯函数，不连 Redis、不依赖 bullmq——拓扑判定在单测里就能全覆盖。
 */

import { AGENT_RUNS_QUEUE_NAME } from './constants.js';
import { RedisConfigError } from './errors.js';

/**
 * 深度 → 队列名。
 *
 * 深度 0 沿用 `agent-runs`：那既是历史名字，也让「旧队列里的存量作业」在
 * 升级后仍然有消费者，不需要先排空（见 {@link assertNoStrandedLayers} 对
 * 反向情况的处理）。
 */
export function runQueueNameForDepth(depth: number, base = AGENT_RUNS_QUEUE_NAME): string {
  if (!Number.isInteger(depth) || depth < 0) {
    throw new RedisConfigError(`subagent depth must be a non-negative integer, got ${String(depth)}`);
  }
  const root = String(base ?? '').trim() || AGENT_RUNS_QUEUE_NAME;
  return depth === 0 ? root : `${root}-d${depth}`;
}

/** 一层的消费计划。 */
export interface RunQueueLayer {
  readonly depth: number;
  readonly queueName: string;
  /** 这一层的 BullMQ Worker 并发度。恒 ≥ 1。 */
  readonly concurrency: number;
}

export interface RunQueueTopology {
  /** 允许的最大子任务深度（与 `AGENT_SUBAGENT_MAX_DEPTH` 同源）。 */
  readonly maxDepth: number;
  /**
   * 全部层的并发之和——**显式**的总预算，不随层数翻倍。
   * 只有消费者（Worker）才有这个数；纯投递方（HTTP 进程）为 `null`。
   */
  readonly totalConcurrency: number | null;
  readonly layers: readonly RunQueueLayer[];
}

export interface PlanRunQueueTopologyInput {
  /** 允许的最大深度。0 表示不允许子任务，只有一层。 */
  readonly maxDepth: number;
  /** 深度 0 的队列名（`AGENT_RUNS_QUEUE_NAME` 覆盖）；深层由它派生。 */
  readonly baseQueueName?: string;
}

/**
 * **路由拓扑**：有哪些层、各自叫什么名字。投递方与消费方都用它。
 *
 * 刻意**不含并发**：HTTP 进程只投递，不消费，不该因为一个消费者才用得上的
 * 变量（`AGENT_WORKER_CONCURRENCY`）而起不来——这正是 2026-09-16 第一次接线
 * 时踩到的坑：把槽位预算校验放进共享路径，HTTP 面直接拒启。
 */
export function planRunQueueTopology(input: PlanRunQueueTopologyInput): RunQueueTopology {
  const { maxDepth } = input;
  if (!Number.isInteger(maxDepth) || maxDepth < 0) {
    throw new RedisConfigError(
      `AGENT_SUBAGENT_MAX_DEPTH must be a non-negative integer, got ${String(maxDepth)}`,
    );
  }
  const base = input.baseQueueName;
  const layers: RunQueueLayer[] = [];
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    // 并发是消费者侧的事，路由拓扑里先占位为 0；`allocateReservedSlots()`
    // 才会填真值，所以任何拿它当并发用的代码都会立刻露馅（0 个消费者）。
    layers.push({ depth, queueName: runQueueNameForDepth(depth, base), concurrency: 0 });
  }
  return { maxDepth, totalConcurrency: null, layers };
}

/**
 * **消费拓扑**：把总预算分配到各层——每个深度 ≥ 1 的层恰好保留 1 个槽，
 * 剩下的全给深度 0（根任务）。只有 Worker 调用它。
 *
 * 为什么深层只给 1 个：保留槽的作用是「保证队列能推进」，不是「让深层跑得
 * 快」。多给一个槽就要从根任务身上扣一个，而根任务才是吞吐的主体。
 *
 * 预算不足（`totalConcurrency < maxDepth + 1`）时**抛错**，不悄悄把某一层
 * 降成 0 个消费者——那等于把饥饿从「父等子」换成「子永远没人消费」。
 */
export function allocateReservedSlots(
  routing: RunQueueTopology,
  totalConcurrency: number,
): RunQueueTopology {
  const { maxDepth } = routing;
  if (!Number.isInteger(totalConcurrency) || totalConcurrency < 1) {
    throw new RedisConfigError(
      `AGENT_WORKER_CONCURRENCY must be a positive integer, got ${String(totalConcurrency)}`,
    );
  }
  const layerCount = maxDepth + 1;
  if (totalConcurrency < layerCount) {
    throw new RedisConfigError(
      `AGENT_WORKER_CONCURRENCY must be at least ${layerCount} so every subagent depth ` +
        `0..${maxDepth} keeps a reserved consumer slot; got ${totalConcurrency}. ` +
        'Raise the budget or lower AGENT_SUBAGENT_MAX_DEPTH.',
    );
  }
  const layers = routing.layers.map((layer) => ({
    ...layer,
    concurrency: layer.depth === 0 ? totalConcurrency - maxDepth : 1,
  }));
  return { maxDepth, totalConcurrency, layers };
}

/** 拓扑里有没有这个深度的层。 */
export function layerForDepth(
  topology: RunQueueTopology,
  depth: number,
): RunQueueLayer | undefined {
  return topology.layers.find((layer) => layer.depth === depth);
}

/**
 * 深度 → 目的地队列名，**越界即拒绝**。
 *
 * 深度超过拓扑允许的最大值时不「夹到最深那层」——那会让一个本不该存在的
 * Run 挤占保留槽，而且掩盖了上游深度校验的漏洞。`SubagentSpawnService`
 * 在事务里已经拒绝超限的 spawn，这里是第二道、也是路由这一侧的最后一道。
 */
export function routeRunToQueue(topology: RunQueueTopology, depth: number): string {
  const layer = layerForDepth(topology, depth);
  if (layer === undefined) {
    throw new RedisConfigError(
      `run has subagent depth ${String(depth)} but the worker topology only serves 0..${topology.maxDepth}`,
    );
  }
  return layer.queueName;
}

/**
 * 升级 / 回滚的安全闸门：**配置不服务的层里还有存量作业就拒绝启动**。
 *
 * 升级方向不需要排空——深度 0 沿用 `agent-runs`，旧队列里的存量（含升级前
 * 按旧规则投进去的子 Run）仍然由深度 0 的消费者处理，处理器本身与深度无关。
 *
 * 回滚方向才是危险的：换回旧镜像后没有人消费 `agent-runs-d1/d2`，里面的
 * 作业会永远躺着。所以这里在启动时反向检查一遍——把配置**不**服务的深度
 * 对应的队列都数一遍，有存量就 fail-closed，并在错误里点名队列与条数，
 * 让运维知道要先排空哪一个，而不是让作业静默消失。
 *
 * @param counts 读取到的 `{ queueName: pendingJobCount }`，由调用方用真实
 *   BullMQ 队列查（`waiting + active + delayed + prioritized`）。
 */
export function assertNoStrandedLayers(
  topology: RunQueueTopology,
  counts: Readonly<Record<string, number>>,
): void {
  const served = new Set(topology.layers.map((layer) => layer.queueName));
  const stranded = Object.entries(counts)
    .filter(([queueName, count]) => !served.has(queueName) && count > 0)
    .map(([queueName, count]) => `${queueName}=${count}`);
  if (stranded.length > 0) {
    throw new RedisConfigError(
      `refusing to start: these Run queues still hold jobs but no configured layer consumes them: ` +
        `${stranded.join(', ')}. Drain them (or restore the matching AGENT_SUBAGENT_MAX_DEPTH) first.`,
    );
  }
}

/**
 * 启动时该扫哪些队列找存量。覆盖 `0..probeDepth`，即使拓扑只服务其中一部分——
 * 正是为了发现「配置缩小了、但深层队列里还有东西」。
 */
export function queueNamesToProbe(
  probeDepth: number,
  base = AGENT_RUNS_QUEUE_NAME,
): readonly string[] {
  const names: string[] = [];
  for (let depth = 0; depth <= Math.max(0, probeDepth); depth += 1) {
    names.push(runQueueNameForDepth(depth, base));
  }
  return names;
}

/**
 * 探测深度的上界：即使当前配置只服务 0..maxDepth，也要往上多看几层，
 * 才能发现「配置刚被调小、深层队列里还有存量」。
 */
export const MAX_PROBE_DEPTH = 8;
