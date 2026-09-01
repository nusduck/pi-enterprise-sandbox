/**
 * 按 Run 提供的**应用层服务**——给那些注册在进程级、却必须按 Run 干活的插件用。
 *
 * ## 为什么需要这一层
 *
 * DSH 的 provider 插件是 boot 时注册一次的单例（`ctx.subagents.registerProvider`
 * 就发生在 boot），而它要用的东西（MySQL 事务、BullMQ 队列、租户 scope）都是
 * 按 Run 的。两条不能互相迁就：
 * - 把服务放到插件的构造参数上 → 所有 Run 共用一份，A 的子 Run 记到 B 名下；
 * - 每 Run 重新注册一次 provider → 那是把进程级组合层当成每 Run 装配来用，
 *   正是 ADR 0009 D3 拒绝 preset 的同一条理由。
 *
 * 所以用与 `exec-rpc.ts` 完全相同的机制：**ALS**。turn 整个包在
 * `runWithExecRpc` / `runWithRunServices` 的作用域里，插件在**调用时**取本 Run 的那份。
 *
 * 这也解释了为什么 ADR 0009 D3 把「ALS 作用域必须罩住所有工具执行」写成硬约束
 * ——不止 fs/shell/jobs 靠它，子 Agent 这类也靠它。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { DurableSubagentQueue, DurableSubagentStore } from './durable-subagent.js';

export interface RunServices {
  /** 子 Agent 的 durable 队列与结果存储（ADR 0009 D6 / 计划 H5）。 */
  readonly subagents?: {
    readonly queue: DurableSubagentQueue;
    readonly store: DurableSubagentStore;
    readonly tenant?: { readonly orgId: string; readonly userId: string };
    readonly parentRunId?: string;
  };
}

const runServicesAls = new AsyncLocalStorage<RunServices>();

/** 在本 Run 的服务作用域里跑一段。turn 结束前不得离开这个作用域。 */
export function runWithRunServices<T>(services: RunServices, fn: () => T): T {
  return runServicesAls.run(services, fn);
}

/**
 * 取本 Run 的服务；不在任何 Run 作用域里时返回 `undefined`。
 *
 * **调用方必须处理 undefined**，而且处理方式要按用途选：
 * 单测里没有 Run 作用域，回退到进程内实现是合理的；生产路径上拿不到本 Run 的
 * 服务却默默用进程内实现，就是把 durable 面悄悄降级成内存面——那种降级
 * 不会有任何人报错。
 */
export function currentRunServices(): RunServices | undefined {
  return runServicesAls.getStore();
}
