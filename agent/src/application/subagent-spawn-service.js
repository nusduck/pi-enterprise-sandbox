/**
 * SubagentSpawnService — durable child Runs for the subagent-spawn extension.
 *
 * A child is an ordinary Run: same runs table, same BullMQ queue, same worker
 * fleet, same recovery. Only its lineage is new (`source='subagent'`,
 * `parent_run_id`, `subagent_depth`). That is the whole point of routing spawn
 * through MySQL instead of an in-process fan-out — a child survives a worker
 * restart, is cancellable, and shows up in the audit ledger like any other Run.
 *
 * Three things this service must get right:
 *
 * 1. **Its own AgentSession.** A Run holds its AgentSession's execution fence
 *    and Redis lock for its entire life, so a child sharing the parent's
 *    session could never acquire either — it would sit in the queue until the
 *    parent finished waiting for it. Each child therefore gets a fresh
 *    conversation + AgentSession (and hence its own sandbox workspace), bound
 *    to the parent's AgentVersion so it runs the same agent configuration.
 * 2. **Exactly one child per tool call.** The Pi tool call id is the
 *    idempotency key, so a retried `spawn_subagent` adopts the child that was
 *    already created rather than forking a second one.
 * 3. **Fail closed on limits.** Depth and live-sibling count are re-checked
 *    inside the spawning transaction with the parent row locked, so two
 *    concurrent spawns cannot both read "one slot left".
 */

import { AGGREGATE_TYPE_RUN } from '../infrastructure/outbox/outbox-status.js';
import { AGENT_RUNS_QUEUE_NAME } from '../infrastructure/redis/constants.js';
import {
  isTerminalRunStatus,
  RUN_STATUS,
  runStateMachine,
} from '../domain/run/index.js';
import { assertUlid } from '../domain/shared/ulid.js';
import { hashCanonical } from './canonical-json.js';
import { OwnerScopedNotFoundError, ValidationError } from './errors.js';
import { projectAcceptedToQueued } from './run-queued-projection.js';
import { formatStoredTraceCarrier } from '../infrastructure/telemetry.js';
import { runRootSpanId } from '../infrastructure/mysql/repositories/trace-span-repository.js';
import {
  MAX_CONCURRENT_CHILDREN,
  MAX_SUBAGENT_DEPTH,
} from '../extensions/subagent-spawn/constants.js';

/** Run source recorded for every child (runs.source, VARCHAR(32)). */
export const SUBAGENT_RUN_SOURCE = 'subagent';

/** Idempotency operation for the spawn path. */
export const SPAWN_SUBAGENT_OPERATION = 'spawn_subagent';

export const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** Chars of a child's final assistant message handed back to the parent. */
export const DEFAULT_RESULT_SUMMARY_CHARS = 4_000;

/** Coded failures the extension turns into tool errors the model can read. */
export class SubagentLimitError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'SubagentLimitError';
    this.code = code;
  }
}

export class SubagentSpawnService {
  /**
   * @param {{
   *   transactionManager: { run: (fn: (trx: any) => Promise<any>) => Promise<any> },
   *   createRepositories: (db: any) => any,
   *   generateId: () => string,
   *   now?: () => Date,
   *   runQueue: { enqueue: (ref: object) => Promise<unknown> },
   *   runStateMachine?: object,
   *   queueName?: string,
   *   maxDepth?: number,
   *   maxConcurrent?: number,
   *   idempotencyTtlMs?: number,
   *   resultSummaryChars?: number,
   * }} deps
   */
  constructor(deps) {
    if (!deps?.transactionManager?.run) {
      throw new Error('SubagentSpawnService requires transactionManager.run');
    }
    if (typeof deps.createRepositories !== 'function') {
      throw new Error('SubagentSpawnService requires createRepositories(db)');
    }
    if (typeof deps.generateId !== 'function') {
      throw new Error('SubagentSpawnService requires generateId()');
    }
    if (!deps.runQueue || typeof deps.runQueue.enqueue !== 'function') {
      throw new Error('SubagentSpawnService requires runQueue.enqueue()');
    }
    this.tx = deps.transactionManager;
    this.createRepositories = deps.createRepositories;
    this.generateId = deps.generateId;
    this.now = deps.now ?? (() => new Date());
    this.runQueue = deps.runQueue;
    this.stateMachine = deps.runStateMachine ?? runStateMachine;
    this.queueName = deps.queueName ?? AGENT_RUNS_QUEUE_NAME;
    this.maxDepth = positiveOrDefault(deps.maxDepth, MAX_SUBAGENT_DEPTH, 0);
    this.maxConcurrent = positiveOrDefault(
      deps.maxConcurrent,
      MAX_CONCURRENT_CHILDREN,
      1,
    );
    this.idempotencyTtlMs = deps.idempotencyTtlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;
    this.resultSummaryChars = positiveOrDefault(
      deps.resultSummaryChars,
      DEFAULT_RESULT_SUMMARY_CHARS,
      1,
    );
  }

