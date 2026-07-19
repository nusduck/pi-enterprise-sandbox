/** Agent -> Sandbox HMAC transport for formal submit_artifact. */
import { createHash } from 'node:crypto';
import { assertUlid } from '../../domain/shared/ulid.js';
import { computeToolRequestHashV1 } from '../../domain/tool/tool-request-hash.js';
import { issueInternalToken, validateInternalHmacKeyring } from './internal-hmac.js';
import { normalizeBaseUrl } from './internal-files-read-http.js';
import { createTraceHeaders } from './trace-context.js';

export const ARTIFACT_SUBMIT_HTU = '/internal/v1/artifacts/submit';
export const ARTIFACT_SUBMIT_SCOPE = 'sandbox.artifacts.submit';
export const ARTIFACT_SUBMIT_TOOL = 'submit_artifact';

export class InternalArtifactTransportError extends Error {
  constructor(code, message, extra = {}) { super(message); this.name = 'InternalArtifactTransportError'; this.code = code; Object.assign(this, extra); }
}
const fail = (code, message, extra) => { throw new InternalArtifactTransportError(code, message, extra); };
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function ulid(v, field) { try { return assertUlid(v, field); } catch { fail('ARTIFACT_PAYLOAD_INVALID', `${field} invalid`); } }
function text(v, field, max = 255) { if (typeof v !== 'string' || !v || v.length > max || v !== v.trim() || !/^[\x21-\x7e]+$/.test(v)) fail('ARTIFACT_PAYLOAD_INVALID', `${field} invalid`); return v; }
function unicodeText(v, field, max) { if (typeof v !== 'string' || !v || v.length > max || v !== v.trim() || /[\u0000-\u001f\u007f]/u.test(v)) fail('ARTIFACT_PAYLOAD_INVALID', `${field} invalid`); return v; }
function path(v) { const p = text(v, 'path', 512); const prefix = '/home/sandbox/workspace/'; if (!p.startsWith(prefix) || p.endsWith('/') || p.includes('//')) fail('ARTIFACT_PATH_INVALID', 'path invalid'); const parts = p.slice(prefix.length).split('/'); if (!parts.length || parts.some((s) => !s || s === '.' || s === '..' || s.includes('\\'))) fail('ARTIFACT_PATH_INVALID', 'path invalid'); return p; }
function identity(v) {
  if (!plain(v) || Object.keys(v).length !== 8) fail('ARTIFACT_PAYLOAD_INVALID', 'identity invalid');
  const traceId = text(v.traceId, 'identity.traceId', 32); if (!/^[0-9a-f]{32}$/.test(traceId)) fail('ARTIFACT_PAYLOAD_INVALID', 'traceId invalid');
  if (!Number.isSafeInteger(v.executionFenceToken) || v.executionFenceToken <= 0) fail('ARTIFACT_PAYLOAD_INVALID', 'executionFenceToken invalid');
  return { orgId: ulid(v.orgId, 'identity.orgId'), userId: ulid(v.userId, 'identity.userId'), conversationId: ulid(v.conversationId, 'identity.conversationId'), agentSessionId: ulid(v.agentSessionId, 'identity.agentSessionId'), runId: ulid(v.runId, 'identity.runId'), sandboxSessionId: ulid(v.sandboxSessionId, 'identity.sandboxSessionId'), traceId, executionFenceToken: v.executionFenceToken };
}

export function validateAndNormalizeArtifactPayload(payload) {
  if (!plain(payload)) fail('ARTIFACT_PAYLOAD_INVALID', 'payload must be object');
  const allowed = new Set(['path', 'displayName', 'description', 'identity', 'toolExecutionId', 'toolCallId', 'requestHash', 'requestHashVersion']);
  const required = ['path', 'identity', 'toolExecutionId', 'toolCallId', 'requestHash', 'requestHashVersion'];
  if (Object.keys(payload).some((k) => !allowed.has(k)) || required.some((k) => !Object.hasOwn(payload, k))) fail('ARTIFACT_PAYLOAD_INVALID', 'payload keys invalid');
  const out = { path: path(payload.path) };
  if (Object.hasOwn(payload, 'displayName')) out.displayName = payload.displayName == null ? null : unicodeText(payload.displayName, 'displayName', 256);
  if (Object.hasOwn(payload, 'description')) out.description = payload.description == null ? null : unicodeText(payload.description, 'description', 1024);
  const id = identity(payload.identity);
  const toolExecutionId = ulid(payload.toolExecutionId, 'toolExecutionId');
  const toolCallId = text(payload.toolCallId, 'toolCallId');
  const requestHash = text(payload.requestHash, 'requestHash', 64);
  if (!/^[0-9a-f]{64}$/.test(requestHash) || payload.requestHashVersion !== 1) fail('ARTIFACT_HASH_INVALID', 'request hash invalid');
  let computed; try { computed = computeToolRequestHashV1({ toolName: ARTIFACT_SUBMIT_TOOL, args: out }); } catch { fail('ARTIFACT_HASH_INVALID', 'request hash cannot be computed'); }
  if (computed.requestHash !== requestHash) fail('ARTIFACT_HASH_INVALID', 'request hash mismatch');
  return { ...out, identity: id, toolExecutionId, toolCallId, requestHash, requestHashVersion: 1 };
}

