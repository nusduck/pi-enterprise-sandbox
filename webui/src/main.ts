/**
 * Pi Enterprise Sandbox WebUI — Main Entry Point
 *
 * Creates the Pi Agent, wires it to ChatPanel with sandbox tools.
 */
import { Agent } from '@earendil-works/pi-agent-core';
import type { TextContent, ToolUseContent } from '@earendil-works/pi-ai';
import {
  ChatPanel,
  type AgentInterface,
  type ArtifactsPanel,
  type SandboxRuntimeProvider,
  type Artifact,
  type ConsoleLog,
  type DownloadableFile,
  ArtifactsRuntimeProvider,
  ConsoleRuntimeProvider,
  FileDownloadRuntimeProvider,
  AppStorage,
  SessionsStore,
  IndexedDBStorageBackend,
  SettingsStore,
  ProviderKeysStore,
  CustomProvidersStore,
  setAppStorage,
  defaultConvertToLlm,
} from '@earendil-works/pi-web-ui';
import '@earendil-works/pi-web-ui/app.css';

// ── Configuration ──────────────────────────────────────────────────────

const MODEL_ID = import.meta.env.VITE_MODEL_ID || 'deepseek-v4-flash';
const LLMIO_BASE_URL = import.meta.env.VITE_LLMIO_BASE_URL || '';
const LLMIO_API_KEY = import.meta.env.VITE_LLMIO_API_KEY || '';
const API_BASE = '/api';

// ── API Client ─────────────────────────────────────────────────────────

async function apiFetch(path, options = {}) {
  const url = API_BASE + path;
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const resp = await fetch(url, { ...options, headers });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`API ${resp.status}: ${body}`);
  }
  const text = await resp.text();
  return text ? JSON.parse(text) : null;
}

// ── Sandbox Tools ──────────────────────────────────────────────────────

const BLOCKED_COMMANDS = [
  'sudo', 'su ', 'chmod 777', 'chown ', 'rm -rf /', 'rm -rf /*',
  'dd if=', 'mkfs.', 'fdisk', '> /dev/', '< /dev/',
];

function isBlocked(cmd) {
  for (const prefix of BLOCKED_COMMANDS) {
    if (cmd.trim().startsWith(prefix)) return prefix;
  }
  return null;
}

function toolContent(text) {
  const lines = text.split('\n');
  const preview = lines.slice(0, 200).join('\n');
  const note = lines.length > 200 ? '\n... [' + (lines.length - 200) + ' more lines]' : '';
  return [{ type: 'text', text: preview + note }];
}

