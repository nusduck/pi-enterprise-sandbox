/** Durable owner-scoped user interaction repository. */

import { assertUlid } from '../../../domain/shared/ulid.js';
import {
  assertInteractionStatus,
  assertInteractionType,
  INTERACTION_STATUS,
  assertInteractionResumePhase,
  INTERACTION_RESUME_PHASE,
} from '../../../domain/interaction/interaction-status.js';
import { sha256Hex, stableStringify } from '../../../application/canonical-json.js';
import { CanonicalJsonError } from '../../../application/errors.js';
import { validateInteractionResponse } from '../../../domain/interaction/response-validation.js';
import { applyOwnerScope, requireOwnerScope } from '../ownership.js';
import { ConflictError, NotFoundError } from '../errors.js';
import { mapInteraction, toMysqlDateTime } from '../row-mappers.js';

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;

function serializeJson(value, maxBytes, label) {
  // Persistence is the fact source. Do not redact or truncate before hashing:
  // event/public projections apply their own redaction policy later.
  try {
    const text = stableStringify(value, { maxBytes });
    return { value: JSON.parse(text), text };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof CanonicalJsonError) {
      throw new CanonicalJsonError(`${label} is invalid: ${message}`, {
        ...(error.details || {}),
        label,
      });
    }
    throw new Error(`${label} is invalid: ${message}`);
  }
}

function responseHash(text) {
  return sha256Hex(text);
}

/**
 * @param {Record<string, unknown>} row
 * @returns {string}
 */
function rowStatus(row) {
  return assertInteractionStatus(row.status);
}

function assertReplayMatches(existing, expected, requestText) {
  const existingRequest = stableStringify(existing.requestJson, {
    maxBytes: MAX_REQUEST_BYTES,
  });
  if (
    existing.orgId !== expected.orgId ||
    existing.userId !== expected.userId ||
    existing.runId !== expected.runId ||
    existing.agentSessionId !== expected.agentSessionId ||
    existing.toolExecutionId !== expected.toolExecutionId ||
    existing.toolCallId !== expected.toolCallId ||
    existing.interactionType !== expected.interactionType ||
    existingRequest !== requestText
  ) {
    throw new ConflictError(
      'interaction tool call replay differs from durable request binding',
      {
        resource: 'interactions',
        id: existing.interactionId,
      },
    );
  }
  return existing;
}

export class InteractionRepository {
  /**
   * @param {import('knex').Knex | import('knex').Knex.Transaction} db
   * @param {{ now?: () => Date }} [opts]
   */
  constructor(db, opts = {}) {
    if (!db) throw new Error('InteractionRepository requires a knex executor');
    this.db = db;
    this.now = opts.now ?? (() => new Date());
  }

  /** @param {string} runId @param {{orgId:string,userId:string}} scope @param {{forUpdate?:boolean}} [opts] */
  async requireOwnedRun(runId, scope, opts = {}) {
    const s = requireOwnerScope(scope);
    const id = assertUlid(runId, 'runId');
    let q = applyOwnerScope(this.db('runs').where({ run_id: id }), s);
    if (opts.forUpdate) q = q.forUpdate();
    const row = await q.first();
    if (!row) {
      throw new NotFoundError('Run not found for interaction scope', {
        resource: 'runs',
        id,
      });
    }
    return row;
  }

