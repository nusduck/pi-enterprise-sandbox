/**
 * Agent turn runner — owns the pi-coding-agent session loop.
 * Emits SSE-compatible event objects via the provided emit callback.
 * Does not touch HTTP; run-manager owns persistence and transport.
 */
import { randomUUID } from 'node:crypto';
import {
  AuthStorage,
  ModelRegistry,
  SettingsManager,
  getAgentDir,
} from '@earendil-works/pi-coding-agent';
import {
  buildAgentSessionOptions,
  createBoundAgentSession,
} from './agent-session-factory.js';
import { createSandboxClient } from '../infrastructure/sandbox-client.js';
import { config, SKILLS_MODE } from '../config.js';
import {
  POLICY_VERSION,
  filterToolResultContent,
} from '../packages/enterprise-agent-kit/extensions/policy/index.js';
import {
  extractMessageText,
  toAgentHistoryMessages,
  toPersistableMessages,
} from '../message-helpers.js';
import {
  extractMessageAttachments,
  injectAttachmentContext,
} from '../attachment-context.js';
import {
  createSkillTools,
  SKILL_TOOL_NAMES,
} from '../packages/enterprise-agent-kit/extensions/skill-management/tool-definitions.js';
import { createSkillManager } from '../skills/manager.js';
import {
  filterProfileTools,
  resolveAgentProfile,
} from '../application/agent-profile-service.js';
import { applyContextPolicy } from '../application/context-policy-service.js';
import {
  createExtensionPackageLoader,
  inspectExtensionPackage,
} from './extension-package-loader.js';
import { createEventBridge } from './event-bridge.js';
import {
  createEnvironmentCredentialResolver,
  createMcpConnectionManager,
} from '../infrastructure/mcp-connection-manager.js';
import {
  SessionRestoreError,
  createInMemorySession,
  createNewPersistedSession,
  isForceInMemory,
  openSessionFromResume,
  persistNewEntries,
} from '../services/session-persistence.js';
import { createBudgetTracker } from '../services/budget.js';
import {
  ApprovalSuspendedError,
  waitForApproval,
  clearPendingApproval,
} from '../services/approval-waiter.js';
import {
  InputSuspendedError,
  clearPendingInput,
  registerPendingInput,
} from '../services/interaction-waiter.js';
import { summarizeToolArguments } from './tool-payload-sanitizer.js';
import {
  ModelRegistryError,
  aggregateUsageFromMessages,
  resolveModel,
  toPiModel,
} from '../services/model-registry.js';

// Public tool contract remains relative paths + opaque workspace_id. Pi SDK
// itself receives the stable logical session cwd, never the physical host path.
const AGENT_SKILL = config.SKILLS_ROOT || '/home/sandbox/skill';

/** Stable Sandbox tool names exposed through the active Agent Profile. */
export const BASE_TOOL_NAMES = [
  'read',
  'write',
  'edit',
  'apply_patch',
  'bash',
  'ls',
  'find',
  'grep',
  'submit_artifact',
  'process_start',
  'process_status',
  'process_logs',
  'process_wait',
  'process_write_stdin',
  'process_signal',
  'process_cancel',
];

export const TOOL_REGISTRY_VERSION = '2026-07-14.extension-profile.1';

/**
 * Tool allowlist for createAgentSession — includes skill tools only in development.
 * Extra MCP names can be appended by the caller after discovery.
 * @param {string} [skillsMode]
 * @param {string[]} [extraNames]
 */
export function resolveToolAllowlist(skillsMode = config.SKILLS_MODE, extraNames = []) {
  const base =
    skillsMode === SKILLS_MODE.DEVELOPMENT
      ? [...BASE_TOOL_NAMES, ...SKILL_TOOL_NAMES]
      : [...BASE_TOOL_NAMES];
  if (Array.isArray(extraNames) && extraNames.length) {
    for (const n of extraNames) {
      if (n && !base.includes(n)) base.push(n);
    }
  }
  return base;
}

/**
 * Resolve active model from the enterprise Model Registry.
 * Env MODEL_ID / MODEL_CONTEXT_WINDOW / MODEL_MAX_TOKENS remain as overrides.
 *
 * @param {string|null|undefined} [modelId]
 * @returns {import('../services/model-registry.js').ModelEntry}
 */
export function resolveActiveModel(modelId) {
  return resolveModel(modelId || config.MODEL_ID);
}

/**
 * Build a pi-ai Model object from the registry entry + runtime LLMIO config.
 * @param {import('../services/model-registry.js').ModelEntry} [entry]
 */
export function makeModel(entry) {
  const resolved = entry || resolveActiveModel();
  return toPiModel(resolved, {
    baseUrl: config.LLMIO_BASE_URL,
    apiKey: config.LLMIO_API_KEY,
  });
}

/**
 * Build the Pi SDK createAgentSession options in one place so cwd cannot drift
 * from the SessionManager/ResourceLoader contract.
 * @param {object} opts
 */
export function buildCreateAgentSessionOptions(opts) {
  return buildAgentSessionOptions(opts);
}

/**
 * Resolve conversation + sandbox session (reuse when possible).
 * @param {ReturnType<typeof createSandboxClient>} client
 * @param {string | null | undefined} conversation_id
 */
export async function resolveConversationAndSession(client, conversation_id) {
  let activeConversationId = conversation_id || null;
  let sandboxSessionId = null;
  let workspaceId = null;
  let reusedSession = false;

  if (activeConversationId) {
    try {
      const conv = await client.getConversation(activeConversationId);
      if (conv.sandbox_session_id) {
        try {
          const existing = await client.getSession(conv.sandbox_session_id);
          if (existing?.status === 'RUNNING' && existing.session_id) {
            sandboxSessionId = existing.session_id;
            workspaceId = existing.workspace_id || null;
            reusedSession = true;
            console.log(`[agent] Reusing sandbox session ${sandboxSessionId}`);
          }
        } catch {
          // session expired or missing
        }
      }
      console.log(
        `[agent] Reusing conversation ${activeConversationId} workspace_id=conv_${activeConversationId}`,
      );
    } catch {
      console.log(`[agent] Conversation ${activeConversationId} not found, will create new`);
      activeConversationId = null;
    }
  }

  if (!activeConversationId) {
    const convResp = await client.createConversation();
    activeConversationId = convResp.id;
    console.log(
      `[agent] Created conversation ${activeConversationId} workspace_id=conv_${activeConversationId}`,
    );
  }

  if (!sandboxSessionId) {
    const sessionData = await client.createSession('pi-coding-agent', {
      conversation_id: activeConversationId,
      enterprise_session_id: activeConversationId,
    });
    sandboxSessionId = sessionData.session_id;
    workspaceId = sessionData.workspace_id || null;
    try {
      await client.updateConversation(activeConversationId, {
        sandbox_session_id: sandboxSessionId,
      });
    } catch (err) {
      console.warn('[agent] Failed to bind sandbox_session_id on conversation:', err.message);
    }
    console.log(`[agent] Created sandbox session ${sandboxSessionId}`);
  }

  return {
    activeConversationId,
    workspace_id: workspaceId || (activeConversationId ? `conv_${activeConversationId}` : null),
    sessionCwd: config.SESSION_WORKSPACE_CWD,
    sandboxSessionId,
    reusedSession,
    agentSessionId: null,
  };
}

