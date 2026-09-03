/**
 * PiRunExecutor (PR-05 slice B) — recoverable RunExecutor backed by Pi SDK.
 *
 * Lifecycle ownership:
 * - PiRunExecutor owns Session Lock + MySQL execution fence for the job.
 * - ExecuteRunService owns Run Lease + Run status transitions.
 * - Session lock is held until dispose() because ExecuteRunService terminalizes
 *   the Run before disposing the per-job executor.
 *
 * Event ownership:
 * - PiRunExecutor is the sole durable projector of Pi → RunEvent+Outbox for
 *   the run. PR-06 observability must call into this recorder rather than
 *   double-writing. The RunExecutorContext.emit seam is optional; when omitted,
 *   all persistence stays encapsulated here (no process-local Map authority).
 *
 * Production worker wires createPiRunExecutorFactory via
 * ServiceContainer.ensureWorkerRunExecutorFactory (default model/workspace
 * resolvers). Custom inject still supported on the container constructor.
 *
 * Mid-tool crash resume is NOT claimed. Uncertain completed side effects →
 * recovery-required (not success).
 */

import { RUN_STATUS } from '../domain/run/run-status.js';
import { assertUlid } from '../domain/shared/ulid.js';
import {
  SessionFenceConflictError,
  SessionRecoveryRequiredError,
} from '../domain/session/errors.js';
import { RECOVERY_REASON_CODE } from '../domain/session/recovery-reason.js';
import {
  generateSessionLockOwnerToken,
  createSerialRenewLoop,
} from '../infrastructure/redis/session-lock-manager.js';
import { SessionLockError } from '../infrastructure/redis/errors.js';
import { PINNED_PI_SDK_VERSION } from '../infrastructure/dsh/constants.js';
import { buildMcpPolicyBindings } from '../infrastructure/mcp/mcp-policy-bindings.js';
import {
  buildAgentVersionToolRiskBindings,
  readAgentVersionToolPolicy,
} from './tool-risk-bindings.js';
import { PlatformEventProjector } from '../infrastructure/dsh/event-projector.js';
import {
  extractAssistantTextForUi,
  extractAssistantThinkingForUi,
} from '../lib/event-redaction.js';
import {
  assertTriggeringMessageBinding,
  looksLikeUncertainSideEffect,
  terminalOutcomeFromNewAssistantEntries,
  type DshRunExecutorDeps,
  type PiRunExecutorDeps,
} from './dsh-run-executor-deps.js';
import { sanitizeStatusReason } from './sanitize-status-reason.js';
import { SessionRecoveryService } from './session-recovery-service.js';
import { captureSessionSnapshotPayload } from './session-json-codec.js';
import { ConflictError } from '../infrastructure/mysql/errors.js';
import { FencedRunEventRecorder } from './fenced-run-event-recorder.js';
import { FencedToolGovernanceRecorder } from './fenced-tool-governance-recorder.js';
import { DurableSteerController } from './durable-steer-controller.js';
import {
  installDshRunToolBudget,
  installPiRunToolBudget,
} from './dsh-run-tool-budget.js';
import {
  DURABLE_INTERACTION_PENDING,
  INTERACTION_STATUS,
} from '../domain/interaction/interaction-status.js';
import {
  appendCurrentTurnAttachmentContext,
  appendNonVisionImageNotice,
  attachmentsFromTriggeringMessage,
  derivePromptFromTriggeringMessage,
  imageAttachmentsFromTriggeringMessage,
  requestedModelIdFromTriggeringMessage,
  toDshPromptInvocation,
  toPiPromptInvocation,
} from './dsh-run-input.js';

export { createPromiseTail } from './promise-tail.js';
export {
  FencedRunEventRecorder,
  buildCanonicalEnvelope,
  redactEventData,
} from './fenced-run-event-recorder.js';
export {
  FencedToolGovernanceRecorder,
  DurablePolicyConflictError,
  assertCompatiblePolicyReplay,
} from './fenced-tool-governance-recorder.js';
export {
  appendCurrentTurnAttachmentContext,
  attachmentsFromTriggeringMessage,
  derivePromptFromTriggeringMessage,
  generateRunLeaseOwnerToken,
  imageAttachmentsFromTriggeringMessage,
  requestedModelIdFromTriggeringMessage,
  replaceSuspendedToolResultInSession,
  toDshPromptInvocation,
  toPiPromptInvocation,
} from './dsh-run-input.js';

/** Ordinary UI assistant message entry_id prefix — never collides with journal entry ids. */
import {
  prepareApprovalResume,
  prepareInteractionResume,
} from './dsh-run-resume.js';
import { GovernanceApprovalStore } from './governance-approval-store.js';
import { approvalIdOf } from '../runtime/policy/approval-id.js';
import { integrityFingerprint } from '../infrastructure/mysql/repositories/tool-execution-repository.js';
import { buildRunServices } from './durable-subagent-port.js';
import { buildRunRiskResolver } from './tool-risk-resolver.js';
import { createInteractionRequester } from './interaction-requester.js';

/** 过渡期宽松类型：注入的依赖多数还是 JS 类，形状由各自的模块负责。 */
type Loose = any;

export const UI_ASSISTANT_ENTRY_PREFIX = 'ui:assistant:';
export const UI_ASSISTANT_PI_ENTRY_PREFIX = UI_ASSISTANT_ENTRY_PREFIX;

export class DshRunExecutor {
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  tx: Loose;
  createRepositories: Loose;
  sessionLockManager: Loose;
  piRuntimeFactory: Loose;
  sessionAdapter: Loose;
  modelResolver: Loose;
  promptImageLoader: Loose;
  requestAuthResolver: Loose;
  workspaceResolver: Loose;
  sandboxSessionProvisioner: Loose;
  generateId: Loose;
  now: Loose;
  projector: Loose;
  recoveryService: Loose;
  sessionLockRenewIntervalMs: Loose;
  skillRootsForRun: Loose;
  /** 运维层风险表（`config/agent/tool-risk.json` / `TOOL_RISK_POLICY_*`）。 */
  riskOverrides: Loose;
  /** 子 Agent 的 durable 面（ADR 0009 D6 / 计划 H5）。 */
  subagentSpawnPort: Loose;
  eventProjectionMode: Loose;
  steerPollIntervalMs: Loose;
  toolBudget: Loose;
  _lockToken: string | null;
  _lockedSessionId: string | null;
  _lockRenewLoop: ReturnType<typeof createSerialRenewLoop> | null;
  _fenceToken: number | null;
  _runtime: any;
  _unsubscribe: (() => void) | null;
  _eventTail: { enqueue: (fn: () => void | Promise<void>) => Promise<void>, flush: () => Promise<void>, error?: () => unknown } | null;
  _eventRecorder: FencedRunEventRecorder | null;
  _governanceRecorder: FencedToolGovernanceRecorder | null;
  _pendingInteractionToolCallIds: Set<string>;
  /** 本 Run 的停泊端口。每次 execute() 重建；未开跑时为 null。 */
  _runSuspensionPort: Loose;
  _steerController: DurableSteerController | null;
  _disposed: boolean;
  _lockLost: boolean;
  _cleanupErrors: unknown[];

