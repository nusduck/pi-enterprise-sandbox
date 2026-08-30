/**
 * A2A Task service (plan §20) — SendMessage / GetTask / CancelTask.
 *
 * Severe guarantees (PR-12 follow-up):
 * - messageId or Idempotency-Key required (no random keys → no duplicate Runs)
 * - Deterministic task id per (org, client, run); mapping failure → durable cancel
 *   compensate (fail-closed), never orphan Run without mapping
 * - Status always projected from Run
 * - Client isolation (org_id, client_id)
 * - Mutating audit fail-closed
 * - GetTask artifacts from owner-scoped repo or full event page (no silent truncate)
 */

import {
  A2A_SCOPES,
  hasScope,
} from '../../domain/a2a/scopes.js';
import {
  projectRunStatusToA2a,
  isTerminalA2aTaskStatus,
} from '../../domain/a2a/status.js';
import { isTerminalRunStatus } from '../../domain/run/run-status.js';
import { assertUlid } from '../../domain/shared/ulid.js';
import { formatUserExternalSubject } from '../../infrastructure/mysql/repositories/organization-repository.js';
import {
  normalizeOpaqueContextId,
  A2A_CONTEXT_ID_MAX_LEN,
} from '../../infrastructure/mysql/repositories/a2a-task-repository.js';
import {
  OwnerScopedNotFoundError,
  ValidationError,
} from '../errors.js';
import {
  buildA2aTaskObject,
  collectArtifactsFromEnvelopes,
  projectArtifactRowsToA2a,
  projectMessagesToA2aHistory,
  GET_TASK_EVENT_SCAN_MAX,
  GET_TASK_ARTIFACT_MAX,
} from './event-projector.js';
import { A2A_RPC_ERROR, JSON_RPC_ERROR } from './json-rpc.js';
import { A2A_ENTERPRISE_EXTENSION_URI } from './agent-card.js';
import { deterministicA2aTaskId } from './deterministic-task-id.js';
import { formatA2aExternalUserId } from './identity.js';

export { formatA2aExternalUserId } from './identity.js';
import {
  A2aAuditError,
  A2aTaskError,
  CONTINUABLE_RUN_STATUSES,
  assertSendConfiguration,
  extractTextFromA2aMessage,
  parseSendParams,
  requireStableIdempotencyKey,
} from './task-request.js';

/** 过渡期宽松类型：注入的依赖多数还是 JS 类，形状由各自的模块负责。 */
type Loose = any;

// Re-exported so callers keep one entry point for the A2A task surface.
export {
  A2aAuditError,
  A2aTaskError,
  assertSendConfiguration,
  extractTextFromA2aMessage,
  parseSendParams,
  requireStableIdempotencyKey,
} from './task-request.js';

export class A2aTaskService {
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  createRunService: Loose;
  getRunService: Loose;
  cancelRunService: Loose;
  eventQueryService: Loose;
  createRepositories: Loose;
  tx: Loose;
  db: Loose;
  generateId: Loose;
  now: Loose;
  defaultProvider: Loose;
  buildArtifactDownloadUri: Loose;
  requireAudit: Loose;

