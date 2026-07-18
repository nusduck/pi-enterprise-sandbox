/**
 * FencedToolGovernanceRecorder (PR-06 B2).
 *
 * Atomic under ACTIVE session executionFenceToken:
 * ledger mutations + run_events + outbox in one transaction.
 * External emit only after commit.
 *
 * Idempotency is MySQL-authoritative (survives process restart):
 * - policy audit: append only when ToolExecution getOrCreate.created
 * - approval.requested: append only when Approval getOrCreatePending.created
 * - tool.execution.started/completed/failed: append only when ledger status changes
 *
 * In-process pending Map only serializes concurrent calls on the same instance;
 * it is not the authority for replay across restarts.
 *
 * Approval resolution/resume is NOT claimed (PR-09).
 */

import { assertUlid } from '../domain/shared/ulid.js';
import { SessionFenceConflictError } from '../domain/session/errors.js';
import { ConflictError } from '../infrastructure/mysql/errors.js';
import { AGGREGATE_TYPE_RUN } from '../infrastructure/outbox/outbox-status.js';
import {
  TOOL_EXECUTION_STATUS,
  TOOL_SOURCE,
  assertToolSource,
  assertToolRiskLevel,
  isTerminalToolExecutionStatus,
} from '../domain/tool/tool-execution-status.js';
import {
  APPROVAL_STATUS,
  DURABLE_APPROVAL_PENDING,
} from '../domain/tool/approval-status.js';
import {
  buildCanonicalEnvelope,
  redactEventData,
} from './fenced-run-event-recorder.js';
import { createPromiseTail } from './promise-tail.js';
import { isLocalSandboxTool } from '../extensions/enterprise-policy/tool-risk-classifier.js';
import { redactPayload } from '../infrastructure/pi/platform-event-projector.js';
import {
  assertToolExecutionReplayMatch,
  policyDecisionFingerprint,
} from '../infrastructure/mysql/repositories/tool-execution-repository.js';

/**
 * Durable policy state conflict — enterprise-policy maps to block.
 * Does not claim PR-09 resume; prevents allow bypass of prior deny/pending.
 */
export class DurablePolicyConflictError extends Error {
  /**
   * @param {string} message
   * @param {{ reasonCode?: string, toolExecution?: object }} [meta]
   */
  constructor(message, meta = {}) {
    super(message);
    this.name = 'DurablePolicyConflictError';
    this.code = 'POLICY_DURABLE_CONFLICT';
    this.reasonCode = meta.reasonCode || 'POLICY_DURABLE_CONFLICT';
    this.toolExecution = meta.toolExecution ?? null;
  }
}

/**
 * @typedef {import('./fenced-run-event-recorder.js').RunEventContext} RunEventContext
 * @typedef {import('./fenced-run-event-recorder.js').CanonicalRunEventEnvelope} CanonicalRunEventEnvelope
 */

export class FencedToolGovernanceRecorder {
  /**
   * @param {{
   *   transactionManager: { run: (fn: (trx: any) => Promise<any>) => Promise<any> },
   *   createRepositories: (db: any) => any,
   *   generateId: () => string,
   *   context: RunEventContext,
   *   executionFenceToken: number,
   *   now?: () => Date,
   *   emit?: ((envelope: CanonicalRunEventEnvelope) => Promise<void> | void) | null,
   *   isLockLost?: () => boolean,
   * }} deps
   */
  constructor(deps) {
    if (!deps?.transactionManager?.run) {
      throw new Error('FencedToolGovernanceRecorder requires transactionManager');
    }
    if (typeof deps.createRepositories !== 'function') {
      throw new Error('FencedToolGovernanceRecorder requires createRepositories');
    }
    if (typeof deps.generateId !== 'function') {
      throw new Error('FencedToolGovernanceRecorder requires generateId');
    }
    if (!deps.context?.runId || !deps.context?.agentSessionId) {
      throw new Error('FencedToolGovernanceRecorder requires run context');
    }
    if (
      deps.executionFenceToken == null ||
      !Number.isFinite(Number(deps.executionFenceToken))
    ) {
      throw new Error('FencedToolGovernanceRecorder requires executionFenceToken');
    }

    this.tx = deps.transactionManager;
    this.createRepositories = deps.createRepositories;
    this.generateId = deps.generateId;
    this.context = Object.freeze({ ...deps.context });
    this.executionFenceToken = Number(deps.executionFenceToken);
    this.now = deps.now ?? (() => new Date());
    this.emit = typeof deps.emit === 'function' ? deps.emit : null;
    this.isLockLost = deps.isLockLost ?? (() => false);
    this._tail = createPromiseTail();
    /**
     * In-process concurrent claim only (same instance). Not restart authority.
     * @type {Map<string, Promise<any>>}
     */
    this._inflight = new Map();
  }

  enqueue(fn) {
    return this._tail.enqueue(fn);
  }

  async flush() {
    await this._tail.flush();
  }