/**
 * Resolve or create the logical Pi SDK agent session for a conversation.
 * Fail-closed when a bound session cannot be restored.
 *
 * @param {ReturnType<typeof createSandboxClient>} client
 * @param {string} conversationId
 * @param {{
 *   sandboxSessionId?: string|null,
 *   workspaceId?: string|null,
 *   sessionCwd?: string|null,
 *   modelId?: string|null,
 *   emit?: (event: object) => void,
 * }} [opts]
 */
export async function resolveAgentSessionManager(client, conversationId, opts = {}) {
  const emit = typeof opts.emit === 'function' ? opts.emit : () => {};
  const sessionCwd = opts.sessionCwd || config.SESSION_WORKSPACE_CWD;

  if (isForceInMemory() || config.AGENT_FORCE_INMEMORY) {
    console.warn('[agent] AGENT_FORCE_INMEMORY set — using ephemeral SessionManager.inMemory()');
    return {
      ...createInMemorySession({ cwd: sessionCwd }),
      agentSessionId: null,
      restored: false,
      forceInMemory: true,
    };
  }

  let boundAgentSessionId = null;
  try {
    const conv = await client.getConversation(conversationId);
    boundAgentSessionId = conv?.agent_session_id || null;
  } catch {
    boundAgentSessionId = null;
  }

  if (boundAgentSessionId) {
    try {
      const resume = await client.resumeAgentSession(boundAgentSessionId);
      if (!resume?.session?.id) {
        throw new SessionRestoreError('Resume returned empty session', {
          agentSessionId: boundAgentSessionId,
          conversationId,
        });
      }
      const opened = openSessionFromResume(resume, {
        conversationId,
        cwd: sessionCwd,
      });
      console.log(
        `[agent] Restored agent session ${boundAgentSessionId} ` +
          `(${opened.persistedCount} entries) for conversation ${conversationId}`,
      );
      return {
        ...opened,
        agentSessionId: boundAgentSessionId,
        restored: true,
        forceInMemory: false,
      };
    } catch (err) {
      const message = err?.message || String(err);
      emit({
        type: 'session_restore_failed',
        conversation_id: conversationId,
        agent_session_id: boundAgentSessionId,
        error: message,
      });
      // Fail closed: never invent a silent empty session when restore fails.
      throw new SessionRestoreError(message, {
        agentSessionId: boundAgentSessionId,
        conversationId,
        cause: err,
      });
    }
  }

  // First turn: create a file-backed SessionManager and bind a new agent session row.
  const created = createNewPersistedSession({ cwd: sessionCwd });
  const header = created.sessionManager.getHeader() || {
    type: 'session',
    version: 3,
    id: created.sessionManager.getSessionId(),
    timestamp: new Date().toISOString(),
    cwd: sessionCwd,
  };
  try {
    const row = await client.createAgentSession({
      conversation_id: conversationId,
      sdk_session_id: created.sessionManager.getSessionId(),
      workspace_id: opts.workspaceId || `conv_${conversationId}`,
      sandbox_session_id: opts.sandboxSessionId || null,
      model_id: opts.modelId || config.MODEL_ID,
      session_schema_version: header.version || 3,
      header_payload: header,
    });
    console.log(
      `[agent] Created agent session ${row.id} (sdk=${row.sdk_session_id}) ` +
        `for conversation ${conversationId}`,
    );
    return {
      ...created,
      agentSessionId: row.id,
      restored: false,
      forceInMemory: false,
    };
  } catch (err) {
    created.cleanup();
    throw err;
  }
}

/**
 * @typedef {'completed'|'cancelled'|'failed'|'waiting_approval'|'waiting_input'|'budget_exceeded'|'rejected'} TurnStatus
 */

/**
 * Run one agent turn.
 *
 * @param {{
 *   messages: unknown[],
 *   conversation_id?: string|null,
 *   auth?: object|null,
 *   trace_id?: string|null,
 *   budget?: ReturnType<typeof createBudgetTracker>|null,
 *   model_id?: string|null,
 *   emit: (event: object) => void,
 *   isCancelled: () => boolean,
 *   onSessionReady?: (info: { session: object, sandboxSessionId: string, client: object }) => void,
 *   onRunReady?: (run: object) => Promise<void>|void,
 *   sandboxClient?: ReturnType<typeof createSandboxClient>,
 *   onApprovalSuspend?: (pending: object) => Promise<void>|void,
 *   onInputSuspend?: (pending: object) => Promise<void>|void,
 *   agent_profile_id?: string,
 *   preApprovedAttempt?: object|null,
 *   resume_tool_call?: object|null,
 * }} opts
 * @returns {Promise<{ status: TurnStatus, run_id?: string|null, conversation_id?: string|null, model_id?: string|null, usage?: object|null, error?: string, pending_approval?: object|null }>}
 */
