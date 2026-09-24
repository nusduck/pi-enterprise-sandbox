/**
 * BFF event-replay helpers (PR-10 / plan §18.4).
 *
 * BFF does **not** own MySQL run_events or Redis streams. Agent is the replay
 * authority (MySQL history + Redis live). This module:
 *   - Parses public SSE resume cursors (afterSequence / Last-Event-ID)
 *   - Documents ownership / fail-closed expectations
 *
 * Forbidden: process-local event buffer as the state source for recovery.
 */

/** Crockford ULID (event id) or pure decimal sequence for Last-Event-ID. */
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

export interface SseResumeCursor {
  afterSequence: number;
  lastEventId: string | null;
}

export interface ParseSseResumeCursorInput {
  searchParams?: URLSearchParams | { get: (k: string) => string | null };
  headers?: Record<string, string | string[] | undefined>;
}

/**
 * Parse resume cursor from query + headers.
 */
export function parseSseResumeCursor(input: ParseSseResumeCursorInput = {}): SseResumeCursor {
  const params = input.searchParams;
  const headers = input.headers || {};

  let afterSequence = 0;
  if (params && typeof params.get === 'function') {
    for (const key of ['afterSequence', 'after_sequence', 'after']) {
      const raw = params.get(key);
      if (raw != null && /^\d+$/.test(String(raw).trim())) {
        afterSequence = Math.max(afterSequence, parseInt(String(raw).trim(), 10) || 0);
      }
    }
  }

  // Node lowercases inbound header names; the lowercase key is the only
  // reachable spelling of Last-Event-ID.
  const rawLast = headers['last-event-id'] ?? null;
  const lastEventId =
    typeof rawLast === 'string' && rawLast.trim()
      ? rawLast.trim()
      : Array.isArray(rawLast) && rawLast[0]
        ? String(rawLast[0]).trim()
        : null;

  if (lastEventId && /^\d+$/.test(lastEventId)) {
    afterSequence = Math.max(afterSequence, parseInt(lastEventId, 10) || 0);
    return { afterSequence, lastEventId: null };
  }

  if (lastEventId && ULID_RE.test(lastEventId)) {
    return { afterSequence, lastEventId: lastEventId.toUpperCase() };
  }

  // Unknown Last-Event-ID shape: ignore id, keep numeric afterSequence only.
  return { afterSequence, lastEventId: null };
}

/**
 * Present the Agent create-run response on the public wire contract.
 */
export function presentCreateRunAccepted(result: any): Record<string, unknown> {
  const runId = result?.run_id || null;
  const sandboxSessionId =
    result?.sandbox_session_id || result?.session_id || null;

  return {
    ...result,
    run_id: runId,
    conversation_id: result?.conversation_id || null,
    agent_session_id: result?.agent_session_id || null,
    // Both names for the sandbox session: upload / artifact-download read
    // `session_id`, run-scoped callers read `sandbox_session_id`.
    session_id: sandboxSessionId,
    sandbox_session_id: sandboxSessionId,
    status: result?.status || 'ACCEPTED',
    events_url:
      result?.events_url || (runId ? `/api/runs/${runId}/events` : null),
  };
}

