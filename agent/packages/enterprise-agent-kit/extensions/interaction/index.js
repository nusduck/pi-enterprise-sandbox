import { randomUUID } from 'node:crypto';
import { Type } from 'typebox';
import { InputSuspendedError } from '../../../../services/interaction-waiter.js';

export function createInteractionExtension(options = {}) {
  return function interactionExtension(pi) {
    pi.registerTool({
      name: 'ask_user',
      label: 'Ask user',
      description: 'Pause durably and ask the user for required input, confirmation, or a selection.',
      parameters: Type.Object({
        interaction_type: Type.Union([
          Type.Literal('input'),
          Type.Literal('select'),
          Type.Literal('confirm'),
        ]),
        title: Type.String(),
        message: Type.Optional(Type.String()),
        options: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
        placeholder: Type.Optional(Type.String()),
      }),
      async execute(toolCallId, input) {
        if (input.interaction_type === 'select' && (!input.options || input.options.length < 2)) {
          return {
            content: [{ type: 'text', text: 'select requires at least two options' }],
            details: { isError: true },
            isError: true,
          };
        }
        const pending = {
          interaction_id: `interaction_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
          interaction_type: input.interaction_type,
          title: input.title,
          message: input.message || null,
          options: input.options || [],
          placeholder: input.placeholder || null,
          tool_name: 'ask_user',
          tool_call_id: toolCallId,
          ...(options.getMeta?.() || {}),
        };
        options.emit?.({ type: 'interaction_requested', durable: true, ...pending });
        await options.onInputSuspend?.(pending);
        throw new InputSuspendedError(pending);
      },
    });
  };
}