  #assertLock() {
    if (this.isLockLost()) {
      throw new SessionFenceConflictError(
        'session lock lost; refusing durable governance write',
        {
          agentSessionId: this.context.agentSessionId,
          expectedToken: this.executionFenceToken,
        },
      );
    }
  }

  /**
   * Serialize concurrent same-key work on this instance only.
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} work
   * @returns {Promise<T>}
   */
  async #withInflight(key, work) {
    const existing = this._inflight.get(key);
    if (existing) return existing;
    const p = (async () => {
      try {
        return await work();
      } finally {
        this._inflight.delete(key);
      }
    })();
    this._inflight.set(key, p);
    return p;
  }

  /**
   * @param {any} repos
   * @param {{ type: string, data: object, spanId?: string | null, timestamp: Date }} input
   */
  async #appendEventInTrx(repos, input) {
    const eventId = assertUlid(this.generateId(), 'eventId');
    const outboxId = assertUlid(this.generateId(), 'outboxId');
    const data = redactEventData(input.data ?? {});
    const spanId = input.spanId ?? null;
    const stored = await repos.runEvents.append({
      eventId,
      runId: this.context.runId,
      orgId: this.context.orgId,
      userId: this.context.userId,
      eventType: input.type,
      eventVersion: 1,
      payloadJson: {
        context: {
          orgId: this.context.orgId,
          userId: this.context.userId,
          conversationId: this.context.conversationId,
          agentSessionId: this.context.agentSessionId,
          runId: this.context.runId,
          traceId: this.context.traceId,
          spanId,
        },
        data,
      },
      traceId: this.context.traceId,
      spanId,
      createdAt: input.timestamp,
    });
    const envelope = buildCanonicalEnvelope({
      eventId: stored.eventId,
      sequence: stored.sequenceNo,
      type: input.type,
      timestamp: input.timestamp,
      context: { ...this.context, spanId },
      data,
      eventVersion: 1,
    });
    await repos.outbox.insert({
      outboxId,
      aggregateType: AGGREGATE_TYPE_RUN,
      aggregateId: this.context.runId,
      eventType: input.type,
      payloadJson: {
        eventId: envelope.eventId,
        eventVersion: envelope.eventVersion,
        sequence: envelope.sequence,
        type: envelope.type,
        timestamp: envelope.timestamp,
        context: envelope.context,
        data: envelope.data,
        runId: this.context.runId,
        orgId: this.context.orgId,
        userId: this.context.userId,
      },
    });
    return envelope;
  }

  #resolveToolSource(toolName, explicit) {
    if (explicit) return assertToolSource(explicit);
    if (isLocalSandboxTool(toolName)) return TOOL_SOURCE.SANDBOX;
    if (toolName.startsWith('mcp__')) return TOOL_SOURCE.MCP;
    return TOOL_SOURCE.INTERNAL;
  }

  /**
   * Policy decision audit + ToolExecution propose.
   * Restart-safe: audit only when ToolExecution is newly created.
   * Always returns stable `{ toolExecution, audit, created, envelopes }`.
   *
   * @param {{
   *   toolCallId: string,
   *   toolName: string,
   *   args?: unknown,
   *   decision: {
   *     decision: string,
   *     reasonCode: string,
   *     reason: string,
   *     policyId: string,
   *     riskLevel: string,
   *   },
   *   toolSource?: string,
   * }} input
   */
  async recordPolicyDecision(input) {
    this.#assertLock();
    const toolCallId = String(input.toolCallId || '').trim();
    if (!toolCallId) {
      throw new Error('recordPolicyDecision requires toolCallId');
    }
    const toolName = String(input.toolName || '').trim();

    return this.#withInflight(`policy.decision:${toolCallId}`, async () => {
      const decision = input.decision;
      const toolSource = this.#resolveToolSource(toolName, input.toolSource);
      const riskLevel = assertToolRiskLevel(decision.riskLevel || 'low');
      // Exact durable policy identity (hidden in args envelope).
      const policyFingerprint = policyDecisionFingerprint({
        decision: decision.decision,
        reasonCode: decision.reasonCode,
        reason: decision.reason,
        policyId: decision.policyId,
        riskLevel: decision.riskLevel,
      });

      let desiredStatus = TOOL_EXECUTION_STATUS.PROPOSED;
      let errorCode = null;
      if (decision.decision === 'deny') {
        desiredStatus = TOOL_EXECUTION_STATUS.FAILED;
        errorCode = decision.reasonCode || 'POLICY_DENIED';
      } else if (decision.decision === 'require_approval') {
        desiredStatus = TOOL_EXECUTION_STATUS.WAITING_APPROVAL;
      }

      /** @type {any} */
      let result = null;

      await this.tx.run(async (trx) => {
        const repos = this.createRepositories(trx);
        await repos.sessions.assertExecutionFence(
          this.context.agentSessionId,
          {
            orgId: this.context.orgId,
            userId: this.context.userId,
          },
          this.executionFenceToken,
          { forUpdate: true, requireActive: true },
        );

        if (!repos.toolExecutions || !repos.sandboxAudit) {
          throw new Error(
            'createRepositories must wire toolExecutions and sandboxAudit (PR-06 B2)',
          );
        }

        // Always PROPOSED first; getOrCreate transitions for deny/waiting with timestamps.
        // policyFingerprint is stored in hidden envelope metadata.
        const proposed = await repos.toolExecutions.getOrCreate({
          toolExecutionId: assertUlid(this.generateId(), 'toolExecutionId'),
          runId: this.context.runId,
          agentSessionId: this.context.agentSessionId,
          toolCallId,
          toolName,
          toolSource,
          riskLevel,
          argumentsJson: input.args ?? {},
          status: desiredStatus,
          errorCode,
          policyFingerprint,
          traceId: this.context.traceId,
          orgId: this.context.orgId,
          userId: this.context.userId,
        });

        let toolExecution = proposed.toolExecution;

        // Fail-closed durable policy state on replay.
        // - exact fingerprint only
        // - allow only for PROPOSED (never re-execute RUNNING/SUCCEEDED/…)
        if (!proposed.created) {
          assertCompatiblePolicyReplay(toolExecution, {
            decision: decision.decision,
            desiredStatus,
            errorCode,
            policyFingerprint,
          });
        }

        // Replay: if existing is still PROPOSED but we need deny/waiting, transition once.
        if (
          !proposed.created &&
          toolExecution.status === TOOL_EXECUTION_STATUS.PROPOSED &&
          desiredStatus !== TOOL_EXECUTION_STATUS.PROPOSED
        ) {
          const tr = await repos.toolExecutions.transitionStatus({
            toolExecutionId: toolExecution.toolExecutionId,
            orgId: this.context.orgId,
            userId: this.context.userId,
            fromStatus: TOOL_EXECUTION_STATUS.PROPOSED,
            toStatus: desiredStatus,
            errorCode,
            setCompletedAt: desiredStatus === TOOL_EXECUTION_STATUS.FAILED,
          });
          toolExecution = tr.toolExecution;
        }

        // Exactly-once audit per ToolExecution proposal across restarts.
        let audit = null;
        if (proposed.created) {
          audit = await repos.sandboxAudit.append({
            auditId: assertUlid(this.generateId(), 'auditId'),
            orgId: this.context.orgId,
            userId: this.context.userId,
            eventType: 'policy.decision',
            sandboxSessionId: this.context.sandboxSessionId ?? null,
            executionId: null,
            processId: null,
            traceId: this.context.traceId,
            payloadJson: {
              toolCallId,
              toolName,
              toolExecutionId: toolExecution.toolExecutionId,
              decision: decision.decision,
              reasonCode: decision.reasonCode,
              reason: decision.reason,
              policyId: decision.policyId,
              riskLevel: decision.riskLevel,
              argsSummary: redactPayload({
                toolName,
                keys:
                  input.args && typeof input.args === 'object'
                    ? Object.keys(/** @type {object} */ (input.args)).slice(
                        0,
                        16,
                      )
                    : [],
              }),
              context: {
                orgId: this.context.orgId,
                userId: this.context.userId,
                runId: this.context.runId,
                agentSessionId: this.context.agentSessionId,
                conversationId: this.context.conversationId,
                traceId: this.context.traceId,
              },
            },
          });
        }

        result = {
          toolExecution,
          audit,
          created: proposed.created,
          envelopes: /** @type {CanonicalRunEventEnvelope[]} */ ([]),
        };
      });

      return result;
    });
  }

  /**
   * require_approval: pending Approval + approval.requested only when newly created.
   *
   * @param {{
   *   toolCallId: string,
   *   toolName: string,
   *   args?: unknown,
   *   decision: object,
   *   toolExecutionId?: string,
   * }} input
   */
  async requestApproval(input) {
    this.#assertLock();
    const toolCallId = String(input.toolCallId || '').trim();
    if (!toolCallId) throw new Error('requestApproval requires toolCallId');
    const toolName = String(input.toolName || '').trim();

    return this.#withInflight(`approval.requested:${toolCallId}`, async () => {
      const timestamp = this.now();
      /** @type {any} */
      let out = null;

      await this.tx.run(async (trx) => {
        const repos = this.createRepositories(trx);
        await repos.sessions.assertExecutionFence(
          this.context.agentSessionId,
          {
            orgId: this.context.orgId,
            userId: this.context.userId,
          },
          this.executionFenceToken,
          { forUpdate: true, requireActive: true },
        );

        let toolExecution;
        const expectedSource = this.#resolveToolSource(toolName);
        if (input.toolExecutionId) {
          toolExecution = await repos.toolExecutions.getById(
            input.toolExecutionId,
            {
              orgId: this.context.orgId,
              userId: this.context.userId,
            },
            { forUpdate: true },
          );
          // Must bind to this run/session/call — never attach approval to wrong call.
          if (
            toolExecution.runId !== this.context.runId ||
            toolExecution.agentSessionId !== this.context.agentSessionId ||
            toolExecution.toolCallId !== toolCallId
          ) {
            throw new ConflictError(
              'toolExecutionId does not match current run/session/toolCallId',
              {
                resource: 'tool_executions',
                id: toolExecution.toolExecutionId,
              },
            );
          }
          assertToolExecutionReplayMatch(toolExecution, {
            toolName,
            toolSource: expectedSource,
            argumentsJson: input.args ?? {},
          });
        } else {
          const got = await repos.toolExecutions.getOrCreate({
            toolExecutionId: assertUlid(this.generateId(), 'toolExecutionId'),
            runId: this.context.runId,
            agentSessionId: this.context.agentSessionId,
            toolCallId,
            toolName,
            toolSource: expectedSource,
            riskLevel: input.decision?.riskLevel || 'high',
            argumentsJson: input.args ?? {},
            status: TOOL_EXECUTION_STATUS.WAITING_APPROVAL,
            traceId: this.context.traceId,
            orgId: this.context.orgId,
            userId: this.context.userId,
          });
          toolExecution = got.toolExecution;
        }

        if (toolExecution.status === TOOL_EXECUTION_STATUS.PROPOSED) {
          const tr = await repos.toolExecutions.transitionStatus({
            toolExecutionId: toolExecution.toolExecutionId,
            orgId: this.context.orgId,
            userId: this.context.userId,
            fromStatus: TOOL_EXECUTION_STATUS.PROPOSED,
            toStatus: TOOL_EXECUTION_STATUS.WAITING_APPROVAL,
          });
          toolExecution = tr.toolExecution;
        }

        const { approval, created } = await repos.approvals.getOrCreatePending({
          approvalId: assertUlid(this.generateId(), 'approvalId'),
          orgId: this.context.orgId,
          userId: this.context.userId,
          runId: this.context.runId,
          toolExecutionId: toolExecution.toolExecutionId,
          requestedBy: this.context.userId,
          requestJson: {
            toolCallId,
            toolName,
            toolExecutionId: toolExecution.toolExecutionId,
            decision: input.decision,
            argsSummary: redactPayload(input.args ?? {}),
            runId: this.context.runId,
            agentSessionId: this.context.agentSessionId,
            traceId: this.context.traceId,
          },
        });

        /** @type {CanonicalRunEventEnvelope | null} */
        let envelope = null;
        // MySQL-authoritative: event only when Approval row is newly created.
        if (created) {
          envelope = await this.#appendEventInTrx(repos, {
            type: 'approval.requested',
            timestamp,
            data: {
              approvalId: approval.approvalId,
              toolExecutionId: toolExecution.toolExecutionId,
              toolCallId,
              toolName,
              status: APPROVAL_STATUS.PENDING,
              reasonCode: input.decision?.reasonCode ?? 'EXTERNAL_HIGH_RISK',
              riskLevel: input.decision?.riskLevel ?? 'high',
            },
          });
        }

        out = {
          approval,
          toolExecution,
          envelope,
          created,
          durablePending: Object.freeze({
            kind: DURABLE_APPROVAL_PENDING,
            approvalId: approval.approvalId,
            toolExecutionId: toolExecution.toolExecutionId,
            toolCallId,
            toolName,
            runId: this.context.runId,
            status: APPROVAL_STATUS.PENDING,
          }),
        };
      });

      if (out?.envelope && this.emit) {
        await this.emit(out.envelope);
      }
      return out;
    });
  }

  /**
   * tool.execution.started only when ledger transitions into RUNNING.
   *
   * @param {{ toolCallId: string, toolName: string, args?: unknown }} input
   */
  async recordToolStarted(input) {
    this.#assertLock();
    const toolCallId = String(input.toolCallId || '').trim();
    if (!toolCallId) throw new Error('recordToolStarted requires toolCallId');
    const toolName = String(input.toolName || '').trim();

    return this.#withInflight(`tool.execution.started:${toolCallId}`, async () => {
      const timestamp = this.now();
      /** @type {CanonicalRunEventEnvelope | null} */
      let envelope = null;
      /** @type {any} */
      let toolExecution = null;
      let statusChanged = false;

      await this.tx.run(async (trx) => {
        const repos = this.createRepositories(trx);
        await repos.sessions.assertExecutionFence(
          this.context.agentSessionId,
          {
            orgId: this.context.orgId,
            userId: this.context.userId,
          },
          this.executionFenceToken,
          { forUpdate: true, requireActive: true },
        );

        const existing = await repos.toolExecutions.getByRunAndToolCallId(
          this.context.runId,
          toolCallId,
          {
            orgId: this.context.orgId,
            userId: this.context.userId,
          },
          { forUpdate: true },
        );

        const expectedSource = this.#resolveToolSource(
          toolName,
          input.toolSource,
        );
        if (existing) {
          // Full name/source/args integrity check on restart/replay.
          assertToolExecutionReplayMatch(existing, {
            toolName,
            toolSource: expectedSource,
            argumentsJson: input.args ?? {},
          });
          if (existing.status === TOOL_EXECUTION_STATUS.WAITING_APPROVAL) {
            throw new ConflictError(
              'TOOL_WAITING_APPROVAL: cannot start tool execution while approval is pending',
              {
                resource: 'tool_executions',
                id: existing.toolExecutionId,
              },
            );
          }
          if (isTerminalToolExecutionStatus(existing.status)) {
            // Already finished — no start event on restart.
            toolExecution = existing;
            return;
          }
          toolExecution = existing;
        } else {
          const got = await repos.toolExecutions.getOrCreate({
            toolExecutionId: assertUlid(this.generateId(), 'toolExecutionId'),
            runId: this.context.runId,
            agentSessionId: this.context.agentSessionId,
            toolCallId,
            toolName,
            toolSource: expectedSource,
            riskLevel: 'low',
            argumentsJson: input.args ?? {},
            status: TOOL_EXECUTION_STATUS.PROPOSED,
            traceId: this.context.traceId,
            orgId: this.context.orgId,
            userId: this.context.userId,
          });
          toolExecution = got.toolExecution;
        }

        if (toolExecution.status === TOOL_EXECUTION_STATUS.PROPOSED) {
          const tr = await repos.toolExecutions.transitionStatus({
            toolExecutionId: toolExecution.toolExecutionId,
            orgId: this.context.orgId,
            userId: this.context.userId,
            fromStatus: TOOL_EXECUTION_STATUS.PROPOSED,
            toStatus: TOOL_EXECUTION_STATUS.RUNNING,
            setStartedAt: true,
          });
          toolExecution = tr.toolExecution;
          statusChanged = tr.changed;
        } else if (toolExecution.status === TOOL_EXECUTION_STATUS.RUNNING) {
          statusChanged = false;
        } else {
          throw new ConflictError(
            `cannot start tool from status ${toolExecution.status}`,
            {
              resource: 'tool_executions',
              id: toolExecution.toolExecutionId,
            },
          );
        }

        // Event only when ledger actually moved into RUNNING.
        if (statusChanged) {
          envelope = await this.#appendEventInTrx(repos, {
            type: 'tool.execution.started',
            timestamp,
            data: {
              toolCallId,
              toolName,
              toolExecutionId: toolExecution.toolExecutionId,
              args: redactPayload(input.args ?? {}),
            },
          });
        }
      });

      if (envelope && this.emit) await this.emit(envelope);
      return { envelope, toolExecution, statusChanged };
    });
  }

  /**
   * tool.execution.completed|failed only when ledger transitions to terminal.
   * Same terminal + same integrity → no event; different result → conflict.
   * WAITING_APPROVAL / incompatible status → fail closed.
   *
   * @param {{
   *   toolCallId: string,
   *   toolName: string,
   *   isError?: boolean,
   *   result?: unknown,
   * }} input
   */
  async recordToolEnded(input) {
    this.#assertLock();
    const toolCallId = String(input.toolCallId || '').trim();
    if (!toolCallId) throw new Error('recordToolEnded requires toolCallId');
    const toolName = String(input.toolName || '').trim();
    const isError = Boolean(input.isError);
    const eventType = isError
      ? 'tool.execution.failed'
      : 'tool.execution.completed';
    const toStatus = isError
      ? TOOL_EXECUTION_STATUS.FAILED
      : TOOL_EXECUTION_STATUS.SUCCEEDED;

    return this.#withInflight(`${eventType}:${toolCallId}`, async () => {
      const timestamp = this.now();
      /** @type {CanonicalRunEventEnvelope | null} */
      let envelope = null;
      /** @type {any} */
      let toolExecution = null;
      let statusChanged = false;

      await this.tx.run(async (trx) => {
        const repos = this.createRepositories(trx);
        await repos.sessions.assertExecutionFence(
          this.context.agentSessionId,
          {
            orgId: this.context.orgId,
            userId: this.context.userId,
          },
          this.executionFenceToken,
          { forUpdate: true, requireActive: true },
        );

        let existing = await repos.toolExecutions.getByRunAndToolCallId(
          this.context.runId,
          toolCallId,
          {
            orgId: this.context.orgId,
            userId: this.context.userId,
          },
          { forUpdate: true },
        );

        // End event has name/status/result; args often absent from Pi end event.
        // Validate name + derived source; args integrity only when args provided.
        if (existing) {
          assertToolExecutionReplayMatch(existing, {
            toolName,
            toolSource: this.#resolveToolSource(toolName, input.toolSource),
            ...(input.args !== undefined
              ? { argumentsJson: input.args }
              : {}),
          });
        }

        if (existing?.status === TOOL_EXECUTION_STATUS.WAITING_APPROVAL) {
          throw new ConflictError(
            'TOOL_WAITING_APPROVAL: cannot complete tool while approval is pending',
            {
              resource: 'tool_executions',
              id: existing.toolExecutionId,
            },
          );
        }

        if (!existing) {
          const got = await repos.toolExecutions.getOrCreate({
            toolExecutionId: assertUlid(this.generateId(), 'toolExecutionId'),
            runId: this.context.runId,
            agentSessionId: this.context.agentSessionId,
            toolCallId,
            toolName,
            toolSource: this.#resolveToolSource(toolName),
            riskLevel: 'low',
            argumentsJson: {},
            status: TOOL_EXECUTION_STATUS.PROPOSED,
            traceId: this.context.traceId,
            orgId: this.context.orgId,
            userId: this.context.userId,
          });
          existing = got.toolExecution;
        }

        toolExecution = existing;

        if (toolExecution.status === TOOL_EXECUTION_STATUS.PROPOSED) {
          await repos.toolExecutions.transitionStatus({
            toolExecutionId: toolExecution.toolExecutionId,
            orgId: this.context.orgId,
            userId: this.context.userId,
            fromStatus: TOOL_EXECUTION_STATUS.PROPOSED,
            toStatus: TOOL_EXECUTION_STATUS.RUNNING,
            setStartedAt: true,
          });
          const tr = await repos.toolExecutions.transitionStatus({
            toolExecutionId: toolExecution.toolExecutionId,
            orgId: this.context.orgId,
            userId: this.context.userId,
            fromStatus: TOOL_EXECUTION_STATUS.RUNNING,
            toStatus,
            resultJson: input.result ?? null,
            errorCode: isError ? 'TOOL_ERROR' : null,
            setCompletedAt: true,
          });
          toolExecution = tr.toolExecution;
          statusChanged = tr.changed;
        } else if (toolExecution.status === TOOL_EXECUTION_STATUS.RUNNING) {
          const tr = await repos.toolExecutions.transitionStatus({
            toolExecutionId: toolExecution.toolExecutionId,
            orgId: this.context.orgId,
            userId: this.context.userId,
            fromStatus: TOOL_EXECUTION_STATUS.RUNNING,
            toStatus,
            resultJson: input.result ?? null,
            errorCode: isError ? 'TOOL_ERROR' : null,
            setCompletedAt: true,
          });
          toolExecution = tr.toolExecution;
          statusChanged = tr.changed;
        } else if (toolExecution.status === toStatus) {
          // Same terminal — integrity check inside transitionStatus; no event.
          const tr = await repos.toolExecutions.transitionStatus({
            toolExecutionId: toolExecution.toolExecutionId,
            orgId: this.context.orgId,
            userId: this.context.userId,
            fromStatus: toStatus,
            toStatus,
            resultJson: input.result ?? toolExecution.resultJson,
          });
          toolExecution = tr.toolExecution;
          statusChanged = false;
        } else if (isTerminalToolExecutionStatus(toolExecution.status)) {
          // Different terminal (e.g. SUCCEEDED vs FAILED) — fail closed.
          throw new ConflictError(
            `tool execution already terminal as ${toolExecution.status}; cannot end as ${toStatus}`,
            {
              resource: 'tool_executions',
              id: toolExecution.toolExecutionId,
            },
          );
        } else {
          throw new ConflictError(
            `cannot end tool from status ${toolExecution.status}`,
            {
              resource: 'tool_executions',
              id: toolExecution.toolExecutionId,
            },
          );
        }

        if (statusChanged) {
          envelope = await this.#appendEventInTrx(repos, {
            type: eventType,
            timestamp,
            data: {
              toolCallId,
              toolName,
              toolExecutionId: toolExecution.toolExecutionId,
              isError,
              result: redactPayload(input.result ?? null),
            },
          });
        }
      });

      if (envelope && this.emit) await this.emit(envelope);
      return { envelope, toolExecution, statusChanged };
    });
  }

  /**
   * Explicit ambiguous/unknown tool completion (PR-07B).
   *
   * ONLY for uncertain outcomes (transport/timeout ambiguity). Ordinary tool
   * errors must continue to use {@link recordToolEnded} → FAILED.
   * Transitions RUNNING → UNKNOWN (terminal). Emits durable
   * `tool.execution.failed` with unknownOutcome marker — never success.
   * Idempotent on same UNKNOWN + same result; conflicts with
   * SUCCEEDED/FAILED/CANCELLED/WAITING_APPROVAL/PROPOSED.
   *
   * @param {{
   *   toolCallId: string,
   *   toolName: string,
   *   result?: unknown,
   *   errorCode?: string | null,
   *   toolSource?: string,
   *   args?: unknown,
   * }} input
   */
  async recordToolUnknown(input) {
    this.#assertLock();
    const toolCallId = String(input.toolCallId || '').trim();
    if (!toolCallId) throw new Error('recordToolUnknown requires toolCallId');
    const toolName = String(input.toolName || '').trim();
    const eventType = 'tool.execution.failed';
    const toStatus = TOOL_EXECUTION_STATUS.UNKNOWN;
    const errorCode =
      input.errorCode != null && String(input.errorCode).trim()
        ? String(input.errorCode)
        : 'TOOL_OUTCOME_UNKNOWN';
    // Stable default — never invent a fresh object on idempotent replay.
    const defaultUnknownResult = Object.freeze({
      unknown: true,
      reason: 'TOOL_OUTCOME_UNKNOWN',
    });

    return this.#withInflight(`tool.execution.unknown:${toolCallId}`, async () => {
      const timestamp = this.now();
      /** @type {CanonicalRunEventEnvelope | null} */
      let envelope = null;
      /** @type {any} */
      let toolExecution = null;
      let statusChanged = false;

      await this.tx.run(async (trx) => {
        const repos = this.createRepositories(trx);
        await repos.sessions.assertExecutionFence(
          this.context.agentSessionId,
          {
            orgId: this.context.orgId,
            userId: this.context.userId,
          },
          this.executionFenceToken,
          { forUpdate: true, requireActive: true },
        );

        let existing = await repos.toolExecutions.getByRunAndToolCallId(
          this.context.runId,
          toolCallId,
          {
            orgId: this.context.orgId,
            userId: this.context.userId,
          },
          { forUpdate: true },
        );

        if (existing) {
          assertToolExecutionReplayMatch(existing, {
            toolName,
            toolSource: this.#resolveToolSource(toolName, input.toolSource),
            ...(input.args !== undefined
              ? { argumentsJson: input.args }
              : {}),
          });
        }

        if (existing?.status === TOOL_EXECUTION_STATUS.WAITING_APPROVAL) {
          throw new ConflictError(
            'TOOL_WAITING_APPROVAL: cannot mark unknown while approval is pending',
            {
              resource: 'tool_executions',
              id: existing.toolExecutionId,
            },
          );
        }

        if (!existing) {
          throw new ConflictError(
            'recordToolUnknown requires an existing ToolExecution (no invent)',
            {
              resource: 'tool_executions',
              id: `${this.context.runId}:${toolCallId}`,
            },
          );
        }

        toolExecution = existing;

        if (toolExecution.status === TOOL_EXECUTION_STATUS.RUNNING) {
          const resultJson =
            input.result !== undefined ? input.result : defaultUnknownResult;
          const tr = await repos.toolExecutions.transitionStatus({
            toolExecutionId: toolExecution.toolExecutionId,
            orgId: this.context.orgId,
            userId: this.context.userId,
            fromStatus: TOOL_EXECUTION_STATUS.RUNNING,
            toStatus,
            resultJson,
            errorCode,
            setCompletedAt: true,
          });
          toolExecution = tr.toolExecution;
          statusChanged = tr.changed;
        } else if (toolExecution.status === toStatus) {
          // Idempotent same UNKNOWN: only re-check integrity when caller
          // supplies result. Omitted result must not re-fingerprint a newly
          // constructed default object against stored integrity.
          /** @type {Record<string, unknown>} */
          const replay = {
            toolExecutionId: toolExecution.toolExecutionId,
            orgId: this.context.orgId,
            userId: this.context.userId,
            fromStatus: toStatus,
            toStatus,
          };
          if (input.result !== undefined) {
            replay.resultJson = input.result;
          }
          const tr = await repos.toolExecutions.transitionStatus(replay);
          toolExecution = tr.toolExecution;
          statusChanged = false;
        } else if (isTerminalToolExecutionStatus(toolExecution.status)) {
          throw new ConflictError(
            `tool execution already terminal as ${toolExecution.status}; cannot mark UNKNOWN`,
            {
              resource: 'tool_executions',
              id: toolExecution.toolExecutionId,
            },
          );
        } else {
          // PROPOSED and any other non-RUNNING non-terminal status.
          throw new ConflictError(
            `cannot mark UNKNOWN from status ${toolExecution.status}`,
            {
              resource: 'tool_executions',
              id: toolExecution.toolExecutionId,
            },
          );
        }

        if (statusChanged) {
          const resultForEvent =
            input.result !== undefined ? input.result : defaultUnknownResult;
          envelope = await this.#appendEventInTrx(repos, {
            type: eventType,
            timestamp,
            data: {
              toolCallId,
              toolName,
              toolExecutionId: toolExecution.toolExecutionId,
              isError: true,
              unknownOutcome: true,
              errorCode,
              result: redactPayload(resultForEvent),
            },
          });
        }
      });

      if (envelope && this.emit) await this.emit(envelope);
      return { envelope, toolExecution, statusChanged };
    });
  }

  /**
   * Bind sandbox request-hash to an existing RUNNING ToolExecution ledger row
   * (PR-07B batch 2B). Must complete before any Sandbox transport call.
   *
   * Reuses ToolExecutionRepository.bindSandboxRequest (session/run FOR SHARE,
   * direct tool FOR UPDATE; ACTIVE fence; conversation + sandboxSession +
   * exact toolName; RUNNING + tool_source=sandbox only).
   *
   * @param {{
   *   toolCallId: string,
   *   toolName: string,
   *   requestHash: string,
   *   requestHashVersion?: number,
   *   toolExecutionId?: string,
   * }} input
   * @returns {Promise<{
   *   toolExecutionId: string,
   *   requestHash: string,
   *   requestHashVersion: number,
   *   bound: boolean,
   *   toolExecution: object,
   * }>}
   */
  async bindSandboxRequest(input) {
    this.#assertLock();
    const toolCallId = String(input?.toolCallId || '').trim();
    if (!toolCallId) {
      throw new Error('bindSandboxRequest requires toolCallId');
    }
    const toolName = String(input?.toolName || '').trim();
    if (!toolName) {
      throw new Error('bindSandboxRequest requires toolName');
    }
    const requestHash = String(input?.requestHash || '');
    if (!/^[0-9a-f]{64}$/.test(requestHash)) {
      throw new Error('bindSandboxRequest requires requestHash (64 lowercase hex)');
    }
    // Strict positive safe int — no string/bool/float coercion.
    const rawVer =
      input?.requestHashVersion != null ? input.requestHashVersion : 1;
    if (
      typeof rawVer !== 'number' ||
      !Number.isSafeInteger(rawVer) ||
      rawVer <= 0
    ) {
      throw new Error(
        'bindSandboxRequest requires positive safe integer requestHashVersion',
      );
    }
    const requestHashVersion = rawVer;

    const conversationId = this.context.conversationId;
    const sandboxSessionId = this.context.sandboxSessionId;
    if (
      conversationId == null ||
      !String(conversationId).trim() ||
      sandboxSessionId == null ||
      !String(sandboxSessionId).trim()
    ) {
      throw new Error(
        'bindSandboxRequest requires frozen context conversationId and sandboxSessionId',
      );
    }

    return this.#withInflight(`sandbox.bind:${toolCallId}`, async () => {
      /** @type {any} */
      let out = null;
      await this.tx.run(async (trx) => {
        const repos = this.createRepositories(trx);
        if (!repos?.toolExecutions?.bindSandboxRequest) {
          throw new Error(
            'createRepositories must wire toolExecutions.bindSandboxRequest',
          );
        }
        /** @type {Record<string, unknown>} */
        const bindInput = {
          runId: this.context.runId,
          toolCallId,
          toolName,
          agentSessionId: this.context.agentSessionId,
          conversationId: String(conversationId),
          sandboxSessionId: String(sandboxSessionId),
          requestHash,
          requestHashVersion,
          executionFenceToken: this.executionFenceToken,
          orgId: this.context.orgId,
          userId: this.context.userId,
        };
        if (
          input.toolExecutionId != null &&
          String(input.toolExecutionId).trim() !== ''
        ) {
          bindInput.toolExecutionId = assertUlid(
            input.toolExecutionId,
            'toolExecutionId',
          );
        }
        const result = await repos.toolExecutions.bindSandboxRequest(bindInput);
        out = {
          toolExecutionId: String(result.toolExecution.toolExecutionId),
          requestHash,
          requestHashVersion,
          bound: Boolean(result.bound),
          toolExecution: result.toolExecution,
        };
      });
      return out;
    });
  }
}

