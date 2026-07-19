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

import { randomBytes } from 'node:crypto';
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
import { PINNED_PI_SDK_VERSION } from '../infrastructure/pi/pi-runtime-factory.js';
import { buildMcpPolicyBindings } from '../infrastructure/mcp/pi-mcp-adapter-factory.js';
import {
  PlatformEventProjector,
  extractAssistantTextForUi,
  redactPayload,
} from '../infrastructure/pi/platform-event-projector.js';
import { normalizeExecutorResult } from './run-executor.js';
import { sanitizeStatusReason } from './sanitize-status-reason.js';
import {
  SessionRecoveryService,
  emptySessionPayload,
} from './session-recovery-service.js';
import { ConflictError } from '../infrastructure/mysql/errors.js';
import { FencedRunEventRecorder } from './fenced-run-event-recorder.js';
import { FencedToolGovernanceRecorder } from './fenced-tool-governance-recorder.js';
import { createPromiseTail } from './promise-tail.js';
import { APPROVAL_STATUS } from '../domain/tool/approval-status.js';
import { TOOL_EXECUTION_STATUS } from '../domain/tool/tool-execution-status.js';
import { DurableSteerController } from './durable-steer-controller.js';
import {
  DURABLE_INTERACTION_PENDING,
  INTERACTION_STATUS,
} from '../domain/interaction/interaction-status.js';

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

/** Ordinary UI assistant message pi_entry_id prefix — never collides with journal entry ids. */
export const UI_ASSISTANT_PI_ENTRY_PREFIX = 'ui:assistant:';

/**
 * Unique Run lease acquisition token (workerId is metadata only).
 * Format: `{workerId}:{cryptographicSuffix}` — same shape as session lock tokens.
 *
 * @param {string} workerId
 * @param {{ randomBytes?: (n: number) => Buffer | Uint8Array }} [opts]
 * @returns {string}
 */
export function generateRunLeaseOwnerToken(workerId, opts = {}) {
  const base = String(workerId ?? '').trim();
  if (!base) {
    throw new Error('workerId is required for run lease owner token');
  }
  const rnd = opts.randomBytes ?? randomBytes;
  return `${base}:${Buffer.from(rnd(16)).toString('hex')}`;
}

/**
 * Derive Pi prompt content from the durable triggering user message only.
 * Never re-sends full accumulated history into prompt.
 *
 * @param {object | null | undefined} message — mapped Message row
 * @returns {string | Array<{ type: string, text?: string, [k: string]: unknown }>}
 */
export function derivePromptFromTriggeringMessage(message) {
  if (!message) {
    throw new Error('triggering message is required');
  }
  const content = message.contentJson || {};

  // Multimodal / parts form
  if (Array.isArray(content.parts)) {
    return content.parts.map((p) => {
      if (p && typeof p === 'object') {
        if (p.type === 'text' || p.type === 'image') return p;
        if (typeof p.text === 'string') return { type: 'text', text: p.text };
      }
      return { type: 'text', text: String(p) };
    });
  }

  // CreateRun stores { messages: [{role, content}], ... }
  if (Array.isArray(content.messages) && content.messages.length) {
    const lastUser = [...content.messages]
      .reverse()
      .find((m) => m && (m.role === 'user' || !m.role));
    const raw = lastUser?.content ?? lastUser?.text ?? content.messages[0]?.content;
    if (Array.isArray(raw)) {
      return raw.map((p) => {
        if (p && typeof p === 'object' && p.type) return p;
        return { type: 'text', text: String(p?.text ?? p) };
      });
    }
    if (typeof raw === 'string') return raw;
  }

  if (typeof content.text === 'string') return content.text;
  if (typeof content.content === 'string') return content.content;

  // Fallback: single string body
  if (typeof content === 'string') return content;
  return JSON.stringify(content);
}

/**
 * Adapt durable text/image parts to AgentSession.prompt(text, { images }).
 * Pi 0.80.3 always requires the first argument to be a string.
 *
 * @param {string | Array<{ type: string, text?: string, [k: string]: unknown }>} prompt
 * @returns {{ text: string, options?: { images: object[] } }}
 */
