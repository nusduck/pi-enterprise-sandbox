/**
 * A2A request-side contract for the Task service.
 *
 * The error types every A2A entry point throws, and the fail-closed parsing of
 * an inbound message/send: text extraction, params shape, configuration limits,
 * and the stable idempotency key that stops a retry becoming a second Run.
 * Pure — no repositories, no Run lookups.
 */

import {
  isTerminalRunStatus,
  RUN_STATUS,
} from '../../domain/run/run-status.js';
import {
  normalizeOpaqueContextId,
  A2A_CONTEXT_ID_MAX_LEN,
} from '../../infrastructure/mysql/repositories/a2a-task-repository.js';
import { ValidationError } from '../errors.js';
import { A2A_RPC_ERROR, JSON_RPC_ERROR } from './json-rpc.js';
import {
  A2A_SUPPORTED_OUTPUT_MODES,
  A2A_ENTERPRISE_EXTENSION_URI,
} from './agent-card.js';

/** Run statuses that accept a follow-up message on the same task conversation. */
export const CONTINUABLE_RUN_STATUSES = new Set([
  RUN_STATUS.SUCCEEDED,
  RUN_STATUS.FAILED,
  RUN_STATUS.WAITING_INPUT,
  RUN_STATUS.WAITING_APPROVAL,
  RUN_STATUS.CANCELLED,
]);

export class A2aTaskError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, rpc?: { code: number, message: string }, details?: unknown }} [opts]
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = 'A2aTaskError';
    this.code = opts.code ?? 'A2A_TASK_ERROR';
    this.rpc = opts.rpc ?? null;
    this.details = opts.details ?? null;
  }
}

export class A2aAuditError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string }} [opts]
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = 'A2aAuditError';
    this.code = opts.code ?? 'A2A_AUDIT_FAILED';
  }
}

/**
 * @param {unknown} message
 * @returns {string}
 */
export function extractTextFromA2aMessage(message) {
  if (!message || typeof message !== 'object') {
    throw new ValidationError('message is required');
  }
  const parts = /** @type {any} */ (message).parts;
  if (!Array.isArray(parts) || parts.length === 0) {
    const bare =
      /** @type {any} */ (message).text ||
      /** @type {any} */ (message).content;
    if (typeof bare === 'string' && bare.trim()) return bare.trim();
    throw new ValidationError('message.parts must be a non-empty array');
  }
  const texts = [];
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    const kind = part.kind || part.type || (part.text != null ? 'text' : null);
    if (kind === 'text' || kind === 'TextPart') {
      if (typeof part.text === 'string' && part.text.trim()) {
        texts.push(part.text.trim());
      }
    } else if (typeof part.text === 'string' && part.text.trim()) {
      texts.push(part.text.trim());
    }
  }
  if (texts.length === 0) {
    throw new ValidationError(
      'message must include at least one text part (other part types not supported yet)',
    );
  }
  return texts.join('\n');
}

/**
 * @param {unknown} params
 * @returns {{
 *   message: object,
 *   messageId: string | null,
 *   taskId: string | null,
 *   contextId: string | null,
 *   configuration: Record<string, unknown> | null,
 *   metadata: object,
 * }}
 */
