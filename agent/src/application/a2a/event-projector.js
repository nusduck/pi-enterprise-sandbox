/**
 * Project internal Run events → A2A protocol stream events (plan §20.3–20.5).
 *
 * Rules:
 * - Task status always derived from Internal Run (never a2a_tasks status).
 * - TaskArtifactUpdateEvent only from explicit artifact.ready with durable ULID artifact_id.
 * - Never project path/name-only artifacts; never leak workspace/internal paths.
 * - Download URI only when short-lived capability mint succeeds; else no fake URI.
 */

import {
  A2A_TASK_STATUS,
  projectRunStatusToA2a,
  isTerminalA2aTaskStatus,
} from '../../domain/a2a/status.js';
import { isRunStatus } from '../../domain/run/run-status.js';
import { isUlid } from '../../domain/shared/ulid.js';

/**
 * Platform event types that carry Run status transitions.
 *
 * The first block is the vocabulary the Run services actually append
 * (`applyRunTransitionInTxn` defaults to `run.status.changed`; the terminal
 * success event is `run.completed`). The second block is accepted-but-unused
 * spelling kept so older journals still project. Adding a new `run.*`
 * eventType without listing it here makes the A2A stream silently skip the
 * transition — `tests/a2a/a2a-terminal-event-vocabulary.unit.test.js` fails
 * when that happens.
 */
export const RUN_STATUS_EVENT_TYPES = new Set([
  'run.accepted',
  'run.queued',
  'run.started',
  'run.retrying',
  'run.status.changed',
  'run.completed',
  'run.failed',
  'run.cancelled',
  // Legacy / historical spellings.
  'run.starting',
  'run.running',
  'run.waiting_input',
  'run.waiting_approval',
  'run.cancelling',
  'run.succeeded',
  'run.status',
  'run.terminal',
]);

/**
 * Types whose name alone does not identify the target status — the durable
 * payload must say. Never inherit the ambient Run status for these: a generic
 * transition read while the Run row already reads SUCCEEDED would otherwise
 * project a premature `final: true`.
 */
const AMBIGUOUS_RUN_STATUS_EVENT_TYPES = new Set([
  'run.status.changed',
  'run.status',
  'run.terminal',
]);

/** Explicit artifact delivery only (plan §2.8 / §20.5). */
const ARTIFACT_EVENT_TYPES = new Set([
  'artifact.ready',
  'artifact.created',
]);

/** Completed assistant turns → standalone A2A Message (not status.message). */
const MESSAGE_EVENT_TYPES = new Set(['message.completed']);

/**
 * @param {object} envelope
 * @param {{
 *   a2aTaskId: string,
 *   contextId?: string | null,
 *   runStatus?: string | null,
 *   principal?: { orgId?: string, clientId?: string } | null,
 *   buildDownloadUri?: Function | null,
 *   lastA2aStatus?: string | null,
 * }} ctx
 */