export function toPiPromptInvocation(prompt) {
  if (typeof prompt === 'string') return { text: prompt };

  const text = prompt
    .filter((part) => part?.type === 'text')
    .map((part) => String(part.text ?? ''))
    .join('\n');
  const images = prompt
    .filter((part) => part?.type === 'image')
    .map((part) => ({ ...part }));

  return images.length > 0 ? { text, options: { images } } : { text };
}

/**
 * Replace a parked approval/interaction placeholder in live state and the
 * durable branch. `appendIfMissing` is reserved for interaction recovery from
 * an older snapshot that was checkpointed before Pi emitted a toolResult slot.
 */
export function replaceSuspendedToolResultInSession(session, replacement) {
  if (!session || !replacement?.toolCallId) return false;
  const toolCallId = String(replacement.toolCallId);
  const content = Array.isArray(replacement.content)
    ? replacement.content
    : [];
  const details =
    replacement.details && typeof replacement.details === 'object'
      ? replacement.details
      : {};
  const isError = Boolean(replacement.isError);
  let rewrote = false;
  const appendIfMissing = replacement.appendIfMissing === true;

  const messages = session.agent?.state?.messages;
  if (Array.isArray(messages)) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (
        message?.role !== 'toolResult' ||
        String(message.toolCallId || '') !== toolCallId
      ) {
        continue;
      }
      messages[i] = {
        ...message,
        toolName: replacement.toolName || message.toolName,
        content,
        details: { ...(message.details || {}), ...details },
        isError,
      };
      rewrote = true;
      break;
    }
  }

  const manager = session.sessionManager;
  if (
    manager &&
    typeof manager.getEntries === 'function' &&
    typeof manager.branch === 'function' &&
    typeof manager.appendMessage === 'function'
  ) {
    const entries = manager.getEntries() || [];
    const parked = [...entries].reverse().find(
      (entry) =>
        entry?.type === 'message' &&
        entry.message?.role === 'toolResult' &&
        String(entry.message.toolCallId || '') === toolCallId,
    );
    if (parked?.parentId) {
      manager.branch(parked.parentId);
      manager.appendMessage({
        role: 'toolResult',
        toolCallId,
        toolName:
          replacement.toolName || parked.message?.toolName || 'tool',
        content,
        details,
        isError,
        timestamp: Date.now(),
      });
      rewrote = true;
    }
  }
  if (!rewrote && appendIfMissing) {
    if (
      manager &&
      typeof manager.appendMessage === 'function'
    ) {
      manager.appendMessage({
        role: 'toolResult',
        toolCallId,
        toolName: replacement.toolName || 'tool',
        content,
        details,
        isError,
        timestamp: Date.now(),
      });
      rewrote = true;
    } else if (Array.isArray(messages)) {
      messages.push({
        role: 'toolResult',
        toolCallId,
        toolName: replacement.toolName || 'tool',
        content,
        details,
        isError,
      });
      rewrote = true;
    }
  }
  return rewrote;
}

