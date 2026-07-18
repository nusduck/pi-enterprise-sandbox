/**
 * SSE presentation helpers for platform event envelopes (plan §18.4).
 *
 * Wire shape:
 *   id: {eventId}
 *   event: {type}
 *   data: {JSON platform envelope or BFF relay envelope}
 *
 * Heartbeat:
 *   event: ping
 *   data: {"timestamp":"..."}
 */

import type { PlatformEventEnvelope } from './envelope.ts';

/**
 * Format one SSE event frame (includes trailing blank line).
 */
export function formatSseFrame(parts: {
  id?: string | number | null;
  event?: string | null;
  data: string | Record<string, unknown>;
}): string {
  const lines: string[] = [];
  if (parts.id != null && String(parts.id).length > 0) {
    lines.push(`id: ${String(parts.id)}`);
  }
  if (parts.event != null && String(parts.event).length > 0) {
    lines.push(`event: ${String(parts.event)}`);
  }
  const data =
    typeof parts.data === 'string' ? parts.data : JSON.stringify(parts.data);
  lines.push(`data: ${data}`);
  return `${lines.join('\n')}\n\n`;
}

/**
 * Plan §18.4 platform envelope → SSE frame.
 */
export function formatPlatformEventSse(envelope: PlatformEventEnvelope): string {
  return formatSseFrame({
    id: envelope.eventId,
    event: envelope.type,
    data: envelope,
  });
}

/**
 * Heartbeat / keep-alive frame.
 */
export function formatSsePing(timestamp: string = new Date().toISOString()): string {
  return formatSseFrame({
    event: 'ping',
    data: { timestamp },
  });
}

/**
 * Parse Last-Event-ID: numeric sequence or ULID event id.
 */
export function parseLastEventId(value: unknown): {
  sequence: number | null;
  eventId: string | null;
} {
  if (value == null) return { sequence: null, eventId: null };
  const s = String(value).trim();
  if (!s) return { sequence: null, eventId: null };
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return {
      sequence: Number.isSafeInteger(n) ? n : null,
      eventId: null,
    };
  }
  if (/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(s)) {
    return { sequence: null, eventId: s.toUpperCase() };
  }
  return { sequence: null, eventId: null };
}
