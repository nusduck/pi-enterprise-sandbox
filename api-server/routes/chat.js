/**
 * Route: POST /api/chat — SSE streaming chat with Pi Agent.
 *
 * Multi-turn: prior messages are restored into the agent transcript before
 * prompting with the latest user text. Conversation workspace is reused;
 * sandbox session is reused when still RUNNING.
 *
 * Each chat turn generates a trace_id (UUID) and propagates it to the sandbox
 * via X-Trace-Id on all sandbox-client calls.
 *
 * Runtime selection (reversible):
 * - AGENT_RUNTIME=node (default): this handleChat Node path
 * - AGENT_RUNTIME=python: SSE pass-through proxy to sandbox POST /agent/chat
 */
import { randomUUID } from 'node:crypto';
import { createAgentSession, SessionManager, AuthStorage, ModelRegistry, DefaultResourceLoader, SettingsManager, getAgentDir } from '@earendil-works/pi-coding-agent';
import { createSandboxTools } from '../sandbox-tools.js';
import { authFromRequest, createSandboxClient } from '../services/sandbox-client.js';
import { config, AUTH_HEADER, isPythonAgentRuntime } from '../config.js';
import { mapSdkEventToSse } from '../services/sdk-sse-map.js';
import {
  createSandboxSecurityExtension,
  POLICY_VERSION,
} from '../extensions/sandbox-security.js';

const AGENT_WORKSPACE = '/home/sandbox/workspace';
const AGENT_SKILL = '/home/sandbox/skill';
/** Cap restored turns to keep context bounded. */
const MAX_HISTORY_MESSAGES = 40;

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
 * Extract plain text from a frontend or API message shape.
 */