  /**
   * Create (or adopt) the child Run for one `spawn_subagent` tool call.
   *
   * @param {{
   *   toolCallId: string,
   *   parentRunId: string,
   *   orgId: string,
   *   userId: string,
   *   task: string,
   *   label?: string | null,
   *   maxDepth?: number,
   *   maxConcurrent?: number,
   * }} input
   * @returns {Promise<{ runId: string, replayed: boolean, queueWarning?: string | null }>}
   */
  async spawn(input) {
    const parentRunId = assertUlid(input?.parentRunId, 'parentRunId');
    const scope = requireScope(input);
    const toolCallId = String(input?.toolCallId ?? '').trim();
    if (!toolCallId) {
      throw new ValidationError('spawn_subagent requires a toolCallId');
    }
    const task = String(input?.task ?? '').trim();
    if (!task) {
      throw new ValidationError('spawn_subagent requires a non-empty task');
    }
    const label = input?.label == null ? null : String(input.label);
    // A per-version policy may only tighten the deployment defaults.
    const maxDepth = Math.min(
      this.maxDepth,
      positiveOrDefault(input?.maxDepth, this.maxDepth, 0),
    );
    const maxConcurrent = Math.min(
      this.maxConcurrent,
      positiveOrDefault(input?.maxConcurrent, this.maxConcurrent, 1),
    );

    const committed = await this.tx.run(async (trx) => {
      const repos = this.createRepositories(trx);
      // Lock the parent: two concurrent spawns from the same Run must not both
      // observe the same live-sibling count.
      const parent = await repos.runs.getById(parentRunId, scope, {
        forUpdate: true,
      });
      if (!parent) {
        throw new OwnerScopedNotFoundError('Parent run not found', {
          resource: 'runs',
          id: parentRunId,
        });
      }
      // The parent row is locked FOR UPDATE here and in CancelRunService, so
      // the two serialize: cancel-first makes this refuse, spawn-first makes
      // the cascade see the new child. Without this check the losing order
      // would leave a child running under a cancelled parent forever.
      if (isTerminalRunStatus(parent.status) || parent.cancelRequestedAt) {
        throw new SubagentLimitError(
          'SUBAGENT_PARENT_NOT_RUNNABLE',
          `parent run is ${parent.cancelRequestedAt ? 'being cancelled' : parent.status.toLowerCase()}; not spawning new children`,
        );
      }
      const depth = Number(parent.subagentDepth ?? 0);
      if (depth >= maxDepth) {
        throw new SubagentLimitError(
          'SUBAGENT_DEPTH_LIMIT',
          `sub-agent nesting is capped at depth ${maxDepth}`,
        );
      }

      const begun = await repos.idempotency.begin({
        orgId: scope.orgId,
        userId: scope.userId,
        idempotencyKey: spawnIdempotencyKey(parentRunId, toolCallId),
        operation: SPAWN_SUBAGENT_OPERATION,
        requestHash: hashCanonical({ parentRunId, toolCallId, task, label }),
        expiresAt: new Date(this.now().getTime() + this.idempotencyTtlMs),
      });
      if (begun.outcome === 'replay') {
        const runId = begun.record?.resourceId;
        if (typeof runId === 'string' && runId) {
          return { kind: /** @type {const} */ ('replay'), runId };
        }
        // A record without a resource id is an in-flight or corrupt first
        // write; treat it as retryable rather than inventing a child id.
        throw new SubagentLimitError(
          'SUBAGENT_SPAWN_IN_PROGRESS',
          'a previous spawn for this tool call has not completed yet',
        );
      }
      if (begun.outcome === 'in_progress') {
        throw new SubagentLimitError(
          'SUBAGENT_SPAWN_IN_PROGRESS',
          'a previous spawn for this tool call is still running',
        );
      }

      const siblings = await repos.runs.listChildren(parentRunId, scope);
      const live = siblings.filter((run) => !isTerminalRunStatus(run.status));
      if (live.length >= maxConcurrent) {
        throw new SubagentLimitError(
          'SUBAGENT_CONCURRENCY_LIMIT',
          `at most ${maxConcurrent} sub-agents may run at once; ${live.length} are still active`,
        );
      }

      const parentSpanId = runRootSpanId(parent.traceId, parentRunId);
      const parentConversation = await repos.conversations.getById(
        parent.conversationId,
        scope,
      );
      if (!parentConversation) {
        throw new OwnerScopedNotFoundError('Parent conversation not found', {
          resource: 'conversations',
          id: parent.conversationId,
        });
      }

      // Fresh conversation + AgentSession: the child must not contend for the
      // parent's execution fence (see the module header).
      const conversationId = assertUlid(this.generateId(), 'conversationId');
      const agentSessionId = assertUlid(this.generateId(), 'agentSessionId');
      const sandboxSessionId = assertUlid(this.generateId(), 'sandboxSessionId');
      const workspaceId = assertUlid(this.generateId(), 'workspaceId');
      const runId = assertUlid(this.generateId(), 'runId');
      const messageId = assertUlid(this.generateId(), 'messageId');
      const eventId = assertUlid(this.generateId(), 'eventId');
      const outboxId = assertUlid(this.generateId(), 'outboxId');

      await repos.conversations.create({
        conversationId,
        orgId: scope.orgId,
        userId: scope.userId,
        agentId: parentConversation.agentId,
        // Lineage for the conversation list: a fan-out must not push N rows
        // into the owner's sidebar.
        parentRunId,
        title: childConversationTitle(label, task),
        status: 'active',
        currentAgentSessionId: agentSessionId,
      });
      await repos.sessions.create({
        agentSessionId,
        orgId: scope.orgId,
        userId: scope.userId,
        conversationId,
        agentVersionId: parent.agentVersionId,
        sandboxSessionId,
        workspaceId,
        status: 'ACTIVE',
      });

      await repos.messages.append({
        messageId,
        conversationId,
        orgId: scope.orgId,
        userId: scope.userId,
        agentSessionId,
        runId,
        role: 'user',
        messageType: 'text',
        contentJson: {
          text: task,
          messages: [{ role: 'user', content: task }],
          // The executor reads these selectors off the triggering message; a
          // child inherits the parent's agent and takes the version default
          // model rather than pinning whatever the parent turn requested.
          agentId: parentConversation.agentId,
          agentProfileId: null,
          modelId: null,
          subagent: { parentRunId, toolCallId, ...(label ? { label } : {}) },
        },
      });

      await repos.runs.create({
        runId,
        orgId: scope.orgId,
        userId: scope.userId,
        conversationId,
        agentSessionId,
        agentVersionId: parent.agentVersionId,
        triggeringMessageId: messageId,
        source: SUBAGENT_RUN_SOURCE,
        parentRunId,
        subagentDepth: depth + 1,
        subagentLabel: label,
        status: RUN_STATUS.ACCEPTED,
        queueName: this.queueName,
        // Same trace as the parent, parented to the parent's run span: a
        // fan-out must read as one distributed trace, not as N unrelated roots.
        traceId: parent.traceId,
        traceState: parent.traceState,
        traceFlags: parent.traceFlags,
        traceParentSpanId: parentSpanId,
        nextEventSequence: 0,
      });

      const acceptedEvent = await repos.runEvents.append({
        eventId,
        runId,
        orgId: scope.orgId,
        userId: scope.userId,
        eventType: 'run.accepted',
        eventVersion: 1,
        payloadJson: {
          status: RUN_STATUS.ACCEPTED,
          conversationId,
          agentSessionId,
          triggeringMessageId: messageId,
          source: SUBAGENT_RUN_SOURCE,
          parentRunId,
          subagentDepth: depth + 1,
        },
        traceId: parent.traceId,
        traceState: parent.traceState,
      });

      await repos.outbox.insert({
        outboxId,
        aggregateType: AGGREGATE_TYPE_RUN,
        aggregateId: runId,
        eventType: 'run.accepted',
        payloadJson: {
          eventId: acceptedEvent.eventId,
          runId,
          sequence: acceptedEvent.sequenceNo,
          type: 'run.accepted',
          status: RUN_STATUS.ACCEPTED,
          orgId: scope.orgId,
          userId: scope.userId,
          conversationId,
          parentRunId,
        },
      });

      await repos.idempotency.complete({
        orgId: scope.orgId,
        userId: scope.userId,
        idempotencyKey: spawnIdempotencyKey(parentRunId, toolCallId),
        operation: SPAWN_SUBAGENT_OPERATION,
        responseStatus: 202,
        responseJson: { runId, parentRunId },
        resourceId: runId,
      });

      return {
        kind: /** @type {const} */ ('created'),
        runId,
        traceId: parent.traceId,
        traceState: parent.traceState,
        traceFlags: parent.traceFlags,
        traceParentSpanId: parentSpanId,
      };
    });

    if (committed.kind === 'replay') {
      return { runId: committed.runId, replayed: true, queueWarning: null };
    }

    // Committed before any queue call: a child Run exists even if Redis is
    // down, and recovery re-enqueues it.
    try {
      await this.runQueue.enqueue({
        runId: committed.runId,
        orgId: scope.orgId,
        traceId: committed.traceId,
        ...formatStoredTraceCarrier(committed),
      });
    } catch {
      return {
        runId: committed.runId,
        replayed: false,
        queueWarning: 'QUEUE_ENQUEUE_FAILED',
      };
    }

    const projected = await projectAcceptedToQueued({
      transactionManager: this.tx,
      createRepositories: this.createRepositories,
      generateId: this.generateId,
      stateMachine: this.stateMachine,
      runId: committed.runId,
      orgId: scope.orgId,
      userId: scope.userId,
      traceId: committed.traceId,
    });

    return {
      runId: committed.runId,
      replayed: false,
      queueWarning: projected.ok ? null : 'QUEUE_STATUS_PROJECTION_FAILED',
    };
  }

