/**
 * Emit-time A2A v0.3 StreamResponse checks (no official SDK runtime).
 *
 * Validates the discriminated `kind` union and required fields so Python
 * a2a-sdk / Pydantic clients fail locally instead of on the wire.
 *
 * Official 0.3 StreamResponse `kind` union (a2a-python / Pydantic):
 *   task | message | status-update | artifact-update
 *
 * Stream grammar (§3.1.2):
 *   message-only: exactly one Message, then close
 *   task lifecycle: Task, then status-update | artifact-update, close on terminal
 */

import { ALL_A2A_TASK_STATUSES } from '../../domain/a2a/status.js';

/** 已通过 schema 校验的 A2A 流帧。字段随 kind 变化，故不逐个收窄。 */
export type A2aStreamResult = Record<string, any>;

export const A2A_STREAM_RESULT_KINDS = Object.freeze([
  'task',
  'message',
  'status-update',
  'artifact-update',
]);

/** After an initial Task, official 0.3 allows only these follow-up kinds. */
export const A2A_TASK_LIFECYCLE_FOLLOW_UP_KINDS = Object.freeze([
  'status-update',
  'artifact-update',
]);

const MESSAGE_ROLES = new Set(['user', 'agent']);
const PART_KINDS = new Set(['text', 'file', 'data']);
const STATUS_SET = new Set(ALL_A2A_TASK_STATUSES);

/**
 * @param [_method]
 * @returns {readonly string[]}
 */
export function streamKindsForMethod(_method?: unknown) {
  return A2A_STREAM_RESULT_KINDS;
}

/**
 * Official 0.3 SendStreamingMessage / SubscribeToTask grammar.
 *
 * @param results
 */
export function assertOfficialStreamGrammar(results: Record<string, any>[]) {
  if (!Array.isArray(results) || results.length === 0) {
    throw new A2aStreamSchemaError('stream must contain at least one result');
  }
  for (const result of results) {
    assertA2aStreamResult(result);
  }
  const first = results[0];
  if (first.kind === 'message') {
    if (results.length !== 1) {
      throw new A2aStreamSchemaError(
        'message-only stream must contain exactly one Message',
      );
    }
    return results;
  }
  if (first.kind !== 'task') {
    throw new A2aStreamSchemaError(
      'task-lifecycle stream must start with Task (or a lone Message)',
      { kind: first.kind },
    );
  }
  for (let i = 1; i < results.length; i += 1) {
    const kind = results[i].kind;
    if (!A2A_TASK_LIFECYCLE_FOLLOW_UP_KINDS.includes(kind)) {
      throw new A2aStreamSchemaError(
        'after Task, official 0.3 allows only status-update or artifact-update',
        { kind, index: i },
      );
    }
  }
  return results;
}

/**
 * Deep-omit null/undefined keys so optional fields are absent, not null.
 *
 * @param value
 * @returns {unknown}
 */
export function omitNullFields(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((item) => omitNullFields(item));
  }
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (child == null) continue;
    out[key] = omitNullFields(child);
  }
  return out;
}

/**
 * 校验通过后返回同一个对象。返回类型刻意是宽松记录而不是 `unknown`：
 * 调用方（stream-service）要读 `status.state` 之类的字段，逐个断言只会
 * 把已经校验过的东西再断言一遍。
 */
export function assertA2aStreamResult(result: unknown): A2aStreamResult {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new A2aStreamSchemaError('stream result must be an object');
  }
  const row = (result as Record<string, unknown>);
  const kind = row.kind;
  if (typeof kind !== 'string' || !A2A_STREAM_RESULT_KINDS.includes(kind)) {
    throw new A2aStreamSchemaError(
      `kind must be one of ${A2A_STREAM_RESULT_KINDS.join(', ')}`,
      { kind },
    );
  }
  switch (kind) {
    case 'task':
      assertTask(row);
      break;
    case 'message':
      assertMessage(row);
      break;
    case 'status-update':
      assertStatusUpdate(row);
      break;
    case 'artifact-update':
      assertArtifactUpdate(row);
      break;
    default:
      throw new A2aStreamSchemaError('unsupported kind', { kind });
  }
  return row;
}

/**
 * Omit nulls, then validate. Returns null when the frame is not protocol-valid
 * (caller should skip emit and still advance the journal cursor).
 *
 */
export function prepareA2aStreamResult(result: unknown): A2aStreamResult | null {
  const cleaned = omitNullFields(result);
  try {
    return assertA2aStreamResult(cleaned);
  } catch {
    return null;
  }
}

