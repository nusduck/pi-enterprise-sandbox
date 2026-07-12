/**
 * Agent turn runner — owns the pi-coding-agent session loop.
 * Emits SSE-compatible event objects via the provided emit callback.
 * Does not touch HTTP; run-manager owns persistence and transport.
 */
import { randomUUID } from 'node:crypto';
import {
  createAgentSession,
  AuthStorage,
  ModelRegistry,
  DefaultResourceLoader,
  SettingsManager,
  getAgentDir,
} from '@earendil-works/pi-coding-agent';
import { createSandboxTools } from './sandbox-tools.js';
import { createSandboxClient } from './services/sandbox-client.js';
import { config, SKILLS_MODE, composeSystemPrompt, PLATFORM_SYSTEM_PROMPT_LAYER } from './config.js';
import { mapSdkEventToSse } from './services/sdk-sse-map.js';
import {
  createSandboxSecurityExtension,
  POLICY_VERSION,
} from './extensions/sandbox-security.js';
import {
  extractMessageText,
  toAgentHistoryMessages,
  toPersistableMessages,
} from './message-helpers.js';
import {
  extractMessageAttachments,
  injectAttachmentContext,
} from './attachment-context.js';
import {
  createToolRegistry,
  TOOL_CATEGORY,
  TOOL_REGISTRY_VERSION,
  BUILTIN_TOOLS,
} from './tool-registry.js';
import { createMcpTools } from './mcp-tools.js';
import { createSkillTools, SKILL_TOOL_NAMES } from './skills/tools.js';
import { createSkillManager } from './skills/manager.js';
import {
  SessionRestoreError,
  createInMemorySession,
  createNewPersistedSession,
  isForceInMemory,
  openSessionFromResume,
  persistNewEntries,
} from './services/session-persistence.js';
import { createBudgetTracker } from './services/budget.js';
import {
  ApprovalSuspendedError,
  waitForApproval,
  clearPendingApproval,
} from './services/approval-waiter.js';
import {
  ModelRegistryError,
  aggregateUsageFromMessages,
  resolveModel,
  toPiModel,
} from './services/model-registry.js';

// Public tool contract remains relative paths + opaque workspace_id. Pi SDK
// itself receives the stable logical session cwd, never the physical host path.
const AGENT_SKILL = config.SKILLS_ROOT || '/home/sandbox/skill';

/** Base sandbox tool allowlist (always present). Derived from ToolRegistry builtins. */
export const BASE_TOOL_NAMES = [
  ...BUILTIN_TOOLS[TOOL_CATEGORY.SANDBOX],
  ...BUILTIN_TOOLS[TOOL_CATEGORY.ARTIFACT],
  ...BUILTIN_TOOLS[TOOL_CATEGORY.PROCESS],
];

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

export { TOOL_REGISTRY_VERSION };

/**
 * Resolve active model from the enterprise Model Registry.
 * Env MODEL_ID / MODEL_CONTEXT_WINDOW / MODEL_MAX_TOKENS remain as overrides.
 *
 * @param {string|null|undefined} [modelId]
 * @returns {import('./services/model-registry.js').ModelEntry}
 */
export function resolveActiveModel(modelId) {
  return resolveModel(modelId || config.MODEL_ID);
}

/**
 * Build a pi-ai Model object from the registry entry + runtime LLMIO config.
 * @param {import('./services/model-registry.js').ModelEntry} [entry]
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
  return {
    model: opts.model,
    tools: opts.tools,
    customTools: opts.customTools,
    cwd: opts.sessionCwd,
    sessionManager: opts.sessionManager,
    authStorage: opts.authStorage,
    modelRegistry: opts.modelRegistry,
    resourceLoader: opts.resourceLoader,
    settingsManager: opts.settingsManager,
  };
}

/**
 * Resolve conversation + sandbox session (reuse when possible).
 * @param {ReturnType<typeof createSandboxClient>} client
 * @param {string | null | undefined} conversation_id
 */