  /**
   * Status (and, once terminal, the answer) of a parent's child Runs.
   *
   * The per-child summary read is a bounded N+1: `listChildren` caps the list,
   * and only terminal children are worth summarizing, so a poll costs at most
   * one query per finished child.
   *
   * @param {{
   *   parentRunId: string,
   *   orgId: string,
   *   userId: string,
   *   childRunIds?: readonly string[] | null,
   * }} input
   * @returns {Promise<Array<{ runId: string, status: string, statusReason: string | null, label: string | null, resultSummary?: string }>>}
   */
  async getStatuses(input) {
    const parentRunId = assertUlid(input?.parentRunId, 'parentRunId');
    const scope = requireScope(input);
    return this.tx.run(async (trx) => {
      const repos = this.createRepositories(trx);
      const children = await repos.runs.listChildren(parentRunId, scope, {
        childRunIds: input?.childRunIds ?? null,
      });
      const out = [];
      for (const child of children) {
        const entry = {
          runId: child.runId,
          status: child.status,
          statusReason: child.statusReason ?? null,
          label: child.subagentLabel ?? null,
        };
        if (isTerminalRunStatus(child.status)) {
          const message = await repos.messages.latestAssistantForRun(
            child.conversationId,
            child.runId,
            scope,
          );
          const text = assistantText(message);
          if (text) entry.resultSummary = text.slice(0, this.resultSummaryChars);
        }
        out.push(entry);
      }
      return out;
    });
  }
}

/**
 * @param {string} parentRunId
 * @param {string} toolCallId
 */
export function spawnIdempotencyKey(parentRunId, toolCallId) {
  return `subagent:${parentRunId}:${toolCallId}`.slice(0, 255);
}

/**
 * @param {string | null} label
 * @param {string} task
 */
function childConversationTitle(label, task) {
  const source = (label && label.trim()) || task;
  return source.replace(/\s+/g, ' ').trim().slice(0, 120) || null;
}

/**
 * @param {unknown} message
 * @returns {string}
 */
function assistantText(message) {
  const content = /** @type {{ contentJson?: unknown }} */ (message)?.contentJson;
  if (!content || typeof content !== 'object') return '';
  const text = /** @type {{ text?: unknown }} */ (content).text;
  return typeof text === 'string' ? text.trim() : '';
}

/**
 * @param {{ orgId?: unknown, userId?: unknown }} input
 */
function requireScope(input) {
  return {
    orgId: assertUlid(input?.orgId, 'orgId'),
    userId: assertUlid(input?.userId, 'userId'),
  };
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 */
function positiveOrDefault(value, fallback, min) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= min ? n : fallback;
}
