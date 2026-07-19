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

import { assertUlid, normalizeUlid } from '../domain/shared/ulid.js';
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
import { RUN_STATUS, runStateMachine } from '../domain/run/index.js';
import {
  DURABLE_INTERACTION_PENDING,
  INTERACTION_STATUS,
} from '../domain/interaction/interaction-status.js';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

/**
 * Extract only the structured result produced by the formal submit_artifact
 * bridge. Never inspect tool text, which is model-visible and not a durable
 * artifact contract.
 *
 * @param {unknown} result
 * @returns {{ artifactId: string, name: string, mimeType: string, size: number, sha256: string, description: string | null } | null}
 */
function extractSubmittedArtifact(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const details = /** @type {Record<string, unknown>} */ (result).details;
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;

  const metadata = /** @type {Record<string, unknown>} */ (details);
  const artifactId = normalizeUlid(metadata.artifactId);
  const rawName = metadata.displayName ?? metadata.name;
  const name = typeof rawName === 'string' ? rawName : '';
  const mimeType =
    typeof metadata.mimeType === 'string' ? metadata.mimeType : '';
  const size = metadata.size;
  const sha256 = metadata.sha256;
  const rawDescription = metadata.description;

  if (
    !artifactId ||
    !name ||
    name !== name.trim() ||
    name.length > 256 ||
    CONTROL_CHARACTER_PATTERN.test(name) ||
    !mimeType ||
    mimeType !== mimeType.trim() ||
    mimeType.length > 255 ||
    CONTROL_CHARACTER_PATTERN.test(mimeType) ||
    !Number.isSafeInteger(size) ||
    Number(size) < 0 ||
    typeof sha256 !== 'string' ||
    !SHA256_PATTERN.test(sha256) ||
    (rawDescription != null &&
      (typeof rawDescription !== 'string' ||
        !rawDescription ||
        rawDescription !== rawDescription.trim() ||
        rawDescription.length > 1024 ||
        CONTROL_CHARACTER_PATTERN.test(rawDescription)))
  ) {
    return null;
  }

  return {
    artifactId,
    name,
    mimeType,
    size: Number(size),
    sha256,
    description: rawDescription == null ? null : rawDescription,
  };
}

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
      }

      /** @type {any} */
      let result = null;

      await this.tx.run(async (trx) => {
        const repos = this.createRepositories(trx);
        const scope = {
          orgId: this.context.orgId,
          userId: this.context.userId,
        };
        await repos.sessions.assertExecutionFence(
          this.context.agentSessionId,
          scope,
          this.executionFenceToken,
          { forUpdate: true, requireActive: true },
        );

        if (!repos.toolExecutions || !repos.sandboxAudit) {
          throw new Error(
            'createRepositories must wire toolExecutions and sandboxAudit (PR-06 B2)',
          );
        }

        // Approval requests remain PROPOSED until requestApproval atomically
        // creates the Approval and pauses the Run. policyFingerprint is stored
        // in hidden envelope metadata.
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

        const firstPolicyDecision =
          proposed.created || proposed.adoptedPolicyFingerprint;

        // Fail-closed durable policy state on replay.
        // - exact fingerprint only
        // - allow only for PROPOSED (never re-execute RUNNING/SUCCEEDED/…)
        if (!firstPolicyDecision) {
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

        // Pi's start event precedes beforeToolCall. Only an allowed policy
        // decision may move the side-effect-free PROPOSED row into RUNNING.
        let startedEnvelope = null;
        if (
          decision.decision === 'allow' &&
          proposed.adoptedPolicyFingerprint &&
          toolExecution.status === TOOL_EXECUTION_STATUS.PROPOSED
        ) {
          const tr = await repos.toolExecutions.transitionStatus({
            toolExecutionId: toolExecution.toolExecutionId,
            orgId: this.context.orgId,
            userId: this.context.userId,
            fromStatus: TOOL_EXECUTION_STATUS.PROPOSED,
            toStatus: TOOL_EXECUTION_STATUS.RUNNING,
            setStartedAt: true,
          });
          toolExecution = tr.toolExecution;
          if (tr.changed) {
            startedEnvelope = await this.#appendEventInTrx(repos, {
              type: 'tool.execution.started',
              timestamp: this.now(),
              data: {
                toolCallId,
                toolName,
                toolExecutionId: toolExecution.toolExecutionId,
                args: redactPayload(input.args ?? {}),
              },
            });
          }
        }

        // Exactly-once audit per ToolExecution proposal across restarts.
        let audit = null;
        if (firstPolicyDecision) {
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
          created: firstPolicyDecision,
          envelopes: /** @type {CanonicalRunEventEnvelope[]} */ (
            startedEnvelope ? [startedEnvelope] : []
          ),
        };
      });

      if (this.emit) {
        for (const envelope of result?.envelopes || []) {
          await this.emit(envelope);
        }
      }

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
        const scope = {
          orgId: this.context.orgId,
          userId: this.context.userId,
        };
        await repos.sessions.assertExecutionFence(
          this.context.agentSessionId,
          scope,
          this.executionFenceToken,
          { forUpdate: true, requireActive: true },
        );

        // Serialize approval creation and resolution on the owned parent Run.
        const run = await repos.runs.getById(this.context.runId, scope, {
          forUpdate: true,
        });
        if (!run) {
          throw new ConflictError('approval Run is not owned by this context', {
            resource: 'runs',
            id: this.context.runId,
          });
        }
        if (
          run.status !== RUN_STATUS.RUNNING &&
          run.status !== RUN_STATUS.WAITING_APPROVAL
        ) {
          throw new ConflictError(
            `cannot request approval while Run is ${run.status}`,
            { resource: 'runs', id: this.context.runId },
          );
        }

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

        if (approval.status !== APPROVAL_STATUS.PENDING) {
          throw new DurablePolicyConflictError(
            `approval ${approval.approvalId} is already ${approval.status}`,
            {
              reasonCode: 'POLICY_DURABLE_APPROVAL_RESOLVED',
              toolExecution,
            },
          );
        }
        if (created && run.status === RUN_STATUS.WAITING_APPROVAL) {
          throw new ConflictError(
            'Run is already waiting on a different approval',
            { resource: 'runs', id: this.context.runId },
          );
        }

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

        /** @type {CanonicalRunEventEnvelope | null} */
        let statusEnvelope = null;
        if (run.status === RUN_STATUS.RUNNING) {
          runStateMachine.assertTransition(
            RUN_STATUS.RUNNING,
            RUN_STATUS.WAITING_APPROVAL,
          );
          await repos.runs.updateStatusIf(this.context.runId, scope, {
            expectedStatus: RUN_STATUS.RUNNING,
            status: RUN_STATUS.WAITING_APPROVAL,
            statusReason: 'approval pending',
          });
          statusEnvelope = await this.#appendEventInTrx(repos, {
            type: 'run.status.changed',
            timestamp,
            data: {
              from: RUN_STATUS.RUNNING,
              to: RUN_STATUS.WAITING_APPROVAL,
              status: RUN_STATUS.WAITING_APPROVAL,
              approvalId: approval.approvalId,
              toolExecutionId: toolExecution.toolExecutionId,
            },
          });
        }

        out = {
          approval,
          toolExecution,
          envelope,
          statusEnvelope,
          envelopes: [envelope, statusEnvelope].filter(Boolean),
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

      if (this.emit) {
        for (const envelope of out?.envelopes || []) {
          await this.emit(envelope);
        }
      }
      return out;
    });
  }

  /**
   * Create a durable ask_user request and park the Run in WAITING_INPUT.
   * The request, interaction.requested event, Run transition, and outbox row
   * share one transaction; the returned suspension signal is ephemeral.
   * @param {{toolCallId:string,toolName?:string,args?:object,interactionType:string,title:string,message?:string|null,options?:string[],placeholder?:string|null,toolExecutionId?:string}} input
   */
  async requestInteraction(input) {
    this.#assertLock();
    const toolCallId = String(input?.toolCallId || '').trim();
    if (!toolCallId) throw new Error('requestInteraction requires toolCallId');
    const interactionType = String(input?.interactionType || '').trim().toLowerCase();
    if (!['input', 'select', 'confirm'].includes(interactionType)) {
      throw new Error('interactionType must be input, select, or confirm');
    }
    const title = String(input?.title || '').trim();
    if (!title || title.length > 512) throw new Error('interaction title is required and must be <= 512 characters');
    const message = input?.message == null ? null : String(input.message);
    const options = Array.isArray(input?.options)
      ? input.options.map((value) => String(value)).slice(0, 20)
      : [];
    if (interactionType === 'select' && options.length < 2) {
      throw new Error('select interaction requires at least two options');
    }

    return this.#withInflight(`interaction.requested:${toolCallId}`, async () => {
      /** @type {any} */
      let out = null;
      await this.tx.run(async (trx) => {
        const repos = this.createRepositories(trx);
        const scope = { orgId: this.context.orgId, userId: this.context.userId };
        await repos.sessions.assertExecutionFence(
          this.context.agentSessionId,
          scope,
          this.executionFenceToken,
          { forUpdate: true, requireActive: true },
        );
        if (!repos.interactions) {
          throw new Error('createRepositories must wire interactions');
        }
        const run = await repos.runs.getById(this.context.runId, scope, {
          forUpdate: true,
        });
        if (!run) throw new ConflictError('interaction Run is not owned by this context', { resource: 'runs', id: this.context.runId });
        if (run.status !== RUN_STATUS.RUNNING && run.status !== RUN_STATUS.WAITING_INPUT) {
          throw new ConflictError(`cannot request interaction while Run is ${run.status}`, { resource: 'runs', id: run.runId });
        }

        let toolExecution;
        if (input.toolExecutionId) {
          toolExecution = await repos.toolExecutions.getById(input.toolExecutionId, scope, { forUpdate: true });
          if (
            toolExecution.runId !== run.runId ||
            toolExecution.agentSessionId !== this.context.agentSessionId ||
            toolExecution.toolCallId !== toolCallId
          ) {
            throw new ConflictError('interaction tool execution binding mismatch', { resource: 'tool_executions', id: toolExecution.toolExecutionId });
          }
        } else {
          toolExecution = await repos.toolExecutions.getByRunAndToolCallId(
            run.runId,
            toolCallId,
            scope,
            { forUpdate: true },
          );
        }
        if (!toolExecution) {
          const created = await repos.toolExecutions.getOrCreate({
            toolExecutionId: assertUlid(this.generateId(), 'toolExecutionId'),
            runId: run.runId,
            agentSessionId: this.context.agentSessionId,
            toolCallId,
            toolName: String(input.toolName || 'ask_user'),
            toolSource: 'internal',
            riskLevel: 'low',
            argumentsJson: input.args ?? {},
            status: TOOL_EXECUTION_STATUS.PROPOSED,
            traceId: this.context.traceId,
            orgId: this.context.orgId,
            userId: this.context.userId,
          });
          toolExecution = created.toolExecution;
        }
        if (toolExecution.status === TOOL_EXECUTION_STATUS.PROPOSED) {
          const started = await repos.toolExecutions.transitionStatus({
            toolExecutionId: toolExecution.toolExecutionId,
            orgId: this.context.orgId,
            userId: this.context.userId,
            fromStatus: TOOL_EXECUTION_STATUS.PROPOSED,
            toStatus: TOOL_EXECUTION_STATUS.RUNNING,
            setStartedAt: true,
          });
          toolExecution = started.toolExecution;
        }
        if (toolExecution.status !== TOOL_EXECUTION_STATUS.RUNNING) {
          throw new ConflictError(`interaction tool execution is ${toolExecution.status}`, { resource: 'tool_executions', id: toolExecution.toolExecutionId });
        }

        const requestJson = {
          interactionId: input.interactionId || null,
          interactionType,
          title,
          message,
          options,
          placeholder: input.placeholder == null ? null : String(input.placeholder),
          toolName: String(input.toolName || 'ask_user'),
          toolCallId,
          toolExecutionId: toolExecution.toolExecutionId,
          runId: run.runId,
          agentSessionId: this.context.agentSessionId,
          traceId: this.context.traceId,
        };
        const pending = await repos.interactions.getOrCreatePending({
          interactionId: assertUlid(input.interactionId || this.generateId(), 'interactionId'),
          orgId: this.context.orgId,
          userId: this.context.userId,
          runId: run.runId,
          agentSessionId: this.context.agentSessionId,
          toolExecutionId: toolExecution.toolExecutionId,
          toolCallId,
          interactionType,
          requestJson,
        });
        const interaction = pending.interaction;
        if (interaction.status !== INTERACTION_STATUS.PENDING) {
          throw new ConflictError(
            `interaction ${interaction.interactionId} is already ${interaction.status}`,
            { resource: 'interactions', id: interaction.interactionId },
          );
        }
        /** @type {any[]} */
        const envelopes = [];
        if (pending.created) {
          await this.#appendEventInTrx(repos, {
            type: 'interaction.requested',
            timestamp: this.now(),
            data: {
              interactionId: interaction.interactionId,
              interactionType,
              title,
              message,
              options,
              placeholder: requestJson.placeholder,
              toolCallId,
              toolExecutionId: toolExecution.toolExecutionId,
              status: INTERACTION_STATUS.PENDING,
            },
          }).then((envelope) => envelopes.push(envelope));
        }
        if (run.status === RUN_STATUS.RUNNING && pending.created) {
          runStateMachine.assertTransition(RUN_STATUS.RUNNING, RUN_STATUS.WAITING_INPUT);
          await repos.runs.updateStatusIf(run.runId, scope, {
            expectedStatus: RUN_STATUS.RUNNING,
            status: RUN_STATUS.WAITING_INPUT,
            statusReason: 'user interaction pending',
          });
          await this.#appendEventInTrx(repos, {
            type: 'run.status.changed',
            timestamp: this.now(),
            data: {
              from: RUN_STATUS.RUNNING,
              to: RUN_STATUS.WAITING_INPUT,
              status: RUN_STATUS.WAITING_INPUT,
              interactionId: interaction.interactionId,
              interactionType,
              title,
              message,
              options,
            },
          }).then((envelope) => envelopes.push(envelope));
        }
        out = {
          interaction,
          toolExecution,
          created: pending.created,
          envelopes,
          durablePending: Object.freeze({
            kind: DURABLE_INTERACTION_PENDING,
            interactionId: interaction.interactionId,
            interactionType,
            title,
            message,
            options,
            toolCallId,
            toolExecutionId: toolExecution.toolExecutionId,
            runId: run.runId,
            status: INTERACTION_STATUS.PENDING,
          }),
        };
      });
      if (this.emit) {
        for (const envelope of out?.envelopes || []) await this.emit(envelope);
      }
      return out;
    });
  }

  /**
   * tool.execution.started only when ledger transitions into RUNNING.
   *
   * @param {{ toolCallId: string, toolName: string, args?: unknown, toolSource?: string, approvalId?: string }} input
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
            if (!input.approvalId) {
              throw new ConflictError(
                'TOOL_WAITING_APPROVAL: cannot start tool execution while approval is pending',
                {
                  resource: 'tool_executions',
                  id: existing.toolExecutionId,
                },
              );
            }
            const approval = await repos.approvals.getById(
              input.approvalId,
              {
                orgId: this.context.orgId,
                userId: this.context.userId,
              },
              { forUpdate: true },
            );
            if (
              approval.runId !== this.context.runId ||
              approval.toolExecutionId !== existing.toolExecutionId ||
              approval.status !== APPROVAL_STATUS.APPROVED
            ) {
              throw new ConflictError(
                'approved replay does not match the waiting tool execution',
                { resource: 'approvals', id: approval.approvalId },
              );
            }
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
            policyPending: true,
            traceId: this.context.traceId,
            orgId: this.context.orgId,
            userId: this.context.userId,
          });
          toolExecution = got.toolExecution;
        }

        if (
          toolExecution.status === TOOL_EXECUTION_STATUS.PROPOSED ||
          toolExecution.status === TOOL_EXECUTION_STATUS.WAITING_APPROVAL
        ) {
          if (
            toolExecution.status === TOOL_EXECUTION_STATUS.PROPOSED &&
            !toolExecution._policyFingerprint
          ) {
            // Pi emits this notification before beforeToolCall. Leave a
            // side-effect-free placeholder for policy to adopt.
            statusChanged = false;
          } else {
            const fromStatus = toolExecution.status;
            const tr = await repos.toolExecutions.transitionStatus({
              toolExecutionId: toolExecution.toolExecutionId,
              orgId: this.context.orgId,
              userId: this.context.userId,
              fromStatus,
              toStatus: TOOL_EXECUTION_STATUS.RUNNING,
              setStartedAt: true,
            });
            toolExecution = tr.toolExecution;
            statusChanged = tr.changed;
          }
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
              ...(input.approvalId
                ? { approvalId: input.approvalId, approvalReplay: true }
                : {}),
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
      /** @type {CanonicalRunEventEnvelope | null} */
      let artifactEnvelope = null;
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

          const artifact =
            !isError && toolName === 'submit_artifact'
              ? extractSubmittedArtifact(input.result)
              : null;
          if (artifact) {
            artifactEnvelope = await this.#appendEventInTrx(repos, {
              type: 'artifact.ready',
              timestamp,
              data: {
                artifactId: artifact.artifactId,
                name: artifact.name,
                mimeType: artifact.mimeType,
                size: artifact.size,
                sha256: artifact.sha256,
                description: artifact.description,
                toolCallId,
                toolExecutionId: toolExecution.toolExecutionId,
              },
            });
          }
        }
      });

      if (envelope && this.emit) await this.emit(envelope);
      if (artifactEnvelope && this.emit) await this.emit(artifactEnvelope);
      return {
        envelope,
        artifactEnvelope,
        envelopes: [envelope, artifactEnvelope].filter(Boolean),
        toolExecution,
        statusChanged,
      };
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
 * Fresh `allow` may proceed while PROPOSED. RUNNING is replay-compatible only
 * before a Sandbox request claim exists; claimed/terminal states cannot re-enter.
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
    // Exact-policy PROPOSED, or the brief pre-claim RUNNING window, is safe to
    // replay. The toolCall id remains unique and transport binding is atomic.
    if (status === TOOL_EXECUTION_STATUS.PROPOSED) {
      return;
    }
    if (
      status === TOOL_EXECUTION_STATUS.RUNNING &&
      !toolExecution.requestHash
    ) {
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
