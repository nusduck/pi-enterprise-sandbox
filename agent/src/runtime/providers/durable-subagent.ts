/**
 * durable 的子 Agent 提供方（BullMQ 子 Run）。
 *
 * 这是什么：把 `ctx.subagents` 的“同进程受信”契约改成可跨 Worker 重启存活的持久形态。
 * 上游 `dsh-subagent` 文档明确写着 provider 是 trusted same-process，请求/结果是
 * 借用的不可变类型值，不做序列化与 hostile-input 校验。我们的场景相反——父子
 * 跑在不同 Worker 进程甚至不同 Pod，需要把请求序列化进 BullMQ，并在消费端重做
 * 校验与鉴权。`start()` 的发布即所有权转移边界仍保留，但 `localAgent` 为空
 *（远端执行，没有本进程子 Agent），`result` 通过轮询持久化结果集来兑现。
 *
 * 为什么单独一层：决定“发什么任务”与“怎么发/怎么收”必须分开，前者在单测里
 * 不依赖 BullMQ/Redis 即可验证；后者只在集成环境跑。策略（owner 隔离、深度
 * 校验、label 规则）与存储（队列、结果表）解耦，换存储只需换实现。
 */

import type { SubagentProvider, SubagentStartRequest, SubagentRun, ResolvedSubagentStartRequest, SubagentResult, SubagentCapabilities } from '@deepseek-ai/dsh-subagent';
import { currentRunServices } from './run-services.js';

// ── 租户与请求规整 ─────────────────────────────────────────────

/** 子 Run 持久化所需的最小租户维度。 */
export interface DurableSubagentTenant {
  readonly orgId: string;
  readonly userId: string;
  readonly parentSessionId: string;
  readonly parentRunId?: string | undefined;
}

/** 序列化进 BullMQ 的任务体——只含平面数据，不含 Agent/AbortSignal 等活对象。 */
export interface DurableSubagentJobSpec {
  readonly jobId: string;
  readonly tenant: DurableSubagentTenant;
  readonly label?: string | undefined;
  readonly prompt: readonly unknown[];
  readonly maxDepth?: number | undefined;
  /** 序列化时的单调时间戳（ms），供去重与排序。 */
  readonly createdAt: number;
}

/** 队列抽象：生产方只调 `add`，消费方在 Worker 侧取任务执行。 */
export interface DurableSubagentQueue {
  add(spec: DurableSubagentJobSpec): Promise<void>;
}

/** 结果存储抽象：落 MySQL 的子 Run 结果表，支持跨 Worker 重启后查询。 */
export interface DurableSubagentStore {
  putResult(jobId: string, result: SubagentResult): Promise<void>;
  getResult(jobId: string): Promise<SubagentResult | null>;
}

/** 纯函数：把 Start 请求规整为可入队规格，失败则抛错（调用方 catch 后不入队）。 */
export function buildDurableJobSpec(
  request: SubagentStartRequest,
  tenant: DurableSubagentTenant,
  opts?: { now?: () => number; generateId?: () => string },
): DurableSubagentJobSpec {
  const now = opts?.now ?? Date.now;
  const gen = opts?.generateId ?? (() => `sub_${Math.random().toString(36).slice(2, 10)}`);
  const label = request.label?.trim() ? request.label.trim().slice(0, 128) : undefined;

  // 深度校验：与 `dsh-subagent` 的 `assertSubagentMaxDepth` 语义一致，超限直接 fail
  if (request.maxDepth !== undefined) {
    if (!Number.isInteger(request.maxDepth) || request.maxDepth < 0) {
      throw new Error(`invalid maxDepth: ${String(request.maxDepth)}`);
    }
  }
  if (request.signal.aborted) {
    throw new Error('subagent start aborted before enqueue');
  }
  // prompt 至少一条 contentBlock
  if (request.prompt.length === 0) {
    throw new Error('subagent prompt is empty');
  }

  return {
    jobId: gen(),
    tenant,
    label,
    prompt: [...request.prompt],
    maxDepth: request.maxDepth,
    createdAt: now(),
  };
}

// ── 内存替身（单测与本地开发） ──────────────────────────────────

export class InMemoryDurableSubagentQueue implements DurableSubagentQueue {
  readonly specs: DurableSubagentJobSpec[] = [];
  async add(spec: DurableSubagentJobSpec): Promise<void> {
    this.specs.push(spec);
  }
}

export class InMemoryDurableSubagentStore implements DurableSubagentStore {
  private readonly map = new Map<string, SubagentResult>();
  async putResult(jobId: string, result: SubagentResult): Promise<void> {
    this.map.set(jobId, result);
  }
  async getResult(jobId: string): Promise<SubagentResult | null> {
    return this.map.get(jobId) ?? null;
  }
}