  /**
   * @param {{
   *   transactionManager: { run: (fn: (trx: any) => Promise<any>) => Promise<any> },
   *   createRepositories: (db: any) => any,
   *   sessionLockManager: {
   *     acquire: (agentSessionId: string, ownerToken: string) => Promise<boolean>,
   *     renew: (agentSessionId: string, ownerToken: string) => Promise<boolean>,
   *     release: (agentSessionId: string, ownerToken: string) => Promise<boolean>,
   *     renewIntervalMs?: number,
   *   },
   *   piRuntimeFactory: { create: (input: object) => Promise<any> },
   *   sessionAdapter?: { captureSnapshotPayload: Function, dispose?: Function },
   *   modelResolver: (agentVersion: object, selection?: { modelId?: string|null }) => object | Promise<object>,
   *   promptImageLoader?: (input: object) => Promise<Array<{ type: 'image', data: string, mimeType: string }>>,
   *   requestAuthResolver?: (model: object, agentVersion: object) => object | Promise<object>,
   *   workspaceResolver: (agentSession: object) => string | Promise<string>,
   *   sandboxSessionProvisioner?: { ensure: (input: object) => Promise<object> },
   *   generateId: () => string,
   *   now?: () => Date,
   *   projector?: PlatformEventProjector,
   *   recoveryService?: SessionRecoveryService,
   *   sessionLockRenewIntervalMs?: number,
   *   skillRootsForRun?: (identity: object) => string[],
   *   eventProjectionMode?: 'session-subscribe' | 'observability' | 'both',
   *   steerPollIntervalMs?: number,
   *   toolBudget?: { maxToolCalls?: number, maxIdenticalToolCalls?: number, maxModelTurns?: number, runDeadlineMs?: number },
   * }} deps
   */
  constructor(deps: DshRunExecutorDeps) {
    if (!deps?.transactionManager?.run) {
      throw new Error('DshRunExecutor requires transactionManager');
    }
    if (typeof deps.createRepositories !== 'function') {
      throw new Error('DshRunExecutor requires createRepositories');
    }
    if (!deps.sessionLockManager) {
      throw new Error('DshRunExecutor requires sessionLockManager');
    }
    if (!deps.piRuntimeFactory?.create) {
      throw new Error('DshRunExecutor requires piRuntimeFactory');
    }
    if (typeof deps.modelResolver !== 'function') {
      throw new Error('DshRunExecutor requires modelResolver(agentVersion)');
    }
    if (typeof deps.workspaceResolver !== 'function') {
      throw new Error('DshRunExecutor requires workspaceResolver(agentSession)');
    }
    if (typeof deps.generateId !== 'function') {
      throw new Error('DshRunExecutor requires generateId');
    }

    this.tx = deps.transactionManager;
    this.createRepositories = deps.createRepositories;
    this.sessionLockManager = deps.sessionLockManager;
    this.piRuntimeFactory = deps.piRuntimeFactory;
    this.sessionAdapter = deps.sessionAdapter ?? null;
    this.modelResolver = deps.modelResolver;
    this.promptImageLoader = deps.promptImageLoader ?? null;
    this.requestAuthResolver = deps.requestAuthResolver ?? null;
    this.workspaceResolver = deps.workspaceResolver;
    this.sandboxSessionProvisioner = deps.sandboxSessionProvisioner ?? null;
    this.generateId = deps.generateId;
    this.now = deps.now ?? (() => new Date());
    this.projector = deps.projector ?? new PlatformEventProjector();
    this.recoveryService =
      deps.recoveryService ??
      new SessionRecoveryService({
        transactionManager: this.tx,
        createRepositories: this.createRepositories,
        generateId: this.generateId,
        now: this.now,
      });
    this.sessionLockRenewIntervalMs =
      deps.sessionLockRenewIntervalMs ??
      deps.sessionLockManager.renewIntervalMs ??
      10_000;
    /**
     * Per-Run skill roots: `(identity) => string[]`. The user tier is scoped to
     * `<orgId>/<userId>`, so this cannot be resolved once per process.
     */
    this.skillRootsForRun =
      typeof deps.skillRootsForRun === 'function' ? deps.skillRootsForRun : null;
    this.riskOverrides = deps.riskOverrides ?? null;
    this.subagentSpawnPort = deps.subagentSpawnPort ?? null;
    /**
     * When 'observability', session.subscribe projector is disabled (Extension owns
     * message/tool/compaction/model events). Default 'session-subscribe' keeps PR-05
     * tests green when no observability bundle is wired.
     */
    this.eventProjectionMode = deps.eventProjectionMode ?? 'session-subscribe';
    this.steerPollIntervalMs = deps.steerPollIntervalMs;
    this.toolBudget = deps.toolBudget ?? null;

    /** @type {string | null} */
    this._lockToken = null;
    /** @type {string | null} */
    this._lockedSessionId = null;
    /** @type {ReturnType<typeof createSerialRenewLoop> | null} */
    this._lockRenewLoop = null;
    /** @type {number | null} */
    this._fenceToken = null;
    /** @type {any} */
    this._runtime = null;
    /** @type {(() => void) | null} */
    this._unsubscribe = null;
    /** @type {{ enqueue: (fn: () => void | Promise<void>) => Promise<void>, flush: () => Promise<void>, error?: () => unknown } | null} */
    this._eventTail = null;
    /** @type {FencedRunEventRecorder | null} */
    this._eventRecorder = null;
    /** @type {FencedToolGovernanceRecorder | null} */
    this._governanceRecorder = null;
    /** @type {Set<string>} */
    this._pendingInteractionToolCallIds = new Set();
    this._runSuspensionPort = null;
    /** @type {DurableSteerController | null} */
    this._steerController = null;
    /** @type {boolean} */
    this._disposed = false;
    /** @type {boolean} */
    this._lockLost = false;
    /** @type {unknown[]} */
    this._cleanupErrors = [];
  }

