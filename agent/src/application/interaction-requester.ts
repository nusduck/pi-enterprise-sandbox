/** Turn a DSH ask_user request into one durable WAITING_INPUT suspension. */
import { DurableInteractionPendingError } from '../runtime/providers/user-questions.js';

type Loose = any;

export function createInteractionRequester(input: {
  recorder: Loose;
  runSuspensionPort: { onDurableInteractionPending: (pending: unknown) => void };
}) {
  return async (request: Loose): Promise<never> => {
    const first = Array.isArray(request?.questions)
      ? (request.questions[0] as Record<string, any> | undefined)
      : undefined;
    if (!first || typeof first.question !== 'string' || !first.question.trim()) {
      throw new Error('ask_user_question requires a non-empty question');
    }
    const options = Array.isArray(first.options)
      ? first.options
          .map((option: Loose) => String(option?.label ?? '').trim())
          .filter(Boolean)
          .slice(0, 20)
      : [];
    const interactionType = options.length >= 2 ? 'select' : 'input';
    if (!input.recorder) throw new Error('user interaction recorder is unavailable');
    const pending = await input.recorder.requestInteraction({
      toolCallId: String(request.toolCallId || ''),
      toolName: String(request.toolName || 'ask_user_question'),
      args:
        request.args && typeof request.args === 'object' && !Array.isArray(request.args)
          ? request.args
          : {},
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
