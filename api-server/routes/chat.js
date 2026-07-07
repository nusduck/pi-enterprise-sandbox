/**
 * Route: POST /api/chat — SSE streaming chat with Pi Agent.
 */
import { createAgentSession, SessionManager, AuthStorage, ModelRegistry, DefaultResourceLoader, SettingsManager, getAgentDir } from '@earendil-works/pi-coding-agent';
import { sandboxTools, setSandboxSessionId } from '../sandbox-tools.js';
import * as sb from '../services/sandbox-client.js';
import { config } from '../config.js';

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
 * SSE event types sent to the browser:
 *   session, token, tool_start, tool_end, file_ready, done, session_closed, error
 */
export async function handleChat(body, res) {
  const { messages, conversation_id } = body;

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const sse = (data) => { res.write(`data: ${JSON.stringify(data)}\n\n`); };

  let sandboxSessionId = null;
  const pendingToolArgs = new Map();

  try {
    // 1. Resolve conversation workspace: auto-create or reuse
    let targetWorkspace = null;
    let activeConversationId = conversation_id;

    if (activeConversationId) {
      // Try to reuse existing conversation
      try {
        const convWs = await sb.getConversationWorkspace(activeConversationId);
        targetWorkspace = convWs.workspace_path;
        console.log(`[agent] Reusing conversation ${activeConversationId} workspace: ${targetWorkspace}`);
      } catch (err) {
        console.log(`[agent] Conversation ${activeConversationId} not found, will create new`);
        activeConversationId = null;
      }
    }

    if (!activeConversationId) {
      // Auto-create a persistent conversation
      const convResp = await sb.createConversation();
      activeConversationId = convResp.id;
      targetWorkspace = convResp.workspace_path;
      console.log(`[agent] Created conversation ${activeConversationId} workspace: ${targetWorkspace}`);
    }

    // 2. Create sandbox session pointing to conversation workspace
    const extra = { workspace_path: targetWorkspace };
    const sessionData = await sb.createSession('pi-coding-agent', extra);
    sandboxSessionId = sessionData.session_id;
    setSandboxSessionId(sandboxSessionId);
    console.log(`[agent] Session ${sandboxSessionId} workspace: ${sessionData.workspace_path}`);

    sse({ type: 'session', session_id: sandboxSessionId, workspace_path: sessionData.workspace_path, conversation_id: activeConversationId });

    // 2. Auth + model registry
    const authStorage = AuthStorage.create();
    const modelRegistry = ModelRegistry.create(authStorage);
    if (config.LLMIO_API_KEY) {
      await authStorage.set('llmio', config.LLMIO_API_KEY);
    }

    // 3. Resource loader (skills from sandbox mount)
    const settingsManager = SettingsManager.create('/tmp', getAgentDir());
    const resourceLoader = new DefaultResourceLoader({
      cwd: '/tmp',
      agentDir: getAgentDir(),
      settingsManager,
      additionalSkillPaths: ['/sandbox/skills'],
    });
    await resourceLoader.reload();

    // 4. Create pi-coding-agent session
    const { session } = await createAgentSession({
      model: makeModel(),
      tools: ['read', 'bash', 'edit', 'write'],
      customTools: sandboxTools,
      cwd: sessionData.workspace_path,
      sessionManager: SessionManager.inMemory(),
      authStorage,
      modelRegistry,
      resourceLoader,
      settingsManager,
    });

    // 5. Inject download instructions into system prompt
    const DOWNLOAD_INSTRUCTIONS = `
## File Sharing

Files you create in the workspace can be downloaded by the user via a link.

**How to share files with the user:**

1. **write tool** — Files created with the write tool are automatically made available for download. Just create the file using write and tell the user about it.

2. **submit_artifact tool** — For files created via bash (e.g. generated reports, charts, compiled outputs), call the \`submit_artifact\` tool with the file path to explicitly mark it as a downloadable artifact. Example: \`submit_artifact({ path: "output/report.csv", name: "Sales Report" })\`

3. **Important:** Files created via bash are NOT automatically detected. You MUST use \`submit_artifact\` to make them downloadable.

Always mention the file name clearly when you make something available for download so the user knows what to expect.
`;

    const currentPrompt = session.agent.state.systemPrompt;
    if (currentPrompt && !currentPrompt.includes('File Sharing')) {
      session.agent.state.systemPrompt = currentPrompt + DOWNLOAD_INSTRUCTIONS;
    }

    // 6. Subscribe events → SSE
    session.subscribe((event) => {
      switch (event.type) {
        case 'message_update':
          if (event.assistantMessageEvent?.type === 'text_delta') {
            sse({ type: 'token', text: event.assistantMessageEvent.delta });
          }
          break;
        case 'tool_execution_start':
          sse({ type: 'tool_start', id: event.toolCallId, name: event.toolName, args: event.args });
          if (event.args) pendingToolArgs.set(event.toolCallId, event.args);
          break;
        case 'tool_execution_end':
          sse({ type: 'tool_end', id: event.toolCallId, name: event.toolName,
            result: event.result, isError: event.isError });
          if (event.toolName === 'write' && !event.isError) {
            const toolArgs = pendingToolArgs.get(event.toolCallId);
            if (toolArgs?.path) sse({ type: 'file_ready', path: toolArgs.path });
          }
          if (event.toolName === 'submit_artifact' && !event.isError) {
            const toolArgs = pendingToolArgs.get(event.toolCallId);
            if (toolArgs?.path) sse({ type: 'file_ready', path: toolArgs.path });
          }
          pendingToolArgs.delete(event.toolCallId);
          break;
      }
    });

    // 7. Run prompt
    const lastMsg = messages?.[messages.length - 1];
    if (lastMsg) {
      const text = typeof lastMsg.content === 'string'
        ? lastMsg.content
        : Array.isArray(lastMsg.content)
          ? lastMsg.content.map(p => p.text || p.type === 'text' ? p.text : '').filter(Boolean).join('\n')
          : lastMsg.parts?.map(p => p.text).filter(Boolean).join('\n') || '';
      if (text) await session.prompt(text);
    }

    // 8. (removed) Artifact detection now relies solely on explicit
    //    submissions via write tool or POST /sessions/{id}/artifacts/submit.
    //    No automatic workspace full-scan after agent turn.

    sse({ type: 'done' });
  } catch (err) {
    console.error('[agent] Error:', err);
    sse({ type: 'error', message: err.message });
  } finally {
    sse({ type: 'session_closed', session_id: sandboxSessionId });
    res.end();
  }
}