export function parseSendParams(params) {
  if (!params || typeof params !== 'object') {
    throw new ValidationError('params are required');
  }
  const p = /** @type {Record<string, unknown>} */ (params);
  const message = p.message;
  if (!message || typeof message !== 'object') {
    throw new ValidationError('params.message is required');
  }
  const msg = /** @type {Record<string, unknown>} */ (message);
  const messageIdRaw =
    typeof msg.messageId === 'string'
      ? msg.messageId
      : typeof msg.message_id === 'string'
        ? msg.message_id
        : typeof p.messageId === 'string'
          ? p.messageId
          : typeof p.message_id === 'string'
            ? p.message_id
            : null;
  const messageId =
    messageIdRaw && String(messageIdRaw).trim()
      ? String(messageIdRaw).trim()
      : null;

  let taskId = null;
  if (typeof msg.taskId === 'string' && msg.taskId.trim()) {
    taskId = msg.taskId.trim();
  } else if (typeof msg.task_id === 'string' && msg.task_id.trim()) {
    taskId = msg.task_id.trim();
  } else if (typeof p.taskId === 'string' && p.taskId.trim()) {
    taskId = p.taskId.trim();
  }

  let contextId = null;
  try {
    if (typeof p.contextId === 'string' && p.contextId.trim()) {
      contextId = normalizeOpaqueContextId(p.contextId);
    } else if (typeof msg.contextId === 'string' && msg.contextId.trim()) {
      contextId = normalizeOpaqueContextId(msg.contextId);
    } else if (typeof msg.context_id === 'string' && msg.context_id.trim()) {
      contextId = normalizeOpaqueContextId(msg.context_id);
    }
  } catch {
    throw new ValidationError(
      `contextId exceeds max length ${A2A_CONTEXT_ID_MAX_LEN}`,
    );
  }

  const configuration =
    p.configuration &&
    typeof p.configuration === 'object' &&
    !Array.isArray(p.configuration)
      ? /** @type {Record<string, unknown>} */ (p.configuration)
      : msg.configuration &&
          typeof msg.configuration === 'object' &&
          !Array.isArray(msg.configuration)
        ? /** @type {Record<string, unknown>} */ (msg.configuration)
        : null;

  const metadata =
    p.metadata && typeof p.metadata === 'object' && !Array.isArray(p.metadata)
      ? /** @type {object} */ (p.metadata)
      : {};
  return {
    message: /** @type {object} */ (message),
    messageId,
    taskId,
    contextId,
    configuration,
    metadata,
  };
}

/**
 * Fail closed on unsupported push / output-mode negotiation (A2A v0.3).
 * @param {Record<string, unknown> | null | undefined} configuration
 */
export function assertSendConfiguration(configuration) {
  if (!configuration) return;

  if (
    configuration.pushNotificationConfig != null ||
    configuration.pushNotificationsConfig != null ||
    configuration.push_notification_config != null
  ) {
    throw new A2aTaskError('Push Notification is not supported', {
      code: 'PUSH_NOT_SUPPORTED',
      rpc: A2A_RPC_ERROR.PUSH_NOT_SUPPORTED,
    });
  }

  const modes = configuration.acceptedOutputModes ?? configuration.accepted_output_modes;
  if (modes == null) return;
  if (!Array.isArray(modes) || modes.length === 0) {
    throw new A2aTaskError('Content type not supported', {
      code: 'CONTENT_TYPE_NOT_SUPPORTED',
      rpc: A2A_RPC_ERROR.CONTENT_TYPE,
      details: { reason: 'acceptedOutputModes must be a non-empty array' },
    });
  }
  const supported = new Set(A2A_SUPPORTED_OUTPUT_MODES);
  const requested = modes
    .filter((m) => typeof m === 'string' && m.trim())
    .map((m) => String(m).trim());
  if (requested.length === 0) {
    throw new A2aTaskError('Content type not supported', {
      code: 'CONTENT_TYPE_NOT_SUPPORTED',
      rpc: A2A_RPC_ERROR.CONTENT_TYPE,
    });
  }
  const anySupported = requested.some((m) => supported.has(m));
  if (!anySupported) {
    throw new A2aTaskError('Content type not supported', {
      code: 'CONTENT_TYPE_NOT_SUPPORTED',
      rpc: A2A_RPC_ERROR.CONTENT_TYPE,
      details: {
        acceptedOutputModes: requested,
        supportedOutputModes: [...A2A_SUPPORTED_OUTPUT_MODES],
      },
    });
  }
}

/**
 * Require stable messageId or Idempotency-Key (no random generateId keys).
 * @param {{ messageId?: string | null, idempotencyKey?: string | null }} input
 * @returns {string}
 */
export function requireStableIdempotencyKey(input) {
  const fromHeader =
    typeof input.idempotencyKey === 'string' && input.idempotencyKey.trim()
      ? input.idempotencyKey.trim()
      : null;
  const fromMessage =
    typeof input.messageId === 'string' && input.messageId.trim()
      ? input.messageId.trim()
      : null;
  const key = fromHeader || fromMessage;
  if (!key) {
    throw new ValidationError(
      'message.messageId or Idempotency-Key is required for SendMessage',
      { code: 'IDEMPOTENCY_KEY_REQUIRED' },
    );
  }
  if (key.length > 255) {
    throw new ValidationError('idempotency key exceeds max length 255');
  }
  return key;
}