  /**
   * @param {{
   *   createRunService: { execute: Function },
   *   getRunService: { execute: Function },
   *   cancelRunService: { execute: Function },
   *   eventQueryService?: { listEvents: Function } | null,
   *   createRepositories: (db?: any) => any,
   *   transactionManager?: { run: Function } | null,
   *   db?: any,
   *   generateId: () => string,
   *   now?: () => Date,
   *   defaultProvider?: string,
   *   buildArtifactDownloadUri?: Function | null,
   *   requireAudit?: boolean,
   * }} deps
   */
  constructor(deps: { createRunService: { execute: Function }, getRunService: { execute: Function }, cancelRunService: { execute: Function }, eventQueryService?: { listEvents: Function } | null, createRepositories: (db?: any) => any, transactionManager?: { run: Function } | null, db?: any, generateId: () => string, now?: () => Date, defaultProvider?: string, buildArtifactDownloadUri?: Function | null, requireAudit?: boolean, }) {
    if (!deps?.createRunService?.execute) {
      throw new Error('A2aTaskService requires createRunService');
    }
    if (!deps?.getRunService?.execute) {
      throw new Error('A2aTaskService requires getRunService');
    }
    if (!deps?.cancelRunService?.execute) {
      throw new Error('A2aTaskService requires cancelRunService');
    }
    if (typeof deps.createRepositories !== 'function') {
      throw new Error('A2aTaskService requires createRepositories');
    }
    if (typeof deps.generateId !== 'function') {
      throw new Error('A2aTaskService requires generateId');
    }
    this.createRunService = deps.createRunService;
    this.getRunService = deps.getRunService;
    this.cancelRunService = deps.cancelRunService;
    this.eventQueryService = deps.eventQueryService ?? null;
    this.createRepositories = deps.createRepositories;
    this.tx = deps.transactionManager ?? null;
    this.db = deps.db ?? null;
    this.generateId = deps.generateId;
    this.now = deps.now ?? (() => new Date());
    this.defaultProvider = deps.defaultProvider ?? 'a2a';
    this.buildArtifactDownloadUri = deps.buildArtifactDownloadUri ?? null;
    this.requireAudit = deps.requireAudit !== false;
  }

  /**
   * @param {{
   *   principal: object,
   *   agentId: string,
   *   params: Record<string, unknown>,
   *   traceId: string,
   *   traceState?: string | null,
   *   spanId?: string | null,
   *   traceFlags?: string | number | null,
   *   idempotencyKey?: string | null,
   *   method?: string,
   * }} input
   */
  async sendMessage(input: { principal: Record<string, any>, agentId: string, params: Record<string, unknown>, traceId: string, traceState?: string | null, spanId?: string | null, traceFlags?: string | number | null, idempotencyKey?: string | null, method?: string, }) {
    this.#assertScope(input.principal, A2A_SCOPES.INVOKE);
    this.#assertAgentBinding(input.principal, input.agentId);

    const { message, messageId, taskId, contextId, configuration, metadata } =
      parseSendParams(input.params);
    assertSendConfiguration(configuration);

    const text = extractTextFromA2aMessage(message);
    const idempotencyKey = requireStableIdempotencyKey({
      messageId,
      idempotencyKey: input.idempotencyKey,
    });
    const method = input.method || 'SendMessage';

    await this.#ensureA2aIdentityBindings(input.principal);

    let continueFrom: { conversationId: string | null, parentTask: Record<string, any> | null, wireContextId: string | null } = {
      conversationId: null,
      parentTask: null,
      wireContextId: contextId,
    };

    if (taskId) {
      const parent = await this.#loadOwnedTask(input.principal, taskId);
      const parentRun = await this.#loadOwnedRun(input.principal, parent.runId);
      // In-flight tasks cannot accept a parallel follow-up message.
      if (!CONTINUABLE_RUN_STATUSES.has(parentRun.status)) {
        throw new A2aTaskError('Unsupported operation', {
          code: 'TASK_BUSY',
          rpc: A2A_RPC_ERROR.UNSUPPORTED,
          details: {
            reason: 'task_busy',
            runStatus: parentRun.status,
          },
        });
      }
      // Continue the same conversation; wire context prefers explicit request,
      // then the parent task's opaque context, then conversation ULID.
      continueFrom = {
        conversationId: parent.conversationId,
        parentTask: parent,
        wireContextId:
          contextId || parent.contextId || parent.conversationId,
      };
    }

    // Opaque external contextId → internal conversation via provider mapping
    // (RunParentProvisioner / conversation_external_refs). Never require ULID.
    const externalConversationId =
      continueFrom.conversationId ||
      continueFrom.wireContextId ||
      null;

    let createResult;
    try {
      createResult = await this.createRunService.execute({
        messages: [{ role: 'user', content: text }],
        auth: {
          provider: this.defaultProvider,
          externalOrgId: input.principal.orgId,
          externalUserId: formatA2aExternalUserId(
            input.principal.orgId,
            input.principal.clientId,
          ),
          externalConversationId,
          displayName: `a2a:${input.principal.clientId}`,
          orgName: `a2a-org:${input.principal.orgId}`,
        },
        traceId: input.traceId,
        ...(input.traceState ? { traceState: input.traceState } : {}),
        traceFlags: input.traceFlags,
        idempotencyKey,
        agentId: input.agentId,
        agentProfileId: input.agentId,
        spanId: input.spanId ?? null,
        budget: metadata?.budget ?? null,
      });
    } catch (err) {
      await this.#auditSafe(
        {
          orgId: input.principal.orgId,
          clientId: input.principal.clientId,
          credentialId: input.principal.credentialId,
          agentId: input.principal.agentId,
          traceId: input.traceId,
          eventType: 'a2a.send_message.error',
          method,
          payloadJson: {
            outcome: 'create_run_failed',
            code: err?.code || null,
            continuedTaskId: taskId,
          },
        },
        { failClosed: false },
      );
      throw err;
    }