export function projectEnvelopeToA2aResult(envelope, ctx) {
  if (!envelope || typeof envelope !== 'object') return null;
  const event =
    envelope.event && typeof envelope.event === 'object'
      ? envelope.event
      : envelope;
  const type = String(event.type || '');
  const sequence = Number(envelope.sequence);
  const eventId = envelope.event_id || event.event_id || null;
  const contextId = resolveContextId(ctx);

  if (ARTIFACT_EVENT_TYPES.has(type)) {
    const artifact = projectArtifactEvent(event, ctx);
    if (!artifact) return null;
    return {
      kind: 'artifact-update',
      sequence,
      eventId,
      result: {
        kind: 'artifact-update',
        taskId: ctx.a2aTaskId,
        contextId,
        artifact,
        append: false,
        lastChunk: true,
        metadata: streamMetadata(sequence, eventId),
      },
    };
  }

  if (MESSAGE_EVENT_TYPES.has(type)) {
    // Official 0.3 task-lifecycle stream: after Task, only status-update /
    // artifact-update. Fold assistant text into TaskStatus.message.
    const message = projectCompletedMessage(event, {
      a2aTaskId: ctx.a2aTaskId,
      contextId,
      sequence,
      eventId,
    });
    if (!message) return null;
    const status =
      (typeof ctx.lastA2aStatus === 'string' && ctx.lastA2aStatus) ||
      (ctx.runStatus ? projectRunStatusToA2a(ctx.runStatus) : null) ||
      A2A_TASK_STATUS.WORKING;
    return {
      kind: 'status-update',
      sequence,
      eventId,
      result: {
        kind: 'status-update',
        taskId: ctx.a2aTaskId,
        contextId,
        status: {
          state: status,
          timestamp: envelope.ts
            ? new Date(envelope.ts).toISOString()
            : new Date().toISOString(),
          message,
        },
        final: isTerminalA2aTaskStatus(status),
        metadata: streamMetadata(sequence, eventId),
      },
    };
  }

  // Only the explicit Run-status vocabulary — never prefix-match run.*.
  if (RUN_STATUS_EVENT_TYPES.has(type)) {
    const status = resolveStatusFromEvent(event, ctx.runStatus);
    if (!status) return null;
    // Collapse no-op transitions (accepted+queued both map to submitted).
    if (ctx.lastA2aStatus && ctx.lastA2aStatus === status) return null;
    const final = isTerminalA2aTaskStatus(status);
    const statusBody = {
      state: status,
      timestamp: envelope.ts
        ? new Date(envelope.ts).toISOString()
        : new Date().toISOString(),
    };
    // Message is optional on TaskStatus. When present it MUST include
    // messageId (A2A Message required field) — Python a2a-sdk / Pydantic
    // rejects incomplete Message objects during SendStreamingMessage parse.
    const message = statusMessage(event, status, {
      a2aTaskId: ctx.a2aTaskId,
      contextId,
      sequence,
      eventId,
    });
    if (message) {
      statusBody.message = message;
    }
    return {
      kind: 'status-update',
      sequence,
      eventId,
      result: {
        kind: 'status-update',
        taskId: ctx.a2aTaskId,
        contextId,
        status: statusBody,
        final,
        metadata: streamMetadata(sequence, eventId),
      },
    };
  }

  return null;
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/**
 * @param {{ contextId?: string | null, a2aTaskId: string }} ctx
 * @returns {string}
 */
function resolveContextId(ctx) {
  if (typeof ctx.contextId === 'string' && ctx.contextId.trim()) {
    return ctx.contextId.trim();
  }
  return ctx.a2aTaskId;
}

/**
 * Wire metadata for SSE resume only — no internal runStatus / sourceEventType.
 * @param {number} sequence
 * @param {unknown} eventId
 */
function streamMetadata(sequence, eventId) {
  /** @type {Record<string, unknown>} */
  const metadata = { sequence };
  if (typeof eventId === 'string' && eventId) metadata.eventId = eventId;
  return metadata;
}

/**
 * @param {{
 *   a2aTaskId: string,
 *   contextId?: string | null,
 *   runStatus: string,
 *   createdAt?: string | null,
 *   updatedAt?: string | null,
 *   artifacts?: object[],
 *   history?: object[],
 *   metadata?: Record<string, unknown>,
 * }} input
 */
export function buildA2aTaskObject(input) {
  const state = projectRunStatusToA2a(input.runStatus);
  const contextId =
    typeof input.contextId === 'string' && input.contextId.trim()
      ? input.contextId.trim()
      : input.a2aTaskId;
  /** @type {Record<string, unknown>} */
  const task = {
    id: input.a2aTaskId,
    contextId,
    status: {
      state,
      timestamp: input.updatedAt || input.createdAt || new Date().toISOString(),
    },
    artifacts: Array.isArray(input.artifacts) ? input.artifacts : [],
    kind: 'task',
    metadata: {
      ...(input.metadata || {}),
    },
  };
  if (Array.isArray(input.history) && input.history.length > 0) {
    task.history = input.history;
  }
  return task;
}

/**
 * Project durable conversation messages → A2A Message history.
 *
 * @param {object[]} messages
 * @param {{ a2aTaskId: string, contextId?: string | null }} ctx
 * @returns {object[]}
 */
export function projectMessagesToA2aHistory(messages, ctx) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const contextId =
    typeof ctx.contextId === 'string' && ctx.contextId.trim()
      ? ctx.contextId.trim()
      : ctx.a2aTaskId;
  /** @type {object[]} */
  const out = [];
  for (const row of messages) {
    if (!row || typeof row !== 'object') continue;
    const roleRaw = String(row.role || '').toLowerCase();
    const role =
      roleRaw === 'assistant' || roleRaw === 'agent'
        ? 'agent'
        : roleRaw === 'user'
          ? 'user'
          : null;
    if (!role) continue;
    const content = extractTextFromMessageRow(row);
    if (!content) continue;
    const messageId =
      typeof row.messageId === 'string' && row.messageId
        ? row.messageId
        : typeof row.message_id === 'string' && row.message_id
          ? row.message_id
          : `${ctx.a2aTaskId}:${row.sequenceNo ?? out.length}`;
    out.push({
      kind: 'message',
      messageId,
      role,
      parts: [{ kind: 'text', text: content }],
      taskId: ctx.a2aTaskId,
      contextId,
    });
  }
  return out;
}

