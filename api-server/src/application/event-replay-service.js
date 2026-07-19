/**
 * BFF event-replay helpers (PR-10 / plan §18.4).
 *
 * BFF does **not** own MySQL run_events or Redis streams. Agent is the replay
 * authority (MySQL history + Redis live). This module:
 *   - Parses public SSE resume cursors (afterSequence / Last-Event-ID)
 *   - Documents ownership / fail-closed expectations
 *   - Provides sequence-dedupe for any future BFF-side frame projection
 *
 * Forbidden: process-local event buffer as the state source for recovery.
 */

/** Crockford ULID (event id) or pure decimal sequence for Last-Event-ID. */
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

/**
 * @typedef {{ afterSequence: number, lastEventId: string|null }} SseResumeCursor
 */

/**
 * Parse resume cursor from query + headers.
 *
 * Supported:
 *   ?afterSequence=N | ?after_sequence=N | ?after=N
 *   Last-Event-ID: <sequence> | <event ULID>
 *
 * @param {{
 *   searchParams?: URLSearchParams | { get: (k: string) => string|null },
 *   headers?: Record<string, string|string[]|undefined>,
 * }} input
 * @returns {SseResumeCursor}
 */
export function parseSseResumeCursor(input = {}) {
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

  const rawLast =
    headers['last-event-id'] ??
    headers['Last-Event-ID'] ??
    headers['LAST-EVENT-ID'] ??
    null;
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
 * Build Agent internal events URL query.
 * @param {SseResumeCursor} cursor
 * @returns {string} query string without leading ?
 */
export function buildAgentEventsQuery(cursor) {
  const parts = [];
  const after = Math.max(0, Number(cursor?.afterSequence) || 0);
  if (after > 0) {
    parts.push(`after=${encodeURIComponent(String(after))}`);
    parts.push(`afterSequence=${encodeURIComponent(String(after))}`);
  }
  return parts.join('&');
}

/**
 * Sequence-monotonic dedupe for projected envelopes (defense-in-depth).
 * Live + historical paths may briefly overlap across reconnect / catch-up.
 *
 * @param {number} lastEmitted
 * @param {{ sequence?: number } | null | undefined} envelope
 * @returns {{ emit: boolean, next: number }}
 */
export function dedupeBySequence(lastEmitted, envelope) {
  const last = Math.max(0, Number(lastEmitted) || 0);
  const seq = Number(envelope?.sequence);
  if (!Number.isSafeInteger(seq) || seq < 0) {
    return { emit: false, next: last };
  }
  if (seq <= last) {
    return { emit: false, next: last };
  }
  return { emit: true, next: seq };
}

/**
 * Present create-run response in plan §18.3 dual-key shape when Agent returns
 * snake_case-only legacy fields.
 *
 * @param {object} result
 * @returns {object}
 */
export function presentCreateRunAccepted(result) {
  const runId = result?.runId || result?.run_id || null;
  const conversationId =
    result?.conversationId || result?.conversation_id || null;
  const agentSessionId =
    result?.agentSessionId || result?.agent_session_id || null;
  const status = result?.status || 'ACCEPTED';
  const eventsUrl =
    result?.eventsUrl ||
    result?.events_url ||
    (runId ? `/api/runs/${runId}/events` : null);

  return {
    ...result,
    runId,
    run_id: runId,
    conversationId,
    conversation_id: conversationId,
    agentSessionId,
    agent_session_id: agentSessionId,
    status,
    eventsUrl,
    events_url: eventsUrl,
  };
}
