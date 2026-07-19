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

/** Platform event types that carry Run status transitions. */
const RUN_STATUS_EVENT_TYPES = new Set([
  'run.accepted',
  'run.queued',
  'run.starting',
  'run.started',
  'run.running',
  'run.waiting_input',
  'run.waiting_approval',
  'run.cancelling',
  'run.retrying',
  'run.succeeded',
  'run.failed',
  'run.cancelled',
  'run.status',
  'run.terminal',
]);

/** Explicit artifact delivery only (plan §2.8 / §20.5). */
const ARTIFACT_EVENT_TYPES = new Set([
  'artifact.ready',
  'artifact.created',
]);

/**
 * @param {object} envelope
 * @param {{
 *   a2aTaskId: string,
 *   contextId?: string | null,
 *   runStatus?: string | null,
 *   principal?: { orgId?: string, clientId?: string } | null,
 *   buildDownloadUri?: ((input: object) => string | null) | null,
 * }} ctx
 */
export function projectEnvelopeToA2aResult(envelope, ctx) {
  if (!envelope || typeof envelope !== 'object') return null;
  const event =
    envelope.event && typeof envelope.event === 'object'
      ? envelope.event
      : envelope;
  const type = String(event.type || event.event_type || '');
  const sequence = Number(envelope.sequence);
  const eventId =
    envelope.eventId ||
    envelope.event_id ||
    event.eventId ||
    event.event_id ||
    null;

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
        contextId: ctx.contextId ?? null,
        artifact,
        append: false,
        lastChunk: true,
        metadata: {
          sequence,
          eventId,
          sourceEventType: type,
        },
      },
    };
  }

  if (RUN_STATUS_EVENT_TYPES.has(type) || type.startsWith('run.')) {
    const status = resolveStatusFromEvent(event, ctx.runStatus);
    if (!status) return null;
    const final = isTerminalA2aTaskStatus(status);
    return {
      kind: 'status-update',
      sequence,
      eventId,
      result: {
        kind: 'status-update',
        taskId: ctx.a2aTaskId,
        contextId: ctx.contextId ?? null,
        status: {
          state: status,
          timestamp: envelope.ts
            ? new Date(envelope.ts).toISOString()
            : new Date().toISOString(),
          message: statusMessage(event, status),
        },
        final,
        metadata: {
          sequence,
          eventId,
          sourceEventType: type,
          runStatus: extractRunStatus(event) ?? ctx.runStatus ?? null,
        },
      },
    };
  }

  return null;
}

/**
 * @param {{
 *   a2aTaskId: string,
 *   contextId?: string | null,
 *   runStatus: string,
 *   createdAt?: string | null,
 *   updatedAt?: string | null,
 *   artifacts?: object[],
 *   metadata?: Record<string, unknown>,
 * }} input
 */
export function buildA2aTaskObject(input) {
  const state = projectRunStatusToA2a(input.runStatus);
  return {
    id: input.a2aTaskId,
    contextId: input.contextId ?? null,
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
  const filePart = {
    kind: 'file',
    file: {
      name,
      mimeType:
        typeof mimeType === 'string' ? mimeType : 'application/octet-stream',
    },
  };
  if (uri) {
    filePart.file.uri = uri;
  }
  parts.push(filePart);

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

  return {
    artifactId,
    name,
    description:
      typeof event.description === 'string'
        ? event.description.slice(0, 512)
        : typeof data.description === 'string'
          ? data.description.slice(0, 512)
          : typeof payload.description === 'string'
            ? payload.description.slice(0, 512)
            : null,
    parts,
    metadata: {
      mimeType: typeof mimeType === 'string' ? mimeType : 'application/octet-stream',
      sizeBytes:
        sizeBytes != null && Number.isFinite(Number(sizeBytes))
          ? Number(sizeBytes)
          : null,
      // Explicitly omit path / relative_path / workspace fields.
    },
  };
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

function resolveStatusFromEvent(event, fallbackRunStatus) {
  const fromEvent = extractRunStatus(event);
  if (fromEvent) return projectRunStatusToA2a(fromEvent);
  if (fallbackRunStatus && isRunStatus(fallbackRunStatus)) {
    return projectRunStatusToA2a(fallbackRunStatus);
  }
  const type = String(event.type || event.event_type || '');
  const map = {
    'run.accepted': A2A_TASK_STATUS.SUBMITTED,
    'run.queued': A2A_TASK_STATUS.SUBMITTED,
    'run.starting': A2A_TASK_STATUS.WORKING,
    'run.started': A2A_TASK_STATUS.WORKING,
    'run.running': A2A_TASK_STATUS.WORKING,
    'run.waiting_input': A2A_TASK_STATUS.INPUT_REQUIRED,
    'run.waiting_approval': A2A_TASK_STATUS.AUTH_REQUIRED,
    'run.cancelling': A2A_TASK_STATUS.WORKING,
    'run.retrying': A2A_TASK_STATUS.WORKING,
    'run.succeeded': A2A_TASK_STATUS.COMPLETED,
    'run.failed': A2A_TASK_STATUS.FAILED,
    'run.cancelled': A2A_TASK_STATUS.CANCELED,
  };
  return map[type] || null;
}

function extractRunStatus(event) {
  const candidates = [
    event.status,
    event.runStatus,
    event.run_status,
    event.payload?.status,
    event.payload?.runStatus,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && isRunStatus(c)) return c;
  }
  return null;
}

function statusMessage(event, a2aStatus) {
  const reason =
    event.statusReason ||
    event.status_reason ||
    event.reason ||
    event.payload?.statusReason ||
    null;
  if (typeof reason === 'string' && reason.trim()) {
    return {
      role: 'agent',
      parts: [{ kind: 'text', text: reason.trim().slice(0, 500) }],
      kind: 'message',
    };
  }
  return {
    role: 'agent',
    parts: [{ kind: 'text', text: `Task state: ${a2aStatus}` }],
    kind: 'message',
  };
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