/**
 * @param {object} row
 * @returns {string | null}
 */
function extractTextFromMessageRow(row) {
  const json = row.contentJson ?? row.content_json ?? null;
  if (typeof json === 'string') {
    try {
      const parsed = JSON.parse(json);
      return extractTextFromContentJson(parsed);
    } catch {
      return json.trim() || null;
    }
  }
  if (json && typeof json === 'object') {
    return extractTextFromContentJson(json);
  }
  if (typeof row.content === 'string' && row.content.trim()) {
    return row.content.trim();
  }
  return null;
}

/**
 * @param {unknown} content
 * @returns {string | null}
 */
function extractTextFromContentJson(content) {
  if (!content || typeof content !== 'object') return null;
  const c = /** @type {Record<string, unknown>} */ (content);
  if (typeof c.text === 'string' && c.text.trim()) return c.text.trim();
  if (typeof c.content === 'string' && c.content.trim()) return c.content.trim();
  if (Array.isArray(c.parts)) {
    const texts = [];
    for (const p of c.parts) {
      if (p && typeof p === 'object' && typeof p.text === 'string' && p.text.trim()) {
        texts.push(p.text.trim());
      }
    }
    if (texts.length) return texts.join('\n');
  }
  return null;
}

/**
 * Durable artifact_id required (ULID). Path/name-only rejected.
 * Never includes relativePath/workspace path on the wire.
 *
 * @param {object} event
 * @param {{
 *   a2aTaskId: string,
 *   contextId?: string | null,
 *   principal?: { orgId?: string, clientId?: string } | null,
 *   buildDownloadUri?: Function | null,
 * }} ctx
 * @returns {object | null}
 */
