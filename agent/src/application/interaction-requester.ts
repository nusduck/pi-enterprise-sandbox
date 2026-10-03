/**
 * Application 层的 ask_user 持久化工厂：把一次 DSH ask_user 请求写成一条
 * durable WAITING_INPUT 悬挂（经 recorder.requestInteraction 落库），再抛
 * `DurableInteractionPendingError` 让 executor 停下来等人工回答。
 *
 * 消歧：`runtime/providers/user-questions.ts` 的 `InteractionRequester` 接口 +
 * ALS（`runWithInteractionRequester` / `currentInteractionRequester`）是 Run
 * 作用域的**调用 plumbing**（工具执行时从 ALS 取到本 Run 的 requester）；
 * 本文件的 `createInteractionRequester` 是该接口的**落库实现**，由
 * `dsh-run-executor` 装配后注入 ALS。
 */
import { DurableInteractionPendingError } from '../runtime/providers/user-questions.js';

interface AskUserRequest { readonly questions?: unknown; readonly toolCallId?: unknown; readonly toolName?: unknown; readonly args?: unknown; }
interface InteractionRecorder { requestInteraction(input: { readonly toolCallId: string; readonly toolName: string; readonly args: Record<string, unknown>; readonly interactionType: string; readonly title: string; readonly message: string; readonly options: string[]; readonly placeholder: null }): Promise<{ readonly durablePending: unknown }>; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

export function createInteractionRequester(input: {
  recorder: InteractionRecorder;
  runSuspensionPort: { onDurableInteractionPending: (pending: unknown) => void };
}) {
  return async (request: AskUserRequest): Promise<never> => {
    const questions: unknown = request?.questions;
    const first = Array.isArray(questions) && isRecord(questions[0]) ? questions[0] : undefined;
    if (!first || typeof first.question !== 'string' || !first.question.trim()) {
      throw new Error('ask_user_question requires a non-empty question');
    }
    const options = Array.isArray(first.options)
      ? first.options
          .map((option: unknown) => String(isRecord(option) ? option.label ?? '' : '').trim())
          .filter(Boolean)
          .slice(0, 20)
      : [];
    const interactionType = options.length >= 2 ? 'select' : 'input';
    if (!input.recorder) throw new Error('user interaction recorder is unavailable');
    const pending = await input.recorder.requestInteraction({
      toolCallId: String(request.toolCallId || ''),
      toolName: String(request.toolName || 'ask_user_question'),
      args: isRecord(request.args) ? request.args : {},
      interactionType,
      title: String(first.header || '').trim() || '需要输入',
      message: first.question,
      options,
      placeholder: null,
    });
    input.runSuspensionPort.onDurableInteractionPending(pending.durablePending);
    // The durable row is the result of this call. Throwing prevents DSH from
    // fabricating an answers value while the executor tears down the prompt.
    throw new DurableInteractionPendingError();
  };
}
