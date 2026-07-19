/**
 * Follow-up creates a new durable Run in the same Conversation/Agent Session.
 * SessionLock serializes execution behind the currently active Run.
 */

import { assertUlid } from '../domain/shared/ulid.js';
import { ValidationError } from './errors.js';

export class FollowUpService {
  /** @param {{ createRunService: { execute: Function } }} deps */
  constructor(deps) {
    if (!deps?.createRunService?.execute) {
      throw new Error('FollowUpService requires createRunService.execute');
    }
    this.createRunService = deps.createRunService;
  }

  /**
   * @param {{
   *   conversationId: string,
   *   text: string,
   *   auth: object,
   *   traceId: string,
   *   traceState?: string | null,
   *   idempotencyKey: string,
   *   agentId?: string | null,
   *   spanId?: string | null,
   * }} input
   */
  async execute(input) {
    if (!input || typeof input !== 'object') {
      throw new ValidationError('FollowUp input is required');
    }
    const conversationId = assertUlid(
      input.conversationId,
      'conversationId',
    );
    if (typeof input.text !== 'string' || !input.text.trim()) {
      throw new ValidationError('text is required');
    }
    if (!input.auth) {
      throw new ValidationError('auth (trusted external subjects) is required');
    }
    if (typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim()) {
      throw new ValidationError('idempotencyKey is required');
    }

    return this.createRunService.execute({
      messages: [{ role: 'user', content: input.text.trim() }],
      auth: {
        ...input.auth,
        externalConversationId: conversationId,
      },
      traceId: input.traceId,
      ...(input.traceState ? { traceState: input.traceState } : {}),
      idempotencyKey: input.idempotencyKey.trim(),
      agentId: input.agentId ?? null,
      spanId: input.spanId ?? null,
    });
  }
}