export class A2aStreamSchemaError extends Error {
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'A2aStreamSchemaError';
    this.details = details;
  }
}

function assertTask(row: Record<string, unknown>) {
  requireNonEmptyString(row.id, 'task.id');
  requireNonEmptyString(row.contextId, 'task.contextId');
  assertTaskStatus(row.status, 'task.status');
}

function assertMessage(row: Record<string, unknown>) {
  requireNonEmptyString(row.messageId, 'message.messageId');
  if (typeof row.role !== 'string' || !MESSAGE_ROLES.has(row.role)) {
    throw new A2aStreamSchemaError('message.role must be "user" or "agent"', {
      role: row.role,
    });
  }
  if (!Array.isArray(row.parts) || row.parts.length === 0) {
    throw new A2aStreamSchemaError('message.parts must be a non-empty array');
  }
  assertParts(row.parts, 'message.parts');
}

function assertStatusUpdate(row: Record<string, unknown>) {
  requireNonEmptyString(row.taskId, 'status-update.taskId');
  requireNonEmptyString(row.contextId, 'status-update.contextId');
  assertTaskStatus(row.status, 'status-update.status');
  if (typeof row.final !== 'boolean') {
    throw new A2aStreamSchemaError('status-update.final must be a boolean');
  }
}

function assertArtifactUpdate(row: Record<string, unknown>) {
  requireNonEmptyString(row.taskId, 'artifact-update.taskId');
  requireNonEmptyString(row.contextId, 'artifact-update.contextId');
  if (!row.artifact || typeof row.artifact !== 'object' || Array.isArray(row.artifact)) {
    throw new A2aStreamSchemaError('artifact-update.artifact is required');
  }
  const artifact = (row.artifact as Record<string, unknown>);
  requireNonEmptyString(artifact.artifactId, 'artifact.artifactId');
  if ('description' in artifact && artifact.description == null) {
    throw new A2aStreamSchemaError('artifact.description must be omitted when empty');
  }
  if (artifact.parts != null) {
    if (!Array.isArray(artifact.parts)) {
      throw new A2aStreamSchemaError('artifact.parts must be an array');
    }
    assertParts(artifact.parts, 'artifact.parts');
  }
}

function assertTaskStatus(status: unknown, label: string) {
  if (!status || typeof status !== 'object' || Array.isArray(status)) {
    throw new A2aStreamSchemaError(`${label} must be an object`);
  }
  const body = (status as Record<string, unknown>);
  if (typeof body.state !== 'string' || !STATUS_SET.has((body.state as any))) {
    throw new A2aStreamSchemaError(`${label}.state is not an A2A task state`, {
      state: body.state,
    });
  }
  if (body.message != null) {
    if (typeof body.message !== 'object' || Array.isArray(body.message)) {
      throw new A2aStreamSchemaError(`${label}.message must be a Message`);
    }
    assertMessage((body.message as Record<string, unknown>));
  }
}

function assertParts(parts: unknown[], label: string) {
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (!part || typeof part !== 'object' || Array.isArray(part)) {
      throw new A2aStreamSchemaError(`${label}[${i}] must be an object`);
    }
    const p = (part as Record<string, unknown>);
    if (typeof p.kind !== 'string' || !PART_KINDS.has(p.kind)) {
      throw new A2aStreamSchemaError(
        `${label}[${i}].kind must be text, file, or data`,
        { kind: p.kind },
      );
    }
    if (p.kind === 'text') {
      if (typeof p.text !== 'string' || !p.text) {
        throw new A2aStreamSchemaError(`${label}[${i}].text is required`);
      }
    } else if (p.kind === 'file') {
      if (!p.file || typeof p.file !== 'object' || Array.isArray(p.file)) {
        throw new A2aStreamSchemaError(`${label}[${i}].file is required`);
      }
      const file = (p.file as Record<string, unknown>);
      const hasUri = typeof file.uri === 'string' && file.uri.trim();
      const hasBytes = typeof file.bytes === 'string' && file.bytes;
      if (!hasUri && !hasBytes) {
        throw new A2aStreamSchemaError(
          `${label}[${i}].file must include uri or bytes`,
        );
      }
    } else if (p.kind === 'data') {
      if (!p.data || typeof p.data !== 'object' || Array.isArray(p.data)) {
        throw new A2aStreamSchemaError(`${label}[${i}].data must be an object`);
      }
    }
  }
}

function requireNonEmptyString(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new A2aStreamSchemaError(`${label} is required`);
  }
}
