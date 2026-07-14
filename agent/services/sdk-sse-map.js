/**
 * Map pi-coding-agent AgentSession events → BFF SSE payloads.
 *
 * Pure helpers used by the Agent Run event bridge and sdk-compat suite.
 * No live LLM / network dependency.
 */

/**
 * Pull structured fields from a tool result (object, string, or content parts).
 * @param {unknown} result
 * @returns {Record<string, unknown>}
 */
export function extractToolDetails(result) {
  if (!result) return {};
  if (typeof result === 'string') {
    return parseArtifactFieldsFromText(result);
  }
  if (typeof result !== 'object') return {};

  const sources = [];
  if (result.details && typeof result.details === 'object') sources.push(result.details);
  sources.push(result);
  if (Array.isArray(result.content)) {
    for (const part of result.content) {
      if (part?.type === 'text' && part.text) sources.push(parseArtifactFieldsFromText(part.text));
    }
  }

  const out = {};
  for (const s of sources) {
    if (!s || typeof s !== 'object') continue;
    for (const key of ['artifact_id', 'path', 'name', 'mime_type', 'size']) {
      if (out[key] == null && s[key] != null) out[key] = s[key];
    }
  }
  return out;
}

/**
 * @param {string} text
 * @returns {Record<string, unknown>}
 */
export function parseArtifactFieldsFromText(text) {
  if (!text || typeof text !== 'string') return {};
  const out = {};
  const id = text.match(/artifact_id[=:\s]+([a-zA-Z0-9_-]+)/);
  if (id) out.artifact_id = id[1];
  const path = text.match(/\bpath[=:\s]+([^\s,)]+)/);
  if (path) out.path = path[1];
  const size = text.match(/\bsize[=:\s]+(\d+)/);
  if (size) out.size = Number(size[1]);
  return out;
}

/**
 * Map a single SDK session event to zero or more BFF SSE events.
 *
 * Mutates `pendingToolArgs` for tool_start/tool_end correlation (file_ready).
 *
 * @param {object} event - AgentSessionEvent-like object
 * @param {{ pendingToolArgs?: Map<string, object> }} [ctx]
 * @returns {object[]} SSE payloads (each has `type`)
 */
export function mapSdkEventToSse(event, ctx = {}) {
  const pendingToolArgs = ctx.pendingToolArgs || new Map();
  const out = [];
  if (!event || typeof event !== 'object') return out;

  switch (event.type) {
    case 'message_update':
      if (event.assistantMessageEvent?.type === 'text_delta') {
        const delta = event.assistantMessageEvent.delta || '';
        out.push({ type: 'token', text: delta });
      }
      break;

    case 'tool_execution_start':
      out.push({
        type: 'tool_start',
        id: event.toolCallId,
        name: event.toolName,
        args: event.args,
      });
      if (event.args) pendingToolArgs.set(event.toolCallId, event.args);
      break;

    case 'tool_execution_end': {
      out.push({
        type: 'tool_end',
        id: event.toolCallId,
        name: event.toolName,
        result: event.result,
        isError: event.isError,
      });
      if (event.toolName === 'submit_artifact' && !event.isError) {
        const toolArgs = pendingToolArgs.get(event.toolCallId) || {};
        const details = {
          ...extractToolDetails(event.result),
          ...extractToolDetails(event.details),
        };
        const path = details.path || toolArgs.path;
        if (path || details.artifact_id) {
          const payload = { type: 'file_ready' };
          if (details.artifact_id) payload.artifact_id = details.artifact_id;
          if (path) payload.path = path;
          const name =
            details.name || toolArgs.name || (path ? String(path).split('/').pop() : undefined);
          if (name) payload.name = name;
          const mime = details.mime_type || toolArgs.mime_type;
          if (mime) payload.mime_type = mime;
          if (details.size != null) payload.size = details.size;
          out.push(payload);
        }
      }
      pendingToolArgs.delete(event.toolCallId);
      break;
    }

    case 'compaction_end':
      if (event.errorMessage) {
        out.push({
          type: 'compaction_failed',
          reason: event.reason,
          error: event.errorMessage,
          aborted: Boolean(event.aborted),
          will_retry: Boolean(event.willRetry),
        });
      }
      break;

    default:
      // Other SDK events (agent_start, turn_*, etc.) are not forwarded as BFF SSE.
      break;
  }

  return out;
}

/**
 * Lifecycle SSE events the BFF emits outside the SDK subscribe loop.
 * Documented for contract tests / golden vectors.
 */
export const BFF_LIFECYCLE_SSE_TYPES = Object.freeze([
  'trace',
  'session',
  'approval_required',
  'error',
  'done',
  'session_closed',
]);

/**
 * SDK event types the BFF currently maps into SSE.
 */
export const SDK_SUBSCRIBED_EVENT_TYPES = Object.freeze([
  'message_update',
  'tool_execution_start',
  'tool_execution_end',
  'compaction_end',
]);

/**
 * BFF SSE types produced from SDK subscribe events.
 */
export const SDK_MAPPED_SSE_TYPES = Object.freeze([
  'token',
  'tool_start',
  'tool_end',
  'file_ready',
  'compaction_failed',
]);
