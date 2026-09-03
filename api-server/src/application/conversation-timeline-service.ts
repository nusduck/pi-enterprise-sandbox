/**
 * Build a complete, chronologically ordered persisted conversation timeline.
 *
 * PR-13: Agent MySQL is the sole Run/event fact source. Callers must pass a
 * client that talks to Agent (listAgentRuns + listAgentEvents), never Sandbox
 * /agent-runs dual ledger.
 */

export interface TimelineClient {
  listAgentRuns(q: { conversationId: string }): Promise<any>;
  listAgentEvents(runId: string, q?: { limit?: number; afterSequence?: number }): Promise<any>;
}

export interface PersistedTimelineEvent {
  run_id: string;
  sequence: number;
  event_id: string;
  type: string;
  payload: any;
  created_at?: string;
  schema_version?: number;
}

export interface ConversationTimelineResult {
  runs: any[];
  events: PersistedTimelineEvent[];
  last_run: any;
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function timelineContractError(message: string): Error & { status: number; code: string } {
  const error = new Error(message) as Error & { status: number; code: string };
  error.status = 502;
  error.code = 'AGENT_EVENT_CONTRACT_INVALID';
  return error;
}

function toIsoTimestamp(value: unknown): string | null {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value as string | number);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Project Agent history/SSE envelopes into the public durable event contract. */
export function presentPersistedTimelineEvent(raw: any, fallbackRunId?: string): PersistedTimelineEvent {
  if (!isPlainObject(raw)) {
    throw timelineContractError('Agent history contained a non-object event');
  }
  const inner = isPlainObject(raw['event']) ? raw['event'] : raw;
  const context = isPlainObject(inner['context']) ? inner['context'] : {};
  const runId = String(
    inner['run_id'] ??
      inner['runId'] ??
      context['run_id'] ??
      context['runId'] ??
      raw['run_id'] ??
      raw['runId'] ??
      fallbackRunId ??
      '',
  ).trim();
  const sequence = Number(raw['sequence'] ?? inner['sequence'] ?? inner['sequenceNo']);
  const eventId = String(
    inner['event_id'] ?? inner['eventId'] ?? raw['event_id'] ?? raw['eventId'] ?? '',
  ).trim();
  const type = String(
    inner['type'] ?? inner['event_type'] ?? inner['eventType'] ?? raw['type'] ?? '',
  ).trim();
  if (!runId || !Number.isSafeInteger(sequence) || sequence < 1 || !eventId || !type) {
    throw timelineContractError('Agent history event is missing durable identity fields');
  }

  let payload: Record<string, any>;
  if (isPlainObject(inner['payload']) && !inner['data'] && !inner['context']) {
    payload = { ...inner['payload'] };
  } else {
    payload = { ...inner };
    for (const key of [
      'type',
      'event_type',
      'eventType',
      'event_id',
      'eventId',
      'sequence',
      'sequenceNo',
      'created_at',
      'createdAt',
      'timestamp',
    ]) {
      delete payload[key];
    }
  }

  const createdAt = toIsoTimestamp(
    inner['created_at'] ??
      inner['createdAt'] ??
      inner['timestamp'] ??
      raw['created_at'] ??
      raw['createdAt'] ??
      raw['timestamp'] ??
      raw['ts'],
  );
  const schemaVersion = Number(
    inner['schema_version'] ?? inner['eventVersion'] ?? raw['schema_version'],
  );
  return {
    run_id: runId,
    sequence,
    event_id: eventId,
    type,
    payload,
    ...(createdAt ? { created_at: createdAt } : {}),
    ...(Number.isSafeInteger(schemaVersion) && schemaVersion > 0
      ? { schema_version: schemaVersion }
      : {}),
  };
}

export async function loadConversationTimeline(
  client: TimelineClient,
  conversationId: string,
  { limit }: { limit?: number } = {},
): Promise<ConversationTimelineResult> {
  const listed = await client.listAgentRuns({ conversationId });
  const runs: any[] = Array.isArray(listed)
    ? listed
    : Array.isArray(listed?.runs)
      ? listed.runs
      : [];
  const chronologicalRuns = [...runs].sort((a, b) =>
    String(a.created_at || a.createdAt || '').localeCompare(
      String(b.created_at || b.createdAt || ''),
    ),
  );
  const pageSize = Math.min(
    500,
    Math.max(1, Number.isFinite(limit) ? Number(limit) : 500),
  );
  const eventGroups = await Promise.all(
    chronologicalRuns.map(async (run) => {
      const runId = run.run_id || run.runId || run.id;
      if (!runId) return { run, events: [] };
      // Page through history until a short page — tools often land after many
      // message.delta frames, so a single 200-event page is not enough.
      const collected: any[] = [];
      let afterSequence = 0;
      for (let page = 0; page < 20; page += 1) {
        const batch = await client.listAgentEvents(runId, {
          limit: pageSize,
          afterSequence,
        });
        const rows = Array.isArray(batch) ? batch : [];
        if (rows.length === 0) break;
        collected.push(...rows);
        const last = rows[rows.length - 1];
        const lastSeq = Number(
          last?.sequence ?? last?.sequenceNo ?? last?.sequence_no,
        );
        if (!Number.isFinite(lastSeq) || lastSeq <= afterSequence) break;
        afterSequence = lastSeq;
        if (rows.length < pageSize) break;
      }
      return {
        run,
        events: collected.map((event) =>
          presentPersistedTimelineEvent(event, runId),
        ),
      };
    }),
  );
  return {
    runs: chronologicalRuns,
    events: eventGroups.flatMap(({ events }) => events),
    last_run: chronologicalRuns.at(-1) || null,
  };
}

