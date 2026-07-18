/**
 * ToolExecutionRepository (plan §8.12 / PR-06 B2).
 *
 * Ownership: every read/write is owner-scoped via join to runs (org_id+user_id)
 * with explicit `.select('te.*')` so MySQL does not collapse Run.status/created_at
 * over child columns.
 *
 * Integrity: SHA-256 over full canonical original input (no silent truncate).
 * Metadata stored in an unambiguous envelope; public mapping unwraps payload only.
 */

import { createHash } from 'node:crypto';
import { applyOwnerScope, requireOwnerScope } from '../ownership.js';
import {
  mapToolExecution,
  toMysqlDateTime,
  parseJsonColumn,
} from '../row-mappers.js';
import { ConflictError, NotFoundError } from '../errors.js';
import { assertUlid } from '../../../domain/shared/ulid.js';
import {
  assertToolExecutionStatus,
  assertToolSource,
  assertToolRiskLevel,
  canTransitionToolExecution,
  isTerminalToolExecutionStatus,
  TOOL_EXECUTION_STATUS,
  TOOL_SOURCE,
} from '../../../domain/tool/tool-execution-status.js';
import { SESSION_STATUS } from '../../../domain/session/session-status.js';
import { RUN_STATUS } from '../../../domain/run/run-status.js';
import { redactPayload } from '../../pi/platform-event-projector.js';

const TOOL_CALL_ID_MAX = 255;
const TOOL_NAME_MAX = 255;
const TRACE_ID_RE = /^[0-9a-f]{32}$/i;
const REQUEST_HASH_RE = /^[0-9a-f]{64}$/;
const MAX_ARGS_JSON_BYTES = 64 * 1024;
const MAX_RESULT_JSON_BYTES = 128 * 1024;
/** Explicit max for canonical original before hashing (reject, never truncate). */
export const MAX_INTEGRITY_CANONICAL_BYTES = 1_048_576;

/** Legacy reserved key rejected in caller objects. */
export const INTEGRITY_META_KEY = '_integrity';

/** Internal envelope keys — never part of public payload. */
export const ENVELOPE_VERSION = 1;
export const ENVELOPE_KEYS = Object.freeze([
  '$v',
  '$integrity',
  '$payload',
  '$policyFingerprint',
]);

/**
 * Recursion-stack cycle detection (add/delete) so shared DAG refs serialize
 * repeatedly, while true cycles become "[Circular]".
 *
 * @param {unknown} value
 * @param {Set<object>} [stack]
 * @returns {string}
 */