function projectArtifactEvent(event, ctx) {
  const data =
    event.data && typeof event.data === 'object' && !Array.isArray(event.data)
      ? event.data
      : {};
  const payload =
    event.payload &&
    typeof event.payload === 'object' &&
    !Array.isArray(event.payload)
      ? event.payload
      : {};
  const rawId =
    event.artifactId ||
    event.artifact_id ||
    data.artifactId ||
    data.artifact_id ||
    payload.artifactId ||
    payload.artifact_id ||
    null;
  if (typeof rawId !== 'string' || !isUlid(rawId)) {
    // Fail closed: no durable id → no A2A artifact event (no path-only fallthrough).
    return null;
  }
  const artifactId = rawId.toUpperCase();

  const nameRaw =
    event.name ||
    event.fileName ||
    event.file_name ||
    event.displayName ||
    event.display_name ||
    data.name ||
    data.displayName ||
    payload.name ||
    payload.displayName ||
    null;
  const name =
    typeof nameRaw === 'string' && nameRaw.trim()
      ? nameRaw.trim().slice(0, 256)
      : 'artifact';

  const mimeType =
    event.mimeType ||
    event.mime_type ||
    data.mimeType ||
    data.mime_type ||
    payload.mimeType ||
    payload.mime_type ||
    'application/octet-stream';

  const sizeBytes =
    event.sizeBytes ??
    event.size_bytes ??
    event.size ??
    data.sizeBytes ??
    data.size_bytes ??
    data.size ??
    payload.sizeBytes ??
    payload.size_bytes ??
    payload.size ??
    null;

  /** @type {object[]} */
  const parts = [];
  if (typeof event.text === 'string' && event.text) {
    parts.push({ kind: 'text', text: event.text.slice(0, 4096) });
  }

  // Download URI only when a real byte-capable mint is injected (sync string).
  // Never emit a URI without a safe byte transport (no metadata-as-download).
  let uri = null;
  if (typeof ctx.buildDownloadUri === 'function' && ctx.principal) {
    try {
      const minted = ctx.buildDownloadUri({
        orgId: ctx.principal.orgId,
        clientId: ctx.principal.clientId,
        taskId: ctx.a2aTaskId,
        artifactId,
      });
      if (typeof minted === 'string' && minted.trim()) {
        uri = minted.trim();
      }
      // Promises / null → no URI (fail closed in sync projector).
    } catch {
      uri = null;
    }
  }
  // A2A FilePart requires uri or bytes — never emit a name-only file stub.
  if (uri) {
    parts.push({
      kind: 'file',
      file: {
        name,
        mimeType:
          typeof mimeType === 'string' ? mimeType : 'application/octet-stream',
        uri,
      },
    });
  }

  if (event.data != null && typeof event.data === 'object' && !Array.isArray(event.data)) {
    // Only allow non-path structured data keys.
    const safe = { ...event.data };
    delete safe.path;
    delete safe.filePath;
    delete safe.file_path;
    delete safe.relativePath;
    delete safe.relative_path;
    delete safe.workspacePath;
    parts.push({ kind: 'data', data: safe });
  }

  const descriptionRaw =
    typeof event.description === 'string'
      ? event.description
      : typeof data.description === 'string'
        ? data.description
        : typeof payload.description === 'string'
          ? payload.description
          : '';
  const description = descriptionRaw.trim().slice(0, 512);

  /** @type {Record<string, unknown>} */
  const artifact = {
    artifactId,
    name,
    parts,
  };
  if (description) artifact.description = description;

  /** @type {Record<string, unknown>} */
  const metadata = {
    mimeType: typeof mimeType === 'string' ? mimeType : 'application/octet-stream',
  };
  if (sizeBytes != null && Number.isFinite(Number(sizeBytes))) {
    metadata.sizeBytes = Number(sizeBytes);
  }
  artifact.metadata = metadata;
  return artifact;
}

/**
 * Project durable message.completed → A2A Message (kind: message).
 *
 * @param {object} event
 * @param {{
 *   a2aTaskId: string,
 *   contextId: string,
 *   sequence?: number,
 *   eventId?: string | null,
 * }} ctx
 * @returns {object | null}
 */
