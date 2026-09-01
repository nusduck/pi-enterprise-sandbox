/**
 * 把 runtime 侧的子 Agent 队列/存储抽象接到 `SubagentSpawnService`
 * （ADR 0009 D6 / 计划 H5）。
 *
 * ## 这里补的是第二条断掉的链
 *
 * `SubagentSpawnService` 做的是真正 durable 的事：一个事务里锁住父 Run、
 * 数活着的兄弟、建子 Run、入 BullMQ。而 2026-08-31 之前它挂在
 * `container-run-executor.ts` 的 `subagentSpawnPort` 上，而那个 port
 * **只喂给 `extensionBundleFactory`**——那条链早已终止在一个被
 * `runtime-factory.create()` 忽略的参数上（该文件自己的注释里就写着）。
 *
 * 与此同时 `durable-subagent.ts` 的 provider 用的是
 * `InMemoryDurableSubagentQueue` / `InMemoryDurableSubagentStore`：
 * Worker 一重启，子 Run 全丢——正是那个 provider 的文件头说要避免的事。
 *
 * 本模块把两端接上。
 */
import type {
  DurableSubagentJobSpec,
  DurableSubagentQueue,
  DurableSubagentStore,
} from '../runtime/providers/durable-subagent.js';

/** `SubagentSpawnService` 里本适配器用到的那部分。 */
interface SpawnServiceLike {
  spawn(input: {
    toolCallId: string;
    parentRunId: string;
    orgId: string;
    userId: string;
    task: string;
    label?: string | null;
    maxDepth?: number;
  }): Promise<unknown>;
  getStatuses(input: {
    parentRunId: string;
    orgId: string;
    userId: string;
    childRunIds?: readonly string[] | null;
  }): Promise<Array<{ runId: string; status: string; resultSummary?: string; statusReason?: unknown }>>;
}

/** 子 Run 到达终态时的状态集合——与 `RUN_STATUS` 的终态保持一致。 */
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT']);

/**
 * 队列实现：`add()` 转成一次 durable `spawn()`。
 *
 * `jobId` 由 runtime 侧生成，`spawn()` 生成的是子 `runId`。两者的对应关系记在
 * 本实例里——**每 Run 一个实例**，所以这份映射不会跨 Run 串。Worker 重启后
 * 映射会丢，那时的续跑靠的是 MySQL 里的父子谱系（`listChildren`），不是它。
 */
export class SpawnServiceSubagentQueue implements DurableSubagentQueue {
  readonly jobToRun = new Map<string, string>();

  constructor(
    private readonly service: SpawnServiceLike,
    private readonly parentRunId: string,
  ) {}

  async add(spec: DurableSubagentJobSpec): Promise<void> {
    const out = (await this.service.spawn({
      // 用 jobId 当幂等键：同一个 jobId 重复入队只会得到同一个子 Run
      // （`spawnIdempotencyKey(parentRunId, toolCallId)`）。
      toolCallId: spec.jobId,
      parentRunId: this.parentRunId,
      orgId: spec.tenant.orgId,
      userId: spec.tenant.userId,
      task: promptToTask(spec.prompt),
      label: spec.label ?? null,
      ...(spec.maxDepth !== undefined ? { maxDepth: spec.maxDepth } : {}),
    })) as { runId?: string; childRunId?: string } | null;
    const childRunId = String(out?.childRunId ?? out?.runId ?? '');
    if (childRunId !== '') this.jobToRun.set(spec.jobId, childRunId);
  }
}

/** 结果存储：查子 Run 的终态。 */
export class SpawnServiceSubagentStore implements DurableSubagentStore {
  constructor(
    private readonly service: SpawnServiceLike,
    private readonly parentRunId: string,
    private readonly tenant: { orgId: string; userId: string },
    private readonly queue: SpawnServiceSubagentQueue,
  ) {}

  async putResult(): Promise<void> {
    // 结果由子 Run 自己的 executor 写进 MySQL，父这边只读。
    // 留空实现而不是抛错：provider 的契约里有这个方法，但在 durable 形态下
    // 父进程没有写结果的权限，写了反而会和子 Run 的终态打架。
  }

  async getResult(jobId: string): Promise<never | null> {
    const childRunId = this.queue.jobToRun.get(jobId);
    if (childRunId === undefined) return null;
    const rows = await this.service.getStatuses({
      parentRunId: this.parentRunId,
      orgId: this.tenant.orgId,
      userId: this.tenant.userId,
      childRunIds: [childRunId],
    });
    const row = rows.find((r) => r.runId === childRunId);
    if (row === undefined || !TERMINAL.has(row.status)) return null;
    return {
      output: [{ type: 'text', text: row.resultSummary ?? `subagent ${row.status}` }],
      stopReason: row.status === 'SUCCEEDED' ? 'completed' : 'aborted',
    } as never;
  }
}

/** 子 Agent 的 prompt 是一串消息；durable 面要的是一段文本任务。 */
function promptToTask(prompt: readonly unknown[]): string {
  const parts: string[] = [];
  for (const message of prompt) {
    // dsh-tool-subagent supplies content blocks directly, while the durable
    // Run input seam historically supplied chat messages containing a
    // `content` array. Accept both wire shapes at this boundary; treating a
    // content block as a chat message silently produced an empty task.
    const value = message as { content?: unknown; text?: unknown };
    const content = Array.isArray(value?.content) || typeof value?.content === 'string'
      ? value.content
      : [message];
    if (typeof content === 'string') {
      if (content !== '') parts.push(content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const text = (block as { text?: unknown })?.text;
      if (typeof text === 'string' && text !== '') parts.push(text);
    }
  }
  return parts.join('\n').trim();
}

/**
 * 组装本 Run 的服务包，交给 `runWithRunServices` 的 ALS。
 *
 * 每 Run 一份：队列实例里存着 jobId → childRunId 的映射，做成进程级会串。
 */
export function buildRunServices(input: {
  spawnPort: SpawnServiceLike;
  parentRunId: string;
  tenant: { orgId: string; userId: string };
}): {
  subagents: {
    queue: DurableSubagentQueue;
    store: DurableSubagentStore;
    tenant: { orgId: string; userId: string };
    parentRunId: string;
  };
} {
  const queue = new SpawnServiceSubagentQueue(input.spawnPort, input.parentRunId);
  const store = new SpawnServiceSubagentStore(
    input.spawnPort,
    input.parentRunId,
    input.tenant,
    queue,
  );
  return {
    subagents: {
      queue,
      store,
      tenant: { ...input.tenant },
      parentRunId: input.parentRunId,
    },
  };
}
