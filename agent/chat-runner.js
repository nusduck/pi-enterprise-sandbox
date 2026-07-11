/**
 * Agent turn runner — owns the pi-coding-agent session loop.
 * Emits SSE-compatible event objects via the provided emit callback.
 * Does not touch HTTP; run-manager owns persistence and transport.
 */
import { randomUUID } from 'node:crypto';
import {
  createAgentSession,
  SessionManager,
  AuthStorage,
  ModelRegistry,
  DefaultResourceLoader,
  SettingsManager,
  getAgentDir,
} from '@earendil-works/pi-coding-agent';
import { createSandboxTools } from './sandbox-tools.js';
import { createSandboxClient } from './services/sandbox-client.js';
import { config, SKILLS_MODE } from './config.js';
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
import { createSkillTools, SKILL_TOOL_NAMES } from './skills/tools.js';
import { createSkillManager } from './skills/manager.js';

const AGENT_WORKSPACE = '/home/sandbox/workspace';
const AGENT_SKILL = config.SKILLS_ROOT || '/home/sandbox/skill';

/** Base sandbox tool allowlist (always present). */
export const BASE_TOOL_NAMES = [
  'read',
  'bash',
  'edit',
  'write',
  'submit_artifact',
  'ls',
  'find',
  'grep',
];

/**
 * Tool allowlist for createAgentSession — includes skill tools only in development.
 * @param {string} [skillsMode]
 */
export function resolveToolAllowlist(skillsMode = config.SKILLS_MODE) {
  if (skillsMode === SKILLS_MODE.DEVELOPMENT) {
    return [...BASE_TOOL_NAMES, ...SKILL_TOOL_NAMES];
  }
  return [...BASE_TOOL_NAMES];
}

/**
 * Build a proper pi-ai Model object from env vars.
 */
function makeModel() {
  return {
    id: config.MODEL_ID,
    name: config.MODEL_ID,
    api: 'openai-completions',
    provider: 'llmio',
    baseUrl: config.LLMIO_BASE_URL,
    headers: config.LLMIO_API_KEY ? { Authorization: `Bearer ${config.LLMIO_API_KEY}` } : undefined,
    input: ['text'],
    output: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      maxTokensField: 'max_tokens',
      requiresAssistantAfterToolResult: true,
    },
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
        `[agent] Reusing conversation ${activeConversationId} workspace: ${AGENT_WORKSPACE}`,
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
      `[agent] Created conversation ${activeConversationId} workspace: ${AGENT_WORKSPACE}`,
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
    targetWorkspace: AGENT_WORKSPACE,
    sandboxSessionId,
    reusedSession,
  };
}

/**
 * Run one agent turn.
 *
 * @param {{
 *   messages: unknown[],
 *   conversation_id?: string|null,
 *   auth?: object|null,
 *   trace_id?: string|null,
 *   emit: (event: object) => void,
 *   isCancelled: () => boolean,
 *   onSessionReady?: (info: { session: object, sandboxSessionId: string, client: object }) => void,
 * }} opts
 * @returns {Promise<{ status: 'completed'|'cancelled'|'failed', run_id?: string|null, conversation_id?: string|null, error?: string }>}
 */