export function stableCanonicalStringify(value, stack = new Set()) {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return 'null';
  }
  if (value === null) return 'null';
  if (typeof value === 'bigint') return JSON.stringify(String(value));
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'null';
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') return 'null';

  const objRef = /** @type {object} */ (value);
  if (stack.has(objRef)) {
    return JSON.stringify('[Circular]');
  }
  stack.add(objRef);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((v) => stableCanonicalStringify(v, stack)).join(',')}]`;
    }
    if (value instanceof Date) {
      return JSON.stringify(value.toISOString());
    }
    if (Buffer.isBuffer(value)) {
      return JSON.stringify({ $buf: value.toString('base64') });
    }
    const obj = /** @type {Record<string, unknown>} */ (value);
    const keys = Object.keys(obj).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${stableCanonicalStringify(obj[k], stack)}`)
      .join(',')}}`;
  } finally {
    stack.delete(objRef);
  }
}

/**
 * Reject reserved keys at top-level of plain objects (caller data, not envelope).
 * @param {unknown} original
 */
export function assertNoReservedIntegrityKeys(original) {
  if (!original || typeof original !== 'object' || Array.isArray(original)) {
    return;
  }
  const obj = /** @type {Record<string, unknown>} */ (original);
  if (Object.prototype.hasOwnProperty.call(obj, INTEGRITY_META_KEY)) {
    throw new Error(
      `RESERVED_KEY_FORBIDDEN: arguments/result must not include "${INTEGRITY_META_KEY}"`,
    );
  }
  for (const k of ENVELOPE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) {
      throw new Error(
        `RESERVED_KEY_FORBIDDEN: arguments/result must not include reserved key "${k}"`,
      );
    }
  }
}

/**
 * Full-string SHA-256; rejects oversized canonical forms (no truncate).
 * @param {unknown} value
 * @returns {string}
 */
export function integrityFingerprint(value) {
  const canonical = stableCanonicalStringify(value ?? null);
  const bytes = Buffer.byteLength(canonical, 'utf8');
  if (bytes > MAX_INTEGRITY_CANONICAL_BYTES) {
    const err = new Error(
      `INTEGRITY_INPUT_TOO_LARGE: canonical form is ${bytes} bytes (max ${MAX_INTEGRITY_CANONICAL_BYTES})`,
    );
    /** @type {any} */ (err).code = 'INTEGRITY_INPUT_TOO_LARGE';
    throw err;
  }
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * @deprecated use integrityFingerprint
 * @param {unknown} args
 */
export function fingerprintToolArgs(args) {
  return integrityFingerprint(args);
}

/**
 * Normalized policy decision fingerprint (exact field set, no extra secrets).
 * @param {{
 *   decision: string,
 *   reasonCode: string,
 *   reason: string,
 *   policyId: string,
 *   riskLevel: string,
 * }} decision
 * @returns {string}
 */
export function policyDecisionFingerprint(decision) {
  if (!decision || typeof decision !== 'object') {
    throw new Error('policyDecisionFingerprint requires a decision object');
  }
  const normalized = {
    decision: String(decision.decision ?? ''),
    reasonCode: String(decision.reasonCode ?? ''),
    reason: String(decision.reason ?? ''),
    policyId: String(decision.policyId ?? ''),
    riskLevel: String(decision.riskLevel ?? ''),
  };
  return integrityFingerprint(normalized);
}

/**
 * Pack redacted public value + integrity of original in unambiguous envelope.
 * Optional policyFingerprint is hidden metadata (never in $payload).
 *
 * @param {unknown} original
 * @param {number} maxBytes
 * @param {{ policyFingerprint?: string | null }} [opts]
 * @returns {string}
 */
export function packJsonWithIntegrity(original, maxBytes, opts = {}) {
  assertNoReservedIntegrityKeys(original);
  const hash = integrityFingerprint(original ?? null);
  const redacted = redactPayload(original ?? null);
  /** @type {Record<string, unknown>} */
  const envelope = {
    $v: ENVELOPE_VERSION,
    $integrity: hash,
    $payload: redacted,
  };
  if (opts.policyFingerprint != null && opts.policyFingerprint !== '') {
    const pf = String(opts.policyFingerprint).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(pf)) {
      throw new Error('policyFingerprint must be 64 hex chars');
    }
    envelope.$policyFingerprint = pf;
  }
  const raw = JSON.stringify(envelope);
  if (Buffer.byteLength(raw, 'utf8') > maxBytes) {
    throw new Error(`JSON exceeds max ${maxBytes} bytes after redaction`);
  }
  return raw;
}

/**
 * @param {unknown} stored
 * @returns {string | null}
 */
export function extractIntegrity(stored) {
  if (stored == null) return null;
  let obj = stored;
  if (typeof stored === 'string') {
    try {
      obj = JSON.parse(stored);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  // Envelope form
  if (
    /** @type {any} */ (obj).$v === ENVELOPE_VERSION &&
    typeof /** @type {any} */ (obj).$integrity === 'string'
  ) {
    const h = /** @type {any} */ (obj).$integrity;
    return /^[0-9a-f]{64}$/i.test(h) ? h.toLowerCase() : null;
  }
  // Legacy sibling form
  const h = /** @type {any} */ (obj)[INTEGRITY_META_KEY];
  return typeof h === 'string' && /^[0-9a-f]{64}$/i.test(h) ? h.toLowerCase() : null;
}

/**
 * Extract hidden policy fingerprint from stored envelope (null if absent).
 * @param {unknown} stored
 * @returns {string | null}
 */
export function extractPolicyFingerprint(stored) {
  if (stored == null) return null;
  let obj = stored;
  if (typeof stored === 'string') {
    try {
      obj = JSON.parse(stored);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (/** @type {any} */ (obj).$v !== ENVELOPE_VERSION) return null;
  const pf = /** @type {any} */ (obj).$policyFingerprint;
  return typeof pf === 'string' && /^[0-9a-f]{64}$/i.test(pf)
    ? pf.toLowerCase()
    : null;
}

/**
 * Public view: unwrap envelope payload; strip legacy integrity key.
 * Preserves arrays/primitives/objects as stored in $payload.
 * Never exposes $integrity / $policyFingerprint.
 * @param {unknown} stored
 */
export function publicJsonView(stored) {
  if (stored == null) return stored;
  let obj = stored;
  if (typeof stored === 'string') {
    try {
      obj = JSON.parse(stored);
    } catch {
      return stored;
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  if (
    /** @type {any} */ (obj).$v === ENVELOPE_VERSION &&
    Object.prototype.hasOwnProperty.call(obj, '$payload')
  ) {
    return /** @type {any} */ (obj).$payload;
  }
  // Legacy: strip _integrity sibling
  const { [INTEGRITY_META_KEY]: _h, ...rest } = /** @type {object} */ (obj);
  void _h;
  return rest;
}

/**
 * Required select for owner-joined tool_executions queries (child columns only).
 * @type {readonly string[]}
 */
export const TOOL_EXECUTION_CHILD_SELECT = Object.freeze(['te.*']);

/**
 * @param {string} toolCallId
 */
function assertToolCallId(toolCallId) {
  if (typeof toolCallId !== 'string' || !toolCallId.trim()) {
    throw new Error('toolCallId is required');
  }
  const v = toolCallId.trim();
  if (v.length > TOOL_CALL_ID_MAX) {
    throw new Error(`toolCallId exceeds max length ${TOOL_CALL_ID_MAX}`);
  }
  return v;
}

/**
 * @param {string} toolName
 */
function assertToolName(toolName) {
  if (typeof toolName !== 'string' || !toolName.trim()) {
    throw new Error('toolName is required');
  }
  const v = toolName.trim();
  if (v.length > TOOL_NAME_MAX) {
    throw new Error(`toolName exceeds max length ${TOOL_NAME_MAX}`);
  }
  return v;
}

/**
 * @param {string} traceId
 */
function assertTraceId32(traceId) {
  const t = String(traceId || '').trim().toLowerCase();
  if (!TRACE_ID_RE.test(t) || /^0+$/.test(t)) {
    throw new Error('traceId must be 32 hex chars (non-zero)');
  }
  return t;
}

/**
 * Sandbox request hash: 64 lowercase hex chars.
 * @param {unknown} hash
 * @returns {string}
 */
function assertRequestHash(hash) {
  if (typeof hash !== 'string' || !REQUEST_HASH_RE.test(hash)) {
    throw new Error('requestHash must be 64 lowercase hex chars');
  }
  return hash;
}

/**
 * Strict positive safe JS integer (v1 fence / hash version).
 * Rejects strings, bools, floats (non-integer), NaN/Infinity, BigInt,
 * unsafe integers, and null→0 coercion. Only typeof number +
 * Number.isSafeInteger(n) && n > 0. (Note: JS cannot distinguish 1.0 from 1.)
 *
 * @param {unknown} value
 * @param {string} field
 * @returns {number}
 */
export function assertPositiveSafeInt(value, field) {
  if (typeof value !== 'number') {
    throw new Error(`${field} must be a positive safe integer number`);
  }
  if (!Number.isFinite(value) || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}

/** @deprecated use assertPositiveSafeInt */
function assertPositiveInt(value, field) {
  return assertPositiveSafeInt(value, field);
}

/**
 * @param {Record<string, unknown>} row
 */
function mapToolExecutionPublic(row) {
  const mapped = mapToolExecution(row);
  const rawArgs =
    typeof row.arguments_json === 'string'
      ? parseJsonColumn(row.arguments_json)
      : row.arguments_json;
  const rawResult =
    row.result_json == null
      ? null
      : typeof row.result_json === 'string'
        ? parseJsonColumn(row.result_json)
        : row.result_json;
  return {
    ...mapped,
    argumentsJson: publicJsonView(rawArgs) ?? {},
    resultJson: rawResult == null ? null : publicJsonView(rawResult),
    _argsIntegrity: extractIntegrity(rawArgs),
    _resultIntegrity: extractIntegrity(rawResult),
    /** @internal hidden policy decision fingerprint (not public) */
    _policyFingerprint: extractPolicyFingerprint(rawArgs),
  };
}

/**
 * Assert existing row matches replayed name/source/args (integrity of original).
 * When policyFingerprint is supplied (policy path), exact match is required;
 * missing durable fingerprint fails closed (no permissive legacy fallback).
 *
 * @param {ReturnType<typeof mapToolExecutionPublic>} existing
 * @param {{
 *   toolName: string,
 *   toolSource: string,
 *   argumentsJson?: unknown,
 *   policyFingerprint?: string | null,
 * }} expected
 */
export function assertToolExecutionReplayMatch(existing, expected) {
  const toolName = assertToolName(expected.toolName);
  const toolSource = assertToolSource(expected.toolSource);
  if (existing.toolName !== toolName || existing.toolSource !== toolSource) {
    throw new ConflictError(
      'tool_call_id replay conflicts with existing tool_name/source',
      { resource: 'tool_executions', id: existing.toolExecutionId },
    );
  }
  if (expected.argumentsJson !== undefined) {
    assertNoReservedIntegrityKeys(expected.argumentsJson);
    const nextFp = integrityFingerprint(expected.argumentsJson ?? {});
    const existingFp =
      existing._argsIntegrity || integrityFingerprint(existing.argumentsJson);
    if (existingFp !== nextFp) {
      throw new ConflictError(
        'tool_call_id replay conflicts with existing args integrity',
        { resource: 'tool_executions', id: existing.toolExecutionId },
      );
    }
  }
  if (expected.policyFingerprint != null && expected.policyFingerprint !== '') {
    const want = String(expected.policyFingerprint).toLowerCase();
    const have = existing._policyFingerprint;
    if (!have) {
      const err = new ConflictError(
        'POLICY_FINGERPRINT_MISSING: durable ToolExecution lacks policy fingerprint (fail closed)',
        { resource: 'tool_executions', id: existing.toolExecutionId },
      );
      /** @type {any} */ (err).reasonCode = 'POLICY_FINGERPRINT_MISSING';
      throw err;
    }
    if (have !== want) {
      const err = new ConflictError(
        'POLICY_FINGERPRINT_MISMATCH: policy decision fingerprint differs from durable state',
        { resource: 'tool_executions', id: existing.toolExecutionId },
      );
      /** @type {any} */ (err).reasonCode = 'POLICY_FINGERPRINT_MISMATCH';
      throw err;
    }
  }
}

export class ToolExecutionRepository {
  /**
   * @param {import('knex').Knex | import('knex').Knex.Transaction} db
   * @param {{ now?: () => Date }} [opts]
   */
  constructor(db, opts = {}) {
    if (!db) throw new Error('ToolExecutionRepository requires a knex executor');
    this.db = db;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * @param {string} runId
   * @param {{ orgId: string, userId: string }} scope
   * @param {{ forUpdate?: boolean, forShare?: boolean }} [opts]
   */
  async requireOwnedRun(runId, scope, opts = {}) {
    const s = requireOwnerScope(scope);
    const id = assertUlid(runId, 'runId');
    let q = applyOwnerScope(this.db('runs').where({ run_id: id }), s);
    if (opts.forUpdate) q = q.forUpdate();
    else if (opts.forShare) q = q.forShare();
    const row = await q.first();
    if (!row) {
      throw new NotFoundError('Run not found for tool execution scope', {
        resource: 'runs',
        id,
      });
    }
    return row;
  }

  /**
   * Owner-scoped tool_executions join runs — child columns only.
   * @param {{ orgId: string, userId: string }} scope
   * @param {{ forUpdate?: boolean }} [opts]
   */
  #ownedToolQuery(scope, opts = {}) {
    const s = requireOwnerScope(scope);
    let q = this.db('tool_executions as te')
      .join('runs as r', 'te.run_id', 'r.run_id')
      .select(...TOOL_EXECUTION_CHILD_SELECT)
      .where('r.org_id', s.orgId)
      .andWhere('r.user_id', s.userId);
    if (opts.forUpdate) q = q.forUpdate();
    return q;
  }

  /**
   * @param {string} runId
   * @param {string} toolCallId
   * @param {{ orgId: string, userId: string }} scope
   * @param {{ forUpdate?: boolean }} [opts]
   */
  async getByRunAndToolCallId(runId, toolCallId, scope, opts = {}) {
    const s = requireOwnerScope(scope);
    const rid = assertUlid(runId, 'runId');
    const tc = assertToolCallId(toolCallId);
    const row = await this.#ownedToolQuery(s, opts)
      .andWhere('te.run_id', rid)
      .andWhere('te.tool_call_id', tc)
      .first();
    return row ? mapToolExecutionPublic(row) : null;
  }

  /**
   * @param {string} toolExecutionId
   * @param {{ orgId: string, userId: string }} scope
   * @param {{ forUpdate?: boolean }} [opts]
   */
  async getById(toolExecutionId, scope, opts = {}) {
    const s = requireOwnerScope(scope);
    const id = assertUlid(toolExecutionId, 'toolExecutionId');
    const row = await this.#ownedToolQuery(s, opts)
      .andWhere('te.tool_execution_id', id)
      .first();
    if (!row) {
      throw new NotFoundError('Tool execution not found', {
        resource: 'tool_executions',
        id,
      });
    }
    return mapToolExecutionPublic(row);
  }

  /**
   * @param {{
   *   toolExecutionId: string,
   *   runId: string,
   *   agentSessionId: string,
   *   toolCallId: string,
   *   toolName: string,
   *   toolSource: string,
   *   riskLevel: string,
   *   argumentsJson?: unknown,
   *   status?: string,
   *   errorCode?: string | null,
   *   policyFingerprint?: string | null,
   *   traceId: string,
   *   orgId: string,
   *   userId: string,
   *   conversationId?: string | null,
   * }} input
   */
  async getOrCreate(input) {
    const scope = requireOwnerScope(input);
    const runId = assertUlid(input.runId, 'runId');
    const agentSessionId = assertUlid(input.agentSessionId, 'agentSessionId');
    const toolCallId = assertToolCallId(input.toolCallId);
    const toolName = assertToolName(input.toolName);
    const toolSource = assertToolSource(input.toolSource);
    const riskLevel = assertToolRiskLevel(input.riskLevel);
    const desiredStatus = assertToolExecutionStatus(
      input.status ?? TOOL_EXECUTION_STATUS.PROPOSED,
    );
    const traceId = assertTraceId32(input.traceId);
    const toolExecutionId = assertUlid(input.toolExecutionId, 'toolExecutionId');
    const originalArgs = input.argumentsJson ?? {};
    assertNoReservedIntegrityKeys(originalArgs);
    const policyFingerprint =
      input.policyFingerprint != null && String(input.policyFingerprint).trim()
        ? String(input.policyFingerprint).toLowerCase()
        : null;
    const argsJson = packJsonWithIntegrity(originalArgs, MAX_ARGS_JSON_BYTES, {
      policyFingerprint,
    });
    void integrityFingerprint(originalArgs);

    // Owned Run FOR UPDATE; verify session (and optional conversation) binding
    // before insert/replay so ToolExecution cannot attach to a foreign session.
    const runRow = await this.requireOwnedRun(runId, scope, { forUpdate: true });
    if (String(runRow.agent_session_id) !== agentSessionId) {
      throw new ConflictError(
        'tool execution getOrCreate: run agent_session_id does not match input',
        { resource: 'runs', id: runId },
      );
    }
    if (input.conversationId != null && String(input.conversationId).trim()) {
      const conversationId = assertUlid(input.conversationId, 'conversationId');
      if (String(runRow.conversation_id) !== conversationId) {
        throw new ConflictError(
          'tool execution getOrCreate: run conversation_id does not match input',
          { resource: 'runs', id: runId },
        );
      }
    }

    const existing = await this.db('tool_executions')
      .where({ run_id: runId, tool_call_id: toolCallId })
      .forUpdate()
      .first();

    if (existing) {
      const mapped = mapToolExecutionPublic(existing);
      assertToolExecutionReplayMatch(mapped, {
        toolName,
        toolSource,
        argumentsJson: originalArgs,
        policyFingerprint,
      });
      return { created: false, toolExecution: mapped };
    }

    const now = this.now();
    try {
      await this.db('tool_executions').insert({
        tool_execution_id: toolExecutionId,
        run_id: runId,
        agent_session_id: agentSessionId,
        tool_call_id: toolCallId,
        tool_name: toolName,
        tool_source: toolSource,
        risk_level: riskLevel,
        arguments_json: argsJson,
        result_json: null,
        status: TOOL_EXECUTION_STATUS.PROPOSED,
        error_code: null,
        trace_id: traceId,
        request_hash: null,
        request_hash_version: null,
        execution_fence_token: null,
        started_at: null,
        completed_at: null,
        created_at: toMysqlDateTime(now),
      });
    } catch (err) {
      const code = /** @type {{ code?: string }} */ (err)?.code;
      if (code === 'ER_DUP_ENTRY') {
        const again = await this.db('tool_executions')
          .where({ run_id: runId, tool_call_id: toolCallId })
          .first();
        if (!again) throw err;
        const mapped = mapToolExecutionPublic(again);
        assertToolExecutionReplayMatch(mapped, {
          toolName,
          toolSource,
          argumentsJson: originalArgs,
          policyFingerprint,
        });
        return { created: false, toolExecution: mapped };
      }
      throw err;
    }

    let toolExecution = mapToolExecutionPublic(
      await this.db('tool_executions')
        .where({ tool_execution_id: toolExecutionId })
        .first(),
    );

    if (desiredStatus !== TOOL_EXECUTION_STATUS.PROPOSED) {
      const tr = await this.transitionStatus({
        toolExecutionId,
        orgId: scope.orgId,
        userId: scope.userId,
        fromStatus: TOOL_EXECUTION_STATUS.PROPOSED,
        toStatus: desiredStatus,
        errorCode: input.errorCode ?? null,
        setStartedAt: desiredStatus === TOOL_EXECUTION_STATUS.RUNNING,
        setCompletedAt: isTerminalToolExecutionStatus(desiredStatus),
      });
      toolExecution = tr.toolExecution;
    }

    return { created: true, toolExecution };
  }

  /**
   * Bind a Sandbox request-hash contract to an existing Agent ToolExecution.
   *
   * Lock order (parallel-safe):
   *   AgentSession FOR SHARE → Run FOR SHARE → tool_executions FOR UPDATE
   *   (direct row lock — never owner-join FOR UPDATE after Run is locked,
   *   which would upgrade the joined Run to exclusive and serialize tools).
   *
   * Only tool_source=sandbox + status=RUNNING under ACTIVE session with equal
   * fence; exact toolName; AgentSession conversation_id + sandbox_session_id
   * must match supplied frozen context. NULL→set all three request fields;
   * exact same values are idempotent; any partial/different binding is Conflict.
   *
   * @param {{
   *   toolExecutionId?: string,
   *   runId?: string,
   *   toolCallId?: string,
   *   toolName: string,
   *   agentSessionId: string,
   *   conversationId: string,
   *   sandboxSessionId: string,
   *   requestHash: string,
   *   requestHashVersion: number,
   *   executionFenceToken: number,
   *   orgId: string,
   *   userId: string,
   * }} input
   * @returns {Promise<{ bound: boolean, toolExecution: object }>}
   */
  async bindSandboxRequest(input) {
    const scope = requireOwnerScope(input);
    const agentSessionId = assertUlid(input.agentSessionId, 'agentSessionId');
    const conversationId = assertUlid(input.conversationId, 'conversationId');
    const sandboxSessionId = assertUlid(
      input.sandboxSessionId,
      'sandboxSessionId',
    );
    const toolName = assertToolName(input.toolName);
    const requestHash = assertRequestHash(input.requestHash);
    const requestHashVersion = assertPositiveSafeInt(
      input.requestHashVersion,
      'requestHashVersion',
    );
    const executionFenceToken = assertPositiveSafeInt(
      input.executionFenceToken,
      'executionFenceToken',
    );

    const hasTeId =
      input.toolExecutionId != null && String(input.toolExecutionId).trim() !== '';
    const hasRunCall =
      input.runId != null &&
      String(input.runId).trim() !== '' &&
      input.toolCallId != null &&
      String(input.toolCallId).trim() !== '';
    if (!hasTeId && !hasRunCall) {
      throw new Error(
        'bindSandboxRequest requires toolExecutionId or exact runId+toolCallId',
      );
    }

    // 1) Session FOR SHARE (parent authority — allow concurrent tool binds).
    let sessionQ = applyOwnerScope(
      this.db('agent_sessions').where({ agent_session_id: agentSessionId }),
      scope,
    ).forShare();
    const sessionRow = await sessionQ.first();
    if (!sessionRow) {
      throw new NotFoundError('Agent session not found for request bind', {
        resource: 'agent_sessions',
        id: agentSessionId,
      });
    }
    if (String(sessionRow.status) !== SESSION_STATUS.ACTIVE) {
      throw new ConflictError(
        `bindSandboxRequest requires ACTIVE session, got ${sessionRow.status}`,
        { resource: 'agent_sessions', id: agentSessionId },
      );
    }
    if (String(sessionRow.conversation_id) !== conversationId) {
      throw new ConflictError(
        'bindSandboxRequest: AgentSession.conversation_id does not match context',
        { resource: 'agent_sessions', id: agentSessionId },
      );
    }
    if (String(sessionRow.sandbox_session_id) !== sandboxSessionId) {
      throw new ConflictError(
        'bindSandboxRequest: AgentSession.sandbox_session_id does not match context',
        { resource: 'agent_sessions', id: agentSessionId },
      );
    }
    const sessionFence = Number(sessionRow.execution_fence_token);
    if (
      !Number.isSafeInteger(sessionFence) ||
      sessionFence !== executionFenceToken
    ) {
      throw new ConflictError(
        `bindSandboxRequest stale execution fence: session has ${sessionFence}, request ${executionFenceToken}`,
        { resource: 'agent_sessions', id: agentSessionId },
      );
    }

    // Resolve runId without locking tool yet (lock order: session → run → tool).
    let runId;
    let toolCallId = null;
    let toolExecutionId = hasTeId
      ? assertUlid(input.toolExecutionId, 'toolExecutionId')
      : null;
    if (hasRunCall) {
      runId = assertUlid(input.runId, 'runId');
      toolCallId = assertToolCallId(input.toolCallId);
    } else {
      // Peek tool row for run_id only (not authoritative; re-locked below).
      const peek = await this.db('tool_executions')
        .where({ tool_execution_id: toolExecutionId })
        .first();
      if (!peek) {
        throw new NotFoundError('Tool execution not found for request bind', {
          resource: 'tool_executions',
          id: toolExecutionId,
        });
      }
      runId = String(peek.run_id);
    }

    // 2) Owned Run FOR SHARE + session/conversation binding + RUNNING.
    const runRow = await this.requireOwnedRun(runId, scope, { forShare: true });
    if (String(runRow.agent_session_id) !== agentSessionId) {
      throw new ConflictError(
        'bindSandboxRequest: run is not bound to agentSessionId',
        { resource: 'runs', id: runId },
      );
    }
    if (String(runRow.conversation_id) !== conversationId) {
      throw new ConflictError(
        'bindSandboxRequest: run conversation_id does not match context conversationId',
        { resource: 'runs', id: runId },
      );
    }
    if (String(runRow.status) !== RUN_STATUS.RUNNING) {
      throw new ConflictError(
        `bindSandboxRequest: owned Run must be RUNNING (got ${runRow.status})`,
        { resource: 'runs', id: runId },
      );
    }

    // 3) Direct ToolExecution FOR UPDATE (no join — Run already owner-validated).
    //    Joining runs + FOR UPDATE would exclusively lock the Run and serialize
    //    concurrent tool calls on the same run.
    let toolRow;
    if (toolExecutionId) {
      toolRow = await this.db('tool_executions')
        .where({ tool_execution_id: toolExecutionId })
        .forUpdate()
        .first();
      if (!toolRow) {
        throw new NotFoundError('Tool execution not found for request bind', {
          resource: 'tool_executions',
          id: toolExecutionId,
        });
      }
      if (String(toolRow.run_id) !== runId) {
        throw new ConflictError(
          'bindSandboxRequest: toolExecutionId run_id does not match validated run',
          { resource: 'tool_executions', id: toolExecutionId },
        );
      }
      if (hasRunCall) {
        if (String(toolRow.tool_call_id) !== toolCallId) {
          throw new ConflictError(
            'bindSandboxRequest: toolExecutionId does not match runId+toolCallId',
            { resource: 'tool_executions', id: toolExecutionId },
          );
        }
      } else {
        toolCallId = assertToolCallId(String(toolRow.tool_call_id));
      }
    } else {
      toolRow = await this.db('tool_executions')
        .where({ run_id: runId, tool_call_id: toolCallId })
        .forUpdate()
        .first();
      if (!toolRow) {
        throw new NotFoundError('Tool execution not found for request bind', {
          resource: 'tool_executions',
          id: `${runId}:${toolCallId}`,
        });
      }
      toolExecutionId = String(toolRow.tool_execution_id);
    }

    const existing = mapToolExecutionPublic(toolRow);

    if (String(existing.agentSessionId) !== agentSessionId) {
      throw new ConflictError(
        'bindSandboxRequest: tool row agentSessionId mismatch',
        { resource: 'tool_executions', id: toolExecutionId },
      );
    }
    if (String(existing.runId) !== runId) {
      throw new ConflictError(
        'bindSandboxRequest: tool row runId mismatch',
        { resource: 'tool_executions', id: toolExecutionId },
      );
    }
    if (existing.toolName !== toolName) {
      throw new ConflictError(
        `bindSandboxRequest: tool_name mismatch (ledger ${existing.toolName}, request ${toolName})`,
        { resource: 'tool_executions', id: toolExecutionId },
      );
    }
    if (existing.toolSource !== TOOL_SOURCE.SANDBOX) {
      throw new ConflictError(
        `bindSandboxRequest: only tool_source=sandbox may bind (got ${existing.toolSource})`,
        { resource: 'tool_executions', id: toolExecutionId },
      );
    }
    if (existing.status !== TOOL_EXECUTION_STATUS.RUNNING) {
      throw new ConflictError(
        `bindSandboxRequest: only RUNNING may bind (got ${existing.status})`,
        { resource: 'tool_executions', id: toolExecutionId },
      );
    }

    const curHash = existing.requestHash;
    const curVer = existing.requestHashVersion;
    const curFence = existing.executionFenceToken;
    const allNull = curHash == null && curVer == null && curFence == null;
    const allSame =
      curHash === requestHash &&
      curVer === requestHashVersion &&
      curFence === executionFenceToken;

    if (allSame) {
      return { bound: false, toolExecution: existing };
    }
    if (!allNull) {
      throw new ConflictError(
        'bindSandboxRequest: request binding conflict (partial or different hash/version/fence)',
        { resource: 'tool_executions', id: toolExecutionId },
      );
    }

    // CAS: only if still all NULL — no blind update of partially set rows.
    const updated = await this.db('tool_executions')
      .where({ tool_execution_id: toolExecutionId })
      .whereNull('request_hash')
      .whereNull('request_hash_version')
      .whereNull('execution_fence_token')
      .update({
        request_hash: requestHash,
        request_hash_version: requestHashVersion,
        execution_fence_token: executionFenceToken,
      });
    if (!updated) {
      throw new ConflictError(
        'bindSandboxRequest: request binding CAS lost race',
        { resource: 'tool_executions', id: toolExecutionId },
      );
    }

    return {
      bound: true,
      toolExecution: await this.getById(toolExecutionId, scope),
    };
  }

  /**
   * @param {{
   *   toolExecutionId: string,
   *   orgId: string,
   *   userId: string,
   *   fromStatus: string | string[],
   *   toStatus: string,
   *   resultJson?: unknown,
   *   errorCode?: string | null,
   *   setStartedAt?: boolean,
   *   setCompletedAt?: boolean,
   * }} input
   */
  async transitionStatus(input) {
    const scope = requireOwnerScope(input);
    const id = assertUlid(input.toolExecutionId, 'toolExecutionId');
    const toStatus = assertToolExecutionStatus(input.toStatus);
    const fromList = (
      Array.isArray(input.fromStatus) ? input.fromStatus : [input.fromStatus]
    ).map(assertToolExecutionStatus);

    const existing = await this.getById(id, scope, { forUpdate: true });

    if (
      existing.status === toStatus &&
      isTerminalToolExecutionStatus(toStatus)
    ) {
      if (input.resultJson !== undefined) {
        if (input.resultJson != null) {
          assertNoReservedIntegrityKeys(input.resultJson);
        }
        const nextFp = integrityFingerprint(input.resultJson);
        const existingFp =
          existing._resultIntegrity ||
          integrityFingerprint(existing.resultJson ?? null);
        if (existingFp !== nextFp) {
          throw new ConflictError(
            'tool execution terminal result conflict on replay',
            { resource: 'tool_executions', id },
          );
        }
      }
      return { changed: false, toolExecution: existing };
    }

    if (!fromList.includes(existing.status)) {
      throw new ConflictError(
        `tool execution status CAS failed: have ${existing.status}, expected one of ${fromList.join(',')}`,
        { resource: 'tool_executions', id },
      );
    }

    if (!canTransitionToolExecution(existing.status, toStatus)) {
      throw new ConflictError(
        `illegal tool execution transition ${existing.status} → ${toStatus}`,
        { resource: 'tool_executions', id },
      );
    }

    const now = this.now();
    /** @type {Record<string, unknown>} */
    const patch = { status: toStatus };
    if (input.setStartedAt || toStatus === TOOL_EXECUTION_STATUS.RUNNING) {
      if (!existing.startedAt) {
        patch.started_at = toMysqlDateTime(now);
      }
    }
    if (input.setCompletedAt || isTerminalToolExecutionStatus(toStatus)) {
      patch.completed_at = toMysqlDateTime(now);
    }
    if (input.resultJson !== undefined) {
      if (input.resultJson == null) {
        patch.result_json = null;
      } else {
        assertNoReservedIntegrityKeys(input.resultJson);
        patch.result_json = packJsonWithIntegrity(
          input.resultJson,
          MAX_RESULT_JSON_BYTES,
        );
      }
    }
    if (input.errorCode !== undefined) {
      patch.error_code = input.errorCode;
    }

    const updated = await this.db('tool_executions')
      .where({ tool_execution_id: id, status: existing.status })
      .update(patch);
    if (!updated) {
      throw new ConflictError('tool execution status CAS lost race', {
        resource: 'tool_executions',
        id,
      });
    }
    return {
      changed: true,
      toolExecution: await this.getById(id, scope),
    };
  }
}

export { parseJsonColumn };