  /**
   * @param ctx
   * @returns {Promise<import('./run-executor.js').RunExecutorResult>}
   */
  async execute(ctx: import('./run-executor.js').RunExecutorContext) {
    if (this._disposed) {
      return {
        outcome: RUN_STATUS.FAILED,
        statusReason: 'executor already disposed',
      };
    }

    // A PiRunExecutor is normally single-use, but clear this ephemeral signal
    // before every attempt so a reused test/worker instance cannot carry a
    // prior Run's ask_user marker into a later execution.
    this._pendingInteractionToolCallIds.clear();

    const scope = {
      orgId: assertUlid(ctx.scope.orgId, 'orgId'),
      userId: assertUlid(ctx.scope.userId, 'userId'),
    };
    const runId = assertUlid(ctx.run.runId, 'runId');
    const workerId = String(ctx.workerId || 'worker').trim();
    const signal = ctx.signal;
    const externalEmit = typeof ctx.emit === 'function' ? ctx.emit : null;
    const approvalResume = ctx.run?.approvalResume ?? null;
    const interactionResume = ctx.run?.interactionResume ?? null;

    // 1) Verify run + scope from durable row (not job-supplied session data).
    const run = await this.tx.run(async (trx) => {
      const repos = this.createRepositories(trx);
      return repos.runs.requireById(runId, scope);
    });

    const agentSessionId = assertUlid(run.agentSessionId, 'agentSessionId');
    const conversationId = assertUlid(run.conversationId, 'conversationId');
    const agentVersionId = assertUlid(run.agentVersionId, 'agentVersionId');
    const traceId = String(run.traceId || '');
    const traceState = run.traceState == null ? null : String(run.traceState);

    // 2) Unique SessionLock owner token + serial renew
    const lockToken = generateSessionLockOwnerToken(workerId);
    this._lockToken = lockToken;
    this._lockedSessionId = agentSessionId;

    let acquired = false;
    try {
      acquired = await this.sessionLockManager.acquire(
        agentSessionId,
        lockToken,
      );
    } catch (err) {
      return {
        outcome: RUN_STATUS.FAILED,
        statusReason: sanitizeStatusReason(err) ?? 'session lock acquire failed',
      };
    }
    if (!acquired) {
      return {
        outcome: RUN_STATUS.FAILED,
        statusReason: 'session lock busy',
      };
    }

    this._lockLost = false;
    this._lockRenewLoop = createSerialRenewLoop({
      intervalMs: this.sessionLockRenewIntervalMs,
      isStopped: () => this._lockLost || this._disposed,
      tick: async () => {
        try {
          const ok = await this.sessionLockManager.renew(
            agentSessionId,
            lockToken,
          );
          if (!ok) {
            this._lockLost = true;
          }
        } catch {
          this._lockLost = true;
        }
      },
    });
    this._lockRenewLoop.start();

    try {
      // 3) MySQL execution fence + Session/Run binding
      const { fenceToken, session } = await this.tx.run(async (trx) => {
        const repos = this.createRepositories(trx);
        const result = await repos.sessions.acquireExecutionFenceForRun(
          agentSessionId,
          scope,
          {
            conversationId,
            agentVersionId,
            runId,
          },
        );
        return result;
      });
      this._fenceToken = fenceToken;

      // Fail closed: fence must be a positive finite integer before any
      // extension bundle / runtime construction (no coercion of bad values).
      if (
        typeof fenceToken !== 'number' ||
        !Number.isFinite(fenceToken) ||
        !Number.isInteger(fenceToken) ||
        fenceToken <= 0
      ) {
        return {
          outcome: RUN_STATUS.FAILED,
          statusReason:
            'executionFenceToken must be a positive finite integer after fence acquisition',
        };
      }

      // SandboxSession + Workspace must exist before recovery/runtime/tools.
      // The HMAC endpoint verifies this exact tuple against the ACTIVE
      // AgentSession row under the freshly acquired execution fence.
      if (this.sandboxSessionProvisioner) {
        try {
          await this.sandboxSessionProvisioner.ensure({
            orgId: scope.orgId,
            userId: scope.userId,
            conversationId,
            agentSessionId,
            sandboxSessionId: session.sandboxSessionId,
            runId,
            workspaceId: session.workspaceId,
            executionFenceToken: fenceToken,
            traceId,
            ...(traceState ? { traceState } : {}),
          });
        } catch (error) {
          return {
            outcome: RUN_STATUS.FAILED,
            statusReason:
              sanitizeStatusReason(error) ??
              'sandbox session provisioning failed',
          };
        }
      }

      // 4) Exact AgentVersion + full model via resolver (exact 0.80.3)
      const agentVersion = await this.tx.run(async (trx) => {
        const repos = this.createRepositories(trx);
        const v = await repos.catalog.getVersionById(agentVersionId);
        if (!v) {
          throw new Error(`AgentVersion not found: ${agentVersionId}`);
        }
        return v;
      });
      void PINNED_PI_SDK_VERSION;

      const triggering = await this.tx.run(async (trx) => {
        const repos = this.createRepositories(trx);
        return repos.messages.getById(run.triggeringMessageId, scope);
      });
      assertTriggeringMessageBinding(triggering, run);
      const requestedModelId = requestedModelIdFromTriggeringMessage(triggering);
      const currentTurnAttachments = attachmentsFromTriggeringMessage(triggering);
      const imageAttachments = imageAttachmentsFromTriggeringMessage(triggering);

      const model = await this.modelResolver(agentVersion, {
        modelId: requestedModelId,
      });
      if (!model) {
        return {
          outcome: RUN_STATUS.FAILED,
          statusReason: 'modelResolver returned no model',
        };
      }
      // A text-only model drops the images and is told so in the prompt rather
      // than failing: the run used to die, taking the user's question with it.
      const modelAcceptsImages =
        Array.isArray(model.input) && model.input.includes('image');
      const requestAuth = this.requestAuthResolver
        ? await this.requestAuthResolver(model, agentVersion)
        : null;

      // 5) Recover snapshot/journal
      const recovered = await this.recoveryService.recover({
        agentSessionId,
        orgId: scope.orgId,
        userId: scope.userId,
        executionFenceToken: fenceToken,
        workspaceId: session.workspaceId,
        agentVersionId,
        markSuspendedOnFailure: true,
      });
      // Entry IDs present before this run's prompt — UI messages only for net-new.
      const priorEntryIds: Set<string> = new Set(
        (recovered.payload?.entries || [])
          .map((e) => (e && typeof e.id === 'string' ? e.id : null))
          .filter(Boolean),
      );

      // 6) cwd via workspaceResolver only (no fake production path)
      const cwd = await this.workspaceResolver(session);
      if (typeof cwd !== 'string' || !cwd.trim()) {
        return {
          outcome: RUN_STATUS.FAILED,
          statusReason: 'workspaceResolver returned empty cwd',
        };
      }

      // 7) Fenced event recorder (sole durability owner) + optional extension bundle
      /** @type {unknown[] | undefined} */
      let extensionFactories;
      let projectionMode = this.eventProjectionMode;
      let sandboxSessionIdForCtx = session.sandboxSessionId ?? null;
      // 2026-08-31（计划 H8）：这里原来有一条 fail-closed 断言，条件是
      // `if (typeof this.extensionBundleFactory === 'function')`。生产从来没有
      // 接过 bundle，所以那条断言**只在测试里跑过**。删掉 bundle 之后它的触发
      // 条件不复存在。
      //
      // 不把它改成无条件——那会让「会话没有 sandboxSessionId」的 Run 从此起不来，
      // 是超出 H8 范围的行为变更。改成**有值才校验**：保住「格式不对就别往下走」
      // 这一半，不改变哪些 Run 能跑。
      if (sandboxSessionIdForCtx != null) {
        try {
          sandboxSessionIdForCtx = assertUlid(sandboxSessionIdForCtx, 'sandboxSessionId');
        } catch {
          return {
            outcome: RUN_STATUS.FAILED,
            statusReason: 'sandboxSessionId is present but not a valid ULID',
          };
        }
      }
      let runtimeSession: any = null;
      let pendingApproval: Record<string, any> | null = null;

      /**
       * 停泊端口——收到 durable 信号才把 Run 停下并让 Worker 归还 lease。
       *
       * 2026-08-31（计划 H4.3）从 `extensionBundleFactory(...)` 的内联字面量里
       * 提出来：现在有**两个**消费者。一个是那批 Pi Extension（H8 会删掉），
       * 另一个是接 durable 审批面的 `GovernanceApprovalStore`——审批判定发生在
       * DSH 的策略挂载点上，那条路不经过 extension bundle。
       */
      // 挂到实例上：停泊端口以前只能经 `extensionBundleFactory` 的 deps 拿到，
      // 那个形参 2026-08-31（计划 H8）删了。用例要驱动「Run 在 prompt 展开期间
      // 被 durable 停泊」这个时序，就必须能拿到它；排查线上问题时同理。
      const runSuspensionPort = this._runSuspensionPort = {
        onDurableApprovalPending: (pending: Record<string, any>) => {
          if (
            !pending ||
            pending.kind !== 'DURABLE_APPROVAL_PENDING' ||
            pending.runId !== runId
          ) {
            throw new Error('durable approval signal does not match Run');
          }
          pendingApproval = Object.freeze({ ...pending });
          try {
            runtimeSession?.abort?.();
          } catch {
            // Run is already durably parked; prompt teardown is best-effort.
          }
        },
        onDurableInteractionPending: (pending: Record<string, any>) => {
          const toolCallId = String(pending?.toolCallId ?? '').trim();
          if (
            !pending ||
            pending.kind !== DURABLE_INTERACTION_PENDING ||
            pending.runId !== runId ||
            !toolCallId ||
            pending.status !== INTERACTION_STATUS.PENDING
          ) {
            throw new Error('durable interaction signal does not match Run');
          }
          this._pendingInteractionToolCallIds.add(toolCallId);
          pendingInteraction = Object.freeze({ ...pending });
          try {
            runtimeSession?.abort?.();
          } catch {
            // Run is already durably parked; prompt teardown is best-effort.
          }
        },
      };
      let pendingInteraction: Record<string, any> | null = null;

      const eventContext = {
        orgId: scope.orgId,
        userId: scope.userId,
        workspaceId: session.workspaceId,
        conversationId,
        agentSessionId,
        runId,
        sandboxSessionId: sandboxSessionIdForCtx,
        traceId,
        ...(traceState ? { traceState } : {}),
        executionFenceToken: fenceToken,
        // Depth of this Run in the sub-agent chain; the spawn cap reads it.
        subagentDepth: Number(run.subagentDepth ?? 0),
      };

      const emitAfterCommit = externalEmit
        ? async (envelope) => {
            await externalEmit({
              type: envelope.type,
              payload: {
                eventId: envelope.eventId,
                sequence: envelope.sequence,
                eventVersion: envelope.eventVersion,
                timestamp: envelope.timestamp,
                context: envelope.context,
                data: envelope.data,
              },
            });
          }
        : null;

      this._eventRecorder = new FencedRunEventRecorder({
        transactionManager: this.tx,
        createRepositories: this.createRepositories,
        generateId: this.generateId,
        context: eventContext,
        executionFenceToken: (fenceToken as number),
        now: this.now,
        isLockLost: () => this._lockLost,
        emit: emitAfterCommit,
      });
      this._eventTail = this._eventRecorder;

      // PR-06 B2: durable tool ledger + policy audit + approval requests.
      this._governanceRecorder = new FencedToolGovernanceRecorder({
        transactionManager: this.tx,
        createRepositories: this.createRepositories,
        generateId: this.generateId,
        context: eventContext,
        executionFenceToken: (fenceToken as number),
        now: this.now,
        isLockLost: () => this._lockLost,
        emit: emitAfterCommit,
      });

      /**
       * Proof for piRuntimeFactory that configJson.toolPolicy is actually
       * enforced this Run. Only enterprise-policy enforces it, so a Run with
       * no AgentVersion tool policy deliberately leaves this null.
       * @type {object | null}
       */
      let toolPolicyBinding = null;

      // 租户层策略（ADR 0009 D3「toolPolicy → 闸门的过滤」/ 计划 H8）。
      //
      // 2026-08-31 之前这整段算在 `if (extensionBundleFactory)` 里面，也就是
      // **只有测试注入 bundle 时才会算**。生产没有 bundle，于是 AgentVersion 的
      // toolPolicy / riskPolicy 算都不算。
      //
      // 现在无条件算，并合进本 Run 的风险解析函数交给策略装配。
      // 租户层只能收紧不能放松（`mergeToolRiskPolicies` 取最大风险 / 更严决定）：
      // 一个 org 不能靠发新版本把平台的审批闸门关掉。
      // `buildMcpPolicyBindings` 在对象**没有** `configJson` / `config_json` 键时，
      // 会把传进去的整个对象当成一份 mcp 配置去解析——于是一个不带配置的
      // AgentVersion 会撞上 "mcp config must be an array or { mcpServers: [] }"。
      // 这个坑以前藏在 `if (extensionBundleFactory)` 后面（生产不走），把这段
      // 提出来之后才暴露。按语义收敛在调用处：**没有配置就是没有 MCP 策略**。
      const hasVersionConfig =
        agentVersion != null &&
        typeof agentVersion === 'object' &&
        (Object.hasOwn(agentVersion as object, 'configJson') ||
          Object.hasOwn(agentVersion as object, 'config_json'));
      const { mcpToolRiskPolicy } = hasVersionConfig
        ? buildMcpPolicyBindings(agentVersion)
        : { mcpToolRiskPolicy: undefined };
      const { agentVersionToolPolicy, agentVersionToolRiskPolicy } =
        buildAgentVersionToolRiskBindings(agentVersion, { mcpToolRiskPolicy });
      if (Object.keys(readAgentVersionToolPolicy(agentVersion)).length > 0) {
        toolPolicyBinding = Object.freeze({
          appliedBy: 'enterprise-policy',
          tools: agentVersionToolPolicy ?? null,
          riskPolicy: agentVersionToolRiskPolicy ?? null,
        });
      }
      const runRiskResolver = buildRunRiskResolver(this.riskOverrides, agentVersion);

      // 8) Create Pi runtime (bindExtensions happens inside factory when extensions present)
      const piSnapshot =
        recovered.payload != null
          ? {
              snapshotJson: recovered.payload,
              checksum: recovered.checksum,
            }
          : null;

      // Skill discovery is per-caller: the system tier plus this user's own
      // directory. Resolved here (not at factory construction) so one Run's
      // prompt can never list another tenant's installed skills.
      const runSkillPaths = this.skillRootsForRun
        ? this.skillRootsForRun({
            orgId: eventContext.orgId,
            userId: eventContext.userId,
          })
        : null;

      this._runtime = await this.piRuntimeFactory.create({
        agentVersion,
        agentSession: session,
        piSnapshot,
        cwd,
        model,
        requestAuth,
        context: eventContext,
        extensionFactories,
        runEventRecorder: this._eventRecorder,
        // 本 Run 的风险解析函数（平台层 + 租户层合并）。**必须按 Run 传**：
        // 租户层来自 AgentVersion，而工厂是进程级单例。
        riskOverrides: runRiskResolver,
        // 把 runtime 侧的审批判定接到 durable 面（ADR 0009 D5 / 计划 H4.3）。
        // 少了这一步，策略挂载点用的是进程内的 InMemoryApprovalStore：判定是
        // 对的，但不落库、不发事件、不停泊 Run、不释放 Worker——审批链条从
        // 判定之后就断了。2026-08-31 之前 recorder 只经 extensionBundleFactory
        // 到达运行时，而那批 Pi Extension 已经删了。
        // 本 Run 的应用层服务，经 ALS 交给注册在进程级的 provider（计划 H5）。
        // provider 是 boot 时注册一次的单例，而队列绑着这个 Run 的事务与租户
        // scope，所以只能在调用时按 Run 取——与 ctx.fs/shell/jobs 走 exec-rpc
        // ALS 是同一条纪律（ADR 0009 D3）。
        ...(this.subagentSpawnPort
          ? {
              runServices: buildRunServices({
                spawnPort: this.subagentSpawnPort,
                parentRunId: runId,
                tenant: { orgId: eventContext.orgId, userId: eventContext.userId },
              }),
            }
          : {}),
        // 工具执行的 durable 记录（ADR 0009 D11 / 计划 H9.6）。少了它，Run 跑成功、
        // 文件真的落盘，而 `tool_executions` 一行都没有——2026-08-31 的 compose
        // 端到端就是这么发现的。与审批、子 Agent、风险表同一族的断链：
        // 记录器此前只经 `extensionBundleFactory` 到达运行时。
        toolLedger: {
          started: (i: Record<string, unknown>) =>
            (this._governanceRecorder as never as Record<string, any>).recordToolStarted(i),
          ended: (i: Record<string, unknown>) => {
            const toolCallId = String(i?.toolCallId ?? '').trim();
            if (toolCallId && this._pendingInteractionToolCallIds.has(toolCallId)) {
              return;
            }
            return (this._governanceRecorder as never as Record<string, any>).recordToolEnded(i);
          },
        },
        interactionRequester: createInteractionRequester({
          recorder: this._governanceRecorder,
          runSuspensionPort,
        }),
        approvalStore: new GovernanceApprovalStore({
          recorder: this._governanceRecorder as never,
          onDurableApprovalPending: (pending) => {
            runSuspensionPort.onDurableApprovalPending(pending as never);
          },
          // 续跑路径（ADR 0009 D5 / 计划 H4.4）：模型重新发起的调用带的是
          // **新 callId**，只能按「工具名 + 参数指纹」找那条已批准的记录。
          // 指纹用 durable 侧的 `integrityFingerprint`——账本存的就是它；
          // 拿策略层的 `digestArgs` 去查 MySQL 永远查不到（compose 端到端实测：
          // 批准之后又停泊了一次，因为这一步查空、重新铸了 PENDING）。
          findResolvedByDigest: async (toolName, _digest, args) => {
            const found = await this.tx.run(async (trx: Loose) => {
              const repos = this.createRepositories(trx);
              const approvals = await repos.approvals.listByRunId(runId, scope);
              const wanted = integrityFingerprint(args ?? {});
              for (const approval of approvals) {
                if (String(approval.status).toUpperCase() !== 'APPROVED') continue;
                const exec = await repos.toolExecutions
                  .getById(approval.toolExecutionId, scope)
                  .catch(() => null);
                if (exec == null || exec.toolName !== toolName) continue;
                if (exec._argsIntegrity && exec._argsIntegrity !== wanted) continue;
                return { approval, exec };
              }
              return null;
            });
            if (found == null) return null;
            return {
              id: approvalIdOf(String(found.exec.toolCallId ?? '')),
              toolName,
              sourceDigest: String(found.exec._argsIntegrity ?? ''),
              argsCanonical: JSON.stringify(args ?? {}),
              status: 'APPROVED',
              runStatusHint: 'WAITING_APPROVAL',
            } as never;
          },
        }),
        ...(runSkillPaths?.length ? { additionalSkillPaths: runSkillPaths } : {}),
        ...(toolPolicyBinding ? { toolPolicyBinding } : {}),
      });

      runtimeSession = this._runtime?.session;
      if (!runtimeSession) {
        return {
          outcome: RUN_STATUS.FAILED,
          statusReason: 'runtime has no session',
        };
      }

      // 8b) Durable AgentVersion fingerprint event. run.accepted records the
      // version id; this pins the exact config the Run *executed* with, so an
      // audit trail stays meaningful even if the catalog row is later edited
      // (configJson is mutable in the catalog). Recovery/checkpoint keep the
      // same identity for cross-referencing.
      try {
        await this._eventRecorder.record({
          type: 'run.agent_version',
          data: {
            agentVersionId,
            configHash: String(agentVersion.configHash || ''),
            piSdkVersion: PINNED_PI_SDK_VERSION,
          },
          dedupeKey: `run.agent_version:${runId}`,
        });
      } catch (err) {
        if (this._lockLost || err instanceof SessionFenceConflictError) {
          await this.#maybeMarkRecoveryOnLockLoss(
            agentSessionId,
            scope,
            (this._fenceToken as number),
          );
          return {
            outcome: RUN_STATUS.FAILED,
            statusReason: 'lock or fence lost during agent-version fingerprint',
          };
        }
        throw err;
      }

      // 9) Optional session.subscribe projector (disabled when observability owns events)
      const projector = this.projector;
      const useSessionSubscribe =
        projectionMode === 'session-subscribe' || projectionMode === 'both';

      const persistProjected = async (piEvent) => {
        if (this._lockLost) {
          throw new SessionFenceConflictError(
            'session lock lost; refusing durable event write',
            {
              agentSessionId,
              expectedToken: this._fenceToken ?? undefined,
            },
          );
        }
        const projected = projector.project(piEvent, eventContext);
        if (!projected?.length) return;
        // Single-owner mode: do not dedupe message.completed (role-only keys
        // swallow later assistants). Tool/model keys are stable identities.
        await this._eventRecorder.recordProjected(projected, {
          dedupeKeyFor: (ev) => {
            const p = ev.payload || {};
            if (ev.type.startsWith('tool.') && p.toolCallId) {
              return `${ev.type}:${p.toolCallId}`;
            }
            // message.* — no dedupe; each projected event is unique durability.
            if (ev.type.startsWith('model.request.') && p.correlationId) {
              return `${ev.type}:${p.correlationId}`;
            }
            return null;
          },
        });
      };

      if (useSessionSubscribe && typeof runtimeSession.subscribe === 'function') {
        this._unsubscribe = runtimeSession.subscribe((ev) => {
          this._eventTail?.enqueue(async () => {
            try {
              await persistProjected(ev);
            } catch (err) {
              if (
                err instanceof SessionFenceConflictError ||
                this._lockLost
              ) {
                this._lockLost = true;
                try {
                  runtimeSession.abort?.();
                } catch {
                  /* best-effort */
                }
              }
              // Surface on flush
              throw err;
            }
          });
        });
      }

      // AbortSignal → runtime.session.abort()
      const onAbort = () => {
        try {
          runtimeSession.abort?.();
        } catch {
          /* best-effort */
        }
      };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }

      // 10) A resumed approval executes the exact durable tool call first and
      // prompts only with its resolution. Ordinary runs use the triggering user
      // message and never dump accumulated history into a fresh prompt.
      let prompt;
      if (interactionResume) {
        prompt = toDshPromptInvocation(
          await this.#prepareInteractionResume({
            interactionResume,
            runtimeSession,
            run,
            scope,
            signal,
          }),
        );
      } else if (approvalResume) {
        prompt = toDshPromptInvocation(
          await this.#prepareApprovalResume({
            approvalResume,
            runtimeSession,
            run,
            scope,
            signal,
          }),
        );
      } else {
        prompt = toDshPromptInvocation(
          appendNonVisionImageNotice(
            appendCurrentTurnAttachmentContext(
              derivePromptFromTriggeringMessage(triggering),
              currentTurnAttachments,
            ),
            modelAcceptsImages ? [] : imageAttachments,
            String(model.id || ''),
          ),
        );
        if (imageAttachments.length > 0 && modelAcceptsImages) {
          if (!this.promptImageLoader) {
            return {
              outcome: RUN_STATUS.FAILED,
              statusReason: 'image attachments require a configured attachment store',
            };
          }
          let images;
          try {
            images = await this.promptImageLoader({
              attachments: imageAttachments,
              sandboxSessionId: session.sandboxSessionId,
              workspaceId: session.workspaceId,
              scope,
              traceId,
              traceState,
              signal,
            });
          } catch (error) {
            return {
              outcome: RUN_STATUS.FAILED,
              statusReason:
                sanitizeStatusReason(error) ?? 'image attachment resolution failed',
            };
          }
          if (images.length > 0) {
            prompt.options = { ...(prompt.options || {}), images };
          }
        }
      }

      if (this._lockLost || signal?.aborted) {
        return {
          outcome: RUN_STATUS.CANCELLED,
          statusReason: this._lockLost ? 'session lock lost' : 'aborted',
        };
      }

      // 11) Await prompt while consuming durable steer requests. HTTP and
      // Worker are separate processes; MySQL events are the hand-off channel.
      let promptError = null;
      let promptPromise = null;
      // DSH's native loop deliberately has no Run-level tool budget. This
      // temporary guard keeps the normal governance hooks intact and restores
      // the session after this Run completes.
      const toolBudgetGuard = installDshRunToolBudget(
        runtimeSession,
        this.toolBudget ?? undefined,
      );
      // Wall-clock hard deadline: a hung model stream never returns from
      // prompt(), so the budget's turn/tool hooks alone cannot fire. A timer
      // aborts the session (same path as cancellation); the budget guard then
      // keeps any post-abort turns from requesting more tools.
      let deadlineTimer = null;
      // Set by the deadline timer only. `signal.aborted` cannot stand in for
      // it: that is the external cancellation signal, so a deadline abort that
      // resolves prompt() without an error would otherwise fall through to the
      // success path and commit a half-finished turn as SUCCEEDED.
      let deadlineExceeded = false;
      const runDeadlineMs = Number(this.toolBudget?.runDeadlineMs) || null;
      try {
        if (typeof runtimeSession.prompt === 'function') {
          promptPromise = runtimeSession.prompt(prompt.text, prompt.options);
        } else if (typeof runtimeSession.prompt === 'undefined') {
          // Test fakes may use run/complete
          if (typeof runtimeSession.run === 'function') {
            promptPromise = runtimeSession.run(prompt.text, prompt.options);
          }
        }

        this._steerController = new DurableSteerController({
          transactionManager: this.tx,
          createRepositories: this.createRepositories,
          runtimeSession: {
            steer: async (text) => {
              if (typeof runtimeSession.steer !== 'function') {
                throw new Error('Pi runtime session.steer() is unavailable');
              }
              await runtimeSession.steer(text);
            },
          },
          eventRecorder: this._eventRecorder,
          runId,
          conversationId,
          agentSessionId,
          scope,
          pollIntervalMs: this.steerPollIntervalMs,
          onError: () => {
            try {
              runtimeSession.abort?.();
            } catch {
              // The controller error remains authoritative.
            }
          },
        });
        this._steerController.start();
        if (runDeadlineMs != null) {
          deadlineTimer = setTimeout(() => {
            deadlineExceeded = true;
            try {
              runtimeSession.abort?.();
            } catch {
              /* best-effort; budget guard still blocks further tools */
            }
          }, runDeadlineMs);
          if (typeof deadlineTimer.unref === 'function') deadlineTimer.unref();
        }
        await promptPromise;
      } catch (err) {
        promptError = err;
      } finally {
        if (deadlineTimer != null) clearTimeout(deadlineTimer);
        await this._steerController?.stop();
        toolBudgetGuard.dispose();
        if (!promptError && this._steerController?.error) {
          promptError = this._steerController.error;
        }
      }

      // 12) Flush event tail (message_end may precede SessionManager append)
      try {
        await this._eventTail?.flush();
      } catch (err) {
        if (this._lockLost || err instanceof SessionFenceConflictError) {
          await this.#maybeMarkRecoveryOnLockLoss(
            agentSessionId,
            scope,
            (this._fenceToken as number),
          );
          return {
            outcome: RUN_STATUS.FAILED,
            statusReason: 'lock or fence lost during event persistence',
          };
        }
        throw err;
      }

      if (this._lockLost) {
        await this.#maybeMarkRecoveryOnLockLoss(
          agentSessionId,
          scope,
          (this._fenceToken as number),
        );
        return {
          outcome: RUN_STATUS.FAILED,
          statusReason: 'session lock lost; no success commit',
        };
      }

      if (signal?.aborted) {
        return {
          outcome: RUN_STATUS.CANCELLED,
          statusReason: 'aborted',
        };
      }

      // A run killed by its own wall-clock budget is a failure, not a success:
      // whatever the model had produced when the session was aborted is a
      // partial turn, and recording it as SUCCEEDED hides a hung provider.
      //
      // A durable park outranks it, exactly as it does for promptError below.
      // Parking commits an approval/interaction row as PENDING and aborts the
      // session, so the deadline timer can fire inside that same window. A
      // terminal Run with a PENDING approval against it is unresolvable: the
      // decision endpoints refuse to act on a finished Run, so the approval
      // can never be granted, denied or cleaned up. The deadline guards a hung
      // provider — it is not a clock on the human, who gets a fresh one when
      // their decision resumes the Run.
      if (deadlineExceeded && !pendingApproval && !pendingInteraction) {
        return {
          outcome: RUN_STATUS.FAILED,
          statusReason: `run deadline exceeded after ${runDeadlineMs}ms`,
        };
      }

      if (promptError && !pendingApproval && !pendingInteraction) {
        const msg = sanitizeStatusReason(promptError);
        // Uncertain side effects → recovery-required, not silent success
        if (looksLikeUncertainSideEffect(promptError)) {
          await this.#markRecoveryRequired(
            agentSessionId,
            scope,
            (this._fenceToken as number),
            RECOVERY_REASON_CODE.RECOVERY_REQUIRED,
          );
          return {
            outcome: RUN_STATUS.FAILED,
            statusReason: msg ?? 'uncertain side effects; recovery required',
          };
        }
        return {
          outcome: RUN_STATUS.FAILED,
          statusReason: msg,
        };
      }

      // 12) Capture full SessionManager entries AFTER prompt completed
      // Explicit renew confirms + extends session lock TTL before durable writes.
      if (!(await this.#confirmSessionLock(agentSessionId))) {
        await this.#maybeMarkRecoveryOnLockLoss(
          agentSessionId,
          scope,
          (this._fenceToken as number),
        );
        return {
          outcome: RUN_STATUS.FAILED,
          statusReason: 'session lock lost before checkpoint; no success',
        };
      }

      const sessionManager =
        this._runtime?.sessionManager ??
        runtimeSession.sessionManager ??
        null;
      const payload = await captureSessionSnapshotPayload({
        sessionAdapter: this.sessionAdapter,
        sessionManager,
        recoveredPayload: recovered.payload,
        cwd,
        agentSessionId,
      });

      // 12b) UI assistant Messages only for entries new this run (not recovered history).
      if (!(await this.#confirmSessionLock(agentSessionId))) {
        await this.#maybeMarkRecoveryOnLockLoss(
          agentSessionId,
          scope,
          (this._fenceToken as number),
        );
        return {
          outcome: RUN_STATUS.FAILED,
          statusReason: 'session lock lost before assistant persist; no success',
        };
      }
      await this.#persistAssistantMessagesFromPayload({
        payload,
        priorEntryIds,
        run,
        scope,
        conversationId,
        agentSessionId,
        fenceToken: (this._fenceToken as number),
      });

      // 13) Atomic journal + snapshot checkpoint (fence gated inside service)
      if (!(await this.#confirmSessionLock(agentSessionId))) {
        await this.#maybeMarkRecoveryOnLockLoss(
          agentSessionId,
          scope,
          (this._fenceToken as number),
        );
        return {
          outcome: RUN_STATUS.FAILED,
          statusReason: 'session lock lost before checkpoint; no success',
        };
      }

      const configHash = String(agentVersion.configHash || '');
      await this.recoveryService.checkpoint({
        agentSessionId,
        orgId: scope.orgId,
        userId: scope.userId,
        executionFenceToken: (this._fenceToken as number),
        runId,
        traceId,
        payload,
        workspacePath: cwd,
        agentVersionId,
        configHash,
        workspaceId: session.workspaceId,
        piSdkVersion: PINNED_PI_SDK_VERSION,
        interactionResumeId: interactionResume?.interactionId ?? null,
      });

      if (this._lockLost) {
        return {
          outcome: RUN_STATUS.FAILED,
          statusReason: 'session lock lost after prompt; no success',
        };
      }

      if (pendingApproval) {
        return {
          outcome: RUN_STATUS.WAITING_APPROVAL,
          statusReason: 'approval pending',
        };
      }

      if (pendingInteraction) {
        return {
          outcome: RUN_STATUS.WAITING_INPUT,
          statusReason: 'user interaction pending',
        };
      }

      // `AgentSession.prompt()` can resolve even when the provider/runtime
      // records a terminal assistant message with `stopReason: "error"`.
      // Treating that state as a normal completion caused the durable Run to
      // be marked SUCCEEDED with no assistant answer. Inspect only entries
      // created by this prompt so an error in recovered history cannot poison
      // a later successful turn.
      const runtimeTerminal = terminalOutcomeFromNewAssistantEntries(
        payload,
        priorEntryIds,
      );
      if (runtimeTerminal) return runtimeTerminal;

      return { outcome: RUN_STATUS.SUCCEEDED, statusReason: null };
    } catch (err) {
      if (err instanceof SessionRecoveryRequiredError) {
        return {
          outcome: RUN_STATUS.FAILED,
          statusReason: sanitizeStatusReason(err) ?? 'recovery required',
        };
      }
      if (err instanceof SessionFenceConflictError) {
        return {
          outcome: RUN_STATUS.FAILED,
          statusReason: sanitizeStatusReason(err) ?? 'fence conflict',
        };
      }
      if (err instanceof SessionLockError) {
        return {
          outcome: RUN_STATUS.FAILED,
          statusReason: sanitizeStatusReason(err) ?? 'session lock error',
        };
      }
      if (signal?.aborted) {
        return {
          outcome: RUN_STATUS.CANCELLED,
          statusReason: 'aborted',
        };
      }
      return {
        outcome: RUN_STATUS.FAILED,
        statusReason: sanitizeStatusReason(err),
      };
    }
  }

  /** @see prepareApprovalResume */
  async #prepareApprovalResume(args) {
    return prepareApprovalResume(this, args);
  }

  /** @see prepareInteractionResume */
  async #prepareInteractionResume(args) {
    return prepareInteractionResume(this, args);
  }

  /**
   * dispose order: unsubscribe → abort if needed → flush → runtime.dispose →
   * stop renew → token-safe release. Idempotent; aggregates cleanup errors.
   */
  async dispose() {
    if (this._disposed) {
      if (this._cleanupErrors.length) {
        throw this._cleanupErrors.length === 1
          ? this._cleanupErrors[0]
          : new AggregateError(this._cleanupErrors, 'DshRunExecutor dispose failures');
      }
      return;
    }
    this._disposed = true;
    this._pendingInteractionToolCallIds.clear();
    const errors: unknown[] = [];

    if (this._steerController) {
      try {
        await this._steerController.stop();
      } catch (err) {
        errors.push(err);
      }
      this._steerController = null;
    }

    if (this._unsubscribe) {
      try {
        this._unsubscribe();
      } catch (err) {
        errors.push(err);
      }
      this._unsubscribe = null;
    }

    try {
      this._runtime?.session?.abort?.();
    } catch (err) {
      errors.push(err);
    }

    if (this._eventTail) {
      try {
        await this._eventTail.flush();
      } catch (err) {
        errors.push(err);
      }
      this._eventTail = null;
    }

    if (this._runtime && typeof this._runtime.dispose === 'function') {
      try {
        await this._runtime.dispose();
      } catch (err) {
        errors.push(err);
      }
      this._runtime = null;
    }

    if (this._lockRenewLoop) {
      try {
        await this._lockRenewLoop.stop();
      } catch (err) {
        errors.push(err);
      }
      this._lockRenewLoop = null;
    }

    if (this._lockToken && this._lockedSessionId) {
      try {
        await this.sessionLockManager.release(
          this._lockedSessionId,
          this._lockToken,
        );
      } catch (err) {
        errors.push(err);
      }
      this._lockToken = null;
      this._lockedSessionId = null;
    }

    this._cleanupErrors = errors;
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, 'DshRunExecutor dispose failures');
    }
  }




  /**
   * Confirm session lock still held: renew current token (extends TTL).
   * Background renew continues; this is an explicit pre-write gate.
   * @param agentSessionId
   * @returns {Promise<boolean>}
   */
  async #confirmSessionLock(agentSessionId: string) {
    if (this._lockLost || this._disposed) return false;
    if (!this._lockToken || this._lockedSessionId !== agentSessionId) {
      this._lockLost = true;
      return false;
    }
    try {
      const ok = await this.sessionLockManager.renew(
        agentSessionId,
        this._lockToken,
      );
      if (!ok) {
        this._lockLost = true;
        return false;
      }
      return true;
    } catch {
      this._lockLost = true;
      return false;
    }
  }

  /**
   * Persist UI assistant messages for **new** Pi session entries only.
   * Fenced + transactional; idempotent via ui:assistant:{entryId} pi_entry_id.
   * Recovered history entry IDs are excluded so old assistants are never
   * re-bound to the current run.
   *
   * @param {{
   *   payload: { entries?: object[] },
   *   priorEntryIds: Set<string>,
   *   run: object,
   *   scope: { orgId: string, userId: string },
   *   conversationId: string,
   *   agentSessionId: string,
   *   fenceToken: number,
   * }} args
   */
  async #persistAssistantMessagesFromPayload(args: { payload: { entries?: Record<string, any>[] }, priorEntryIds: Set<string>, run: Record<string, any>, scope: { orgId: string, userId: string }, conversationId: string, agentSessionId: string, fenceToken: number, }) {
    const {
      payload,
      priorEntryIds,
      run,
      scope,
      conversationId,
      agentSessionId,
      fenceToken,
    } = args;
    const prior = priorEntryIds instanceof Set ? priorEntryIds : new Set();
    const entries = Array.isArray(payload?.entries) ? payload.entries : [];
    for (const entry of entries) {
      if (!entry || entry.type !== 'message') continue;
      if (typeof entry.id !== 'string' || !entry.id) continue;
      // Skip entries that already existed before this run's prompt.
      if (prior.has(entry.id)) continue;

      const msg = entry.message;
      if (!msg || msg.role !== 'assistant') continue;
      const text = extractAssistantTextForUi(msg);
      const thinking = extractAssistantThinkingForUi(msg);
      if (!text && !thinking && !Array.isArray(msg.content)) continue;

      const uiEntryId = `${UI_ASSISTANT_ENTRY_PREFIX}${entry.id}`;

      await this.tx.run(async (trx) => {
        const repos = this.createRepositories(trx);
        await repos.sessions.assertExecutionFence(
          agentSessionId,
          scope,
          fenceToken,
          { forUpdate: true, requireActive: true },
        );

        const existing = await repos.journal.getByEntryId(
          agentSessionId,
          uiEntryId,
          scope,
        );
        if (existing) return;

        try {
          await repos.messages.append({
            messageId: this.generateId(),
            conversationId,
            orgId: scope.orgId,
            userId: scope.userId,
            agentSessionId,
            runId: run.runId,
            role: 'assistant',
            messageType: 'text',
            contentJson: {
              kind: 'assistant_message',
              piEntryId: entry.id,
              text,
              ...(thinking ? { thinking } : {}),
            },
            piEntryId: uiEntryId,
            piEntryKind: 'assistant_ui',
          });
        } catch (err) {
          const isDup =
            (err as { code?: string })?.code === 'ER_DUP_ENTRY' ||
            err instanceof ConflictError ||
            err?.name === 'ConflictError';
          if (isDup) {
            // Only treat as idempotent when the same uiEntryId already exists.
            const again = await repos.journal.getByEntryId(
              agentSessionId,
              uiEntryId,
              scope,
            );
            if (again) return;
          }
          throw err;
        }
      });
    }
  }

  async #markRecoveryRequired(agentSessionId: string, scope: { orgId: string, userId: string }, fence: number, reason: string) {
    try {
      await this.tx.run(async (trx) => {
        const repos = this.createRepositories(trx);
        await repos.sessions.markRecoveryRequiredIfFence(
          agentSessionId,
          scope,
          {
            expectedFenceToken: fence,
            recoveryReasonCode: reason,
          },
        );
      });
    } catch {
      /* stale fence — do not claim */
    }
  }

  async #maybeMarkRecoveryOnLockLoss(agentSessionId: string, scope: { orgId: string, userId: string }, fence: number) {
    await this.#markRecoveryRequired(
      agentSessionId,
      scope,
      fence,
      RECOVERY_REASON_CODE.LEASE_LOST,
    );
  }
}

export const PiRunExecutor = DshRunExecutor;
export type PiRunExecutor = DshRunExecutor;

export {
  createDshRunExecutorFactory,
  createPiRunExecutorFactory,
} from './dsh-run-executor-factory.js';
export { normalizeExecutorResult } from './run-executor.js';