export async function runAgentTurn(opts) {
  const {
    messages,
    conversation_id = null,
    auth = null,
    emit,
    isCancelled = () => false,
    onSessionReady = null,
  } = opts;

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
  const pendingToolArgs = new Map();
  let assistantText = '';
  let runTerminal = false;
  /** @type {import('@earendil-works/pi-coding-agent').AgentSession | null} */
  let agentSession = null;

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

  const securityGetMeta = () => ({
    conversation_id: activeConversationId,
    session_id: sandboxSessionId,
    trace_id,
    workspace_key: activeConversationId || sandboxSessionId,
    policy_version: POLICY_VERSION,
  });

  const sandboxTools = createSandboxTools({
    client,
    getSessionId: () => sandboxSessionId,
    getWorkspaceKey: () => activeConversationId || sandboxSessionId || 'default',
    approvalEnabled: config.APPROVAL_ENABLED,
    getMeta: securityGetMeta,
    skillRoots: config.SKILL_ROOTS,
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
  });

  const customTools = [...sandboxTools, ...skillTools];
  const toolAllowlist = resolveToolAllowlist(config.SKILLS_MODE);

  try {
    if (isCancelled()) {
      return { status: 'cancelled', run_id: null, conversation_id: conversation_id || null };
    }

    const resolved = await resolveConversationAndSession(client, conversation_id);
    activeConversationId = resolved.activeConversationId;
    sandboxSessionId = resolved.sandboxSessionId;

    try {
      const leaseOwner = `agent_${trace_id.slice(0, 12)}`;
      const run = await client.createAgentRun({
        conversation_id: activeConversationId,
        sandbox_session_id: sandboxSessionId,
        workspace_id: activeConversationId,
        model_id: config.MODEL_ID,
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
      workspace_path: AGENT_WORKSPACE,
      conversation_id: activeConversationId,
      session_reused: resolved.reusedSession,
      trace_id,
      run_id: activeRunId,
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

    const authStorage = AuthStorage.create();
    const modelRegistry = ModelRegistry.create(authStorage);
    if (config.LLMIO_API_KEY) {
      await authStorage.set('llmio', config.LLMIO_API_KEY);
    }

    const settingsManager = SettingsManager.create('/tmp', getAgentDir());
    const resourceLoader = new DefaultResourceLoader({
      cwd: '/tmp',
      agentDir: getAgentDir(),
      settingsManager,
      additionalSkillPaths: [AGENT_SKILL, '/sandbox/skills'],
      extensionFactories: [
        createSandboxSecurityExtension({
          getMeta: securityGetMeta,
          approvalEnabled: () => config.APPROVAL_ENABLED,
        }),
      ],
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      model: makeModel(),
      tools: toolAllowlist,
      customTools,
      cwd: AGENT_WORKSPACE,
      sessionManager: SessionManager.inMemory(),
      authStorage,
      modelRegistry,
      resourceLoader,
      settingsManager,
    });
    agentSession = session;
    liveAgentSession = session;

    if (typeof onSessionReady === 'function') {
      onSessionReady({ session, sandboxSessionId, client });
    }

    const skillModeHint =
      config.SKILLS_MODE === SKILLS_MODE.DEVELOPMENT
        ? `
## Skill management (development mode)

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
## Workspace layout (stable paths)

Your working directory is always:
\`${AGENT_WORKSPACE}\`

${skillModeHint}

Use **relative paths** under the workspace for all file tools. Do not rely on host/physical paths
(e.g. \`/var/sandbox/workspaces/...\`). If a shell prints a different absolute path, still treat
\`${AGENT_WORKSPACE}\` as your logical workspace.

## Multi-turn context

Prior user/assistant messages in this conversation may already be in your transcript.
Continue the task with that context; do not ask the user to repeat earlier details.

## File Sharing (Artifact-only delivery)

Available tools: \`read\`, \`write\`, \`edit\`, \`bash\`, \`ls\`, \`find\`, \`grep\`, **\`submit_artifact\`` +
      (config.SKILLS_MODE === SKILLS_MODE.DEVELOPMENT
        ? `, \`skill_install\`, \`skill_edit\`, \`skill_reload\``
        : '') +
      `.

Prefer structured \`ls\` / \`find\` / \`grep\` over shell for file discovery and text search (bounded, audited, workspace-only).

\`write\` and \`edit\` only create or update **private workspace files**. They do **not** share anything with the user and do **not** create download links.

**To share a file with the user you MUST call \`submit_artifact\`.** That is the only path that registers a deliverable and makes it downloadable.

**Rules:**
1. Use \`write\` / \`edit\` / \`bash\` freely for intermediate work in the private workspace.
2. When a final, important, or user-requested file is ready, call \`submit_artifact\` with the path (optional display name and mime_type). Example: \`submit_artifact({ path: "report.csv", name: "Sales Report" })\`
3. Only submit final/important/user-requested files — do **not** submit every intermediate draft.
4. There is **no** automatic workspace scan. Files from bash, write, or edit are never auto-shared.
5. After submitting, mention the file name clearly so the user knows what to download.
`;

    const currentPrompt = session.agent.state.systemPrompt;
    if (currentPrompt && !currentPrompt.includes('File Sharing')) {
      session.agent.state.systemPrompt = currentPrompt + DOWNLOAD_INSTRUCTIONS;
    }

    const allMessages = Array.isArray(messages) ? messages : [];
    const priorMessages = allMessages.slice(0, -1);
    const lastMsg = allMessages[allMessages.length - 1];
    const history = toAgentHistoryMessages(priorMessages);
    if (history.length > 0) {
      session.agent.state.messages = history;
      console.log(`[agent] Restored ${history.length} prior message(s) into agent transcript`);
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
        }
        emit(payload);
      }
    });

    if (lastMsg) {
      const text = extractMessageText(lastMsg).trim();
      if (text) {
        await persistEvent('user_message', { text: text.slice(0, 4000) });
        if (isCancelled()) {
          await markRunInterrupted('cancelled');
          return {
            status: 'cancelled',
            run_id: activeRunId,
            conversation_id: activeConversationId,
          };
        }
        await session.prompt(text);
      }
    }

    flushTokenBatch();

    if (isCancelled()) {
      await markRunInterrupted('cancelled');
      emit({ type: 'session_closed', session_id: sandboxSessionId });
      return {
        status: 'cancelled',
        run_id: activeRunId,
        conversation_id: activeConversationId,
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
        interrupted: false,
        last_run_id: activeRunId || undefined,
      });
    } catch (err) {
      console.warn('[agent] Failed to persist conversation messages:', err.message);
    }

    if (activeRunId && !runTerminal) {
      runTerminal = true;
      try {
        await client.completeAgentRun(activeRunId, {
          lease_owner: activeLeaseOwner || undefined,
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
    };
  } catch (err) {
    console.error('[agent] Error:', err);
    emit({ type: 'error', message: err.message || String(err) });
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
    if (isCancelled() && sandboxSessionId) {
      client.cancelActiveExecution(sandboxSessionId).catch(() => {});
      await markRunInterrupted('cancelled');
    }
    // Drop reference; GC session
    agentSession = null;
    liveAgentSession = null;
  }
}
