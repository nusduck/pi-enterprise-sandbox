import { AsyncLocalStorage } from 'node:async_hooks';

export interface ToolExecutionContext {
  readonly callId: string;
  readonly toolName: string;
  readonly args: unknown;
}

const toolExecutionAls = new AsyncLocalStorage<ToolExecutionContext>();

/**
 * 本次工具调用「结果未知」的标记（2026-09-17，STATUS G2）。
 *
 * 执行面在请求**可能已送达**之后断开（连接被重置、传输截止到期），调用方拿不到
 * 结果，但命令可能已经部分执行。这件事只有 RPC 客户端知道，而决定账本记什么的
 * 是 `tools/execute` 的包装层——DSH 把工具异常序列化成结果时只给自家
 * `HarnessError` 保留错误码，靠结果文本判断又不可靠。所以经本次调用的 ALS 上下文
 * 传递，键是上下文对象本身：不改变上下文的形状，也不会串到别的调用。
 */
const outcomeUnknown = new WeakMap<ToolExecutionContext, string>();

export function runWithToolExecutionContext<T>(
  context: ToolExecutionContext,
  fn: () => T,
): T {
  return toolExecutionAls.run(context, fn);
}

export function currentToolExecutionContext(): ToolExecutionContext | undefined {
  return toolExecutionAls.getStore();
}

/** 把当前工具调用标为结果未知；不在工具调用内时是空操作。首个原因生效。 */
export function markCurrentToolOutcomeUnknown(reason: string): void {
  const context = toolExecutionAls.getStore();
  if (context === undefined || outcomeUnknown.has(context)) return;
  outcomeUnknown.set(context, reason);
}

/** 这次调用是否被标为结果未知；返回原因。 */
export function toolOutcomeUnknownReason(context: ToolExecutionContext): string | undefined {
  return outcomeUnknown.get(context);
}