export async function runAgentTurn(opts) {
  const {
    messages,
    conversation_id = null,
    auth = null,
    emit,
    isCancelled = () => false,
    onSessionReady = null,
    onApprovalSuspend = null,
    onInputSuspend = null,
    preApprovedAttempt = null,
    resume_tool_call = null,
  } = opts;

  const budget = opts.budget || createBudgetTracker();
  const trace_id = opts.trace_id || randomUUID();
  const client = opts.sandboxClient || createSandboxClient({
    traceId: trace_id,
    auth: auth || {},
  });

  emit({ type: 'trace', trace_id });

  let sandboxSessionId = null;
  let activeConversationId = null;
  let activeWorkspaceId = null;
  let activeRunId = null;
  let activeLeaseOwner = null;
  let leaseHeartbeat = null;
  let activeAgentSessionId = null;
  /** @type {null | { cleanup: () => void, sessionManager: object, agentSessionId: string|null, persistedCount: number, forceInMemory?: boolean, restored?: boolean }} */
  let sessionHandle = null;
  let assistantText = '';
  let runTerminal = false;
  /** @type {import('../services/model-registry.js').ModelEntry | null} */
  let activeModelEntry = null;
  /** @type {import('@earendil-works/pi-coding-agent').AgentSession | null} */
  let agentSession = null;
  let sessionEventBridge = null;
  /** @type {object|null} */
  let suspendedPending = null;
  let suspendedInput = null;
  /** A single in-flight terminal transition prevents competing cancel/fail paths. */
  let terminalTransition = null;
  // A resume approval is a one-shot authorization for one exact normalized
  // operation. It is consumed only after Sandbox returns approved, so a
  // changed operation cannot inherit the prior decision.
  let activePreApprovedAttempt = preApprovedAttempt;
  /** @type {Array<object>|null} */
  let sandboxToolDefinitions = null;
  const getPreApprovedAttempt = () => activePreApprovedAttempt;
  const claimPreApprovedAttempt = () => {
    const attempt = activePreApprovedAttempt;
    if (!attempt || attempt._claimed) return null;
    attempt._claimed = true;
    return attempt;
  };
  const releasePreApprovedAttempt = (attempt) => {
    if (activePreApprovedAttempt === attempt) attempt._claimed = false;
  };
  const consumePreApprovedAttempt = () => {
    activePreApprovedAttempt = null;
  };

  const persistEvent = (type, payload = {}, options = {}) => {
    if (!activeRunId) return Promise.resolve(null);
    return client
      .appendAgentEvent(activeRunId, { type, payload })
      .catch((err) => {
        console.warn(`[agent] append event ${type} failed:`, err.message);
        if (options.required) throw err;
        return null;
      });
  };

  /**
   * Close any tool whose terminal event was lost before the run boundary.
   * A normally completed run cannot prove that an executing side effect
   * succeeded, so those rows are deliberately marked unknown. Error and
   * cancellation paths use explicit failed/cancelled states instead.
   */
  const reconcileToolLedger = async (terminalStatus, reason) => {
    if (!activeRunId || typeof client.listToolExecutions !== 'function') return;
    try {
      const response = await client.listToolExecutions({ runId: activeRunId });
      const tools = Array.isArray(response)
        ? response
        : Array.isArray(response?.tools)
          ? response.tools
          : [];
      const activeTools = tools.filter((tool) =>
        ['prepared', 'waiting_approval', 'executing'].includes(String(tool?.status)),
      );
      if (!activeTools.length || typeof client.markToolTerminal !== 'function') return;

      const status =
        terminalStatus === 'cancelled'
          ? 'cancelled'
          : terminalStatus === 'failed'
            ? 'failed'
            : 'unknown';
      await Promise.all(activeTools.map(async (tool) => {
        const toolCallId = tool?.tool_call_id || tool?.toolCallId;
        if (!toolCallId) return;
        const summary = reason || `Run ended while tool was ${tool.status}`;
        try {
          await client.markToolTerminal(toolCallId, {
            status,
            summary,
            error: status === 'unknown' ? summary : null,
          });
        } catch (err) {
          // Unknown is the safest fallback if the first terminal transition
          // itself was rejected; Sandbox makes terminal transitions sticky.
          if (status !== 'unknown') {
            try {
              await client.markToolTerminal(toolCallId, {
                status: 'unknown',
                summary: `${summary}; terminal outcome could not be confirmed`,
                error: `${err?.message || err}`,
              });
            } catch (fallbackErr) {
              console.warn(
                `[agent] tool ${toolCallId} reconciliation failed:`,
                fallbackErr?.message || fallbackErr,
              );
            }
          } else {
            console.warn(
              `[agent] tool ${toolCallId} reconciliation failed:`,
              err?.message || err,
            );
          }
        }
      }));
    } catch (err) {
      // The Sandbox run terminal transition performs the same reconciliation
      // server-side. This keeps a transient Agent/Sandbox outage observable
      // without holding the turn open indefinitely here.
      console.warn('[agent] tool ledger reconciliation unavailable:', err?.message || err);
    }
  };

  const transitionTerminal = (terminalStatus, transition, reason) => {
    if (!activeRunId || runTerminal) return Promise.resolve(null);
    if (terminalTransition) return terminalTransition;
    terminalTransition = (async () => {
      try {
        await sessionEventBridge?.flush();
      } catch (err) {
        console.warn('[agent] terminal boundary persistence failed:', err?.message || err);
      }
      await reconcileToolLedger(terminalStatus, reason);
      const result = await transition();
      // Keep the local guard unset until the durable transition succeeds. If
      // every bounded completion/failure request fails, the caller can still
      // attempt the explicit failure path and the lease reaper remains able to
      // repair the run later.
      runTerminal = true;
      return result;
    })().finally(() => {
      terminalTransition = null;
    });
    return terminalTransition;
  };

  const markRunInterrupted = (reason) => transitionTerminal(
    'cancelled',
    () => client.interruptAgentRun(activeRunId, {
      reason,
      partial_text: assistantText.trim() || null,
      lease_owner: activeLeaseOwner || undefined,
    }),
    reason,
  );

  const markBudgetExceeded = async (reason) => {
    try {
      await transitionTerminal('failed', async () => {
        if (typeof client.budgetExceedAgentRun === 'function') {
          await client.budgetExceedAgentRun(activeRunId, {
            reason,
            lease_owner: activeLeaseOwner || undefined,
            usage: budget.snapshot(),
          });
        } else {
          await client.failAgentRun(activeRunId, {
            error: reason || 'budget_exceeded',
            lease_owner: activeLeaseOwner || undefined,
          });
          await persistEvent('budget_exceeded', {
            reason,
            usage: budget.snapshot(),
          });
        }
      }, reason);
    } catch (err) {
      console.warn('[agent] budget exceed mark failed:', err.message);
    }
  };

  /**
   * Complete the durable run with one bounded retry. If the response was
   * lost after the first write, the authoritative GET prevents a second
   * transition. If completion remains unavailable, fail the durable run so a
   * local ``done`` event can never leave Sandbox in Running indefinitely.
   */
  const completeAgentRunWithFallback = async (body) => {
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await client.completeAgentRun(activeRunId, body);
      } catch (err) {
        lastError = err;
        try {
          if (typeof client.getAgentRun === 'function') {
            const snapshot = await client.getAgentRun(activeRunId);
            if (['completed', 'failed', 'cancelled', 'interrupted', 'budget_exceeded']
              .includes(String(snapshot?.status))) {
              return snapshot;
            }
          }
        } catch {
          /* Retry/fallback below remains bounded. */
        }
        if (attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    }

    try {
      return await client.failAgentRun(activeRunId, {
        error: `run completion failed: ${lastError?.message || 'unknown error'}`,
        lease_owner: activeLeaseOwner || undefined,
      });
    } catch (fallbackError) {
      const terminalError = new Error(
        `Unable to persist terminal run state: ${fallbackError?.message || lastError?.message || 'unknown error'}`,
      );
      terminalError.cause = fallbackError || lastError;
      throw terminalError;
    }
  };

  const markWaitingApproval = async (pending) => {
    if (!activeRunId) return;
    try {
      if (typeof client.markAgentRunWaitingApproval === 'function') {
        await client.markAgentRunWaitingApproval(activeRunId, {
          approval_id: pending.approval_id,
          pending_approval: pending,
          lease_owner: activeLeaseOwner || undefined,
        });
      } else {
        await persistEvent('waiting_approval', {
          approval_id: pending.approval_id,
          tool_name: pending.tool_name,
          pending_approval: pending,
        });
        // Best-effort status via fail path is wrong; use interrupt-like event only
      }
    } catch (err) {
      console.warn('[agent] mark waiting_approval failed:', err.message);
    }
  };

  const markWaitingInput = async (pending) => {
    if (!activeRunId) return;
    try {
      await client.markAgentRunWaitingInput(activeRunId, {
        pending_input: pending,
        lease_owner: activeLeaseOwner || undefined,
      });
    } catch (err) {
      console.warn('[agent] mark waiting_input failed:', err.message);
      await persistEvent('waiting_input', { pending_input: pending });
    }
  };

  const securityGetMeta = () => ({
    user_id: auth?.actingUserId || null,
    tenant_id: auth?.actingOrganizationId || null,
    conversation_id: activeConversationId,
    session_id: sandboxSessionId,
    run_id: activeRunId,
    workspace_id: activeWorkspaceId || sandboxSessionId,
    workspace_key: activeWorkspaceId || sandboxSessionId,
    trace_id,
    policy_version: POLICY_VERSION,
  });

  const handleApprovalSuspend = async (pending) => {
    const enriched = {
      ...pending,
      run_id: activeRunId || pending.run_id,
      conversation_id: activeConversationId || pending.conversation_id,
      sandbox_session_id: sandboxSessionId || pending.sandbox_session_id,
      agent_session_id: activeAgentSessionId || pending.agent_session_id,
      agent_profile_id: opts.agent_profile_id || 'coding-agent',
    };
    suspendedPending = enriched;
    // Register durable waiter (survives in-process; rehydrate on restart)
    waitForApproval(enriched);
    // Persist checkpoint before releasing resources
    if (activeAgentSessionId && sessionHandle?.sessionManager) {
      try {
        await persistNewEntries({
          client,
          agentSessionId: activeAgentSessionId,
          sessionManager: sessionHandle.sessionManager,
          alreadyPersistedCount: sessionHandle.persistedCount || 0,
          modelId: config.MODEL_ID,
        });
      } catch (err) {
        console.warn('[agent] checkpoint before approval failed:', err?.message || err);
      }
    }
    await markWaitingApproval(enriched);
    if (typeof onApprovalSuspend === 'function') {
      await onApprovalSuspend(enriched);
    }
    // Release lease so waiting does not pin a worker claim
    if (activeRunId && activeLeaseOwner && typeof client.releaseAgentRun === 'function') {
      try {
        await client.releaseAgentRun(activeRunId, {
          lease_owner: activeLeaseOwner,
          status: 'waiting_approval',
        });
      } catch {
        /* best-effort */
      }
    }
  };

  const handleInputSuspend = async (pending) => {
    const enriched = {
      ...pending,
      run_id: activeRunId || pending.run_id,
      conversation_id: activeConversationId || pending.conversation_id,
      sandbox_session_id: sandboxSessionId || pending.sandbox_session_id,
      agent_session_id: activeAgentSessionId || pending.agent_session_id,
      agent_profile_id: opts.agent_profile_id || 'coding-agent',
    };
    suspendedInput = enriched;
    registerPendingInput(enriched);
    if (activeAgentSessionId && sessionHandle?.sessionManager) {
      await persistNewEntries({
        client,
        agentSessionId: activeAgentSessionId,
        sessionManager: sessionHandle.sessionManager,
        alreadyPersistedCount: sessionHandle.persistedCount || 0,
        modelId: config.MODEL_ID,
      }).catch((err) => console.warn('[agent] checkpoint before input failed:', err.message));
    }
    await markWaitingInput(enriched);
    await onInputSuspend?.(enriched);
    if (activeRunId && activeLeaseOwner) {
      await client.releaseAgentRun(activeRunId, {
        lease_owner: activeLeaseOwner,
        status: 'waiting_input',
      }).catch(() => {});
    }
  };

  const sandboxToolOptions = {
    client,
    getSessionId: () => sandboxSessionId,
    getWorkspaceKey: () => activeWorkspaceId || sandboxSessionId || 'default',
    approvalMode: config.APPROVAL_MODE,
    getMeta: securityGetMeta,
    skillRoots: config.SKILL_ROOTS,
    getPreApprovedAttempt,
    claimPreApprovedAttempt,
    releasePreApprovedAttempt,
    consumePreApprovedAttempt,
    onToolsReady: (definitions) => {
      sandboxToolDefinitions = definitions;
    },
    onApprovalSuspend: handleApprovalSuspend,
    approvalNotifier: (ev) => {
      try {
        emit(ev);
      } catch {
        /* ignore */
      }
    },
  };

  /** @type {{ reload?: () => Promise<void>, resourceLoader?: object } | null} */
  let liveAgentSession = null;

  const skillManager = createSkillManager({
    mode: config.SKILLS_MODE,
    skillRoots: config.SKILL_ROOTS,
    localAllowlist: config.SKILLS_INSTALL_LOCAL_ALLOWLIST,
    auditLogPath: config.SKILLS_AUDIT_LOG || null,
    getMeta: securityGetMeta,
    getAgentSession: () => liveAgentSession,
  });

  const skillTools = createSkillTools({
    manager: skillManager,
    getAgentSession: () => liveAgentSession,
    getMeta: securityGetMeta,
    client,
  });

  const agentProfile = resolveAgentProfile(opts.agent_profile_id || 'coding-agent');
  const packageDiagnostics = inspectExtensionPackage(agentProfile);
  emit({ type: 'extension_package_diagnostics', ...packageDiagnostics });
  const extensionToolNames = [
    ...BASE_TOOL_NAMES,
    ...(config.SKILLS_MODE === SKILLS_MODE.DEVELOPMENT
      ? skillTools.map((tool) => tool.name)
      : []),
    'mcp',
    'task_plan',
    'ask_user',
    'context_compact',
    'structured_output',
  ];
  const profileToolNames = filterProfileTools(agentProfile, extensionToolNames, {
    skillsMode: config.SKILLS_MODE,
  });
  const toolAllowlist = profileToolNames;
  const customTools = [];
  const mcpManager = createMcpConnectionManager({
    servers: config.MCP_SERVERS,
    credentialResolver: createEnvironmentCredentialResolver(),
    allowedServers: agentProfile.allowedMcpServers,
    allowedTools: agentProfile.allowedMcpTools,
    context: securityGetMeta,
  });

  try {
    if (isCancelled()) {
      return { status: 'cancelled', run_id: null, conversation_id: conversation_id || null };
    }

    const resolved = await resolveConversationAndSession(client, conversation_id);
    activeConversationId = resolved.activeConversationId;
    sandboxSessionId = resolved.sandboxSessionId;
    activeWorkspaceId = resolved.workspace_id;

    if (isCancelled()) {
      return {
        status: 'cancelled',
        run_id: null,
        conversation_id: activeConversationId,
      };
    }

    // Registry-driven capabilities (context window, max output, tool/reasoning flags).
    activeModelEntry = resolveActiveModel(opts.model_id || config.MODEL_ID);
    const activeModelId = activeModelEntry.model_id;

    if (isCancelled()) {
      return {
        status: 'cancelled',
        run_id: null,
        conversation_id: activeConversationId,
      };
    }

    try {
      const leaseOwner = `agent_${trace_id.slice(0, 12)}`;
      const run = opts.resume_existing_run && opts.run_id
        ? await client.claimAgentRun(opts.run_id, {
            lease_owner: leaseOwner,
            lease_seconds: 300,
          })
        : await client.createAgentRun({
            run_id: opts.run_id || undefined,
            conversation_id: activeConversationId,
            sandbox_session_id: sandboxSessionId,
            workspace_id: activeWorkspaceId,
            model_id: activeModelId,
            lease_owner: leaseOwner,
            lease_seconds: 300,
          });
      if (!run?.run_id) {
        throw new Error('Sandbox did not return a durable run_id');
      }
      activeRunId = run.run_id;
      activeLeaseOwner = run.lease_owner || leaseOwner;
      if (isCancelled()) {
        runTerminal = true;
        await client.failAgentRun(run.run_id, {
          error: 'run initialization cancelled',
          lease_owner: activeLeaseOwner || undefined,
        }).catch(() => {});
        return {
          status: 'cancelled',
          run_id: activeRunId,
          conversation_id: activeConversationId,
        };
      }
      await opts.onRunReady?.(run);
      if (typeof client.renewAgentRunLease === 'function') {
        leaseHeartbeat = setInterval(() => {
          client.renewAgentRunLease(activeRunId, {
            lease_owner: activeLeaseOwner,
            lease_seconds: 300,
          }).catch((err) => {
            console.warn('[agent] run lease heartbeat failed:', err?.message || err);
          });
        }, 60_000);
        leaseHeartbeat.unref?.();
      }
    } catch (err) {
      throw new Error(`Failed to create durable agent run: ${err.message}`, {
        cause: err,
      });
    }

    emit({
      type: 'session',
      session_id: sandboxSessionId,
      workspace_id: resolved.workspace_id || `conv_${activeConversationId}`,
      conversation_id: activeConversationId,
      session_reused: resolved.reusedSession,
      trace_id,
      run_id: activeRunId,
      model_id: activeModelId,
      model: {
        provider: activeModelEntry.provider,
        model_id: activeModelId,
        context_window: activeModelEntry.context_window,
        max_output_tokens: activeModelEntry.max_output_tokens,
        supports_tool_call: activeModelEntry.supports_tool_call,
        supports_reasoning: activeModelEntry.supports_reasoning,
        thinking_levels: activeModelEntry.thinking_levels,
      },
      policy_version: POLICY_VERSION,
      approval_mode: config.APPROVAL_MODE,
      skills_mode: config.SKILLS_MODE,
    });
    if (activeRunId) {
      await persistEvent('session', {
        session_id: sandboxSessionId,
        conversation_id: activeConversationId,
        trace_id,
      });
    }

    if (isCancelled()) {
      await markRunInterrupted('cancelled');
      return {
        status: 'cancelled',
        run_id: activeRunId,
        conversation_id: activeConversationId,
      };
    }

    // Resolve / restore logical Pi SDK session (one per conversation).
    sessionHandle = await resolveAgentSessionManager(client, activeConversationId, {
      sandboxSessionId,
      workspaceId: resolved.workspace_id || `conv_${activeConversationId}`,
      sessionCwd: resolved.sessionCwd,
      modelId: activeModelId,
      emit,
    });
    activeAgentSessionId = sessionHandle.agentSessionId;
    let persistedEntryCount = sessionHandle.persistedCount || 0;

    const authStorage = AuthStorage.create();
    const modelRegistry = ModelRegistry.create(authStorage);
    if (config.LLMIO_API_KEY) {
      await authStorage.set(activeModelEntry.provider || 'llmio', config.LLMIO_API_KEY);
    }

    const sessionCwd = resolved.sessionCwd || config.SESSION_WORKSPACE_CWD;
    const settingsManager = applyContextPolicy(
      SettingsManager.create(sessionCwd, getAgentDir()),
      agentProfile.contextPolicy,
    );
    const emitExtensionEvent = (event) => {
      emit(event);
      if (activeRunId && event?.type) {
        void persistEvent(event.type, event).catch((error) => {
          console.warn('[agent] extension event persistence failed:', error.message);
        });
      }
    };
    const { resourceLoader } = await createExtensionPackageLoader({
      profile: agentProfile,
      diagnostics: packageDiagnostics,
      cwd: sessionCwd,
      agentDir: getAgentDir(),
      settingsManager,
      kitOptions: {
        sandboxToolOptions,
        policyOptions: {
          getMeta: securityGetMeta,
          approvalMode: () => config.APPROVAL_MODE,
          auditSink: (event) => emitExtensionEvent({ type: 'tool_policy_decision', ...event }),
        },
        extraSkillPaths: [AGENT_SKILL],
        emit: emitExtensionEvent,
        getMeta: securityGetMeta,
        mcpManager,
        approvalMode: config.APPROVAL_MODE,
        getPreApprovedAttempt,
        claimPreApprovedAttempt,
        releasePreApprovedAttempt,
        consumePreApprovedAttempt,
        onApprovalSuspend: handleApprovalSuspend,
        onInputSuspend: handleInputSuspend,
        createApproval: (request) =>
          client.createApproval({
            session_id: sandboxSessionId,
            ...request,
          }),
        projectTaskPlan: (projection) =>
          activeRunId ? client.replaceTaskPlan(activeRunId, projection) : Promise.resolve(null),
        productPrompt: config.PRODUCT_SYSTEM_PROMPT,
        logicalCwd: config.SESSION_WORKSPACE_CWD,
        skillsMode: config.SKILLS_MODE,
        skillTools,
      },
    });

    const piModel = makeModel(activeModelEntry);
    const requestUiInteraction = async (interactionType, payload = {}) => {
      const pending = {
        interaction_id: `interaction_${randomUUID()}`,
        interaction_type: interactionType,
        title: payload.title || 'Input required',
        message: payload.message || payload.placeholder || null,
        options: payload.options || null,
        source: 'extension_ui',
        ...securityGetMeta(),
      };
      emitExtensionEvent({ type: 'interaction_requested', durable: true, ...pending });
      await handleInputSuspend(pending);
      throw new InputSuspendedError(pending);
    };
    const interactionManager = {
      input: (payload) => requestUiInteraction('input', payload),
      select: (payload) => requestUiInteraction('select', payload),
      confirm: (payload) => requestUiInteraction('confirm', payload),
      editor: (payload) => requestUiInteraction('editor', payload),
      custom: (payload) => requestUiInteraction('custom', payload),
    };
    const { session } = await createBoundAgentSession({
      model: piModel,
      tools: toolAllowlist,
      customTools,
      // Logical session cwd matches Sandbox's workspace contract. Physical
      // access remains isolated behind the relative-path sandbox tools.
      sessionCwd,
      sessionManager: sessionHandle.sessionManager,
      authStorage,
      modelRegistry,
      resourceLoader,
      settingsManager,
      sessionStartEvent: {
        type: 'session_start',
        reason: sessionHandle.restored ? 'resume' : 'startup',
      },
      runId: activeRunId,
      conversationId: activeConversationId,
      workspaceId: activeWorkspaceId,
      emit,
      interactionManager,
      abortHandler: () => {
        if (agentSession && typeof agentSession.abort === 'function') {
          agentSession.abort();
        }
      },
      shutdownHandler: () => {
        if (agentSession && typeof agentSession.abort === 'function') {
          agentSession.abort();
        }
      },
    });
    agentSession = session;
    liveAgentSession = session;

    // Surface agent session binding on the session event stream.
    if (activeAgentSessionId) {
      emit({
        type: 'agent_session',
        agent_session_id: activeAgentSessionId,
        conversation_id: activeConversationId,
        restored: Boolean(sessionHandle.restored),
        entry_count: persistedEntryCount,
      });
    }

    const flushSessionEntries = async () => {
      if (!activeAgentSessionId || !sessionHandle?.sessionManager) return;
      try {
        persistedEntryCount = await persistNewEntries({
          client,
          agentSessionId: activeAgentSessionId,
          sessionManager: sessionHandle.sessionManager,
          alreadyPersistedCount: persistedEntryCount,
          modelId: activeModelId,
        });
      } catch (err) {
        console.warn('[agent] Failed to live-persist session entries:', err?.message || err);
      }
    };

    /**
     * Collect token/cost usage from the live SDK session and persist on the run.
     * @returns {import('../services/model-registry.js').TokenUsage | null}
     */
    const collectRunUsage = () => {
      if (!activeModelEntry) return null;
      try {
        const msgs = session?.agent?.state?.messages || [];
        return aggregateUsageFromMessages(msgs, activeModelEntry);
      } catch {
        return aggregateUsageFromMessages([], activeModelEntry);
      }
    };

    if (typeof onSessionReady === 'function') {
      onSessionReady({ session, sandboxSessionId, client });
    }

    const allMessages = Array.isArray(messages) ? messages : [];
    let priorMessages = allMessages.slice(0, -1);
    let lastMsg = allMessages[allMessages.length - 1];
    // Prefer full SDK session restore over last-40 plain-text injection.
    // Only inject text history for legacy conversations with no agent session yet
    // (first bind after upgrade) or force-inMemory rollback mode.
    const sdkHasHistory =
      sessionHandle?.restored &&
      (sessionHandle.sessionManager?.getEntries?.()?.length || 0) > 0;
    if (!sdkHasHistory) {
      const history = toAgentHistoryMessages(
        resume_tool_call ? allMessages : priorMessages,
      );
      if (history.length > 0) {
        session.agent.state.messages = history;
        console.log(
          `[agent] Injected ${history.length} prior text message(s) ` +
            `(no restored SDK session history)`,
        );
      }
    } else {
      console.log(
        `[agent] Using restored SDK session context ` +
          `(${sessionHandle.sessionManager.getEntries().length} entries); ` +
          `skipping plain-text history injection`,
      );
    }

    const enforceBudgetOrAbort = async (checkResult) => {
      if (!checkResult?.exceeded) {
        if (budget.consumeNearWarning()) {
          const hint =
            'Budget nearly exhausted. Converge: finish the current task, avoid new tools, summarize results.';
          emit({
            type: 'budget_warning',
            usage: budget.snapshot(),
            limits: budget.limits,
            message: hint,
          });
          try {
            if (session && typeof session.steer === 'function') {
              await session.steer(hint);
            }
          } catch {
            /* best-effort converge hint */
          }
        }
        return false;
      }
      const reason = checkResult.reason || 'budget_exceeded';
      emit({
        type: 'budget_exceeded',
        reason,
        usage: checkResult.usage || budget.snapshot(),
        limits: budget.limits,
      });
      try {
        if (session && typeof session.abort === 'function') session.abort();
      } catch {
        /* ignore */
      }
      await markBudgetExceeded(reason);
      return true;
    };

    sessionEventBridge = createEventBridge({
      session,
      emit,
      persistEvent,
      budget,
      enforceBudgetOrAbort,
      flushSessionEntries,
      isCancelled,
      onToken: (text) => {
        assistantText += text;
      },
    });

    let resumePromptText = null;
    if (resume_tool_call?.approval_id) {
      const replayTool = Array.isArray(sandboxToolDefinitions)
        ? sandboxToolDefinitions.find(
            (tool) => tool?.name === resume_tool_call.tool_name,
          )
        : null;

      if (replayTool && resume_tool_call.tool_call_id) {
        const replayId = String(resume_tool_call.tool_call_id);
        const replayName = String(resume_tool_call.tool_name || 'tool');
        const replayArgs = summarizeToolArguments(
          replayName,
          resume_tool_call.params || {},
        );
        let replayResult;
        const replayStart = {
          type: 'tool_start',
          id: replayId,
          name: replayName,
          args: replayArgs,
          approval_replay: true,
        };
        emit(replayStart);
        await persistEvent('tool_start', replayStart);
        try {
          // Execute the exact approved operation with the original tool-call
          // ID. The ledger can then transition the parked row from
          // waiting_approval → executing → terminal without a new
          // model-generated attempt.
          replayResult = await replayTool.execute(
            replayId,
            resume_tool_call.params || {},
            undefined,
            undefined,
            undefined,
          );
        } catch (err) {
          if (err instanceof ApprovalSuspendedError || err?.name === 'ApprovalSuspendedError') {
            throw err;
          }
          replayResult = {
            content: [{ type: 'text', text: `Error: ${err?.message || String(err)}` }],
            details: { isError: true },
            isError: true,
          };
        }
        const filtered = filterToolResultContent(replayResult?.content || []);
        const resultText = filtered.content
          .filter((part) => part?.type === 'text' && part.text)
          .map((part) => String(part.text))
          .join('\n')
          .slice(0, 20_000);
        const safeReplayResult = {
          ...(replayResult || {}),
          content: filtered.content,
        };
        const replayError = Boolean(replayResult?.isError);
        const replayEnd = {
          type: 'tool_end',
          id: replayId,
          name: replayName,
          result: safeReplayResult,
          isError: replayError,
          approval_replay: true,
        };
        emit(replayEnd);
        await persistEvent('tool_end', replayEnd);
        resumePromptText =
          `[system] Approval ${resume_tool_call.approval_id} granted. ` +
          `The original ${replayName} tool call was executed exactly once with ` +
          `the approved arguments. Its result${replayError ? ' (error)' : ''} is:\n` +
          `${resultText || '(no textual output)'}` +
          '\nContinue the task without reissuing this same tool call.';
      } else {
        // MCP/other extension approvals do not expose a local definition;
        // preserve the model-mediated fallback for those tools.
        resumePromptText =
          `[system] Approval ${resume_tool_call.approval_id} granted for tool ` +
          `\`${resume_tool_call.tool_name}\`. Re-execute that tool with the same arguments and continue.`;
      }
    }

    if (resumePromptText) {
      // Keep the original user turn in legacy text history, but make the
      // replay result the only new prompt. This prevents the model from
      // generating another copy of the approved tool call.
      priorMessages = allMessages;
      lastMsg = { role: 'user', content: resumePromptText };
    }

    if (lastMsg) {
      // ADR §4.5: explicit current-turn attachment context (no uploads/ scan)
      const turnAttachments = extractMessageAttachments(lastMsg);
      const rawText = extractMessageText(lastMsg).trim();
      const text = injectAttachmentContext(rawText, turnAttachments);
      if (turnAttachments.length) {
        await persistEvent('user_attachments', {
          attachments: turnAttachments,
          count: turnAttachments.length,
        });
      }
      if (text) {
        await persistEvent('user_message', {
          text: text.slice(0, 4000),
          attachment_count: turnAttachments.length,
        });
        if (isCancelled()) {
          await markRunInterrupted('cancelled');
          return {
            status: 'cancelled',
            run_id: activeRunId,
            conversation_id: activeConversationId,
          };
        }
        const stepCheck = budget.recordStep();
        if (await enforceBudgetOrAbort(stepCheck)) {
          emit({ type: 'done', status: 'budget_exceeded' });
          emit({ type: 'session_closed', session_id: sandboxSessionId });
          return {
            status: 'budget_exceeded',
            run_id: activeRunId,
            conversation_id: activeConversationId,
            error: stepCheck.reason || 'budget_exceeded',
          };
        }
        // Duration check before prompt
        const dur = budget.check();
        if (await enforceBudgetOrAbort(dur)) {
          emit({ type: 'done', status: 'budget_exceeded' });
          emit({ type: 'session_closed', session_id: sandboxSessionId });
          return {
            status: 'budget_exceeded',
            run_id: activeRunId,
            conversation_id: activeConversationId,
            error: dur.reason || 'budget_exceeded',
          };
        }
        await session.prompt(text);
      }
    }

    // Boundary persistence is drainable: tool_end/token batches must reach
    // the durable ledger before the run can be completed.
    await sessionEventBridge.flush();
    // Persist any remaining SDK entries after the turn (assistant/tool/compaction).
    await flushSessionEntries();

    if (suspendedPending) {
      // Resources already released in handleApprovalSuspend; do not complete run.
      emit({
        type: 'run_status',
        status: 'waiting_approval',
        approval_id: suspendedPending.approval_id,
      });
      emit({ type: 'session_closed', session_id: sandboxSessionId });
      return {
        status: 'waiting_approval',
        run_id: activeRunId,
        conversation_id: activeConversationId,
        pending_approval: suspendedPending,
      };
    }

    if (suspendedInput) {
      emit({
        type: 'run_status',
        status: 'waiting_input',
        interaction_id: suspendedInput.interaction_id,
      });
      emit({ type: 'session_closed', session_id: sandboxSessionId });
      return {
        status: 'waiting_input',
        run_id: activeRunId,
        conversation_id: activeConversationId,
        pending_input: suspendedInput,
      };
    }

    if (isCancelled()) {
      await markRunInterrupted('cancelled');
      emit({ type: 'session_closed', session_id: sandboxSessionId });
      return {
        status: 'cancelled',
        run_id: activeRunId,
        conversation_id: activeConversationId,
      };
    }

    const finalBudget = budget.check();
    if (finalBudget.exceeded) {
      await markBudgetExceeded(finalBudget.reason);
      emit({
        type: 'budget_exceeded',
        reason: finalBudget.reason,
        usage: finalBudget.usage,
      });
      emit({ type: 'done', status: 'budget_exceeded' });
      emit({ type: 'session_closed', session_id: sandboxSessionId });
      return {
        status: 'budget_exceeded',
        run_id: activeRunId,
        conversation_id: activeConversationId,
        error: finalBudget.reason || 'budget_exceeded',
      };
    }

    try {
      const persisted = toPersistableMessages(allMessages);
      if (assistantText.trim()) {
        persisted.push({ role: 'assistant', content: assistantText.trim() });
      }
      await client.updateConversation(activeConversationId, {
        messages: persisted,
        sandbox_session_id: sandboxSessionId,
        agent_session_id: activeAgentSessionId || undefined,
        interrupted: false,
        last_run_id: activeRunId || undefined,
      });
    } catch (err) {
      console.warn('[agent] Failed to persist conversation messages:', err.message);
    }

    const runUsage = collectRunUsage();
    if (runUsage) {
      emit({
        type: 'usage',
        model_id: runUsage.model_id,
        provider: runUsage.provider,
        input_tokens: runUsage.input_tokens,
        output_tokens: runUsage.output_tokens,
        cache_read_tokens: runUsage.cache_read_tokens,
        cache_write_tokens: runUsage.cache_write_tokens,
        total_tokens: runUsage.total_tokens,
        cost: runUsage.cost,
      });
      await persistEvent('usage', runUsage);
    }

    if (activeRunId && !runTerminal) {
      let terminalResult = null;
      try {
        terminalResult = await transitionTerminal(
          'completed',
          () => completeAgentRunWithFallback({
            lease_owner: activeLeaseOwner || undefined,
            model_id: activeModelEntry?.model_id || activeModelId,
            usage: runUsage || undefined,
          }),
          'run completed',
        );
      } catch (err) {
        console.warn('[agent] complete run failed:', err.message);
        if (activeRunId && !runTerminal) {
          try {
            await transitionTerminal(
              'failed',
              () => client.failAgentRun(activeRunId, {
                error: `terminal completion failed: ${err.message}`,
                lease_owner: activeLeaseOwner || undefined,
              }),
              `terminal completion failed: ${err.message}`,
            );
          } catch (fallbackErr) {
            console.warn('[agent] terminal failure fallback failed:', fallbackErr?.message || fallbackErr);
          }
        }
        await persistEvent('terminal_transition_failed', {
          status: 'failed',
          error: err.message,
        });
        emit({ type: 'error', message: err.message, code: 'terminal_transition_failed' });
        emit({ type: 'done', status: 'failed' });
        emit({ type: 'session_closed', session_id: sandboxSessionId });
        return {
          status: 'failed',
          run_id: activeRunId,
          conversation_id: activeConversationId,
          error: err.message,
        };
      }
      const finalStatus = String(terminalResult?.status || 'completed');
      if (finalStatus !== 'completed') {
        emit({ type: 'done', status: finalStatus });
        emit({ type: 'session_closed', session_id: sandboxSessionId });
        return {
          status: finalStatus,
          run_id: activeRunId,
          conversation_id: activeConversationId,
          error: terminalResult?.error || 'Run terminalized with a non-success status',
        };
      }
    }

    emit({ type: 'done' });
    emit({ type: 'session_closed', session_id: sandboxSessionId });
    return {
      status: 'completed',
      run_id: activeRunId,
      conversation_id: activeConversationId,
      model_id: activeModelEntry?.model_id || null,
      usage: runUsage,
    };
  } catch (err) {
    // Recoverable approval: park run, release resources, no terminal done.
    if (err instanceof ApprovalSuspendedError || err?.name === 'ApprovalSuspendedError') {
      const pending = err.pending || suspendedPending;
      if (pending && !suspendedPending) {
        try {
          await handleApprovalSuspend(pending);
        } catch {
          /* already best-effort */
        }
      }
      const p = suspendedPending || pending;
      console.log(
        `[agent] Run parked waiting_approval approval_id=${p?.approval_id} run=${activeRunId}`,
      );
      emit({
        type: 'run_status',
        status: 'waiting_approval',
        approval_id: p?.approval_id,
      });
      // Do not emit done — client should keep the run open for resume.
      emit({ type: 'session_closed', session_id: sandboxSessionId });
      return {
        status: 'waiting_approval',
        run_id: activeRunId,
        conversation_id: activeConversationId,
        pending_approval: p,
      };
    }
    if (err instanceof InputSuspendedError || err?.name === 'InputSuspendedError') {
      const pending = err.pending || suspendedInput;
      if (pending && !suspendedInput) await handleInputSuspend(pending).catch(() => {});
      const current = suspendedInput || pending;
      emit({
        type: 'run_status',
        status: 'waiting_input',
        interaction_id: current?.interaction_id,
      });
      emit({ type: 'session_closed', session_id: sandboxSessionId });
      return {
        status: 'waiting_input',
        run_id: activeRunId,
        conversation_id: activeConversationId,
        pending_input: current,
      };
    }

    console.error('[agent] Error:', err);
    const isRestoreFail =
      err instanceof SessionRestoreError || err?.name === 'SessionRestoreError';
    const isModelFail =
      err instanceof ModelRegistryError || err?.name === 'ModelRegistryError';
    if (isRestoreFail) {
      emit({
        type: 'error',
        message: err.message || String(err),
        code: 'session_restore_failed',
      });
    } else if (isModelFail) {
      emit({
        type: 'error',
        message: err.message || String(err),
        code: err.code || 'model_registry_error',
        model_id: err.modelId || null,
      });
    } else {
      emit({ type: 'error', message: err.message || String(err) });
    }
    // An exception can arrive immediately after tool_end. Drain its durable
    // boundary before marking the run failed so the ledger cannot lag status.
    try {
      await sessionEventBridge?.flush();
    } catch (flushErr) {
      console.warn('[agent] failed to drain event bridge:', flushErr?.message || flushErr);
    }
    if (activeRunId && !runTerminal) {
      try {
        await transitionTerminal(
          'failed',
          () => client.failAgentRun(activeRunId, {
            error: err.message,
            lease_owner: activeLeaseOwner || undefined,
          }),
          err.message || 'run failed',
        );
      } catch {
        try {
          await markRunInterrupted('error');
        } catch (interruptErr) {
          console.warn(
            '[agent] interrupt fallback failed; periodic lease reaper will reconcile:',
            interruptErr?.message || interruptErr,
          );
        }
      }
    }
    emit({ type: 'done' });
    emit({ type: 'session_closed', session_id: sandboxSessionId });
    return {
      status: 'failed',
      run_id: activeRunId,
      conversation_id: activeConversationId,
      error: err.message || String(err),
    };
  } finally {
    if (leaseHeartbeat) clearInterval(leaseHeartbeat);
    leaseHeartbeat = null;
    try {
      await sessionEventBridge?.dispose();
    } catch (err) {
      console.warn('[agent] event bridge dispose failed:', err?.message || err);
    }
    sessionEventBridge = null;
    // Best-effort: cancel in-flight sandbox work if cancelled mid-turn
    if (isCancelled() && sandboxSessionId && !suspendedPending) {
      client.cancelActiveExecution(sandboxSessionId).catch(() => {});
      try {
        await markRunInterrupted('cancelled');
      } catch (err) {
        console.warn(
          '[agent] cancellation transition failed; periodic lease reaper will reconcile:',
          err?.message || err,
        );
      }
    }
    // Drop temp JSONL materialization; durable state is in sandbox DB.
    // Always cleanup on suspended states too — resources must be released.
    if (sessionHandle && typeof sessionHandle.cleanup === 'function') {
      try {
        sessionHandle.cleanup();
      } catch {
        /* ignore */
      }
    }
    sessionHandle = null;
    agentSession = null;
    liveAgentSession = null;
  }
}

