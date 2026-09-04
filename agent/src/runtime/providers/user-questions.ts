import { AsyncLocalStorage } from 'node:async_hooks';
import { currentToolExecutionContext } from './tool-execution-context.js';

export interface UserQuestionRequest {
  readonly questions: readonly unknown[];
  readonly agent?: unknown;
  readonly signal?: AbortSignal;
}

export interface InteractionRequester {
  (request: UserQuestionRequest & {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly args: unknown;
  }): Promise<unknown>;
}

/**
 * Thrown after the durable WAITING_INPUT row is committed. DSH must not
 * fabricate an answers value; the tool ledger must not record this throw as
 * a FAILED execution — that 409s the later human response.
 */
export class DurableInteractionPendingError extends Error {
  constructor() {
    super('user interaction pending');
    this.name = 'DurableInteractionPendingError';
  }
}

export function isDurableInteractionPendingError(error: unknown): boolean {
  if (error instanceof DurableInteractionPendingError) return true;
  return error instanceof Error && error.message === 'user interaction pending';
}

const requesterAls = new AsyncLocalStorage<InteractionRequester | null>();
const installedContexts = new WeakSet<object>();

export function runWithInteractionRequester<T>(
  requester: InteractionRequester | undefined,
  fn: () => T,
): T {
  return requesterAls.run(requester ?? null, fn);
}

export function currentInteractionRequester(): InteractionRequester | undefined {
  return requesterAls.getStore() ?? undefined;
}

/**
 * Bridge the DSH process-wide question service to the current Run. The
 * durable request is deliberately resolved from ALS at ask time; registering
 * one provider per Run would let concurrent scopes overwrite each other.
 */
export function installUserQuestionBridge(ctx: Record<string, any>): void {
  if (installedContexts.has(ctx)) return;
  const service = typeof ctx.get === 'function' ? ctx.get('userQuestions') : undefined;
  if (!service || typeof service.registerProvider !== 'function') return;

  service.registerProvider({
    ask: async (request: UserQuestionRequest) => {
      const requester = currentInteractionRequester();
      const execution = currentToolExecutionContext();
      if (!requester || !execution) {
        throw new Error('user interaction is unavailable outside an active Run tool execution');
      }
      return requester({
        ...request,
        toolCallId: execution.callId,
        toolName: execution.toolName,
        args: execution.args,
      });
    },
  });
  installedContexts.add(ctx);
}