function createSandboxTools(sessionIdFn) {
  return [
    {
      name: 'read',
      description: 'Read the contents of a file at the given path within the sandbox workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (relative to workspace)' },
          offset: { type: 'number', description: 'Line number to start from (1-indexed)' },
          limit: { type: 'number', description: 'Max lines to return' },
        },
        required: ['path'],
      },
      promptGuidelines: ['Use read to inspect existing files before editing them.'],
      async execute(_toolCallId, params) {
        const sid = sessionIdFn();
        const q = new URLSearchParams({ path: params.path });
        if (params.offset != null) q.set('offset', '' + params.offset);
        if (params.limit != null) q.set('limit', '' + params.limit);
        const result = await apiFetch('/sessions/' + sid + '/files/read?' + q);
        return {
          content: toolContent(result.content || ''),
          details: { size: result.size, truncated: result.truncated, mime_type: result.mime_type },
        };
      },
    },
    {
      name: 'write',
      description: 'Write content to a file at the given path in the sandbox workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (relative to workspace)' },
          content: { type: 'string', description: 'Content to write' },
        },
        required: ['path', 'content'],
      },
      promptGuidelines: ['Use write to create new files or overwrite existing ones.'],
      async execute(_toolCallId, params) {
        const sid = sessionIdFn();
        const result = await apiFetch('/sessions/' + sid + '/files/write', {
          method: 'POST',
          body: JSON.stringify({ path: params.path, content: params.content }),
        });
        return {
          content: toolContent('Written ' + result.size + ' bytes to ' + params.path),
          details: { size: result.size },
        };
      },
    },
    {
      name: 'edit',
      description: 'Edit a file by replacing old_string with new_string (targeted find-and-replace).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (relative to workspace)' },
          old_string: { type: 'string', description: 'Text to find and replace (must match exactly)' },
          new_string: { type: 'string', description: 'Replacement text' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
      promptGuidelines: ['Use edit for targeted changes. Prefer edit over write for small modifications.'],
      async execute(_toolCallId, params) {
        const sid = sessionIdFn();
        const q = new URLSearchParams({ path: params.path });
        const file = await apiFetch('/sessions/' + sid + '/files/read?' + q);
        const content = file.content || '';
        const idx = content.lastIndexOf(params.old_string);
        if (idx === -1) {
          throw new Error('old_string not found in ' + params.path + '. Make sure it matches exactly.');
        }
        const newContent = content.slice(0, idx) + params.new_string + content.slice(idx + params.old_string.length);
        await apiFetch('/sessions/' + sid + '/files/write', {
          method: 'POST',
          body: JSON.stringify({ path: params.path, content: newContent }),
        });
        return {
          content: toolContent('Replaced "' + params.old_string + '" with "' + params.new_string + '" in ' + params.path),
          details: { path: params.path, diff_lines: params.new_string.split('\n').length },
        };
      },
    },
    {
      name: 'bash',
      description: 'Run a shell command inside the sandbox. Use for any terminal operation including Python, Node.js, grep, find, ls, cat, compilation, and testing.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
          timeout: { type: 'number', description: 'Timeout in seconds (default: 120, max: 300)' },
          description: { type: 'string', description: 'Short description for audit' },
        },
        required: ['command'],
      },
      promptGuidelines: ['Use bash for ALL terminal operations.'],
      async execute(_toolCallId, params) {
        const sid = sessionIdFn();
        const blocked = isBlocked(params.command);
        if (blocked) {
          return { content: toolContent('Command blocked: "' + blocked + '" prefix is not allowed.'), isError: true };
        }
        const body = { command: params.command };
        if (params.timeout) body.timeout = params.timeout;
        const result = await apiFetch('/sessions/' + sid + '/executions/command', {
          method: 'POST', body: JSON.stringify(body),
        });
        const isError = result.exit_code != null && result.exit_code !== 0;
        const output = [
          result.stdout_preview ? 'STDOUT:\n' + result.stdout_preview : '',
          result.stderr_preview ? 'STDERR:\n' + result.stderr_preview : '',
        ].filter(Boolean).join('\n\n') || '(no output)';
        return {
          content: toolContent(output),
          details: { exit_code: result.exit_code, duration_ms: result.duration_ms, truncated: result.truncated },
          isError,
        };
      },
    },
    {
      name: 'skill_view',
      description: 'Load a workflow skill by name to get step-by-step guidance for common tasks.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: "Skill name (e.g. 'document-parser', 'data-analysis', 'sql-query')" },
          file_path: { type: 'string', description: "Optional file within the skill (e.g. 'scripts/parse.py')" },
        },
        required: ['name'],
      },
      promptGuidelines: ['Use skill_view to load workflow guidance when a user asks about a skill.'],
      async execute(_toolCallId, params) {
        const result = await apiFetch('/skills/' + params.name + (params.file_path ? '?file=' + encodeURIComponent(params.file_path) : ''));
        return { content: toolContent(result.content || 'Skill not found') };
      },
    },
  ];
}

// ── Runtime Providers ──────────────────────────────────────────────────

