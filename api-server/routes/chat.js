/**
 * Route: POST /api/chat — SSE streaming chat with Pi Agent.
 *
 * Multi-turn: prior messages are restored into the agent transcript before
 * prompting with the latest user text. Conversation workspace is reused;
 * sandbox session is reused when still RUNNING.
 *
 * Each chat turn generates a trace_id (UUID) and propagates it to the sandbox
 * via X-Trace-Id on all sandbox-client calls.
 */
import { randomUUID } from 'node:crypto';
import { createAgentSession, SessionManager, AuthStorage, ModelRegistry, DefaultResourceLoader, SettingsManager, getAgentDir } from '@earendil-works/pi-coding-agent';
import { sandboxTools, setSandboxSessionId, setApprovalNotifier } from '../sandbox-tools.js';
import * as sb from '../services/sandbox-client.js';
import { config } from '../config.js';

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
 * Pull structured fields from a tool result.
 */
function extractToolDetails(result) {
  if (!result) return {};
  if (typeof result === 'string') {
    return parseArtifactFieldsFromText(result);
  }
  if (typeof result !== 'object') return {};

  const sources = [];
  if (result.details && typeof result.details === 'object') sources.push(result.details);
  sources.push(result);
  if (Array.isArray(result.content)) {
    for (const part of result.content) {
      if (part?.type === 'text' && part.text) sources.push(parseArtifactFieldsFromText(part.text));
    }
  }

  const out = {};
  for (const s of sources) {
    if (!s || typeof s !== 'object') continue;
    for (const key of ['artifact_id', 'path', 'name', 'mime_type', 'size']) {
      if (out[key] == null && s[key] != null) out[key] = s[key];
    }
  }
  return out;
}

function parseArtifactFieldsFromText(text) {
  if (!text || typeof text !== 'string') return {};
  const out = {};
  const id = text.match(/artifact_id[=:\s]+([a-zA-Z0-9_-]+)/);
  if (id) out.artifact_id = id[1];
  const path = text.match(/\bpath[=:\s]+([^\s,)]+)/);
  if (path) out.path = path[1];
  const size = text.match(/\bsize[=:\s]+(\d+)/);
  if (size) out.size = Number(size[1]);
  return out;
}

/**
 * Resolve conversation + sandbox session (reuse when possible).
 */
async function resolveConversationAndSession(conversation_id) {
  let activeConversationId = conversation_id || null;
  let targetWorkspace = null;
  let sandboxSessionId = null;
  let reusedSession = false;

  if (activeConversationId) {
    try {
      const conv = await sb.getConversation(activeConversationId);
      targetWorkspace = conv.workspace_path || null;
      // Prefer dedicated workspace endpoint if path missing
      if (!targetWorkspace) {
        const convWs = await sb.getConversationWorkspace(activeConversationId);
        targetWorkspace = convWs.workspace_path;
      }
      // Reuse sandbox session if still RUNNING
      if (conv.sandbox_session_id) {
        try {
          const existing = await sb.getSession(conv.sandbox_session_id);
          if (existing?.status === 'RUNNING' && existing.session_id) {
            sandboxSessionId = existing.session_id;
            reusedSession = true;
            console.log(`[agent] Reusing sandbox session ${sandboxSessionId}`);
          }
        } catch {
          // session expired or missing
        }
      }
      console.log(`[agent] Reusing conversation ${activeConversationId} workspace: ${targetWorkspace}`);
    } catch {
      console.log(`[agent] Conversation ${activeConversationId} not found, will create new`);
      activeConversationId = null;
      targetWorkspace = null;
    }
  }

  if (!activeConversationId) {
    const convResp = await sb.createConversation();
    activeConversationId = convResp.id;
    targetWorkspace = convResp.workspace_path;
    console.log(`[agent] Created conversation ${activeConversationId} workspace: ${targetWorkspace}`);
  }

  if (!sandboxSessionId) {
    const extra = targetWorkspace ? { workspace_path: targetWorkspace } : {};
    const sessionData = await sb.createSession('pi-coding-agent', {
      ...extra,
      enterprise_session_id: activeConversationId,
    });
    sandboxSessionId = sessionData.session_id;
    // Bind session id onto conversation for next turn
    try {
      await sb.updateConversation(activeConversationId, {
        sandbox_session_id: sandboxSessionId,
        workspace_path: targetWorkspace || sessionData.workspace_path,
      });
    } catch (err) {
      console.warn('[agent] Failed to bind sandbox_session_id on conversation:', err.message);
    }
    console.log(`[agent] Created sandbox session ${sandboxSessionId}`);
  }

  return { activeConversationId, targetWorkspace, sandboxSessionId, reusedSession };
}