/**
 * Enforce durable prior policy state vs a freshly evaluated decision.
 *
 * Exact policy fingerprint required (no broad POLICY/DENIED matching).
 * Fresh `allow` may proceed only when durable status is still PROPOSED.
 * RUNNING / SUCCEEDED / FAILED / WAITING_APPROVAL must not re-enter execute
 * (tool_call gate returns block via DurablePolicyConflictError).
 *
 * @param {object} toolExecution
 * @param {{
 *   decision: string,
 *   desiredStatus: string,
 *   errorCode?: string | null,
 *   policyFingerprint: string,
 * }} next
 */
export function assertCompatiblePolicyReplay(toolExecution, next) {
  const status = toolExecution.status;
  const decision = next.decision;
  const nextPf = next.policyFingerprint
    ? String(next.policyFingerprint).toLowerCase()
    : '';
  const havePf = toolExecution._policyFingerprint
    ? String(toolExecution._policyFingerprint).toLowerCase()
    : '';

  if (!nextPf || !/^[0-9a-f]{64}$/.test(nextPf)) {
    throw new DurablePolicyConflictError(
      'POLICY_FINGERPRINT_REQUIRED: policy replay requires exact decision fingerprint',
      { reasonCode: 'POLICY_FINGERPRINT_REQUIRED', toolExecution },
    );
  }
  // Legacy rows without stored fingerprint: fail closed for policy path.
  if (!havePf) {
    throw new DurablePolicyConflictError(
      'POLICY_FINGERPRINT_MISSING: durable ToolExecution has no policy fingerprint',
      { reasonCode: 'POLICY_FINGERPRINT_MISSING', toolExecution },
    );
  }
  if (havePf !== nextPf) {
    throw new DurablePolicyConflictError(
      'POLICY_FINGERPRINT_MISMATCH: changed decision/reasonCode/reason/policyId/riskLevel',
      { reasonCode: 'POLICY_FINGERPRINT_MISMATCH', toolExecution },
    );
  }

  // Fingerprints match — status-specific compatibility for tool_call gate.
  if (decision === 'allow') {
    // Only exact-policy PROPOSED may return allow (tool not yet started).
    if (status === TOOL_EXECUTION_STATUS.PROPOSED) {
      return;
    }
    if (
      status === TOOL_EXECUTION_STATUS.RUNNING ||
      status === TOOL_EXECUTION_STATUS.SUCCEEDED
    ) {
      throw new DurablePolicyConflictError(
        `durable ToolExecution is ${status}; refuse re-execution (no transport idempotency yet)`,
        {
          reasonCode: 'POLICY_DURABLE_ALREADY_EXECUTED',
          toolExecution,
        },
      );
    }
    if (status === TOOL_EXECUTION_STATUS.FAILED) {
      throw new DurablePolicyConflictError(
        'durable ToolExecution is FAILED; refuse re-execution under allow',
        { reasonCode: 'POLICY_DURABLE_ALREADY_EXECUTED', toolExecution },
      );
    }
    if (status === TOOL_EXECUTION_STATUS.WAITING_APPROVAL) {
      throw new DurablePolicyConflictError(
        'durable ToolExecution is WAITING_APPROVAL; fresh allow cannot bypass',
        { reasonCode: 'POLICY_DURABLE_PENDING', toolExecution },
      );
    }
    throw new DurablePolicyConflictError(
      `durable ToolExecution is ${status}; refuse allow replay`,
      { reasonCode: 'POLICY_DURABLE_CONFLICT', toolExecution },
    );
  }

  if (decision === 'deny') {
    // Exact same deny on FAILED: idempotent block (no new audit).
    if (status === TOOL_EXECUTION_STATUS.FAILED) {
      return;
    }
    // PROPOSED may still transition to FAILED (same fingerprint) — rare.
    if (status === TOOL_EXECUTION_STATUS.PROPOSED) {
      return;
    }
    throw new DurablePolicyConflictError(
      `durable ToolExecution is ${status}; conflicting deny replay`,
      { reasonCode: 'POLICY_DURABLE_CONFLICT', toolExecution },
    );
  }

  if (decision === 'require_approval') {
    if (status === TOOL_EXECUTION_STATUS.WAITING_APPROVAL) {
      return;
    }
    if (status === TOOL_EXECUTION_STATUS.PROPOSED) {
      return;
    }
    throw new DurablePolicyConflictError(
      `durable ToolExecution is ${status}; conflicting require_approval replay`,
      { reasonCode: 'POLICY_DURABLE_CONFLICT', toolExecution },
    );
  }

  throw new DurablePolicyConflictError(
    `unrecognized policy decision for durable replay: ${decision}`,
    { reasonCode: 'POLICY_DURABLE_CONFLICT', toolExecution },
  );
}
