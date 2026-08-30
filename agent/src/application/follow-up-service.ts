/**
 * Follow-up creates a new durable Run in the same Conversation/Agent Session.
 * SessionLock serializes execution behind the currently active Run.
 */

import { assertUlid } from '../domain/shared/ulid.js';
import { ValidationError } from './errors.js';

/** 过渡期宽松类型：注入的依赖多数还是 JS 类，形状由各自的模块负责。 */
type Loose = any;

export class FollowUpService {
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  createRunService: Loose;

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
   *   traceFlags?: string | null,
   *   idempotencyKey: string,
   *   agentId?: string | null,
   *   spanId?: string | null,
   * }} input
   */
  async execute(input: { conversationId: string, text: string, auth: Record<string, any>, traceId: string, traceState?: string | null, traceFlags?: string | null, idempotencyKey: string, agentId?: string | null, spanId?: string | null, }) {
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
      traceFlags: input.traceFlags,
      idempotencyKey: input.idempotencyKey.trim(),
      agentId: input.agentId ?? null,
      spanId: input.spanId ?? null,
    });
  }
}
