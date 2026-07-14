import { Type } from 'typebox';
import { Check, Errors } from 'typebox/value';

function toolResult(value, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    details: value,
    isError,
  };
}

export function createStructuredOutputExtension(options = {}) {
  return function structuredOutputExtension(pi) {
    pi.registerTool({
      name: 'structured_output',
      label: 'Structured output',
      description: 'Validate and publish a JSON value against a complete JSON Schema.',
      parameters: Type.Object({
        schema: Type.Object({}, { additionalProperties: true }),
        value: Type.Unknown(),
        label: Type.Optional(Type.String()),
      }),
      async execute(_toolCallId, input) {
        if (!Check(input.schema, input.value)) {
          const errors = [...Errors(input.schema, input.value)].map((error) => ({
            path: error.path,
            message: error.message,
          }));
          return toolResult({ valid: false, errors }, true);
        }
        const payload = { valid: true, label: input.label || null, value: input.value };
        pi.appendEntry('enterprise_structured_output', payload);
        options.emit?.({ type: 'structured_output', ...payload, ...(options.getMeta?.() || {}) });
        return toolResult(payload);
      },
    });
  };
}