export class PiRunExecutor {
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
   *   modelResolver: (agentVersion: object) => object | Promise<object>,
   *   requestAuthResolver?: (model: object, agentVersion: object) => object | Promise<object>,
   *   workspaceResolver: (agentSession: object) => string | Promise<string>,
   *   sandboxSessionProvisioner?: { ensure: (input: object) => Promise<object> },
   *   generateId: () => string,
   *   now?: () => Date,
   *   projector?: PlatformEventProjector,
   *   recoveryService?: SessionRecoveryService,
   *   sessionLockRenewIntervalMs?: number,
   *   agentDir?: string,
   *   extensionBundleFactory?: (runContext: object, deps: object) => unknown[],
   *   eventProjectionMode?: 'session-subscribe' | 'observability' | 'both',
   *   steerPollIntervalMs?: number,
   * }} deps
   */
  constructor(deps) {
    if (!deps?.transactionManager?.run) {
      throw new Error('PiRunExecutor requires transactionManager');
    }
    if (typeof deps.createRepositories !== 'function') {
      throw new Error('PiRunExecutor requires createRepositories');
    }
    if (!deps.sessionLockManager?.acquire) {
      throw new Error('PiRunExecutor requires sessionLockManager');
    }
    if (!deps.piRuntimeFactory?.create) {
      throw new Error('PiRunExecutor requires piRuntimeFactory');
    }
    if (typeof deps.modelResolver !== 'function') {
      throw new Error('PiRunExecutor requires modelResolver(agentVersion)');
    }
    if (typeof deps.workspaceResolver !== 'function') {
      throw new Error('PiRunExecutor requires workspaceResolver(agentSession)');
    }
    if (typeof deps.generateId !== 'function') {
      throw new Error('PiRunExecutor requires generateId');
    }

    this.tx = deps.transactionManager;
    this.createRepositories = deps.createRepositories;
    this.sessionLockManager = deps.sessionLockManager;
    this.piRuntimeFactory = deps.piRuntimeFactory;
    this.sessionAdapter = deps.sessionAdapter ?? null;
    this.modelResolver = deps.modelResolver;
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
    this.agentDir = deps.agentDir ?? null;
    this.extensionBundleFactory = deps.extensionBundleFactory ?? null;
    /**
     * When 'observability', session.subscribe projector is disabled (Extension owns
     * message/tool/compaction/model events). Default 'session-subscribe' keeps PR-05
     * tests green when no observability bundle is wired.
     */
    this.eventProjectionMode = deps.eventProjectionMode ?? 'session-subscribe';
    this.steerPollIntervalMs = deps.steerPollIntervalMs;

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
    /** @type {ReturnType<typeof createPromiseTail> | null} */
    this._eventTail = null;
    /** @type {FencedRunEventRecorder | null} */
    this._eventRecorder = null;
    /** @type {FencedToolGovernanceRecorder | null} */
    this._governanceRecorder = null;
    /** @type {Set<string>} */
    this._pendingInteractionToolCallIds = new Set();
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
   * @param {import('./run-executor.js').RunExecutorContext} ctx
   * @returns {Promise<import('./run-executor.js').RunExecutorResult>}
   */
  async execute(ctx) {
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
      const piSdk =
        agentVersion.piSdkVersion != null
          ? String(agentVersion.piSdkVersion)
          : PINNED_PI_SDK_VERSION;
      if (piSdk !== PINNED_PI_SDK_VERSION) {
        await this.#markRecoveryRequired(
          agentSessionId,
          scope,
          fenceToken,
          RECOVERY_REASON_CODE.VERSION_INCOMPATIBLE,
        );
        return {
          outcome: RUN_STATUS.FAILED,
          statusReason: `AgentVersion piSdkVersion ${piSdk} != ${PINNED_PI_SDK_VERSION}`,
        };
      }

      const model = await this.modelResolver(agentVersion);
      if (!model) {
        return {
          outcome: RUN_STATUS.FAILED,
          statusReason: 'modelResolver returned no model',
        };
      }
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
      /** @type {Set<string>} */
      const priorEntryIds = new Set(
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
      /** @type {any} */
      let runtimeSession = null;
      /** @type {object | null} */
      let pendingApproval = null;
      /** @type {object | null} */
      let pendingInteraction = null;

      if (typeof this.extensionBundleFactory === 'function') {
        // plan: runtime sandboxSessionId must exist when enterprise extensions run.
        // Bundle assert allows null for unit tests / create-phase; executor fails closed.
        try {
          sandboxSessionIdForCtx = assertUlid(
            sandboxSessionIdForCtx,
            'sandboxSessionId',
          );
        } catch {
          return {
            outcome: RUN_STATUS.FAILED,
            statusReason:
              'sandboxSessionId is required when extensionBundleFactory is enabled (PR-07 provisions sandbox)',
          };
        }
      }

      const eventContext = {
        orgId: scope.orgId,
        userId: scope.userId,
        conversationId,
        agentSessionId,
        runId,
        sandboxSessionId: sandboxSessionIdForCtx,
        traceId,
        ...(traceState ? { traceState } : {}),
        executionFenceToken: fenceToken,
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
        executionFenceToken: /** @type {number} */ (fenceToken),
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
        executionFenceToken: /** @type {number} */ (fenceToken),
        now: this.now,
        isLockLost: () => this._lockLost,
        emit: emitAfterCommit,
      });

      if (typeof this.extensionBundleFactory === 'function') {
        const mcpPolicyBindings = buildMcpPolicyBindings(agentVersion);
          extensionFactories = this.extensionBundleFactory(eventContext, {
            recorder: this._eventRecorder,
            governanceRecorder: this._governanceRecorder,
            observability: {
              modelId:
                typeof model.id === 'string'
                  ? model.id
                  : typeof model.modelId === 'string'
                    ? model.modelId
                    : null,
              provider: typeof model.provider === 'string' ? model.provider : null,
            },
            ...mcpPolicyBindings,
            isDurableInteractionPending: (toolCallId) => {
              const normalized = String(toolCallId ?? '').trim();
              return (
                normalized.length > 0 &&
                this._pendingInteractionToolCallIds.has(normalized)
              );
            },
          runSuspensionPort: {
            onDurableApprovalPending: (pending) => {
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
            onDurableInteractionPending: (pending) => {
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
          },
          // Callers may merge sandboxTransport / policy config in their factory.
        });
        // Observability bundle owns message/tool/compaction/model events.
        if (projectionMode === 'session-subscribe') {
          projectionMode = 'observability';
        }
      }

      // 8) Create Pi runtime (bindExtensions happens inside factory when extensions present)
      const piSnapshot =
        recovered.payload != null
          ? {
              snapshotJson: recovered.payload,
              checksum: recovered.checksum,
            }
          : null;

      this._runtime = await this.piRuntimeFactory.create({
        agentVersion,
        agentSession: session,
        piSnapshot,
        cwd,
        model,
        requestAuth,
        agentDir: this.agentDir ?? undefined,
        context: eventContext,
        extensionFactories,
        runEventRecorder: this._eventRecorder,
      });

      runtimeSession = this._runtime?.session;
      if (!runtimeSession) {
        return {
          outcome: RUN_STATUS.FAILED,
          statusReason: 'runtime has no session',
        };
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
        prompt = toPiPromptInvocation(
          await this.#prepareInteractionResume({
            interactionResume,
            runtimeSession,
            run,
            scope,
            signal,
          }),
        );
      } else if (approvalResume) {
        prompt = toPiPromptInvocation(
          await this.#prepareApprovalResume({
            approvalResume,
            runtimeSession,
            run,
            scope,
            signal,
          }),
        );
      } else {
        const triggering = await this.tx.run(async (trx) => {
          const repos = this.createRepositories(trx);
          return repos.messages.getById(run.triggeringMessageId, scope);
        });
        this.#assertTriggeringMessageBinding(triggering, run);
        prompt = toPiPromptInvocation(
          derivePromptFromTriggeringMessage(triggering),
        );
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
        await promptPromise;
      } catch (err) {
        promptError = err;
      } finally {
        await this._steerController?.stop();
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
            /** @type {number} */ (this._fenceToken),
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
          /** @type {number} */ (this._fenceToken),
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

      if (promptError && !pendingApproval && !pendingInteraction) {
        const msg = sanitizeStatusReason(promptError);
        // Uncertain side effects → recovery-required, not silent success
        if (this.#looksLikeUncertainSideEffect(promptError)) {
          await this.#markRecoveryRequired(
            agentSessionId,
            scope,
            /** @type {number} */ (this._fenceToken),
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
          /** @type {number} */ (this._fenceToken),
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
      let payload;
      if (
        this.sessionAdapter &&
        sessionManager &&
        typeof this.sessionAdapter.captureSnapshotPayload === 'function'
      ) {
        payload = this.sessionAdapter.captureSnapshotPayload(sessionManager, {
          cwd,
        });
      } else if (sessionManager && typeof sessionManager.getEntries === 'function') {
        const header =
          typeof sessionManager.getHeader === 'function'
            ? sessionManager.getHeader()
            : emptySessionPayload({ cwd, id: agentSessionId }).header;
        payload = {
          header: { ...header, cwd, version: 3, type: 'session' },
          entries: [...sessionManager.getEntries()],
        };
      } else if (recovered.payload) {
        payload = recovered.payload;
      } else {
        payload = emptySessionPayload({ cwd, id: agentSessionId });
      }

      // 12b) UI assistant Messages only for entries new this run (not recovered history).
      if (!(await this.#confirmSessionLock(agentSessionId))) {
        await this.#maybeMarkRecoveryOnLockLoss(
          agentSessionId,
          scope,
          /** @type {number} */ (this._fenceToken),
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
        fenceToken: /** @type {number} */ (this._fenceToken),
      });

      // 13) Atomic journal + snapshot checkpoint (fence gated inside service)
      if (!(await this.#confirmSessionLock(agentSessionId))) {
        await this.#maybeMarkRecoveryOnLockLoss(
          agentSessionId,
          scope,
          /** @type {number} */ (this._fenceToken),
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
        executionFenceToken: /** @type {number} */ (this._fenceToken),
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

  /**
   * Verify the worker-provided resume context against MySQL. Approved tools are
   * claimed and executed once with their original toolCallId and arguments;
   * rejected tools only add a continuation result.
   */
  async #prepareApprovalResume({
    approvalResume,
    runtimeSession,
    run,
    scope,
    signal,
  }) {
    const approvalId = assertUlid(
      approvalResume.approvalId,
      'approvalId',
    );
    const durable = await this.tx.run(async (trx) => {
      const repos = this.createRepositories(trx);
      const approval = await repos.approvals.getById(approvalId, scope);
      const toolExecution = await repos.toolExecutions.getById(
        approval.toolExecutionId,
        scope,
      );
      return { approval, toolExecution };
    });
    const { approval, toolExecution } = durable;
    if (
      approval.runId !== run.runId ||
      toolExecution.runId !== run.runId ||
      approval.toolExecutionId !== toolExecution.toolExecutionId ||
      approvalResume.toolExecutionId !== toolExecution.toolExecutionId
    ) {
      throw new ConflictError('approval resume parent binding mismatch', {
        resource: 'approvals',
        id: approvalId,
      });
    }
    if (
      approvalResume.status &&
      approvalResume.status !== approval.status
    ) {
      throw new ConflictError('approval resume status changed', {
        resource: 'approvals',
        id: approvalId,
      });
    }

    const replaySession = {
      agent: runtimeSession.agent,
      sessionManager:
        this._runtime?.sessionManager ?? runtimeSession.sessionManager,
    };

    if (approval.status === APPROVAL_STATUS.REJECTED) {
      if (toolExecution.status !== TOOL_EXECUTION_STATUS.FAILED) {
        throw new ConflictError(
          `rejected approval has non-terminal tool ${toolExecution.status}`,
          { resource: 'tool_executions', id: toolExecution.toolExecutionId },
        );
      }
      const content = [
        {
          type: 'text',
          text: `Approval ${approvalId} was rejected. The tool was not executed.`,
        },
      ];
      replaceSuspendedToolResultInSession(replaySession, {
        toolCallId: toolExecution.toolCallId,
        toolName: toolExecution.toolName,
        content,
        details: {
          approvalId,
          approvalRejected: true,
        },
        isError: true,
      });
      return (
        `[Approval resolution] Approval ${approvalId} for ` +
        `${toolExecution.toolName} was rejected. The tool was not executed. ` +
        'Continue the task without retrying or bypassing the rejected operation.'
      );
    }

    if (approval.status !== APPROVAL_STATUS.APPROVED) {
      throw new ConflictError(`approval is not resolved: ${approval.status}`, {
        resource: 'approvals',
        id: approvalId,
      });
    }
    if (toolExecution.status !== TOOL_EXECUTION_STATUS.WAITING_APPROVAL) {
      throw new ConflictError(
        `approved tool is ${toolExecution.status}, expected WAITING_APPROVAL`,
        { resource: 'tool_executions', id: toolExecution.toolExecutionId },
      );
    }
    if (typeof runtimeSession.getToolDefinition !== 'function') {
      throw new Error(
        'Pi runtime cannot replay approved tool: getToolDefinition unavailable',
      );
    }
    const definition = runtimeSession.getToolDefinition(toolExecution.toolName);
    if (!definition || typeof definition.execute !== 'function') {
      throw new Error(
        `approved tool definition is unavailable: ${toolExecution.toolName}`,
      );
    }

    await this._governanceRecorder.recordToolStarted({
      toolCallId: toolExecution.toolCallId,
      toolName: toolExecution.toolName,
      args: toolExecution.argumentsJson ?? {},
      approvalId,
    });

    let result;
    try {
      result = await definition.execute(
        toolExecution.toolCallId,
        toolExecution.argumentsJson ?? {},
        signal,
        undefined,
        undefined,
      );
    } catch (err) {
      await this._governanceRecorder.recordToolUnknown({
        toolCallId: toolExecution.toolCallId,
        toolName: toolExecution.toolName,
        args: toolExecution.argumentsJson ?? {},
        errorCode: 'APPROVED_TOOL_REPLAY_UNCERTAIN',
        result: {
          unknown: true,
          approvalId,
          reason: sanitizeStatusReason(err),
        },
      });
      const failure = new Error(
        `approved tool replay outcome is uncertain: ${sanitizeStatusReason(err) || 'unknown error'}`,
      );
      failure.code = 'APPROVED_TOOL_REPLAY_UNCERTAIN';
      throw failure;
    }

    const isError = Boolean(result?.isError);
    await this._governanceRecorder.recordToolEnded({
      toolCallId: toolExecution.toolCallId,
      toolName: toolExecution.toolName,
      args: toolExecution.argumentsJson ?? {},
      isError,
      result: result ?? null,
    });

    const safeResult = redactPayload(result ?? null);
    const fallbackText = JSON.stringify(safeResult ?? null).slice(0, 20_000);
    const content = Array.isArray(result?.content)
      ? result.content
      : [{ type: 'text', text: fallbackText }];
    const rewrote = replaceSuspendedToolResultInSession(replaySession, {
      toolCallId: toolExecution.toolCallId,
      toolName: toolExecution.toolName,
      content,
      details: {
        ...(result?.details && typeof result.details === 'object'
          ? result.details
          : {}),
        approvalId,
        approvalReplay: true,
      },
      isError,
    });
    return (
      `[Approval resolution] Approval ${approvalId} was granted. ` +
      `The original ${toolExecution.toolName} call ` +
      `(toolCallId=${toolExecution.toolCallId}) was executed exactly once with ` +
      `its approved arguments${isError ? ' and returned an error' : ''}. ` +
      (rewrote
        ? 'Its result is recorded in the tool result slot. '
        : `Its redacted result is: ${fallbackText || '(empty)'}. `) +
      'Continue from that result without issuing the same operation again.'
    );
  }

  /**
   * Recover a durable ask_user answer into the parked tool-result slot, then
   * continue the existing Pi session with a short continuation prompt.
   */
  async #prepareInteractionResume({
    interactionResume,
    runtimeSession,
    run,
    scope,
    signal,
  }) {
    const interactionId = assertUlid(
      interactionResume.interactionId,
      'interactionId',
    );
    const durable = await this.tx.run(async (trx) => {
      const repos = this.createRepositories(trx);
      const interaction = await repos.interactions.getById(interactionId, scope);
      const toolExecution = await repos.toolExecutions.getById(
        interaction.toolExecutionId,
        scope,
      );
      return { interaction, toolExecution };
    });
    const { interaction, toolExecution } = durable;
    if (
      interaction.runId !== run.runId ||
      interaction.agentSessionId !== run.agentSessionId ||
      interaction.toolCallId !== toolExecution.toolCallId ||
      interactionResume.toolExecutionId !== toolExecution.toolExecutionId ||
      interactionResume.toolCallId !== toolExecution.toolCallId
    ) {
      throw new ConflictError('interaction resume parent binding mismatch', {
        resource: 'interactions',
        id: interactionId,
      });
    }
    if (
      interaction.status !== INTERACTION_STATUS.RESOLVED ||
      interactionResume.status !== interaction.status
    ) {
      throw new ConflictError('interaction is not durably resolved', {
        resource: 'interactions',
        id: interactionId,
      });
    }
    if (
      interactionResume.responseHash &&
      interaction.responseHash !== interactionResume.responseHash
    ) {
      throw new ConflictError('interaction response hash changed', {
        resource: 'interactions',
        id: interactionId,
      });
    }
    if (signal?.aborted) throw new Error('interaction resume aborted');

    const response = interaction.responseJson;
    const responseText =
      typeof response === 'string' ? response : JSON.stringify(response);
    const content = [
      {
        type: 'text',
        text: `User response: ${responseText}`,
      },
    ];
    replaceSuspendedToolResultInSession(
      {
        agent: runtimeSession.agent,
        sessionManager:
          this._runtime?.sessionManager ?? runtimeSession.sessionManager,
      },
      {
        toolCallId: toolExecution.toolCallId,
        toolName: toolExecution.toolName,
        content,
        details: {
          interactionId,
          interactionType: interaction.interactionType,
          responseHash: interaction.responseHash,
        },
        isError: false,
        appendIfMissing: true,
      },
    );
    return (
      `[User interaction resolved] The user answered the ${interaction.interactionType} ` +
      `request ${interactionId}. Continue the task using the answer already ` +
      'recorded in the tool result; do not ask the same question again.'
    );
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
          : new AggregateError(this._cleanupErrors, 'PiRunExecutor dispose failures');
      }
      return;
    }
    this._disposed = true;
    this._pendingInteractionToolCallIds.clear();
    /** @type {unknown[]} */
    const errors = [];

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
      throw new AggregateError(errors, 'PiRunExecutor dispose failures');
    }
  }

  /**
   * @param {unknown} err
   */
  #looksLikeUncertainSideEffect(err) {
    const msg = String(/** @type {Error} */ (err)?.message || err || '');
    return /side.?effect|tool.*uncertain|partial.*tool|mid-tool/i.test(msg);
  }

  /**
   * Fail closed unless triggering message is owned by this run/conversation/session.
   * conversationId, agentSessionId, and runId must all be present and strictly equal.
   * @param {object | null} triggering
   * @param {object} run
   */
  #assertTriggeringMessageBinding(triggering, run) {
    if (!triggering) {
      throw new Error('triggering message is required');
    }
    if (
      triggering.conversationId == null ||
      triggering.conversationId !== run.conversationId
    ) {
      throw new Error('triggering message conversationId does not match run');
    }
    if (
      triggering.agentSessionId == null ||
      triggering.agentSessionId !== run.agentSessionId
    ) {
      throw new Error('triggering message agentSessionId does not match run');
    }
    if (triggering.runId == null || triggering.runId !== run.runId) {
      throw new Error('triggering message runId does not match run');
    }
  }

  /**
   * Confirm session lock still held: renew current token (extends TTL).
   * Background renew continues; this is an explicit pre-write gate.
   * @param {string} agentSessionId
   * @returns {Promise<boolean>}
   */
  async #confirmSessionLock(agentSessionId) {
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
  async #persistAssistantMessagesFromPayload(args) {
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
      if (!text && !Array.isArray(msg.content)) continue;

      const uiEntryId = `${UI_ASSISTANT_PI_ENTRY_PREFIX}${entry.id}`;

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
            },
            piEntryId: uiEntryId,
            piEntryKind: 'assistant_ui',
          });
        } catch (err) {
          const isDup =
            /** @type {{ code?: string }} */ (err)?.code === 'ER_DUP_ENTRY' ||
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

  /**
   * @param {string} agentSessionId
   * @param {{ orgId: string, userId: string }} scope
   * @param {number} fence
   * @param {string} reason
   */
  async #markRecoveryRequired(agentSessionId, scope, fence, reason) {
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

  /**
   * @param {string} agentSessionId
   * @param {{ orgId: string, userId: string }} scope
   * @param {number} fence
   */
  async #maybeMarkRecoveryOnLockLoss(agentSessionId, scope, fence) {
    await this.#markRecoveryRequired(
      agentSessionId,
      scope,
      fence,
      RECOVERY_REASON_CODE.LEASE_LOST,
    );
  }
}

