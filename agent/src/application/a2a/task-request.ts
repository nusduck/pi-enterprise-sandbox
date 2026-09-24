/**
 * A2A request-side contract for the Task service.
 *
 * The error types every A2A entry point throws, and the fail-closed parsing of
 * an inbound message/send: text extraction, params shape, configuration limits,
 * and the stable idempotency key that stops a retry becoming a second Run.
 * Pure — no repositories, no Run lookups.
 */

import { RUN_STATUS } from '../../domain/run/run-status.js';
import {
  normalizeOpaqueContextId,
  A2A_CONTEXT_ID_MAX_LEN,
} from '../../infrastructure/mysql/repositories/a2a-task-repository.js';
import { ValidationError } from '../errors.js';
import { A2A_RPC_ERROR } from './json-rpc.js';
import { A2A_SUPPORTED_OUTPUT_MODES } from './agent-card.js';

/** 过渡期宽松类型：注入的依赖多数还是 JS 类，形状由各自的模块负责。 */
type Loose = any;

/** Run statuses that accept a follow-up message on the same task conversation. */
export const CONTINUABLE_RUN_STATUSES = new Set([
  RUN_STATUS.SUCCEEDED,
  RUN_STATUS.FAILED,
  RUN_STATUS.WAITING_INPUT,
  RUN_STATUS.WAITING_APPROVAL,
  RUN_STATUS.CANCELLED,
]);

export class A2aTaskError extends Error {
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  name: string;
  code: Loose;
  rpc: Loose;
  details: Loose;

  constructor(message: string, opts: { code?: string, rpc?: { code: number, message: string }, details?: unknown } = {}) {
    super(message);
    this.name = 'A2aTaskError';
    this.code = opts.code ?? 'A2A_TASK_ERROR';
    this.rpc = opts.rpc ?? null;
    this.details = opts.details ?? null;
  }
}

export class A2aAuditError extends Error {
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  name: string;
  code: Loose;

  constructor(message: string, opts: { code?: string } = {}) {
    super(message);
    this.name = 'A2aAuditError';
    this.code = opts.code ?? 'A2A_AUDIT_FAILED';
  }
}

/**
 * @param message
 * @returns {string}
 */
export function extractTextFromA2aMessage(message: unknown) {
  if (!message || typeof message !== 'object') {
    throw new ValidationError('message is required');
  }
  const parts = (message as any).parts;
  if (!Array.isArray(parts) || parts.length === 0) {
    const bare =
      (message as any).text ||
      (message as any).content;
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
 * @param params
 * @returns {{
 *   message: object,
 *   messageId: string | null,
 *   taskId: string | null,
 *   contextId: string | null,
 *   configuration: Record<string, unknown> | null,
 *   metadata: object,
 * }}
 */
export function parseSendParams(params: unknown) {
  if (!params || typeof params !== 'object') {
    throw new ValidationError('params are required');
  }
  const p = (params as Record<string, unknown>);
  const message = p.message;
  if (!message || typeof message !== 'object') {
    throw new ValidationError('params.message is required');
  }
  const msg = (message as Record<string, unknown>);
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
      ? (p.configuration as Record<string, unknown>)
      : msg.configuration &&
          typeof msg.configuration === 'object' &&
          !Array.isArray(msg.configuration)
        ? (msg.configuration as Record<string, unknown>)
        : null;

  const metadata =
    p.metadata && typeof p.metadata === 'object' && !Array.isArray(p.metadata)
      ? (p.metadata as Record<string, any>)
      : {};
  return {
    message: (message as Record<string, any>),
    messageId,
    taskId,
    contextId,
    configuration,
    metadata,
  };
}

/**
 * Does one requested output mode match something this agent can produce?
 *
 * Accepts the wire forms real clients send, not just exact MIME strings:
 * the bare `text` alias used throughout the A2A spec samples and a2a-python,
 * and `*​/*` / `type/*` wildcards.
 *
 * @param mode
 * @param supported
 * @returns {boolean}
 */
function isOutputModeSupported(mode: string, supported: Set<string>) {
  const m = mode.toLowerCase();
  if (m === '*' || m === '*/*') return true;
  if (supported.has(m)) return true;
  // Bare type alias: "text" means text/plain.
  if (!m.includes('/')) {
    return [...supported].some((s) => s.split('/')[0] === m);
  }
  if (m.endsWith('/*')) {
    const type = m.slice(0, -2);
    return [...supported].some((s) => s.split('/')[0] === type);
  }
  return false;
}

/**
 * Fail closed on unsupported push / output-mode negotiation (A2A v0.3).
 * @param configuration
 */
export function assertSendConfiguration(configuration: Record<string, unknown> | null | undefined) {
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
  if (!Array.isArray(modes)) {
    throw new A2aTaskError('Content type not supported', {
      code: 'CONTENT_TYPE_NOT_SUPPORTED',
      rpc: A2A_RPC_ERROR.CONTENT_TYPE,
      details: { reason: 'acceptedOutputModes must be an array' },
    });
  }
  const requested = modes
    .filter((m) => typeof m === 'string' && m.trim())
    .map((m) => String(m).trim());
  // An empty list is "no preference", not "nothing works": a2a-python's
  // ClientConfig.accepted_output_modes defaults to []. Rejecting it turned
  // every default-configured official client's message/stream into a JSON-RPC
  // error, which that client reports as an SSE protocol error.
  if (requested.length === 0) return;

  const supported = new Set(A2A_SUPPORTED_OUTPUT_MODES);
  const anySupported = requested.some((m) => isOutputModeSupported(m, supported));
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
 * @param input
 * @returns {string}
 */
export function requireStableIdempotencyKey(input: { messageId?: string | null, idempotencyKey?: string | null }) {
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