export async function resolveConversationAndSession(client, conversation_id) {
  let activeConversationId = conversation_id || null;
  let sandboxSessionId = null;
  let reusedSession = false;

  if (activeConversationId) {
    try {
      const conv = await client.getConversation(activeConversationId);
      if (conv.sandbox_session_id) {
        try {
          const existing = await client.getSession(conv.sandbox_session_id);
          if (existing?.status === 'RUNNING' && existing.session_id) {
            sandboxSessionId = existing.session_id;
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
    workspace_id: activeConversationId ? `conv_${activeConversationId}` : null,
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
 * @typedef {'completed'|'cancelled'|'failed'|'waiting_approval'|'budget_exceeded'|'rejected'} TurnStatus
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
 *   onApprovalSuspend?: (pending: object) => Promise<void>|void,
 *   preApprovedIds?: Set<string>|null,
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
    preApprovedIds = null,
  } = opts;

  const budget = opts.budget || createBudgetTracker();
  const trace_id = opts.trace_id || randomUUID();
  const client = createSandboxClient({
    traceId: trace_id,
    auth: auth || {},
  });

  emit({ type: 'trace', trace_id });

  let sandboxSessionId = null;
  let activeConversationId = null;
  let activeRunId = null;
  let activeLeaseOwner = null;
  let activeAgentSessionId = null;
  /** @type {null | { cleanup: () => void, sessionManager: object, agentSessionId: string|null, persistedCount: number, forceInMemory?: boolean, restored?: boolean }} */
  let sessionHandle = null;
  const pendingToolArgs = new Map();
  let assistantText = '';
  let runTerminal = false;
  /** @type {import('./services/model-registry.js').ModelEntry | null} */
  let activeModelEntry = null;
  /** @type {import('@earendil-works/pi-coding-agent').AgentSession | null} */
  let agentSession = null;
  /** @type {object|null} */
  let suspendedPending = null;
  /** @type {Set<string>} */
  const preApproved = preApprovedIds instanceof Set ? preApprovedIds : new Set();

  const persistEvent = (type, payload = {}) => {
    if (!activeRunId) return Promise.resolve(null);
    return client
      .appendAgentEvent(activeRunId, { type, payload })
      .catch((err) => {
        console.warn(`[agent] append event ${type} failed:`, err.message);
        return null;
      });
  };

  const markRunInterrupted = (reason) => {
    if (!activeRunId || runTerminal) return Promise.resolve(null);
    runTerminal = true;
    return client
      .interruptAgentRun(activeRunId, {
        reason,
        partial_text: assistantText.trim() || null,
      })
      .catch((err) => {
        console.warn('[agent] interrupt run failed:', err.message);
        return null;
      });
  };

  const markBudgetExceeded = async (reason) => {
    if (!activeRunId || runTerminal) return;
    runTerminal = true;
    try {
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
    } catch (err) {
      console.warn('[agent] budget exceed mark failed:', err.message);
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

  const securityGetMeta = () => ({
    conversation_id: activeConversationId,
    session_id: sandboxSessionId,
    run_id: activeRunId,
    workspace_id: activeConversationId || sandboxSessionId,
    workspace_key: activeConversationId || sandboxSessionId,
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

  const sandboxTools = createSandboxTools({
    client,
    getSessionId: () => sandboxSessionId,
    getWorkspaceKey: () => activeConversationId || sandboxSessionId || 'default',
    approvalEnabled: config.APPROVAL_ENABLED,
    getMeta: securityGetMeta,
    skillRoots: config.SKILL_ROOTS,
    getPreApprovedIds: () => preApproved,
    onApprovalSuspend: handleApprovalSuspend,
    approvalNotifier: (ev) => {
      try {
        emit(ev);
      } catch {
        /* ignore */
      }
    },
  });

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

  // Unified ToolRegistry: sandbox + process + artifact + skill + MCP
  const toolRegistry = createToolRegistry();
  toolRegistry.registerMany(
    sandboxTools.map((t) => ({
      ...t,
      category:
        t.name === 'submit_artifact'
          ? TOOL_CATEGORY.ARTIFACT
          : t.name.startsWith('process_')
            ? TOOL_CATEGORY.PROCESS
            : TOOL_CATEGORY.SANDBOX,
    })),
  );
  if (config.SKILLS_MODE === SKILLS_MODE.DEVELOPMENT) {
    toolRegistry.registerMany(
      skillTools.map((t) => ({ ...t, category: TOOL_CATEGORY.SKILL })),
    );
  }

  // MCP discovery (best-effort; failures leave registry without MCP tools)
  let mcpTools = [];
  try {
    mcpTools = await createMcpTools({
      client,
      getSessionId: () => sandboxSessionId,
      getMeta: securityGetMeta,
      approvalEnabled: config.APPROVAL_ENABLED,
      approvalNotifier: (ev) => {
        try {
          emit(ev);
        } catch {
          /* ignore */
        }
      },
    });
    toolRegistry.registerMany(
      mcpTools.map((t) => ({ ...t, category: TOOL_CATEGORY.MCP })),
    );
  } catch (err) {
    console.warn('[agent] MCP tools unavailable:', err?.message || err);
    mcpTools = [];
  }

  const customTools = toolRegistry.customTools().length
    ? toolRegistry.customTools()
    : [
        ...sandboxTools,
        ...(config.SKILLS_MODE === SKILLS_MODE.DEVELOPMENT ? skillTools : []),
        ...mcpTools,
      ];
  const toolAllowlist = resolveToolAllowlist(
    config.SKILLS_MODE,
    mcpTools.map((t) => t.name),
  );

  try {
    if (isCancelled()) {
      return { status: 'cancelled', run_id: null, conversation_id: conversation_id || null };
    }

    const resolved = await resolveConversationAndSession(client, conversation_id);
    activeConversationId = resolved.activeConversationId;
    sandboxSessionId = resolved.sandboxSessionId;

    // Registry-driven capabilities (context window, max output, tool/reasoning flags).
    activeModelEntry = resolveActiveModel(opts.model_id || config.MODEL_ID);
    const activeModelId = activeModelEntry.model_id;

    try {
      const leaseOwner = `agent_${trace_id.slice(0, 12)}`;
      const run = await client.createAgentRun({
        conversation_id: activeConversationId,
        sandbox_session_id: sandboxSessionId,
        workspace_id: activeConversationId,
        model_id: activeModelId,
        lease_owner: leaseOwner,
        lease_seconds: 300,
      });
      activeRunId = run.run_id;
      activeLeaseOwner = run.lease_owner || leaseOwner;
    } catch (err) {
      console.warn('[agent] Failed to create agent run:', err.message);
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
      approval_enabled: config.APPROVAL_ENABLED,
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
    const settingsManager = SettingsManager.create(sessionCwd, getAgentDir());
    const resourceLoader = new DefaultResourceLoader({
      cwd: sessionCwd,
      agentDir: getAgentDir(),
      settingsManager,
      // Single skill root — avoid duplicate mounts (/sandbox/skills, /app/.pi/skills)
      // which only create name collisions; all compose to the same host ./skills.
      additionalSkillPaths: [AGENT_SKILL],
      extensionFactories: [
        createSandboxSecurityExtension({
          getMeta: securityGetMeta,
          approvalEnabled: () => config.APPROVAL_ENABLED,
        }),
      ],
    });
    await resourceLoader.reload();

    const piModel = makeModel(activeModelEntry);
    const { session } = await createAgentSession(buildCreateAgentSessionOptions({
      model: piModel,
      tools: toolAllowlist,
      customTools,
      // Logical session cwd matches Sandbox's workspace contract. Physical
      // access remains isolated behind the relative-path sandbox tools.
      cwd: sessionCwd,
      sessionManager: sessionHandle.sessionManager,
      authStorage,
      modelRegistry,
      resourceLoader,
      settingsManager,
    }));
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
     * @returns {import('./services/model-registry.js').TokenUsage | null}
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

    const skillModeHint =
      config.SKILLS_MODE === SKILLS_MODE.DEVELOPMENT
        ? `
### Skill management (development mode)

Shared skills live at \`${AGENT_SKILL}\` (SKILLS_MODE=development).

- Install: \`skill_install\` (allowlisted local dir or HTTPS Git with required \`ref\`)
- Edit: \`skill_edit\` (path under skill root only)
- Reload: \`skill_reload\` (or continue in the next turn)

Generic \`write\` / \`edit\` / \`bash\` **cannot** modify the skill tree.
Git must be HTTPS; git@/SSH, credentials-in-URL, npm/OCI, and arbitrary install scripts are rejected.
`
        : `
Shared skills at \`${AGENT_SKILL}\` are **read-only** (SKILLS_MODE=readonly).
Skill install/edit tools are not available.
`;

    const DOWNLOAD_INSTRUCTIONS = `
## Skills (required when they match)

You have specialized skills listed in \`<available_skills>\` (name + description + location).

**Progressive disclosure:** only skill names/descriptions are always in context. Full instructions live in each skill's \`SKILL.md\`.

**You MUST load a matching skill before doing specialized work** (documents, PDF/DOCX/XLSX/PPTX, conversion, summarization of office files, formatting, code review playbooks, MCP builders, etc.):

1. Match the user task to a skill \`description\` (e.g. .docx → \`docx\`, PDF → \`pdf\`, convert/总结文档 → \`convert-to-markdown\` or \`docx\`/\`pdf\`).
2. Call \`read\` with the skill's absolute \`<location>\` path (e.g. \`${AGENT_SKILL}/docx/SKILL.md\`).
3. Follow that SKILL.md workflow. Do **not** invent a parallel approach when a skill already covers the task.
4. If multiple skills match, load the most specific one first.

Skill absolute paths under \`${AGENT_SKILL}/\` (and legacy \`/sandbox/skills/\`, \`/app/.pi/skills/\`) are **allowed for \`read\`**. They are not workspace paths.

${skillModeHint}

## Workspace layout (relative paths)

The session workspace is identified by opaque \`workspace_id\` only. There is **no** public absolute workspace path for user files.

For **workspace** file tools use **relative paths** (\`notes/a.txt\`, \`.\`, \`uploads/...\`). Workspace absolute paths and \`..\` escapes are rejected. Do not invent host/physical paths (e.g. \`/var/sandbox/workspaces/...\`).

Exception: skill package paths under \`${AGENT_SKILL}/.../SKILL.md\` as listed in \`<available_skills>\`.

## Multi-turn context

Prior user/assistant messages in this conversation may already be in your transcript.
Continue the task with that context; do not ask the user to repeat earlier details.

## File Sharing (Artifact-only delivery)

Available tools: \`read\`, \`write\`, \`edit\`, \`apply_patch\`, \`bash\`, \`ls\`, \`find\`, \`grep\`, **\`submit_artifact\`**, ` +
      `\`process_start\`, \`process_status\`, \`process_logs\`, \`process_wait\`, \`process_write_stdin\`, \`process_signal\`, \`process_cancel\`` +
      (config.SKILLS_MODE === SKILLS_MODE.DEVELOPMENT
        ? `, \`skill_install\`, \`skill_edit\`, \`skill_reload\``
        : '') +
      `.

Prefer structured \`ls\` / \`find\` / \`grep\` over shell for file discovery and text search (bounded, audited, workspace-only).

\`bash\` is for **short synchronous** commands. For long-running, background, or interactive processes (web servers, watchers, REPLs), use **process_*** tools — do not use \`nohup\`, \`&\`, or shell backgrounding to bypass process management.

\`write\`, \`edit\`, and \`apply_patch\` only create or update **private workspace files**. They do **not** share anything with the user and do **not** create download links.
\`edit\` requires a unique \`old_string\` (multi-match is rejected with line numbers) and returns a unified diff + hashes.
\`apply_patch\` applies a unified diff to one file.

**To share a file with the user you MUST call \`submit_artifact\`.** That is the only path that registers a deliverable and makes it downloadable.

**Rules:**
1. Use \`write\` / \`edit\` / \`bash\` freely for intermediate work in the private workspace.
2. Start long-lived services with \`process_start\`, inspect with \`process_logs\` / \`process_status\`, stop with \`process_cancel\`.
3. When a final, important, or user-requested file is ready, call \`submit_artifact\` with the path (optional display name and mime_type). Example: \`submit_artifact({ path: "report.csv", name: "Sales Report" })\`
4. Only submit final/important/user-requested files — do **not** submit every intermediate draft.
5. There is **no** automatic workspace scan. Files from bash, write, or edit are never auto-shared.
6. After submitting, mention the file name clearly so the user knows what to download.
`;

    // Layered system prompt: product (env) + platform security (always) +
    // runtime workspace/artifact instructions. Platform layer cannot be disabled.
    const currentPrompt = session.agent.state.systemPrompt || '';
    const productLayer = config.PRODUCT_SYSTEM_PROMPT || '';
    let nextPrompt = currentPrompt;
    if (productLayer && !nextPrompt.includes(productLayer.slice(0, 64))) {
      nextPrompt = composeSystemPrompt(productLayer, PLATFORM_SYSTEM_PROMPT_LAYER)
        + (nextPrompt ? `\n\n${nextPrompt}` : '');
    } else if (!nextPrompt.includes('Platform security (non-overridable)')) {
      nextPrompt = composeSystemPrompt(nextPrompt, PLATFORM_SYSTEM_PROMPT_LAYER);
    }
    if (!nextPrompt.includes('File Sharing')) {
      nextPrompt = nextPrompt + DOWNLOAD_INSTRUCTIONS;
    }
    session.agent.state.systemPrompt = nextPrompt;

    const allMessages = Array.isArray(messages) ? messages : [];
    const priorMessages = allMessages.slice(0, -1);
    const lastMsg = allMessages[allMessages.length - 1];
    // Prefer full SDK session restore over last-40 plain-text injection.
    // Only inject text history for legacy conversations with no agent session yet
    // (first bind after upgrade) or force-inMemory rollback mode.
    const sdkHasHistory =
      sessionHandle?.restored &&
      (sessionHandle.sessionManager?.getEntries?.()?.length || 0) > 0;
    if (!sdkHasHistory) {
      const history = toAgentHistoryMessages(priorMessages);
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

    let tokenBatch = '';
    let tokenBatchTimer = null;
    const flushTokenBatch = () => {
      if (!tokenBatch) return;
      const text = tokenBatch;
      tokenBatch = '';
      if (tokenBatchTimer) {
        clearTimeout(tokenBatchTimer);
        tokenBatchTimer = null;
      }
      persistEvent('token_batch', { text });
    };
    const scheduleTokenBatch = (chunk) => {
      tokenBatch += chunk;
      if (tokenBatchTimer) return;
      tokenBatchTimer = setTimeout(flushTokenBatch, 250);
    };

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

    session.subscribe((event) => {
      if (isCancelled()) return;
      const mapped = mapSdkEventToSse(event, { pendingToolArgs });
      for (const payload of mapped) {
        if (payload.type === 'token' && typeof payload.text === 'string') {
          assistantText += payload.text;
          scheduleTokenBatch(payload.text);
        } else if (
          payload.type === 'tool_start' ||
          payload.type === 'tool_end' ||
          payload.type === 'approval_required' ||
          payload.type === 'error' ||
          payload.type === 'file_ready'
        ) {
          flushTokenBatch();
          persistEvent(payload.type, payload);
          if (payload.type === 'tool_start') {
            const isProc = String(payload.name || '') === 'process_start';
            const check = budget.recordToolCall({ isProcessStart: isProc });
            enforceBudgetOrAbort(check);
          } else if (payload.type === 'tool_end') {
            const isErr = Boolean(payload.isError);
            const isProcEnd = String(payload.name || '') === 'process_cancel';
            const check = budget.recordToolResult({
              isError: isErr,
              isProcessEnd: isProcEnd,
            });
            enforceBudgetOrAbort(check);
          }
          // Live-persist SDK entries after tool boundaries (call + result).
          if (payload.type === 'tool_end' || payload.type === 'tool_start') {
            flushSessionEntries();
          }
        }
        emit(payload);
      }
    });

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

    flushTokenBatch();
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
      runTerminal = true;
      try {
        await client.completeAgentRun(activeRunId, {
          lease_owner: activeLeaseOwner || undefined,
          model_id: activeModelEntry?.model_id || activeModelId,
          usage: runUsage || undefined,
        });
      } catch (err) {
        console.warn('[agent] complete run failed:', err.message);
        await persistEvent('done', { status: 'completed' });
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
    if (activeRunId && !runTerminal) {
      runTerminal = true;
      try {
        await client.failAgentRun(activeRunId, {
          error: err.message,
          lease_owner: activeLeaseOwner || undefined,
        });
      } catch {
        await markRunInterrupted('error');
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
    // Best-effort: cancel in-flight sandbox work if cancelled mid-turn
    if (isCancelled() && sandboxSessionId && !suspendedPending) {
      client.cancelActiveExecution(sandboxSessionId).catch(() => {});
      await markRunInterrupted('cancelled');
    }
    // Drop temp JSONL materialization; durable state is in sandbox DB.
    // Always cleanup on waiting_approval too — resources must be released.
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
  const preApproved = new Set([pending.approval_id]);
  // Also decide on sandbox if not already (idempotent)
  try {
    if (typeof client.decideApproval === 'function') {
      await client.decideApproval(pending.approval_id, 'approve').catch(() => {});
    }
  } catch {
    /* ignore */
  }

  const continueText =
    `[system] Approval ${pending.approval_id} granted for tool ` +
    `\`${pending.tool_name}\`. Re-execute that tool with the same arguments and continue.`;

  const prior = Array.isArray(messages) ? messages : [];
  const nextMessages = [
    ...prior,
    { role: 'user', content: continueText },
  ];

  // Re-claim sandbox run if we still have its id
  if (opts.sandbox_run_id && typeof client.claimAgentRun === 'function') {
    try {
      await client.claimAgentRun(opts.sandbox_run_id, {
        lease_owner: `agent_resume_${trace_id.slice(0, 8)}`,
        lease_seconds: 300,
      });
    } catch {
      /* best-effort — start_run path will create if needed */
    }
  }

  return runAgentTurn({
    messages: nextMessages,
    conversation_id: conversation_id || pending.conversation_id || null,
    auth,
    trace_id,
    budget,
    emit,
    isCancelled,
    onSessionReady,
    onApprovalSuspend,
    preApprovedIds: preApproved,
  });
}
