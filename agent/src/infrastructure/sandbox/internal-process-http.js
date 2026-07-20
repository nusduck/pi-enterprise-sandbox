/** Agent -> Sandbox HMAC transport for process_start/status/read/kill. */
import { createHash } from 'node:crypto';
import { computeToolRequestHashV1 } from '../../domain/tool/tool-request-hash.js';
import { assertUlid } from '../../domain/shared/ulid.js';
import { issueInternalToken, validateInternalHmacKeyring } from './internal-hmac.js';
import { normalizeBaseUrl } from './internal-files-read-http.js';
import { createTraceHeaders } from './trace-context.js';

const ROUTES = Object.freeze({
  process_start: ['/internal/v1/processes/start', 'sandbox.processes.process_start'],
  process_status: ['/internal/v1/processes/status', 'sandbox.processes.process_status'],
  process_read: ['/internal/v1/processes/read', 'sandbox.processes.process_read'],
  process_kill: ['/internal/v1/processes/kill', 'sandbox.processes.process_kill'],
});
const PROCESS_SIGNALS = new Set(['TERM', 'KILL', 'INT']);
export const PROCESS_START_HTU = ROUTES.process_start[0];
export const PROCESS_STATUS_HTU = ROUTES.process_status[0];
export const PROCESS_READ_HTU = ROUTES.process_read[0];
export const PROCESS_KILL_HTU = ROUTES.process_kill[0];
export const DEFAULT_PROCESS_TIMEOUT_MS = 30_000;

