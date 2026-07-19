/**
 * Worker-side consumer for durable run.steer.requested facts.
 *
 * Each executor rebuilds its cursor from MySQL, so HTTP/Worker process
 * separation and Worker restart do not lose accepted instructions. The local
 * timer/cursor are acceleration only; run_events + messages remain authority.
 */

import { assertUlid } from '../domain/shared/ulid.js';
import {
  STEER_DELIVERED_EVENT,
  STEER_REQUESTED_EVENT,
} from './steer-run-service.js';

export const DEFAULT_STEER_POLL_INTERVAL_MS = 25;
export const STEER_EVENT_PAGE_SIZE = 500;

function eventData(event) {
  const payload = event?.payloadJson;
  if (!payload || typeof payload !== 'object') return {};
  if (payload.data && typeof payload.data === 'object') return payload.data;
  return payload;
}

export function steerTextFromMessage(message, binding) {
  if (!message || typeof message !== 'object') {
    throw new Error('Durable steer message is missing');
  }
  if (
    message.messageId !== binding.messageId ||
    message.runId !== binding.runId ||
    message.conversationId !== binding.conversationId ||
    message.agentSessionId !== binding.agentSessionId ||
    message.messageType !== 'steer_instruction'
  ) {
    throw new Error('Durable steer message binding mismatch');
  }
  const text = message.contentJson?.text;
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('Durable steer message text is missing');
  }
  return text.trim();
}

export class DurableSteerController {
  /**
   * @param {{
   *   transactionManager: { run: (fn: (trx: any) => Promise<any>) => Promise<any> },
   *   createRepositories: (db: any) => any,
   *   runtimeSession: { steer: (text: string) => Promise<void> | void, abort?: Function },
   *   eventRecorder: { record: Function },
   *   runId: string,
   *   conversationId: string,
   *   agentSessionId: string,
   *   scope: { orgId: string, userId: string },
   *   pollIntervalMs?: number,
   *   onError?: (error: unknown) => void,
   * }} deps
   */
  constructor(deps) {
    if (!deps?.transactionManager?.run) {
      throw new Error('DurableSteerController requires transactionManager');
    }
    if (typeof deps.createRepositories !== 'function') {
      throw new Error('DurableSteerController requires createRepositories');
    }
    if (typeof deps.runtimeSession?.steer !== 'function') {
      throw new Error('Pi runtime session.steer() is required');
    }
    if (typeof deps.eventRecorder?.record !== 'function') {
      throw new Error('DurableSteerController requires eventRecorder.record');
    }
    this.tx = deps.transactionManager;
    this.createRepositories = deps.createRepositories;
    this.runtimeSession = deps.runtimeSession;
    this.eventRecorder = deps.eventRecorder;
    this.runId = assertUlid(deps.runId, 'runId');
    this.conversationId = assertUlid(deps.conversationId, 'conversationId');
    this.agentSessionId = assertUlid(deps.agentSessionId, 'agentSessionId');
    this.scope = Object.freeze({
      orgId: assertUlid(deps.scope?.orgId, 'orgId'),
      userId: assertUlid(deps.scope?.userId, 'userId'),
    });
    this.pollIntervalMs = Math.max(
      5,
      Number(deps.pollIntervalMs) || DEFAULT_STEER_POLL_INTERVAL_MS,
    );
    this.onError = typeof deps.onError === 'function' ? deps.onError : null;
    this.cursor = 0;
    this.pending = new Map();
    this.stopped = true;
    this.timer = null;
    this.inFlight = null;
    this.error = null;
  }

  async #readNewEvents() {
    while (true) {
      const page = await this.tx.run(async (trx) => {
        const repos = this.createRepositories(trx);
        return repos.runEvents.listByRun(this.runId, this.scope, {
          afterSequence: this.cursor,
          limit: STEER_EVENT_PAGE_SIZE,
        });
      });
      for (const event of page) {
        this.cursor = Math.max(this.cursor, Number(event.sequenceNo) || 0);
        const data = eventData(event);
        if (event.eventType === STEER_REQUESTED_EVENT) {
          const steerId = assertUlid(data.steerId ?? event.eventId, 'steerId');
          const messageId = assertUlid(data.messageId, 'messageId');
          this.pending.set(steerId, { steerId, messageId });
        } else if (event.eventType === STEER_DELIVERED_EVENT) {
          const steerId = assertUlid(data.steerId, 'steerId');
          this.pending.delete(steerId);
        }
      }
      if (page.length < STEER_EVENT_PAGE_SIZE) return;
    }
  }

  async #loadMessage(messageId) {
    return this.tx.run(async (trx) => {
      const repos = this.createRepositories(trx);
      return repos.messages.getById(messageId, this.scope);
    });
  }

  async pollOnce() {
    await this.#readNewEvents();
    for (const request of [...this.pending.values()]) {
      const message = await this.#loadMessage(request.messageId);
      const text = steerTextFromMessage(message, {
        messageId: request.messageId,
        runId: this.runId,
        conversationId: this.conversationId,
        agentSessionId: this.agentSessionId,
      });

      await this.runtimeSession.steer(text);
      await this.eventRecorder.record({
        type: STEER_DELIVERED_EVENT,
        data: {
          steerId: request.steerId,
          messageId: request.messageId,
        },
        dedupeKey: `${STEER_DELIVERED_EVENT}:${request.steerId}`,
      });
      this.pending.delete(request.steerId);
    }
  }

  #schedule() {
    if (this.stopped || this.error) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.stopped || this.error) return;
      const work = this.pollOnce();
      this.inFlight = work;
      work.then(
        () => {
          if (this.inFlight === work) this.inFlight = null;
          this.#schedule();
        },
        (error) => {
          if (this.inFlight === work) this.inFlight = null;
          this.error = error;
          this.onError?.(error);
        },
      );
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.#schedule();
  }

  async stop() {
    this.stopped = true;
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inFlight) {
      try {
        await this.inFlight;
      } catch {
        // error is exposed through this.error
      }
    }
  }
}