export function extractMessageText(msg) {
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((p) => {
        if (typeof p === 'string') return p;
        if (p?.type === 'text' && p.text) return p.text;
        if (p?.text) return p.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (Array.isArray(msg.parts)) {
    return msg.parts.map((p) => p.text || '').filter(Boolean).join('\n');
  }
  return '';
}

/**
 * Convert UI/history messages into pi-ai UserMessage / AssistantMessage shapes
 * suitable for agent.state.messages restoration.
 */
export function toAgentHistoryMessages(messages, modelId = config.MODEL_ID) {
  const out = [];
  const list = Array.isArray(messages) ? messages : [];
  for (const m of list) {
    const text = extractMessageText(m).trim();
    if (!text) continue;
    const role = m.role === 'assistant' ? 'assistant' : m.role === 'user' ? 'user' : null;
    if (!role) continue;
    const ts = typeof m.timestamp === 'number' ? m.timestamp : Date.now();
    if (role === 'user') {
      out.push({ role: 'user', content: text, timestamp: ts });
    } else {
      out.push({
        role: 'assistant',
        content: [{ type: 'text', text }],
        api: 'openai-completions',
        provider: 'llmio',
        model: modelId,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp: ts,
      });
    }
  }
  // Keep last N messages only
  if (out.length > MAX_HISTORY_MESSAGES) {
    return out.slice(-MAX_HISTORY_MESSAGES);
  }
  return out;
}

/**
 * Normalize messages for conversation DB persistence (text-only roles).
 */
export function toPersistableMessages(messages) {
  return (messages || [])
    .map((m) => {
      const role = m.role === 'assistant' ? 'assistant' : m.role === 'user' ? 'user' : null;
      if (!role) return null;
      const text = extractMessageText(m).trim();
      if (!text) return null;
      return { role, content: text };
    })
    .filter(Boolean)
    .slice(-100);
}

/**
 * Resolve conversation + sandbox session (reuse when possible).
 * @param {ReturnType<typeof createSandboxClient>} client
 * @param {string | null | undefined} conversation_id
 */
export async function resolveConversationAndSession(client, conversation_id) {
  let activeConversationId = conversation_id || null;
  // Always agent-visible logical path — never host physical roots.
  let targetWorkspace = AGENT_WORKSPACE;
  let sandboxSessionId = null;
  let reusedSession = false;

  if (activeConversationId) {
    try {
      const conv = await client.getConversation(activeConversationId);
      // API returns logical workspace_path; keep logical for clients/SSE.
      targetWorkspace = conv.workspace_path || AGENT_WORKSPACE;
      // Reuse sandbox session if still RUNNING
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
      targetWorkspace = AGENT_WORKSPACE;
    }
  }

  if (!activeConversationId) {
    const convResp = await client.createConversation();
    activeConversationId = convResp.id;
    targetWorkspace = convResp.workspace_path || AGENT_WORKSPACE;
    console.log(
      `[agent] Created conversation ${activeConversationId} workspace: ${AGENT_WORKSPACE}`,
    );
  }

  if (!sandboxSessionId) {
    // Bind session to conversation-owned workspace via conversation_id.
    // Do NOT pass host physical paths — sandbox resolves conv_<id> on disk.
    const sessionData = await client.createSession('pi-coding-agent', {
      conversation_id: activeConversationId,
      enterprise_session_id: activeConversationId,
    });
    sandboxSessionId = sessionData.session_id;
    // Bind session id onto conversation for next turn
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
 * Proxy browser chat SSE to Python sandbox agent (AGENT_RUNTIME=python).
 * Node remains BFF for CORS/auth; orchestration runs in sandbox.
 *
 * @param {object} body
 * @param {import('node:http').ServerResponse} res
 * @param {import('node:http').IncomingMessage} [req]
 */
export async function handleChatPythonProxy(body, res, req = null) {
  const trace_id = randomUUID();
  const ac = new AbortController();
  let finished = false;

  const onClientGone = () => {
    if (finished) return;
    try {
      ac.abort();
    } catch {
      /* ignore */
    }
  };
  if (req) {
    req.on('close', onClientGone);
    req.on('aborted', onClientGone);
  }
  res.on('close', onClientGone);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Trace-Id': trace_id,
  });

  const sse = (data) => {
    if (res.writableEnded || res.destroyed) return;
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {
      /* stream may be closed */
    }
  };

  // Early trace so UI can correlate even before Python responds
  sse({ type: 'trace', trace_id });

  const url = `${config.SANDBOX_BASE_URL}/agent/chat`;
  const auth = authFromRequest(req);
  try {
    const upstreamHeaders = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...AUTH_HEADER,
      'X-Trace-Id': trace_id,
    };
    if (auth.authorization) {
      upstreamHeaders.Authorization = auth.authorization;
    }
    const upstream = await fetch(url, {
      method: 'POST',
      headers: upstreamHeaders,
      body: JSON.stringify({
        messages: body.messages || [],
        conversation_id: body.conversation_id || null,
        sandbox_session_id: body.sandbox_session_id || null,
        workspace_path: body.workspace_path || null,
      }),
      signal: ac.signal,
    });

    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => upstream.statusText);
      sse({
        type: 'error',
        message: `Python agent proxy failed (${upstream.status}): ${detail || upstream.statusText}`,
      });
      sse({ type: 'done' });
      return;
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (res.writableEnded || res.destroyed) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        ac.abort();
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      // Pass through SSE frames; flush complete lines only
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx + 1);
        buffer = buffer.slice(idx + 1);
        try {
          res.write(line);
        } catch {
          ac.abort();
          return;
        }
      }
    }
    if (buffer && !res.writableEnded && !res.destroyed) {
      try {
        res.write(buffer);
      } catch {
        /* ignore */
      }
    }
  } catch (err) {
    if (err?.name === 'AbortError') {
      // Client disconnected — Python side cancels on disconnect
      return;
    }
    console.error('[agent-proxy] Error:', err);
    sse({ type: 'error', message: err.message || String(err) });
    sse({ type: 'done' });
  } finally {
    finished = true;
    if (!res.writableEnded) res.end();
  }
}

/**
 * @param {object} body
 * @param {import('node:http').ServerResponse} res
 * @param {import('node:http').IncomingMessage} [req]
 */
