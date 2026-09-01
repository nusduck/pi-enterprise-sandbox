import { AsyncLocalStorage } from 'node:async_hooks';

export interface ToolExecutionContext {
  readonly callId: string;
  readonly toolName: string;
  readonly args: unknown;
}

const toolExecutionAls = new AsyncLocalStorage<ToolExecutionContext>();

export function runWithToolExecutionContext<T>(
  context: ToolExecutionContext,
  fn: () => T,
): T {
  return toolExecutionAls.run(context, fn);
}

export function currentToolExecutionContext(): ToolExecutionContext | undefined {
  return toolExecutionAls.getStore();
}