function projectCompletedMessage(event, ctx) {
  const payload = plainObject(event.payload);
  // The observability projector writes `{ context, data }` payloads, so the
  // role/message/messageId of a live message.completed sit one level down.
  // Read both shapes: `event.*` (flat), `event.payload.*`, `event.data.*`.
  const data = plainObject(event.data ?? payload.data);
  const roleRaw = String(
    event.role ||
      payload.role ||
      data.role ||
      event.message?.role ||
      /** @type {any} */ (payload.message)?.role ||
      /** @type {any} */ (data.message)?.role ||
      '',
  ).toLowerCase();
  const role =
    roleRaw === 'user' ? 'user' : roleRaw === 'assistant' || roleRaw === 'agent'
      ? 'agent'
      : null;
  if (role !== 'agent') return null;

  const text =
    extractCompletedMessageText(event, payload) ||
    extractCompletedMessageText(data, data);
  if (!text) return null;

  const seq =
    Number.isFinite(Number(ctx.sequence)) && Number(ctx.sequence) >= 0
      ? Number(ctx.sequence)
      : 0;
  const messageId =
    (typeof event.messageId === 'string' && event.messageId.trim()) ||
    (typeof event.message_id === 'string' && event.message_id.trim()) ||
    (typeof payload.messageId === 'string' && payload.messageId.trim()) ||
    (typeof data.messageId === 'string' && data.messageId.trim()) ||
    (typeof ctx.eventId === 'string' && ctx.eventId.trim()) ||
    `a2a-msg-${ctx.a2aTaskId}-${seq}`;

  return {
    kind: 'message',
    messageId,
    role,
    parts: [{ kind: 'text', text: text.slice(0, 16_384) }],
    taskId: ctx.a2aTaskId,
    contextId: ctx.contextId,
    metadata: streamMetadata(seq, ctx.eventId),
  };
}

/**
 * @param {object} event
 * @param {Record<string, unknown>} payload
 * @returns {string | null}
 */
function extractCompletedMessageText(event, payload) {
  if (typeof event.text === 'string' && event.text.trim()) {
    return event.text.trim();
  }
  const msg = event.message ?? payload.message ?? null;
  if (typeof msg === 'string' && msg.trim()) return msg.trim();
  if (!msg || typeof msg !== 'object') return null;
  const body = /** @type {Record<string, unknown>} */ (msg);
  if (typeof body.text === 'string' && body.text.trim()) return body.text.trim();
  if (typeof body.content === 'string' && body.content.trim()) {
    return body.content.trim();
  }
  if (Array.isArray(body.content)) {
    const texts = [];
    for (const part of body.content) {
      if (!part || typeof part !== 'object') continue;
      const p = /** @type {Record<string, unknown>} */ (part);
      if (
        (p.type === 'text' || p.kind === 'text') &&
        typeof p.text === 'string' &&
        p.text.trim()
      ) {
        texts.push(p.text.trim());
      }
    }
    if (texts.length) return texts.join('');
  }
  return null;
}

/**
 * Project durable MySQL artifact rows (no path leak).
 * @param {object[]} rows — mapped ArtifactRepository rows
 * @param {{
 *   a2aTaskId: string,
 *   principal: { orgId: string, clientId: string },
 *   buildDownloadUri?: Function | null,
 * }} ctx
 */
export function projectArtifactRowsToA2a(rows, ctx) {
  const out = [];
  for (const row of rows || []) {
    if (!row?.artifactId || !isUlid(row.artifactId)) continue;
    const event = {
      type: 'artifact.ready',
      artifactId: row.artifactId,
      name: row.displayName,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
    };
    const art = projectArtifactEvent(event, ctx);
    if (art) out.push(art);
  }
  return out;
}

/** Types whose name alone pins the target status. */
const RUN_STATUS_EVENT_TYPE_MAP = {
  'run.accepted': A2A_TASK_STATUS.SUBMITTED,
  'run.queued': A2A_TASK_STATUS.SUBMITTED,
  'run.starting': A2A_TASK_STATUS.WORKING,
  'run.started': A2A_TASK_STATUS.WORKING,
  'run.running': A2A_TASK_STATUS.WORKING,
  'run.waiting_input': A2A_TASK_STATUS.INPUT_REQUIRED,
  'run.waiting_approval': A2A_TASK_STATUS.AUTH_REQUIRED,
  'run.cancelling': A2A_TASK_STATUS.WORKING,
  'run.retrying': A2A_TASK_STATUS.WORKING,
  'run.completed': A2A_TASK_STATUS.COMPLETED,
  'run.succeeded': A2A_TASK_STATUS.COMPLETED,
  'run.failed': A2A_TASK_STATUS.FAILED,
  'run.cancelled': A2A_TASK_STATUS.CANCELED,
};