/**
 * Per-job factory. Requires modelResolver + workspaceResolver.
 * Does **not** set production worker default — inject explicitly.
 *
 * @param {{
 *   transactionManager: any,
 *   createRepositories: (db: any) => any,
 *   sessionLockManager: any,
 *   piRuntimeFactory: any,
 *   modelResolver: (agentVersion: object) => object | Promise<object>,
 *   requestAuthResolver?: (model: object, agentVersion: object) => object | Promise<object>,
 *   workspaceResolver: (agentSession: object) => string | Promise<string>,
 *   sandboxSessionProvisioner?: { ensure: (input: object) => Promise<object> },
 *   generateId: () => string,
 *   now?: () => Date,
 *   sessionAdapter?: any,
 *   projector?: PlatformEventProjector,
 *   recoveryService?: SessionRecoveryService,
 *   extensionFactories?: unknown[],
 *   extensionBundleFactory?: (runContext: object, deps: object) => unknown[],
 *   eventProjectionMode?: 'session-subscribe' | 'observability' | 'both',
 *   agentDir?: string,
 *   sessionLockRenewIntervalMs?: number,
 *   steerPollIntervalMs?: number,
 * }} opts
 * @returns {import('./run-executor.js').RunExecutorFactory}
 */
export function createPiRunExecutorFactory(opts) {
  if (typeof opts?.modelResolver !== 'function') {
    throw new Error(
      'createPiRunExecutorFactory requires modelResolver(agentVersion)',
    );
  }
  if (typeof opts?.workspaceResolver !== 'function') {
    throw new Error(
      'createPiRunExecutorFactory requires workspaceResolver(agentSession)',
    );
  }
  if (!opts.transactionManager || !opts.createRepositories) {
    throw new Error(
      'createPiRunExecutorFactory requires transactionManager and createRepositories',
    );
  }
  if (!opts.sessionLockManager || !opts.piRuntimeFactory) {
    throw new Error(
      'createPiRunExecutorFactory requires sessionLockManager and piRuntimeFactory',
    );
  }
  if (typeof opts.generateId !== 'function') {
    throw new Error('createPiRunExecutorFactory requires generateId');
  }

  return function piRunExecutorFactory(_job) {
    return new PiRunExecutor({
      transactionManager: opts.transactionManager,
      createRepositories: opts.createRepositories,
      sessionLockManager: opts.sessionLockManager,
      piRuntimeFactory: opts.piRuntimeFactory,
      modelResolver: opts.modelResolver,
      requestAuthResolver: opts.requestAuthResolver,
      workspaceResolver: opts.workspaceResolver,
      sandboxSessionProvisioner: opts.sandboxSessionProvisioner,
      generateId: opts.generateId,
      now: opts.now,
      sessionAdapter: opts.sessionAdapter,
      projector: opts.projector,
      recoveryService: opts.recoveryService,
      agentDir: opts.agentDir,
      sessionLockRenewIntervalMs: opts.sessionLockRenewIntervalMs,
      steerPollIntervalMs: opts.steerPollIntervalMs,
      extensionBundleFactory: opts.extensionBundleFactory,
      eventProjectionMode: opts.eventProjectionMode,
    });
  };
}

/**
 * Normalize result helper re-export for callers.
 */
export { normalizeExecutorResult };
