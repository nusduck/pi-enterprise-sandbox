import type { SSEEvent } from '../../shared/sse/parser';
import type { PersistedAgentEvent } from '../../shared/schemas/events';

/** Preserve durable sequence and event id for the same live reducer path. */
export function persistedEventPayload(event: PersistedAgentEvent): SSEEvent {
  return {
    ...(event.payload || {}),
    type: event.type,
    eventId: event.event_id,
    event_id: event.event_id,
    sequence: event.sequence,
    persisted_event_id: event.event_id,
    persisted_sequence: event.sequence,
    timestamp: event.created_at || undefined,
  } as SSEEvent;
}