export async function handleChat(body, res, req = null) {
  if (isPythonAgentRuntime()) {
    return handleChatPythonProxy(body, res, req);
  }

  const { messages, conversation_id } = body;

  // End-to-end trace + request-scoped sandbox client for this chat turn only
  const trace_id = randomUUID();
  const client = createSandboxClient({
    traceId: trace_id,
    auth: authFromRequest(req),
  });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Trace-Id': trace_id,
  });

  const sse = (data) => {
    if (res.writableEnded || res.destroyed) return;
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {
      /* stream may be closed */
    }
  };

  // Emit trace id early so the UI can display / correlate
  sse({ type: 'trace', trace_id });

  let sandboxSessionId = null;
  let activeConversationId = null;
  let activeRunId = null;
  let activeLeaseOwner = null;
  const pendingToolArgs = new Map();
  let assistantText = '';
  let finished = false;
  let runTerminal = false; // completed / interrupted / failed already recorded

  // Best-effort persistence helpers (never break the SSE stream)
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

  // Policy: interactive chat SSE owns in-flight sandbox work — cancel on disconnect.
  // Also mark the agent run interrupted so recovery can surface partial assistant text.
  const onClientGone = () => {
    if (finished) return;
    const sid = sandboxSessionId;
    if (sid) {
      client.cancelActiveExecution(sid).catch((err) => {
        console.warn('[agent] cancel-active on disconnect failed:', err.message);
      });
    }
    markRunInterrupted('client_disconnect');
  };
  if (req) {
    req.on('close', onClientGone);
    req.on('aborted', onClientGone);
  }
  res.on('close', onClientGone);

  // Security meta for extension + tool audit (resolved after conversation setup)
  const securityGetMeta = () => ({
    conversation_id: activeConversationId,
    session_id: sandboxSessionId,
    trace_id,
    workspace_key: activeConversationId || sandboxSessionId,
    policy_version: POLICY_VERSION,
  });

  // Per-turn tools closed over this client, session, and SSE notifier
  const sandboxTools = createSandboxTools({
    client,
    getSessionId: () => sandboxSessionId,
    getWorkspaceKey: () => activeConversationId || sandboxSessionId || 'default',
    approvalEnabled: config.APPROVAL_ENABLED,
    getMeta: securityGetMeta,
    approvalNotifier: (ev) => {
      try {
        sse(ev);
      } catch {
        /* stream may be closed */
      }
    },
  });

  try {
    const resolved = await resolveConversationAndSession(client, conversation_id);
    activeConversationId = resolved.activeConversationId;
    sandboxSessionId = resolved.sandboxSessionId;

    // Create agent run + claim lease (DB-backed; multi-process best-effort)
    try {
      const leaseOwner = `node_${trace_id.slice(0, 12)}`;
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

    sse({
      type: 'session',
      session_id: sandboxSessionId,
      workspace_path: AGENT_WORKSPACE,
      conversation_id: activeConversationId,
      session_reused: resolved.reusedSession,
      trace_id,
      run_id: activeRunId,
      policy_version: POLICY_VERSION,
      approval_enabled: config.APPROVAL_ENABLED,
    });
    if (activeRunId) {
      await persistEvent('session', {
        session_id: sandboxSessionId,
        conversation_id: activeConversationId,
        trace_id,
      });
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
      // Unified tool_call / tool_result security lifecycle (fail-closed)
      extensionFactories: [
        createSandboxSecurityExtension({
          getMeta: securityGetMeta,
          approvalEnabled: () => config.APPROVAL_ENABLED,
        }),
      ],
    });
    await resourceLoader.reload();

    // IMPORTANT: `tools` is an *allowlist* — custom tools must be listed.
    const { session } = await createAgentSession({
      model: makeModel(),
      tools: ['read', 'bash', 'edit', 'write', 'submit_artifact', 'ls', 'find', 'grep'],
      customTools: sandboxTools,
      cwd: AGENT_WORKSPACE,
      sessionManager: SessionManager.inMemory(),
      authStorage,
      modelRegistry,
      resourceLoader,
      settingsManager,
    });

    const DOWNLOAD_INSTRUCTIONS = `
## Workspace layout (stable paths)

Your working directory is always:
\`${AGENT_WORKSPACE}\`

Shared read-only skills:
\`${AGENT_SKILL}\`

Use **relative paths** under the workspace for all file tools. Do not rely on host/physical paths
(e.g. \`/var/sandbox/workspaces/...\`). If a shell prints a different absolute path, still treat
\`${AGENT_WORKSPACE}\` as your logical workspace.

## Multi-turn context

Prior user/assistant messages in this conversation may already be in your transcript.
Continue the task with that context; do not ask the user to repeat earlier details.

## File Sharing (Artifact-only delivery)

Available tools: \`read\`, \`write\`, \`edit\`, \`bash\`, \`ls\`, \`find\`, \`grep\`, **\`submit_artifact\`**.

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

    // ── Multi-turn: restore prior messages into agent transcript ──
    const allMessages = Array.isArray(messages) ? messages : [];
    const priorMessages = allMessages.slice(0, -1);
    const lastMsg = allMessages[allMessages.length - 1];
    const history = toAgentHistoryMessages(priorMessages);
    if (history.length > 0) {
      session.agent.state.messages = history;
      console.log(`[agent] Restored ${history.length} prior message(s) into agent transcript`);
    }

    // Token batching for event store (avoid one row per token)
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
        sse(payload);
      }
    });

    // Prompt with latest user message only (history already in transcript)
    if (lastMsg) {
      const text = extractMessageText(lastMsg).trim();
      if (text) {
        await persistEvent('user_message', { text: text.slice(0, 4000) });
        await session.prompt(text);
      }
    }

    flushTokenBatch();

    // Dual-write: conversation messages projection + done event
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

    sse({ type: 'done' });
  } catch (err) {
    console.error('[agent] Error:', err);
    sse({ type: 'error', message: err.message });
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
  } finally {
    finished = true;
    // Keep sandbox session alive for multi-turn reuse — do not delete.
    // Emit closed for the SSE stream only.
    sse({ type: 'session_closed', session_id: sandboxSessionId });
    if (!res.writableEnded) res.end();
  }
}