/**
 * Resume a parked waiting_approval run after operator approve/reject.
 *
 * @param {{
 *   conversation_id?: string|null,
 *   auth?: object|null,
 *   trace_id?: string|null,
 *   sandbox_run_id?: string|null,
 *   pending_approval: object,
 *   decision: 'approved'|'rejected',
 *   decision_reason?: string|null,
 *   budget?: ReturnType<typeof createBudgetTracker>|null,
 *   messages?: unknown[],
 *   emit: (event: object) => void,
 *   isCancelled?: () => boolean,
 *   onSessionReady?: (info: object) => void,
 *   onApprovalSuspend?: (pending: object) => Promise<void>|void,
 * }} opts
 */
export async function resumeAgentTurnAfterApproval(opts) {
  const {
    conversation_id = null,
    auth = null,
    pending_approval: pending,
    decision,
    decision_reason = null,
    emit,
    isCancelled = () => false,
    onSessionReady = null,
    onApprovalSuspend = null,
    onInputSuspend = null,
    messages = [],
  } = opts;

  if (!pending?.approval_id) {
    return {
      status: 'failed',
      error: 'pending_approval.approval_id required',
      conversation_id,
    };
  }

  const budget = opts.budget || createBudgetTracker();
  const trace_id = opts.trace_id || randomUUID();
  const client = createSandboxClient({
    traceId: trace_id,
    auth: auth || {},
  });

  emit({ type: 'trace', trace_id });
  emit({
    type: 'approval_decision',
    approval_id: pending.approval_id,
    decision,
    reason: decision_reason,
  });

  // Reject path: mark tool failed, continue conversation with rejection context.
  if (decision === 'rejected') {
    if (pending.tool_call_id && typeof client.markToolTerminal === 'function') {
      try {
        await client.markToolTerminal(pending.tool_call_id, {
          status: 'failed',
          summary: decision_reason || 'Rejected by operator',
          error: decision_reason || 'Rejected by operator',
        });
      } catch {
        /* best-effort */
      }
    }
    if (opts.sandbox_run_id && typeof client.failAgentRun === 'function') {
      try {
        await client.failAgentRun(opts.sandbox_run_id, {
          error: decision_reason || 'approval rejected',
        });
      } catch {
        /* ignore */
      }
    }
    clearPendingApproval(pending.approval_id);
    emit({ type: 'done', status: 'rejected' });
    return {
      status: 'rejected',
      run_id: opts.sandbox_run_id || null,
      conversation_id: conversation_id || pending.conversation_id || null,
      error: decision_reason || 'approval rejected',
    };
  }

  // Approved: re-run the deferred tool then continue the agent turn.
  const preApprovedAttempt =
    pending.idempotency_key && pending.operation_fingerprint
      ? {
          approval_id: pending.approval_id,
          idempotency_key: pending.idempotency_key,
          operation_fingerprint: pending.operation_fingerprint,
          tool_name: pending.tool_name,
          run_id: pending.run_id || opts.sandbox_run_id || null,
          sandbox_session_id: pending.sandbox_session_id || null,
        }
      : null;
  // Also decide on sandbox if not already (idempotent)
  try {
    if (typeof client.decideApproval === 'function') {
      await client.decideApproval(pending.approval_id, 'approve').catch(() => {});
    }
  } catch {
    /* ignore */
  }

  const prior = Array.isArray(messages) ? messages : [];

  return runAgentTurn({
    run_id: opts.sandbox_run_id || undefined,
    resume_existing_run: Boolean(opts.sandbox_run_id),
    messages: prior,
    conversation_id: conversation_id || pending.conversation_id || null,
    auth,
    trace_id,
    budget,
    emit,
    isCancelled,
    onSessionReady,
    onApprovalSuspend,
    onInputSuspend,
    agent_profile_id: opts.agent_profile_id,
    preApprovedAttempt,
    resume_tool_call: pending,
  });
}