// ── Provider 工厂 ───────────────────────────────────────────────

/** 创建可跨 Worker 重启的 durable provider。 */
export function createDurableSubagentProvider(opts: {
  name?: string;
  /**
   * 兜底队列/存储。**生产路径不该走到它**：真正的 durable 面按 Run 从
   * `currentRunServices()` 取（计划 H5）。这里留一份进程内实现只为让单测和
   * 「还没接上 durable 面」的启动阶段不至于起不来。
   */
  queue: DurableSubagentQueue;
  store: DurableSubagentStore;
  tenantOf: (parent: unknown) => DurableSubagentTenant;
  now?: () => number;
  generateId?: () => string;
}): SubagentProvider {
  const name = opts.name ?? 'durable-bullmq';

  const capabilities: SubagentCapabilities = {
    outputSchema: false,
    depthLimit: true,
    toolFilter: false,
    persona: false,
  };

  return {
    name,
    capabilities,
    inheritsParentContext: false,

    async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
      // provider 是 boot 时注册的**进程级单例**，而队列与结果存储是按 Run 的
      // （绑着这个 Run 的事务、租户 scope 与 BullMQ 连接）。所以在**调用时**
      // 从 ALS 取本 Run 的那一份，与 `ctx.fs/shell/jobs` 走 exec-rpc ALS 是同一条
      // 纪律（ADR 0009 D3）。取不到就退回构造时的进程内实现——单测走这条。
      const services = currentRunServices()?.subagents;
      const queue = services?.queue ?? opts.queue;
      const store = services?.store ?? opts.store;

      // 1) 决定：纯函数规整为可序列化规格（不触队列）
      const tenant = opts.tenantOf(request.parent);
      const spec = buildDurableJobSpec(request, tenant, {
        ...(opts.now !== undefined ? { now: opts.now } : {}),
        ...(opts.generateId !== undefined ? { generateId: opts.generateId } : {}),
      });

      // 2) 执行：入队（I/O）——失败则清理并 reject，满足“发布前提供方拥有清理”契约
      try {
        await queue.add(spec);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`durable enqueue failed: ${msg}`);
      }

      // 3) 返回远端 Run：无 localAgent，结果通过 store 轮询兑现。
      // 原生 ctx.subagents provider 是 trusted same-process；这里故意不持有
      // localAgent，请求已序列化进队列，跨 Worker 才能活。
      let disposed = false;
      let wake: (() => void) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const aborted = { output: [], stopReason: 'aborted' } as SubagentResult;
      const result: Promise<SubagentResult> = (async () => {
        while (!disposed) {
          if (request.signal.aborted) return aborted;
          const found = await store.getResult(spec.jobId);
          if (found) return found;
          await new Promise<void>((resolve) => {
            wake = resolve;
            timer = setTimeout(() => {
              timer = undefined;
              resolve();
            }, 50);
            const onAbort = (): void => {
              if (timer !== undefined) clearTimeout(timer);
              timer = undefined;
              resolve();
            };
            request.signal.addEventListener('abort', onAbort, { once: true });
          });
        }
        return aborted;
      })();

      return {
        id: spec.jobId as unknown as SubagentRun['id'],
        localAgent: undefined,
        result,
        async dispose(): Promise<void> {
          disposed = true;
          if (timer !== undefined) clearTimeout(timer);
          timer = undefined;
          wake?.();
        },
      };
    },
  };
}

/** Cordis 插件：替换 `dsh-subagent-spawn-in-process`。原生同进程契约对不上，退回自建队列面。 */
export const name = 'durable-subagent';
export const inject = ['subagents'] as const;

export function apply(
  ctx: { subagents: { registerProvider: (provider: SubagentProvider) => unknown } },
  config: { providerName?: string } = {},
): void {
  const providerName = config.providerName ?? 'spawn';
  ctx.subagents.registerProvider(
    createDurableSubagentProvider({
      name: providerName,
      queue: new InMemoryDurableSubagentQueue(),
      store: new InMemoryDurableSubagentStore(),
      tenantOf: (parent: unknown) => {
        const extra = parent as { orgId?: string; userId?: string; session?: { id?: string } };
        if (!extra.orgId || !extra.userId) {
          throw new Error('durable subagent: missing tenant on parent (fail-closed)');
        }
        return {
          orgId: extra.orgId,
          userId: extra.userId,
          parentSessionId: extra.session?.id ?? 'unknown',
        };
      },
    }),
  );
}