    const a2aTaskId = deterministicA2aTaskId(
      input.principal.orgId,
      input.principal.clientId,
      createResult.runId,
    );
    // Protocol wire contextId: caller-supplied opaque string, parent task, or
    // the internal conversation id when the client did not send one.
    const resolvedContextId =
      continueFrom.wireContextId || createResult.conversationId;

    const repos = this.createRepositories(this.db);

    // Already mapped (idempotent retry).
    const existing = await repos.a2aTasks.getByRunId(createResult.runId, {
      orgId: input.principal.orgId,
      clientId: input.principal.clientId,
    });
    if (existing) {
      await this.#auditRequired({
        orgId: input.principal.orgId,
        clientId: input.principal.clientId,
        credentialId: input.principal.credentialId,
        agentId: input.principal.agentId,
        a2aTaskId: existing.a2aTaskId,
        runId: existing.runId,
        traceId: input.traceId,
        eventType: 'a2a.send_message.replay',
        method,
        payloadJson: { outcome: 'replay', replayed: true },
      });
      return this.getTask({
        principal: input.principal,
        agentId: input.agentId,
        taskId: existing.a2aTaskId,
      });
    }

    try {
      await repos.a2aTasks.insert({
        a2aTaskId,
        orgId: input.principal.orgId,
        userId: input.principal.serviceUserId,
        clientId: input.principal.clientId,
        agentId: input.principal.agentId,
        credentialId: input.principal.credentialId,
        runId: createResult.runId,
        conversationId: createResult.conversationId,
        contextId: resolvedContextId,
        traceId: input.traceId,
      });
    } catch (err) {
      // Concurrent insert may race: re-load by run.
      const raced = await repos.a2aTasks.getByRunId(createResult.runId, {
        orgId: input.principal.orgId,
        clientId: input.principal.clientId,
      });
      if (raced) {
        await this.#auditRequired({
          orgId: input.principal.orgId,
          clientId: input.principal.clientId,
          credentialId: input.principal.credentialId,
          agentId: input.principal.agentId,
          a2aTaskId: raced.a2aTaskId,
          runId: raced.runId,
          traceId: input.traceId,
          eventType: 'a2a.send_message.replay',
          method,
          payloadJson: { outcome: 'race_replay', replayed: true },
        });
        return this.getTask({
          principal: input.principal,
          agentId: input.agentId,
          taskId: raced.a2aTaskId,
        });
      }

      // Fail-closed compensation: durable cancel intent so Run is not an orphan
      // without A2A mapping. Retry with same idempotency key reuses same Run.
      await this.#compensateOrphanRun(input.principal, createResult.runId, {
        traceId: input.traceId,
        reason: 'a2a_mapping_failed',
      });
      await this.#auditSafe(
        {
          orgId: input.principal.orgId,
          clientId: input.principal.clientId,
          credentialId: input.principal.credentialId,
          agentId: input.principal.agentId,
          runId: createResult.runId,
          traceId: input.traceId,
          eventType: 'a2a.send_message.mapping_failed',
          method,
          payloadJson: {
            outcome: 'mapping_failed_compensated',
            code: err?.code || 'MAPPING_FAILED',
          },
        },
        { failClosed: false },
      );
      throw new A2aTaskError(
        'Failed to create task mapping; run cancelled for compensation',
        {
          code: 'A2A_MAPPING_FAILED',
          rpc: { ...JSON_RPC_ERROR.INTERNAL },
          details: { compensated: true },
        },
      );
    }

    await this.#auditRequired({
      orgId: input.principal.orgId,
      clientId: input.principal.clientId,
      credentialId: input.principal.credentialId,
      agentId: input.principal.agentId,
      a2aTaskId,
      runId: createResult.runId,
      traceId: input.traceId,
      eventType: 'a2a.send_message',
      method,
      payloadJson: {
        outcome: 'ok',
        conversationId: createResult.conversationId,
        contextId: resolvedContextId,
        continuedFromTaskId: taskId || null,
        queueWarning: createResult.queueWarning ?? null,
        replayed: createResult.replayed === true,
      },
    });

    const run = await this.#loadOwnedRun(input.principal, createResult.runId);
    return buildA2aTaskObject({
      a2aTaskId,
      contextId: resolvedContextId,
      runStatus: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      artifacts: [],
      metadata: {
        callerType: 'a2a',
        clientId: input.principal.clientId,
        orgId: input.principal.orgId,
        [A2A_ENTERPRISE_EXTENSION_URI]: {
          orgId: input.principal.orgId,
          clientId: input.principal.clientId,
        },
      },
    });
  }

  /**
   * @param {{
   *   principal: object,
   *   agentId: string,
   *   taskId: string,
   *   historyLength?: number,
   *   method?: string,
   *   traceId?: string | null,
   * }} input
   */
  async getTask(input: { principal: Record<string, any>, agentId: string, taskId: string, historyLength?: number, method?: string, traceId?: string | null, }) {
    this.#assertScope(input.principal, A2A_SCOPES.READ);
    this.#assertAgentBinding(input.principal, input.agentId);

    const mapping = await this.#loadOwnedTask(input.principal, input.taskId);
    const run = await this.#loadOwnedRun(input.principal, mapping.runId);

    const artifacts = await this.#loadArtifactsComplete(input.principal, mapping);
    const history = await this.#loadMessageHistory(
      input.principal,
      mapping,
      input.historyLength,
    );

    await this.#auditRequired({
      orgId: input.principal.orgId,
      clientId: input.principal.clientId,
      credentialId: input.principal.credentialId,
      agentId: input.principal.agentId,
      a2aTaskId: mapping.a2aTaskId,
      runId: mapping.runId,
      traceId: input.traceId || mapping.traceId,
      eventType: 'a2a.get_task',
      method: input.method || 'GetTask',
      payloadJson: {
        outcome: 'ok',
        artifactCount: artifacts.length,
        historyLength: history.length,
      },
    });

    return buildA2aTaskObject({
      a2aTaskId: mapping.a2aTaskId,
      contextId: mapping.contextId,
      runStatus: run.status,
      createdAt: mapping.createdAt,
      updatedAt: run.updatedAt || mapping.updatedAt,
      artifacts,
      history,
      metadata: {
        callerType: 'a2a',
        clientId: input.principal.clientId,
        orgId: input.principal.orgId,
        [A2A_ENTERPRISE_EXTENSION_URI]: {
          orgId: input.principal.orgId,
          clientId: input.principal.clientId,
        },
      },
    });
  }

  /**
   * List client-scoped tasks (A2A tasks/list).
   * @param {{
   *   principal: object,
   *   agentId: string,
   *   contextId?: string | null,
   *   limit?: number,
   *   method?: string,
   *   traceId?: string | null,
   * }} input
   */
  async listTasks(input: { principal: Record<string, any>, agentId: string, contextId?: string | null, limit?: number, method?: string, traceId?: string | null, }) {
    this.#assertScope(input.principal, A2A_SCOPES.READ);
    this.#assertAgentBinding(input.principal, input.agentId);

    let contextId = null;
    try {
      contextId = normalizeOpaqueContextId(input.contextId ?? null);
    } catch {
      throw new ValidationError(
        `contextId exceeds max length ${A2A_CONTEXT_ID_MAX_LEN}`,
      );
    }

    const repos = this.createRepositories(this.db);
    const mappings = await repos.a2aTasks.listForClient(
      {
        orgId: input.principal.orgId,
        clientId: input.principal.clientId,
      },
      {
        agentId: input.agentId,
        contextId,
        limit: input.limit,
      },
    );

    const tasks: Record<string, any>[] = [];
    for (const mapping of mappings) {
      // eslint-disable-next-line no-await-in-loop
      const run = await this.#loadOwnedRun(input.principal, mapping.runId);
      tasks.push(
        buildA2aTaskObject({
          a2aTaskId: mapping.a2aTaskId,
          contextId: mapping.contextId,
          runStatus: run.status,
          createdAt: mapping.createdAt,
          updatedAt: run.updatedAt || mapping.updatedAt,
          artifacts: [],
          metadata: {
            callerType: 'a2a',
            clientId: input.principal.clientId,
            orgId: input.principal.orgId,
          },
        }),
      );
    }

    await this.#auditRequired({
      orgId: input.principal.orgId,
      clientId: input.principal.clientId,
      credentialId: input.principal.credentialId,
      agentId: input.principal.agentId,
      traceId: input.traceId || null,
      eventType: 'a2a.list_tasks',
      method: input.method || 'ListTasks',
      payloadJson: {
        outcome: 'ok',
        count: tasks.length,
        contextId: contextId || null,
      },
    });

    return { tasks };
  }

  /**
   * @param {{
   *   principal: object,
   *   agentId: string,
   *   taskId: string,
   *   reason?: string | null,
   *   method?: string,
   *   traceId?: string | null,
   * }} input
   */
  async cancelTask(input: { principal: Record<string, any>, agentId: string, taskId: string, reason?: string | null, method?: string, traceId?: string | null, }) {
    this.#assertScope(input.principal, A2A_SCOPES.CANCEL);
    this.#assertAgentBinding(input.principal, input.agentId);

    const mapping = await this.#loadOwnedTask(input.principal, input.taskId);
    const run = await this.#loadOwnedRun(input.principal, mapping.runId);

    if (isTerminalRunStatus(run.status)) {
      const state = projectRunStatusToA2a(run.status);
      if (state === 'canceled') {
        await this.#auditRequired({
          orgId: input.principal.orgId,
          clientId: input.principal.clientId,
          credentialId: input.principal.credentialId,
          agentId: input.principal.agentId,
          a2aTaskId: mapping.a2aTaskId,
          runId: mapping.runId,
          traceId: input.traceId || mapping.traceId,
          eventType: 'a2a.cancel_task',
          method: input.method || 'CancelTask',
          payloadJson: { outcome: 'already_canceled' },
        });
        return buildA2aTaskObject({
          a2aTaskId: mapping.a2aTaskId,
          contextId: mapping.contextId,
          runStatus: run.status,
          createdAt: mapping.createdAt,
          updatedAt: run.updatedAt,
          artifacts: [],
        });
      }
      await this.#auditSafe(
        {
          orgId: input.principal.orgId,
          clientId: input.principal.clientId,
          credentialId: input.principal.credentialId,
          agentId: input.principal.agentId,
          a2aTaskId: mapping.a2aTaskId,
          runId: mapping.runId,
          traceId: input.traceId || mapping.traceId,
          eventType: 'a2a.cancel_task',
          method: input.method || 'CancelTask',
          payloadJson: { outcome: 'not_cancelable', runStatus: run.status },
        },
        { failClosed: false },
      );
      throw new A2aTaskError('Task is not cancelable', {
        code: 'TASK_NOT_CANCELABLE',
        rpc: A2A_RPC_ERROR.TASK_NOT_CANCELABLE,
      });
    }

    await this.cancelRunService.execute({
      runId: mapping.runId,
      auth: this.#runAuth(input.principal),
      reason: input.reason || 'a2a_cancel',
      idempotencyKey: `a2a-cancel-${mapping.a2aTaskId}`,
    });

    await this.#auditRequired({
      orgId: input.principal.orgId,
      clientId: input.principal.clientId,
      credentialId: input.principal.credentialId,
      agentId: input.principal.agentId,
      a2aTaskId: mapping.a2aTaskId,
      runId: mapping.runId,
      traceId: input.traceId || mapping.traceId,
      eventType: 'a2a.cancel_task',
      method: input.method || 'CancelTask',
      payloadJson: { outcome: 'ok' },
    });

    const after = await this.#loadOwnedRun(input.principal, mapping.runId);
    return buildA2aTaskObject({
      a2aTaskId: mapping.a2aTaskId,
      contextId: mapping.contextId,
      runStatus: after.status,
      createdAt: mapping.createdAt,
      updatedAt: after.updatedAt,
      artifacts: [],
    });
  }

  /**
   * Subscribe ownership pre-check + audit (stream open).
   * @param {{
   *   principal: object,
   *   agentId: string,
   *   taskId: string,
   *   method?: string,
   *   traceId?: string | null,
   * }} input
   */
  async beginSubscribe(input: { principal: Record<string, any>, agentId: string, taskId: string, method?: string, traceId?: string | null, }) {
    this.#assertScope(input.principal, A2A_SCOPES.READ);
    this.#assertAgentBinding(input.principal, input.agentId);
    const mapping = await this.#loadOwnedTask(input.principal, input.taskId);
    await this.#auditRequired({
      orgId: input.principal.orgId,
      clientId: input.principal.clientId,
      credentialId: input.principal.credentialId,
      agentId: input.principal.agentId,
      a2aTaskId: mapping.a2aTaskId,
      runId: mapping.runId,
      traceId: input.traceId || mapping.traceId,
      eventType: 'a2a.subscribe_task',
      method: input.method || 'SubscribeToTask',
      payloadJson: { outcome: 'stream_open' },
    });
    return mapping;
  }

  /**
   * Best-effort stream end audit (disconnect / terminal).
   */
  async auditStreamEnd(input) {
    await this.#auditSafe(
      {
        orgId: input.principal.orgId,
        clientId: input.principal.clientId,
        credentialId: input.principal.credentialId,
        agentId: input.principal.agentId,
        a2aTaskId: input.taskId,
        runId: input.runId ?? null,
        traceId: input.traceId ?? null,
        eventType: 'a2a.stream_end',
        method: input.method || 'SubscribeToTask',
        payloadJson: {
          outcome: input.outcome || 'disconnect',
          // no secrets
        },
      },
      { failClosed: false },
    );
  }

  /**
   * Record an owner-authorized Artifact byte delivery. Unlike stream-end
   * telemetry, this is part of the access decision and therefore fails closed
   * when the durable audit append is unavailable.
   * @param {{
   *   principal: object,
   *   agentId: string,
   *   taskId: string,
   *   runId: string,
   *   artifactId: string,
   *   traceId?: string | null,
   * }} input
   */
  async auditArtifactDownload(input: { principal: Record<string, any>, agentId: string, taskId: string, runId: string, artifactId: string, traceId?: string | null, }) {
    this.#assertScope(input.principal, A2A_SCOPES.ARTIFACT_READ);
    this.#assertAgentBinding(input.principal, input.agentId);
    await this.#auditRequired({
      orgId: input.principal.orgId,
      clientId: input.principal.clientId,
      credentialId: input.principal.credentialId,
      agentId: input.principal.agentId,
      a2aTaskId: assertUlid(input.taskId, 'taskId'),
      runId: assertUlid(input.runId, 'runId'),
      traceId: input.traceId || null,
      eventType: 'a2a.artifact_download',
      method: 'ArtifactDownload',
      payloadJson: {
        outcome: 'authorized',
        artifactId: assertUlid(input.artifactId, 'artifactId'),
      },
    });
  }

  async resolveOwnedTask(principal, taskId) {
    return this.#loadOwnedTask(principal, taskId);
  }

  runAuthForPrincipal(principal) {
    return this.#runAuth(principal);
  }

  // ── private ──────────────────────────────────────────────

  #assertScope(principal, scope) {
    if (!hasScope(principal?.scopes, scope)) {
      throw new A2aTaskError('Insufficient credential scope', {
        code: 'A2A_AUTH_SCOPE',
        rpc: A2A_RPC_ERROR.FORBIDDEN,
      });
    }
  }

  #assertAgentBinding(principal, agentId) {
    const id = assertUlid(agentId, 'agentId');
    if (principal.agentId !== id) {
      throw new A2aTaskError('Task not found', {
        code: 'TASK_NOT_FOUND',
        rpc: A2A_RPC_ERROR.TASK_NOT_FOUND,
      });
    }
  }

  #runAuth(principal) {
    return {
      provider: this.defaultProvider,
      externalOrgId: principal.orgId,
      externalUserId: formatA2aExternalUserId(
        principal.orgId,
        principal.clientId,
      ),
    };
  }

  async #loadOwnedTask(principal, taskIdRaw) {
    if (typeof taskIdRaw !== 'string' || !taskIdRaw.trim()) {
      throw new A2aTaskError('Task not found', {
        code: 'TASK_NOT_FOUND',
        rpc: A2A_RPC_ERROR.TASK_NOT_FOUND,
      });
    }
    let taskId;
    try {
      taskId = assertUlid(taskIdRaw, 'taskId');
    } catch {
      throw new A2aTaskError('Task not found', {
        code: 'TASK_NOT_FOUND',
        rpc: A2A_RPC_ERROR.TASK_NOT_FOUND,
      });
    }
    const repos = this.createRepositories(this.db);
    const mapping = await repos.a2aTasks.getById(taskId, {
      orgId: principal.orgId,
      clientId: principal.clientId,
    });
    if (!mapping || mapping.agentId !== principal.agentId) {
      throw new A2aTaskError('Task not found', {
        code: 'TASK_NOT_FOUND',
        rpc: A2A_RPC_ERROR.TASK_NOT_FOUND,
      });
    }
    return mapping;
  }

  async #loadOwnedRun(principal, runId) {
    try {
      return await this.getRunService.execute({
        runId,
        auth: this.#runAuth(principal),
      });
    } catch (err) {
      if (err instanceof OwnerScopedNotFoundError) {
        throw new A2aTaskError('Task not found', {
          code: 'TASK_NOT_FOUND',
          rpc: A2A_RPC_ERROR.TASK_NOT_FOUND,
        });
      }
      throw err;
    }
  }

  /**
   * Prefer owner-scoped artifact repo; else page full event history.
   * Never silently truncate — if over safety cap, throw.
   */
  async #loadArtifactsComplete(principal, mapping) {
    const ctx = {
      a2aTaskId: mapping.a2aTaskId,
      contextId: mapping.contextId,
      principal: {
        orgId: principal.orgId,
        clientId: principal.clientId,
      },
      buildDownloadUri: this.buildArtifactDownloadUri,
    };

    // artifact.read scope required to include download-capable artifacts.
    const canReadArtifacts = hasScope(principal.scopes, A2A_SCOPES.ARTIFACT_READ);

    const repos = this.createRepositories(this.db);
    if (repos.artifacts?.listByRunId && canReadArtifacts) {
      const page = await repos.artifacts.listByRunId(
        mapping.runId,
        { orgId: principal.orgId, userId: principal.serviceUserId },
        { limit: GET_TASK_ARTIFACT_MAX },
      );
      if (page.truncated) {
        throw new A2aTaskError(
          'Artifact list exceeds safety limit; refine query or raise limit',
          {
            code: 'A2A_ARTIFACT_LIST_LIMIT',
            rpc: A2A_RPC_ERROR.RESOURCE_LIMIT,
          },
        );
      }
      return projectArtifactRowsToA2a(page.artifacts, {
        ...ctx,
        // Only mint URI when scope granted.
        buildDownloadUri: canReadArtifacts ? this.buildArtifactDownloadUri : null,
      });
    }

    if (!this.eventQueryService || !canReadArtifacts) {
      return [];
    }

    const all: Record<string, any>[] = [];
    let after = 0;
    let pages = 0;
    const maxPages = Math.ceil(GET_TASK_EVENT_SCAN_MAX / 200) + 1;
    while (pages < maxPages) {
      pages += 1;
      // eslint-disable-next-line no-await-in-loop
      const page = await this.eventQueryService.listEvents({
        runId: mapping.runId,
        auth: this.#runAuth(principal),
        afterSequence: after,
        limit: 200,
      });
      const batch = page.events || [];
      if (batch.length === 0) break;
      all.push(...batch);
      after = Math.max(after, ...batch.map((e) => Number(e.sequence) || 0));
      if (all.length > GET_TASK_EVENT_SCAN_MAX) {
        throw new A2aTaskError(
          'Run event history exceeds safety scan limit for artifact collection',
          {
            code: 'A2A_EVENT_SCAN_LIMIT',
            rpc: A2A_RPC_ERROR.RESOURCE_LIMIT,
          },
        );
      }
      if (batch.length < 200) break;
    }

    return collectArtifactsFromEnvelopes(all, {
      ...ctx,
      buildDownloadUri: canReadArtifacts ? this.buildArtifactDownloadUri : null,
    });
  }

  /**
   * Load A2A Message history for GetTask when historyLength > 0.
   * @param principal
   * @param mapping
   * @param historyLengthRaw
   * @returns {Promise<object[]>}
   */
  async #loadMessageHistory(principal: Record<string, any>, mapping: Record<string, any>, historyLengthRaw: unknown) {
    const n = Number(historyLengthRaw);
    if (!Number.isFinite(n) || n <= 0) return [];
    const limit = Math.min(Math.max(Math.trunc(n), 1), 200);
    const repos = this.createRepositories(this.db);
    if (!repos.messages?.listByConversation) return [];
    try {
      const rows = await repos.messages.listByConversation(
        mapping.conversationId,
        { orgId: principal.orgId, userId: principal.serviceUserId },
        { afterSequence: 0, limit: 500 },
      );
      // Return the last `limit` messages in chronological order.
      const slice = rows.length > limit ? rows.slice(rows.length - limit) : rows;
      return projectMessagesToA2aHistory(slice, {
        a2aTaskId: mapping.a2aTaskId,
        contextId: mapping.contextId,
      });
    } catch {
      return [];
    }
  }

  async #compensateOrphanRun(principal, runId, meta) {
    try {
      await this.cancelRunService.execute({
        runId,
        auth: this.#runAuth(principal),
        reason: meta.reason || 'a2a_mapping_failed',
        idempotencyKey: `a2a-map-fail-cancel-${runId}`,
      });
    } catch {
      // Best-effort durable cancel; surface mapping failure regardless.
    }
  }

  async #ensureA2aIdentityBindings(principal) {
    const repos = this.createRepositories(this.db);
    if (!repos.externalRefs?.getOrCreateOrganizationRef) return;
    const provider = this.defaultProvider;
    await repos.externalRefs.getOrCreateOrganizationRef({
      provider,
      externalSubject: principal.orgId,
      orgId: principal.orgId,
    });
    if (!repos.organizations?.createUserIfAbsent) return;
    const externalUserId = formatA2aExternalUserId(
      principal.orgId,
      principal.clientId,
    );
    const encoded = formatUserExternalSubject(provider, externalUserId);
    const bySubject = await repos.organizations.getUserByExternalSubject(
      encoded,
    );
    if (bySubject) {
      if (bySubject.userId !== principal.serviceUserId) {
        throw new ValidationError(
          'A2A client identity is already bound to a different service user',
        );
      }
    } else {
      await repos.organizations.createUserIfAbsent({
        userId: principal.serviceUserId,
        externalSubject: encoded,
        displayName: `a2a:${principal.clientId}`,
        status: 'active',
      });
    }
    if (typeof repos.organizations.addMembershipIfAbsent === 'function') {
      await repos.organizations.addMembershipIfAbsent({
        orgId: principal.orgId,
        userId: principal.serviceUserId,
        role: 'member',
        status: 'active',
      });
    }
  }

  /**
   * Mutating / authenticated ops: audit failure fails the request.
   * @param input
   */
  async #auditRequired(input: Record<string, any>) {
    return this.#auditSafe(input, { failClosed: this.requireAudit });
  }

  async #auditSafe(input: Record<string, any>, opts: { failClosed?: boolean } = {}) {
    const failClosed = opts.failClosed === true;
    const repos = this.createRepositories(this.db);
    if (!repos?.a2aAudit?.append) {
      if (failClosed) {
        throw new A2aAuditError('A2A audit repository unavailable');
      }
      return;
    }
    try {
      await repos.a2aAudit.append({
        auditId: this.generateId(),
        ...input,
      });
    } catch (err) {
      if (failClosed) {
        throw new A2aAuditError(
          err instanceof Error ? err.message : 'A2A audit write failed',
        );
      }
    }
  }
}

export { isTerminalA2aTaskStatus, projectRunStatusToA2a };