/** Resume a parked waiting_input run with a user response. */
export async function resumeAgentTurnAfterInput(opts) {
  const pending = opts.pending_input;
  if (!pending?.interaction_id) {
    return { status: 'failed', error: 'pending_input.interaction_id required' };
  }
  const response = opts.response;
  const display = typeof response === 'string' ? response : JSON.stringify(response);
  opts.emit({
    type: 'interaction_resolved',
    interaction_id: pending.interaction_id,
    response,
  });
  clearPendingInput(pending.interaction_id);
  const messages = [
    ...(Array.isArray(opts.messages) ? opts.messages : []),
    {
      role: 'user',
      content:
        `[system] User response for interaction ${pending.interaction_id} ` +
        `(${pending.title || pending.interaction_type}): ${display}. Continue the task.`,
    },
  ];
  return runAgentTurn({
    run_id: opts.sandbox_run_id || undefined,
    resume_existing_run: Boolean(opts.sandbox_run_id),
    messages,
    conversation_id: opts.conversation_id || pending.conversation_id || null,
    auth: opts.auth,
    trace_id: opts.trace_id,
    budget: opts.budget,
    emit: opts.emit,
    isCancelled: opts.isCancelled,
    onSessionReady: opts.onSessionReady,
    onApprovalSuspend: opts.onApprovalSuspend,
    onInputSuspend: opts.onInputSuspend,
    agent_profile_id: opts.agent_profile_id,
  });
}
