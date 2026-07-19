/** Validate the typed answer accepted by a durable user interaction. */

import { assertInteractionType } from './interaction-status.js';

export const MAX_INTERACTION_INPUT_CHARS = 64 * 1024;

export class InteractionResponseValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InteractionResponseValidationError';
    this.code = 'INTERACTION_RESPONSE_INVALID';
  }
}

/**
 * Validate an answer against the durable request contract.
 *
 * The response is intentionally typed at the boundary: model/tool code gets a
 * string for input/select and a boolean for confirm, never an arbitrary object
 * that could be interpreted differently by different clients.
 */
export function validateInteractionResponse(interactionType, requestJson, value) {
  const type = assertInteractionType(interactionType);
  if (type === 'confirm') {
    if (typeof value !== 'boolean') {
      throw new InteractionResponseValidationError(
        'confirm interaction response must be a boolean',
      );
    }
    return value;
  }

  if (typeof value !== 'string') {
    throw new InteractionResponseValidationError(
      `${type} interaction response must be a string`,
    );
  }
  if (value.length > MAX_INTERACTION_INPUT_CHARS) {
    throw new InteractionResponseValidationError(
      `interaction response exceeds ${MAX_INTERACTION_INPUT_CHARS} characters`,
    );
  }

  if (type === 'select') {
    const options = Array.isArray(requestJson?.options)
      ? requestJson.options.map((option) => String(option))
      : [];
    if (options.length === 0 || !options.includes(value)) {
      throw new InteractionResponseValidationError(
        'select interaction response must be one of the requested options',
      );
    }
  }
  return value;
}