function resolveStatusFromEvent(event, fallbackRunStatus) {
  // Durable payload status first — it is the fact the transition wrote.
  const fromEvent = extractRunStatus(event);
  if (fromEvent) return projectRunStatusToA2a(fromEvent);
  const type = String(event.type || '');
  const mapped = RUN_STATUS_EVENT_TYPE_MAP[type];
  if (mapped) return mapped;
  // Ambient Run status is a last resort, and never for a generic transition:
  // it is read at page time and may already be terminal.
  if (AMBIGUOUS_RUN_STATUS_EVENT_TYPES.has(type)) return null;
  if (fallbackRunStatus && isRunStatus(fallbackRunStatus)) {
    return projectRunStatusToA2a(fallbackRunStatus);
  }
  return null;
}

function extractRunStatus(event) {
  const candidates = [
    event.status,
    event.runStatus,
    event.run_status,
    // Governance-recorded transitions store `{ context, data }` payloads.
    event.data?.status,
    event.data?.runStatus,
    event.payload?.status,
    event.payload?.runStatus,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && isRunStatus(c)) return c;
  }
  return null;
}

/**
 * Build a protocol-valid A2A Message for TaskStatus.message, or null to omit.
 *
 * Spec: Message.messageId is REQUIRED when a Message object is present.
 * Synthetic "Task state: …" messages are omitted so strict clients (e.g.
 * a2a-python Pydantic) never reject status-update frames; real reasons keep
 * a stable, deterministic messageId for stream replay.
 *
 * @param {object} event
 * @param {string} a2aStatus
 * @param {{
 *   a2aTaskId?: string,
 *   contextId?: string | null,
 *   sequence?: number,
 *   eventId?: string | null,
 * }} [ctx]
 * @returns {object | null}
 */
function statusMessage(event, a2aStatus, ctx = {}) {
  const reason =
    event.statusReason ||
    event.status_reason ||
    event.reason ||
    event.payload?.statusReason ||
    null;
  if (typeof reason !== 'string' || !reason.trim()) {
    return null;
  }
  const seq =
    Number.isFinite(Number(ctx.sequence)) && Number(ctx.sequence) >= 0
      ? Number(ctx.sequence)
      : 0;
  const messageId =
    (typeof event.messageId === 'string' && event.messageId.trim()) ||
    (typeof event.message_id === 'string' && event.message_id.trim()) ||
    (typeof ctx.eventId === 'string' && ctx.eventId.trim()) ||
    `a2a-status-${ctx.a2aTaskId || 'task'}-${seq}-${a2aStatus}`;
  /** @type {Record<string, unknown>} */
  const msg = {
    messageId,
    role: 'agent',
    parts: [{ kind: 'text', text: reason.trim().slice(0, 500) }],
    kind: 'message',
  };
  if (typeof ctx.a2aTaskId === 'string' && ctx.a2aTaskId) {
    msg.taskId = ctx.a2aTaskId;
  }
  if (typeof ctx.contextId === 'string' && ctx.contextId) {
    msg.contextId = ctx.contextId;
  }
  return msg;
}

/**
 * @param {object[]} envelopes
 * @param {object} ctx
 */
export function collectArtifactsFromEnvelopes(envelopes, ctx) {
  const artifacts = [];
  const seen = new Set();
  for (const env of envelopes || []) {
    const projected = projectEnvelopeToA2aResult(env, ctx);
    if (projected?.kind !== 'artifact-update') continue;
    const art = projected.result?.artifact;
    if (!art?.artifactId) continue;
    if (seen.has(art.artifactId)) continue;
    seen.add(art.artifactId);
    artifacts.push(art);
  }
  return artifacts;
}

/** Safety ceiling for GetTask event-scan fallback (not silent truncate). */
export const GET_TASK_EVENT_SCAN_MAX = 10_000;
export const GET_TASK_ARTIFACT_MAX = 500;