export function createInternalArtifactSubmitTransport(options = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl, { allowInsecureHttp: options.allowInsecureHttp === true });
  const fetchImpl = options.fetchImpl ?? globalThis.fetch; if (typeof fetchImpl !== 'function') fail('SANDBOX_TRANSPORT_CONFIG', 'fetchImpl required');
  if (typeof options.tokenIssuer !== 'function') validateInternalHmacKeyring(options.keyring, options.activeKid);
  return Object.freeze({
    async submitArtifact(payload) {
      const normalized = validateAndNormalizeArtifactPayload(payload);
      const body = Buffer.from(JSON.stringify(normalized), 'utf8');
      const bodySha256 = createHash('sha256').update(body).digest('hex');
      const claims = { org_id: normalized.identity.orgId, user_id: normalized.identity.userId, conversation_id: normalized.identity.conversationId, agent_session_id: normalized.identity.agentSessionId, sandbox_session_id: normalized.identity.sandboxSessionId, run_id: normalized.identity.runId, tool_execution_id: normalized.toolExecutionId, tool_call_id: normalized.toolCallId, tool_name: ARTIFACT_SUBMIT_TOOL, scope: [ARTIFACT_SUBMIT_SCOPE], request_hash: normalized.requestHash, execution_fence_token: normalized.identity.executionFenceToken, trace_id: normalized.identity.traceId, htm: 'POST', htu: ARTIFACT_SUBMIT_HTU, body_sha256: bodySha256 };
      const token = typeof options.tokenIssuer === 'function' ? await options.tokenIssuer(claims, { bodyBytes: body, bodySha256 }) : issueInternalToken({ keyring: options.keyring, activeKid: options.activeKid, clock: options.clock, randomBytes: options.randomBytes, ttlSeconds: options.ttlSeconds, claims });
      let response;
      try { response = await fetchImpl(`${baseUrl}${ARTIFACT_SUBMIT_HTU}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': String(body.byteLength), ...createTraceHeaders(normalized.identity.traceId, { randomBytes: options.spanRandomBytes, traceState: options.traceState }) }, body, signal: options.signal }); }
      catch (cause) { fail('TOOL_OUTCOME_UNKNOWN', 'artifact submit outcome unknown', { outcomeUnknown: true, retryable: false, cause }); }
      let parsed; try { const raw = await response.text(); parsed = raw ? JSON.parse(raw) : {}; } catch { fail('SANDBOX_RESPONSE_INVALID', 'Sandbox returned invalid JSON', { httpStatus: response.status }); }
      if (!response.ok) { const e = plain(parsed?.error) ? parsed.error : plain(parsed?.detail) ? parsed.detail : null; const code = typeof e?.code === 'string' ? e.code : response.status === 409 ? 'SANDBOX_CONFLICT' : 'SANDBOX_ERROR'; fail(code, typeof e?.message === 'string' ? e.message.slice(0, 512) : 'artifact submit failed', { httpStatus: response.status, outcomeUnknown: code === 'TOOL_OUTCOME_UNKNOWN' }); }
      if (!plain(parsed)) fail('SANDBOX_RESPONSE_INVALID', 'response must be object');
      const artifactId = ulid(parsed.artifactId, 'artifactId');
      if (parsed.path !== normalized.path || typeof parsed.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(parsed.sha256) || !Number.isSafeInteger(parsed.size) || parsed.size < 0) fail('SANDBOX_RESPONSE_INVALID', 'artifact response invalid');
      if (typeof parsed.name !== 'string' || !parsed.name || typeof parsed.mimeType !== 'string' || !parsed.mimeType) fail('SANDBOX_RESPONSE_INVALID', 'artifact metadata invalid');
      return { artifactId, path: parsed.path, name: parsed.name, displayName: parsed.displayName ?? parsed.name, mimeType: parsed.mimeType, sha256: parsed.sha256, size: parsed.size, status: parsed.status ?? 'ready' };
    },
  });
}