class InternalProcessTransportError extends Error {
  constructor(code, message, extra = {}) {
    super(message); this.name = 'InternalProcessTransportError'; this.code = code;
    if (extra.httpStatus != null) this.httpStatus = extra.httpStatus;
    if (extra.outcomeUnknown === true) this.outcomeUnknown = true;
    if (extra.retryable != null) this.retryable = extra.retryable;
  }
}
function fail(code, message, extra) { throw new InternalProcessTransportError(code, message, extra); }
function plain(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function reqUlid(v, field) { try { return assertUlid(v, field); } catch { fail('PROCESS_PAYLOAD_INVALID', `${field} must be a formal ULID`); } }
function reqText(v, field, max = 255) { if (typeof v !== 'string' || !v || v.length > max || v !== v.trim()) fail('PROCESS_PAYLOAD_INVALID', `${field} invalid`); return v; }
function reqInt(v, field, min, max) { if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) fail('PROCESS_PAYLOAD_INVALID', `${field} invalid`); return v; }
function identity(ctx) {
  if (!plain(ctx) || Object.keys(ctx).length !== 8) fail('PROCESS_PAYLOAD_INVALID', 'identity keys invalid');
  const trace = reqText(ctx.traceId, 'identity.traceId', 32);
  if (!/^[0-9a-f]{32}$/.test(trace)) fail('PROCESS_PAYLOAD_INVALID', 'identity.traceId invalid');
  return { orgId: reqUlid(ctx.orgId, 'identity.orgId'), userId: reqUlid(ctx.userId, 'identity.userId'), conversationId: reqUlid(ctx.conversationId, 'identity.conversationId'), agentSessionId: reqUlid(ctx.agentSessionId, 'identity.agentSessionId'), runId: reqUlid(ctx.runId, 'identity.runId'), sandboxSessionId: reqUlid(ctx.sandboxSessionId, 'identity.sandboxSessionId'), traceId: trace, executionFenceToken: reqInt(ctx.executionFenceToken, 'identity.executionFenceToken', 1, Number.MAX_SAFE_INTEGER) };
}
function normalize(toolName, payload) {
  if (!plain(payload) || !ROUTES[toolName]) fail('PROCESS_PAYLOAD_INVALID', 'payload invalid');
  const expected = new Set(['identity', 'toolExecutionId', 'toolCallId', 'requestHash', 'requestHashVersion', ...(toolName === 'process_start' ? ['command', 'env', 'timeoutSeconds'] : ['processId', ...(toolName === 'process_read' ? ['stream', 'cursor', 'limit'] : []), ...(toolName === 'process_kill' ? ['signal'] : [])])]);
  if (Object.keys(payload).length !== expected.size || Object.keys(payload).some((key) => !expected.has(key))) fail('PROCESS_PAYLOAD_INVALID', 'payload keys invalid');
  const id = identity(payload.identity || {});
  const requestHash = reqText(payload.requestHash, 'requestHash', 64);
  if (!/^[0-9a-f]{64}$/.test(requestHash)) fail('PROCESS_PAYLOAD_INVALID', 'requestHash invalid');
  const out = { identity: id, toolExecutionId: reqUlid(payload.toolExecutionId, 'toolExecutionId'), toolCallId: reqText(payload.toolCallId, 'toolCallId'), requestHash, requestHashVersion: reqInt(payload.requestHashVersion, 'requestHashVersion', 1, 1) };
  if (toolName === 'process_start') {
    out.command = reqText(payload.command, 'command', 8192); out.env = plain(payload.env) ? payload.env : {};
    if (Object.keys(out.env).length > 32 || Object.entries(out.env).some(([k, v]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || k.length > 64 || typeof v !== 'string' || v.length > 1024)) fail('PROCESS_PAYLOAD_INVALID', 'env invalid');
    out.timeoutSeconds = reqInt(payload.timeoutSeconds, 'timeoutSeconds', 1, 86400);
  } else {
    out.processId = reqUlid(payload.processId, 'processId');
    if (toolName === 'process_read') { out.stream = payload.stream; if (out.stream !== 'stdout' && out.stream !== 'stderr') fail('PROCESS_PAYLOAD_INVALID', 'stream invalid'); out.cursor = reqText(payload.cursor, 'cursor', 128); out.limit = reqInt(payload.limit, 'limit', 1, 65536); }
    if (toolName === 'process_kill') {
      out.signal = reqText(payload.signal, 'signal', 16);
      if (!PROCESS_SIGNALS.has(out.signal)) fail('PROCESS_PAYLOAD_INVALID', 'signal invalid');
    }
  }
  const args = toolName === 'process_start' ? { command: out.command, env: out.env, timeoutSeconds: out.timeoutSeconds } : toolName === 'process_status' ? { processId: out.processId } : toolName === 'process_read' ? { processId: out.processId, stream: out.stream, cursor: out.cursor, limit: out.limit } : { processId: out.processId, signal: out.signal };
  let hash; try { hash = computeToolRequestHashV1({ toolName, args }); } catch { fail('PROCESS_HASH_INVALID', 'request hash cannot be computed'); }
  if (hash.requestHash !== out.requestHash || hash.requestHashVersion !== out.requestHashVersion) fail('PROCESS_HASH_INVALID', 'requestHash mismatch');
  return out;
}

export function createInternalProcessTransport(options) {
  if (!options || typeof options !== 'object') fail('PROCESS_TRANSPORT_CONFIG', 'options object is required');
  const baseUrl = normalizeBaseUrl(options.baseUrl, { allowInsecureHttp: options.allowInsecureHttp === true });
  const fetchImpl = options.fetchImpl ?? globalThis.fetch; if (typeof fetchImpl !== 'function') fail('PROCESS_TRANSPORT_CONFIG', 'fetchImpl must be a function');
  validateInternalHmacKeyring(options.keyring, options.activeKid);
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS;
  async function call(toolName, payload) {
    const normalized = normalize(toolName, payload);
    const body = Buffer.from(JSON.stringify(normalized), 'utf8');
    const bodySha256 = createHash('sha256').update(body).digest('hex');
    const [htu, scope] = ROUTES[toolName];
    const token = issueInternalToken({ keyring: options.keyring, activeKid: options.activeKid, clock: options.clock, randomBytes: options.randomBytes, ttlSeconds: options.ttlSeconds, claims: { org_id: normalized.identity.orgId, user_id: normalized.identity.userId, conversation_id: normalized.identity.conversationId, agent_session_id: normalized.identity.agentSessionId, sandbox_session_id: normalized.identity.sandboxSessionId, run_id: normalized.identity.runId, tool_execution_id: normalized.toolExecutionId, tool_call_id: normalized.toolCallId, tool_name: toolName, scope: [scope], request_hash: normalized.requestHash, execution_fence_token: normalized.identity.executionFenceToken, trace_id: normalized.identity.traceId, htm: 'POST', htu, body_sha256: bodySha256 } });
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Let undici generate Content-Length for the Buffer body. The signed
    // body_sha256 remains the integrity binding; forcing the header can throw
    // UND_ERR_INVALID_ARG before the request leaves the Agent process.
    let response; try { response = await fetchImpl(`${baseUrl}${htu}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json', ...createTraceHeaders(normalized.identity.traceId, { randomBytes: options.spanRandomBytes, traceState: options.traceState }) }, body, signal: controller.signal }); } catch (err) { fail('PROCESS_TRANSPORT_UNAVAILABLE', 'Sandbox process request failed', { outcomeUnknown: true, cause: err }); } finally { clearTimeout(timer); }
    const text = await response.text(); let parsed; try { parsed = text ? JSON.parse(text) : {}; } catch { fail('PROCESS_RESPONSE_INVALID', 'Sandbox returned invalid JSON'); }
    if (!response.ok) { const code = plain(parsed?.error) && typeof parsed.error.code === 'string' ? parsed.error.code : 'SANDBOX_ERROR'; fail(code, 'Sandbox process request failed', { httpStatus: response.status, outcomeUnknown: code === 'TOOL_OUTCOME_UNKNOWN' }); }
    if (!plain(parsed)) fail('PROCESS_RESPONSE_INVALID', 'Sandbox response must be object');
    return parsed;
  }
  return Object.freeze({
    processStart: (payload) => call('process_start', payload),
    processStatus: (payload) => call('process_status', payload),
    processRead: (payload) => call('process_read', payload),
    processKill: (payload) => call('process_kill', payload),
  });
}

export { InternalProcessTransportError };