  #ownedQuery(scope, opts = {}) {
    const s = requireOwnerScope(scope);
    let q = this.db('run_interactions as i')
      .join('runs as r', 'i.run_id', 'r.run_id')
      .select('i.*')
      .where('i.org_id', s.orgId)
      .andWhere('i.user_id', s.userId)
      .andWhere('r.org_id', s.orgId)
      .andWhere('r.user_id', s.userId);
    if (opts.forUpdate) q = q.forUpdate();
    return q;
  }

  /** @param {string} interactionId @param {{orgId:string,userId:string}} scope @param {{forUpdate?:boolean}} [opts] */
  async getById(interactionId, scope, opts = {}) {
    const id = assertUlid(interactionId, 'interactionId');
    const row = await this.#ownedQuery(scope, opts)
      .andWhere('i.interaction_id', id)
      .first();
    if (!row) {
      throw new NotFoundError('Interaction not found', {
        resource: 'interactions',
        id,
      });
    }
    return mapInteraction(row);
  }

  /** @param {string} runId @param {{orgId:string,userId:string}} scope @param {{forUpdate?:boolean}} [opts] */
  async listByRunId(runId, scope, opts = {}) {
    const id = assertUlid(runId, 'runId');
    await this.requireOwnedRun(id, scope, { forUpdate: opts.forUpdate === true });
    const rows = await this.#ownedQuery(scope, opts)
      .andWhere('i.run_id', id)
      .orderBy('i.created_at', 'asc')
      .orderBy('i.interaction_id', 'asc');
    return (rows || []).map(mapInteraction);
  }

  /** Return the oldest pending request for an owned Run, if any. */
  async getPendingForRun(runId, scope, opts = {}) {
    const rows = await this.listByRunId(runId, scope, opts);
    return rows.find((row) => row.status === INTERACTION_STATUS.PENDING) || null;
  }

  /**
   * Idempotently create one pending interaction for a Pi tool call.
   * @param {{interactionId:string,orgId:string,userId:string,runId:string,agentSessionId:string,toolExecutionId:string,toolCallId:string,interactionType:string,requestJson:unknown}} input
   */
  async getOrCreatePending(input) {
    const scope = requireOwnerScope(input);
    const interactionId = assertUlid(input.interactionId, 'interactionId');
    const runId = assertUlid(input.runId, 'runId');
    const agentSessionId = assertUlid(input.agentSessionId, 'agentSessionId');
    const toolExecutionId = assertUlid(input.toolExecutionId, 'toolExecutionId');
    const interactionType = assertInteractionType(input.interactionType);
    const toolCallId = String(input.toolCallId || '').trim();
    if (!toolCallId || toolCallId.length > 255) {
      throw new Error('toolCallId must be a non-empty string of at most 255 characters');
    }
    const request = serializeJson(input.requestJson ?? {}, MAX_REQUEST_BYTES, 'request_json');

    const run = await this.requireOwnedRun(runId, scope, { forUpdate: true });
    if (!['RUNNING', 'WAITING_INPUT'].includes(String(run.status))) {
      throw new ConflictError(`cannot request interaction while Run is ${run.status}`, {
        resource: 'runs',
        id: runId,
      });
    }

    const existing = await this.#ownedQuery(scope, { forUpdate: true })
      .andWhere('i.run_id', runId)
      .andWhere('i.tool_call_id', toolCallId)
      .first();
    if (existing) {
      const mapped = assertReplayMatches(
        mapInteraction(existing),
        {
          ...scope,
          runId,
          agentSessionId,
          toolExecutionId,
          toolCallId,
          interactionType,
        },
        request.text,
      );
      if (mapped.status !== INTERACTION_STATUS.PENDING) {
        throw new ConflictError(
          `interaction tool call was already ${mapped.status}`,
          { resource: 'interactions', id: mapped.interactionId },
        );
      }
      return { created: false, interaction: mapped };
    }

    if (String(run.status) === 'WAITING_INPUT') {
      throw new ConflictError(
        'Run is already waiting on a different or missing interaction',
        { resource: 'runs', id: runId },
      );
    }

    const otherPending = await this.#ownedQuery(scope, { forUpdate: true })
      .andWhere('i.run_id', runId)
      .andWhere('i.status', INTERACTION_STATUS.PENDING)
      .first();
    if (otherPending) {
      throw new ConflictError('Run already has a pending interaction', {
        resource: 'interactions',
        id: String(otherPending.interaction_id),
      });
    }

    const toolExecution = await this.db('tool_executions')
      .where({ tool_execution_id: toolExecutionId })
      .forUpdate()
      .first();
    if (!toolExecution) {
      throw new NotFoundError('Tool execution not found for interaction', {
        resource: 'tool_executions',
        id: toolExecutionId,
      });
    }
    if (
      String(toolExecution.run_id) !== runId ||
      String(toolExecution.agent_session_id) !== agentSessionId ||
      String(toolExecution.tool_call_id) !== toolCallId
    ) {
      throw new ConflictError('interaction tool execution binding mismatch', {
        resource: 'tool_executions',
        id: toolExecutionId,
      });
    }

    const now = toMysqlDateTime(this.now());
    try {
      await this.db('run_interactions').insert({
        interaction_id: interactionId,
        org_id: scope.orgId,
        user_id: scope.userId,
        run_id: runId,
        agent_session_id: agentSessionId,
        tool_execution_id: toolExecutionId,
        tool_call_id: toolCallId,
        interaction_type: interactionType,
        request_json: request.text,
        status: INTERACTION_STATUS.PENDING,
        response_json: null,
        response_hash: null,
        responded_by: null,
        resume_phase: INTERACTION_RESUME_PHASE.NONE,
        resume_claimed_at: null,
        resume_applied_at: null,
        cancelled_at: null,
        created_at: now,
        resolved_at: null,
      });
    } catch (err) {
      if (/** @type {{code?:string}} */ (err)?.code === 'ER_DUP_ENTRY') {
        const adopted = await this.#ownedQuery(scope)
          .andWhere('i.run_id', runId)
          .andWhere('i.tool_call_id', toolCallId)
          .first();
        if (adopted) {
          const mapped = assertReplayMatches(
            mapInteraction(adopted),
            {
              ...scope,
              runId,
              agentSessionId,
              toolExecutionId,
              toolCallId,
              interactionType,
            },
            request.text,
          );
          if (mapped.status !== INTERACTION_STATUS.PENDING) {
            throw new ConflictError(
              `interaction tool call was already ${mapped.status}`,
              { resource: 'interactions', id: mapped.interactionId },
            );
          }
          return {
            created: false,
            interaction: mapped,
          };
        }
      }
      throw err;
    }
    return { created: true, interaction: await this.getById(interactionId, scope) };
  }

  /**
   * CAS a pending request to RESOLVED. Repeating the same response is an
   * idempotent no-op; a different response is a conflict.
   * @param {{interactionId:string,orgId:string,userId:string,responseJson:unknown,respondedBy:string}} input
   */
  async resolveIfPending(input) {
    const scope = requireOwnerScope(input);
    const id = assertUlid(input.interactionId, 'interactionId');
    const respondedBy = assertUlid(input.respondedBy, 'respondedBy');
    if (respondedBy !== scope.userId) {
      throw new ConflictError('interaction responder does not match owner', {
        resource: 'interactions',
        id,
      });
    }
    const current = await this.getById(id, scope, { forUpdate: true });
    const typedResponse = validateInteractionResponse(
      current.interactionType,
      current.requestJson,
      input.responseJson,
    );
    const response = serializeJson(
      typedResponse,
      MAX_RESPONSE_BYTES,
      'response_json',
    );
    const hash = responseHash(response.text);
    if (current.status === INTERACTION_STATUS.RESOLVED) {
      if (current.responseHash === hash) return { changed: false, interaction: current };
      throw new ConflictError('interaction already resolved with a different response', {
        resource: 'interactions',
        id,
      });
    }
    if (current.status !== INTERACTION_STATUS.PENDING) {
      throw new ConflictError(`interaction is ${current.status}`, {
        resource: 'interactions',
        id,
      });
    }
    const n = await this.db('run_interactions')
      .where({
        interaction_id: id,
        org_id: scope.orgId,
        user_id: scope.userId,
        status: INTERACTION_STATUS.PENDING,
      })
      .update({
        status: INTERACTION_STATUS.RESOLVED,
        response_json: response.text,
        response_hash: hash,
        responded_by: respondedBy,
        resume_phase: INTERACTION_RESUME_PHASE.READY,
        resolved_at: toMysqlDateTime(this.now()),
      });
    if (!n) {
      const after = await this.getById(id, scope);
      if (after.status === INTERACTION_STATUS.RESOLVED && after.responseHash === hash) {
        return { changed: false, interaction: after };
      }
      throw new ConflictError('interaction resolve CAS lost race', {
        resource: 'interactions',
        id,
      });
    }
    return { changed: true, interaction: await this.getById(id, scope) };
  }

  /** Claim a resolved answer before the Run leaves WAITING_INPUT. */
  async claimResumeIfReady(interactionId, scope) {
    const id = assertUlid(interactionId, 'interactionId');
    const current = await this.getById(id, scope, { forUpdate: true });
    if (current.status !== INTERACTION_STATUS.RESOLVED) {
      throw new ConflictError(`interaction is ${current.status}`, {
        resource: 'interactions',
        id,
      });
    }
    const phase = assertInteractionResumePhase(current.resumePhase);
    if (
      phase === INTERACTION_RESUME_PHASE.CLAIMED ||
      phase === INTERACTION_RESUME_PHASE.APPLIED
    ) {
      return { changed: false, interaction: current };
    }
    // Rows written before the continuation-phase migration have no explicit
    // phase and map to NONE.  RESOLVED is already the durable answer fact, so
    // NONE is equivalent to READY for the first claim; the CAS below upgrades
    // it directly to CLAIMED without requiring a data backfill.
    if (
      phase !== INTERACTION_RESUME_PHASE.READY &&
      phase !== INTERACTION_RESUME_PHASE.NONE
    ) {
      throw new ConflictError(`interaction resume phase is ${phase}`, {
        resource: 'interactions',
        id,
      });
    }
    const changed = await this.db('run_interactions')
      .where({
        interaction_id: id,
        org_id: scope.orgId,
        user_id: scope.userId,
        status: INTERACTION_STATUS.RESOLVED,
      })
      .whereIn('resume_phase', [
        INTERACTION_RESUME_PHASE.NONE,
        INTERACTION_RESUME_PHASE.READY,
      ])
      .update({
        resume_phase: INTERACTION_RESUME_PHASE.CLAIMED,
        resume_claimed_at: toMysqlDateTime(this.now()),
      });
    if (!changed) {
      throw new ConflictError('interaction resume claim CAS lost race', {
        resource: 'interactions',
        id,
      });
    }
    return { changed: true, interaction: await this.getById(id, scope) };
  }

  /** Mark the answer present in the durable Pi checkpoint. */
  async markResumeAppliedIfClaimed(interactionId, scope) {
    const id = assertUlid(interactionId, 'interactionId');
    const current = await this.getById(id, scope, { forUpdate: true });
    const phase = assertInteractionResumePhase(current.resumePhase);
    if (phase === INTERACTION_RESUME_PHASE.APPLIED) {
      return { changed: false, interaction: current };
    }
    if (
      current.status !== INTERACTION_STATUS.RESOLVED ||
      phase !== INTERACTION_RESUME_PHASE.CLAIMED
    ) {
      throw new ConflictError(
        `interaction resume cannot be applied from ${current.status}/${phase}`,
        { resource: 'interactions', id },
      );
    }
    const changed = await this.db('run_interactions')
      .where({
        interaction_id: id,
        org_id: scope.orgId,
        user_id: scope.userId,
        status: INTERACTION_STATUS.RESOLVED,
        resume_phase: INTERACTION_RESUME_PHASE.CLAIMED,
      })
      .update({
        resume_phase: INTERACTION_RESUME_PHASE.APPLIED,
        resume_applied_at: toMysqlDateTime(this.now()),
      });
    if (!changed) {
      throw new ConflictError('interaction resume applied CAS lost race', {
        resource: 'interactions',
        id,
      });
    }
    return { changed: true, interaction: await this.getById(id, scope) };
  }

  /** Cancel only an unanswered interaction while its owned Run is locked. */
  async cancelPendingForRun(runId, scope) {
    const pending = await this.getPendingForRun(runId, scope, {
      forUpdate: true,
    });
    if (!pending) return { changed: false, interaction: null };
    const changed = await this.db('run_interactions')
      .where({
        interaction_id: pending.interactionId,
        org_id: scope.orgId,
        user_id: scope.userId,
        status: INTERACTION_STATUS.PENDING,
      })
      .update({
        status: INTERACTION_STATUS.CANCELLED,
        cancelled_at: toMysqlDateTime(this.now()),
      });
    if (!changed) {
      throw new ConflictError('interaction cancel CAS lost race', {
        resource: 'interactions',
        id: pending.interactionId,
      });
    }
    return {
      changed: true,
      interaction: await this.getById(pending.interactionId, scope),
    };
  }
}