export async function handleChat(body, res) {
  const { messages, conversation_id } = body;

  // End-to-end trace for this chat turn (sandbox X-Trace-Id)
  const trace_id = randomUUID();
  sb.setTraceId(trace_id);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Trace-Id': trace_id,
  });

  const sse = (data) => { res.write(`data: ${JSON.stringify(data)}\n\n`); };

  // Emit trace id early so the UI can display / correlate
  sse({ type: 'trace', trace_id });

  // Wire tool-layer approvals into the SSE stream (human-in-the-loop)
  setApprovalNotifier((ev) => {
    try {
      sse(ev);
    } catch {
      /* stream may be closed */
    }
  });

  let sandboxSessionId = null;
  let activeConversationId = null;
  const pendingToolArgs = new Map();
  let assistantText = '';

  try {
    const resolved = await resolveConversationAndSession(conversation_id);
    activeConversationId = resolved.activeConversationId;
    sandboxSessionId = resolved.sandboxSessionId;
    setSandboxSessionId(sandboxSessionId);

    sse({
      type: 'session',
      session_id: sandboxSessionId,
      workspace_path: AGENT_WORKSPACE,
      conversation_id: activeConversationId,
      session_reused: resolved.reusedSession,
      trace_id,
    });

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
    });
    await resourceLoader.reload();

    // IMPORTANT: `tools` is an *allowlist* — custom tools must be listed.
    const { session } = await createAgentSession({
      model: makeModel(),
      tools: ['read', 'bash', 'edit', 'write', 'submit_artifact'],
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

Available tools: \`read\`, \`write\`, \`edit\`, \`bash\`, **\`submit_artifact\`**.

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

    session.subscribe((event) => {
      switch (event.type) {
        case 'message_update':
          if (event.assistantMessageEvent?.type === 'text_delta') {
            const delta = event.assistantMessageEvent.delta || '';
            assistantText += delta;
            sse({ type: 'token', text: delta });
          }
          break;
        case 'tool_execution_start':
          sse({ type: 'tool_start', id: event.toolCallId, name: event.toolName, args: event.args });
          if (event.args) pendingToolArgs.set(event.toolCallId, event.args);
          break;
        case 'tool_execution_end':
          sse({
            type: 'tool_end', id: event.toolCallId, name: event.toolName,
            result: event.result, isError: event.isError,
          });
          if (event.toolName === 'submit_artifact' && !event.isError) {
            const toolArgs = pendingToolArgs.get(event.toolCallId) || {};
            const details = {
              ...extractToolDetails(event.result),
              ...extractToolDetails(event.details),
            };
            const path = details.path || toolArgs.path;
            if (path || details.artifact_id) {
              const payload = { type: 'file_ready' };
              if (details.artifact_id) payload.artifact_id = details.artifact_id;
              if (path) payload.path = path;
              const name = details.name || toolArgs.name || (path ? path.split('/').pop() : undefined);
              if (name) payload.name = name;
              const mime = details.mime_type || toolArgs.mime_type;
              if (mime) payload.mime_type = mime;
              if (details.size != null) payload.size = details.size;
              sse(payload);
            }
          }
          pendingToolArgs.delete(event.toolCallId);
          break;
      }
    });

    // Prompt with latest user message only (history already in transcript)
    if (lastMsg) {
      const text = extractMessageText(lastMsg).trim();
      if (text) await session.prompt(text);
    }

    // Persist full conversation messages (client history + this assistant turn)
    try {
      const persisted = toPersistableMessages(allMessages);
      if (assistantText.trim()) {
        persisted.push({ role: 'assistant', content: assistantText.trim() });
      }
      await sb.updateConversation(activeConversationId, {
        messages: persisted,
        sandbox_session_id: sandboxSessionId,
      });
    } catch (err) {
      console.warn('[agent] Failed to persist conversation messages:', err.message);
    }

    sse({ type: 'done' });
  } catch (err) {
    console.error('[agent] Error:', err);
    sse({ type: 'error', message: err.message });
  } finally {
    setApprovalNotifier(null);
    // Keep sandbox session alive for multi-turn reuse — do not delete.
    // Emit closed for the SSE stream only.
    sse({ type: 'session_closed', session_id: sandboxSessionId });
    res.end();
  }
}