function createRuntimeProviders() {
  return [
    new ArtifactsRuntimeProvider({
      async listArtifacts(sessionId) {
        const data = await apiFetch('/sessions/' + sessionId + '/artifacts');
        return (data?.artifacts || []).map(a => ({
          id: a.artifact_id,
          name: a.name,
          mimeType: a.mime_type || 'application/octet-stream',
          size: a.size || 0,
          url: API_BASE + '/sessions/' + sessionId + '/files/download?path=' + encodeURIComponent(a.path),
        }));
      },
      async getArtifactContent(_sessionId, artifactUrl) {
        const resp = await fetch(artifactUrl);
        return resp.text();
      },
    }),
    new ConsoleRuntimeProvider({
      async captureConsole() { return []; },
    }),
    new FileDownloadRuntimeProvider({
      async getDownloadUrl(sessionId, filePath) {
        return API_BASE + '/sessions/' + sessionId + '/files/download?path=' + encodeURIComponent(filePath);
      },
      async listDownloadableFiles(sessionId) {
        const data = await apiFetch('/sessions/' + sessionId + '/files?path=.');
        return (data?.files || []).map(f => ({
          name: f.name,
          path: f.path,
          size: f.size,
          mimeType: f.mime_type || 'application/octet-stream',
          url: API_BASE + '/sessions/' + sessionId + '/files/download?path=' + encodeURIComponent(f.path),
        }));
      },
    }),
  ];
}

// ── Storage Setup ──────────────────────────────────────────────────────

function setupStorage() {
  const settings = new SettingsStore();
  const providerKeys = new ProviderKeysStore();
  const sessions = new SessionsStore();
  const customProviders = new CustomProvidersStore();

  const configs = [
    settings.getConfig(),
    SessionsStore.getMetadataConfig(),
    providerKeys.getConfig(),
    customProviders.getConfig(),
    sessions.getConfig(),
  ];

  const backend = new IndexedDBStorageBackend({
    dbName: 'pi-enterprise-sandbox',
    version: 2,
    stores: configs,
  });

  settings.setBackend(backend);
  providerKeys.setBackend(backend);
  customProviders.setBackend(backend);
  sessions.setBackend(backend);

  const storage = new AppStorage(settings, providerKeys, sessions, customProviders, backend);
  setAppStorage(storage);
  return storage;
}

// ── Model Config ───────────────────────────────────────────────────────

function createModelConfig() {
  // Build a custom model config for llmio (OpenAI-compatible)
  const baseUrl = LLMIO_BASE_URL || '/api/proxy';
  return {
    id: MODEL_ID,
    name: MODEL_ID,
    api: 'openai-completions',
    provider: 'llmio',
    baseUrl: baseUrl,
    headers: LLMIO_API_KEY ? { Authorization: 'Bearer ' + LLMIO_API_KEY } : undefined,
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

// ── App Init ───────────────────────────────────────────────────────────

async function initApp() {
  const app = document.getElementById('app');
  if (!app) throw new Error('App container not found');

  // Setup storage
  setupStorage();

  // Create ChatPanel
  const chatPanel = new ChatPanel();

  // Create Agent
  const agent = new Agent({
    initialState: {
      systemPrompt: 'You are the Pi Enterprise Sandbox Agent — a secure code execution assistant.\n\n'
        + 'You have access to a sandboxed execution environment. The sandbox is network-isolated.\n'
        + 'Always use the tools rather than describing what you would do.\n\n'
        + 'Available skills: document-parser, data-analysis, sql-query, sample-skill',
      model: createModelConfig(),
      thinkingLevel: 'off',
      messages: [],
      tools: [],
    },
    getApiKey: (provider) => {
      if (provider === 'llmio') return LLMIO_API_KEY || null;
      return null;
    },
    convertToLlm: defaultConvertToLlm,
  });

  // Sandbox session ID holder
  let sandboxSessionId = null;

  // Wire ChatPanel with tools
  await chatPanel.setAgent(agent, {
    onApiKeyRequired: async () => true,
    toolsFactory: () => {
      const sid = () => {
        if (!sandboxSessionId) throw new Error('No active sandbox session');
        return sandboxSessionId;
      };
      return createSandboxTools(sid);
    },
    sandboxUrlProvider: () => '/',
  });

  // Create sandbox session on first turn
  agent.subscribe((event) => {
    if (event.type === 'turn_start' && !sandboxSessionId) {
      apiFetch('/sessions', {
        method: 'POST',
        body: JSON.stringify({ caller_id: 'pi-webui', metadata: { source: 'pi-web-ui' } }),
      }).then((session) => {
        sandboxSessionId = session.session_id;
      }).catch((err) => {
        console.error('[sandbox] Session create failed:', err);
      });
    }
  });

  // Mount
  app.appendChild(chatPanel);
}

initApp().catch(console.error);
