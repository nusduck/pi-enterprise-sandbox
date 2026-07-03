/**
 * Pi Enterprise Sandbox WebUI — Main Entry
 *
 * Creates Pi Agent, wires sandbox tools, and mounts ChatPanel.
 * Plain JS (no TypeScript) — Vite handles the import resolution.
 */
import { Agent } from '@earendil-works/pi-agent-core';
import {
  ChatPanel,
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

// ── Config ─────────────────────────────────────────────────────────────

const MODEL_ID = import.meta.env.VITE_MODEL_ID || 'deepseek-v4-flash';
const LLMIO_API_KEY = import.meta.env.VITE_LLMIO_API_KEY || '';
const API_BASE = '/api';

// ── API Client ─────────────────────────────────────────────────────────

function apiFetch(path, options = {}) {
  const url = API_BASE + path;
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  return fetch(url, { ...options, headers }).then(async (resp) => {
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error('API ' + resp.status + ': ' + body);
    }
    const text = await resp.text();
    return text ? JSON.parse(text) : null;
  });
}

// ── Sandbox Tools ──────────────────────────────────────────────────────

const BLOCKED = ['sudo', 'su ', 'chmod 777', 'chown ', 'rm -rf /', 'rm -rf /*',
  'dd if=', 'mkfs.', 'fdisk', '> /dev/', '< /dev/'];

function isBlocked(cmd) {
  for (const p of BLOCKED) { if (cmd.trim().startsWith(p)) return p; }
  return null;
}

function toolContent(text) {
  const lines = text.split('\n');
  const preview = lines.slice(0, 200).join('\n');
  const note = lines.length > 200 ? '\n... [' + (lines.length - 200) + ' more lines]' : '';
  return [{ type: 'text', text: preview + note }];
}

function makeTools(getSid) {
  return [
    {
      name: 'read', label: 'Read file',
      description: 'Read file contents from the sandbox workspace.',
      parameters: {
        type: 'object', properties: {
          path: { type: 'string', description: 'File path (relative to workspace)' },
          offset: { type: 'number', description: 'Start line (1-indexed)' },
          limit: { type: 'number', description: 'Max lines' },
        }, required: ['path'],
      },
      async execute(_id, params) {
        const q = new URLSearchParams({ path: params.path });
        if (params.offset != null) q.set('offset', '' + params.offset);
        if (params.limit != null) q.set('limit', '' + params.limit);
        const r = await apiFetch('/sessions/' + getSid() + '/files/read?' + q);
        return { content: toolContent(r.content || ''), details: { size: r.size, truncated: r.truncated } };
      },
    },
    {
      name: 'write', label: 'Write file',
      description: 'Write content to a file in the sandbox workspace.',
      parameters: {
        type: 'object', properties: {
          path: { type: 'string', description: 'File path' },
          content: { type: 'string', description: 'Content to write' },
        }, required: ['path', 'content'],
      },
      async execute(_id, params) {
        const r = await apiFetch('/sessions/' + getSid() + '/files/write', {
          method: 'POST', body: JSON.stringify({ path: params.path, content: params.content }),
        });
        return { content: toolContent('Written ' + r.size + ' bytes to ' + params.path), details: { size: r.size } };
      },
    },
    {
      name: 'edit', label: 'Edit file',
      description: 'Find-and-replace edit on a file in the sandbox.',
      parameters: {
        type: 'object', properties: {
          path: { type: 'string', description: 'File path' },
          old_string: { type: 'string', description: 'Text to find' },
          new_string: { type: 'string', description: 'Replacement text' },
        }, required: ['path', 'old_string', 'new_string'],
      },
      async execute(_id, params) {
        const q = new URLSearchParams({ path: params.path });
        const file = await apiFetch('/sessions/' + getSid() + '/files/read?' + q);
        const idx = (file.content || '').lastIndexOf(params.old_string);
        if (idx === -1) throw new Error('old_string not found in ' + params.path);
        const nc = (file.content || '').slice(0, idx) + params.new_string
          + (file.content || '').slice(idx + params.old_string.length);
        await apiFetch('/sessions/' + getSid() + '/files/write', {
          method: 'POST', body: JSON.stringify({ path: params.path, content: nc }),
        });
        return { content: toolContent('Replaced in ' + params.path), details: { path: params.path } };
      },
    },
    {
      name: 'bash', label: 'Run command',
      description: 'Run a shell command in the sandbox (Python, bash, node, etc).',
      parameters: {
        type: 'object', properties: {
          command: { type: 'string', description: 'Shell command' },
          timeout: { type: 'number', description: 'Seconds (max 300)' },
        }, required: ['command'],
      },
      async execute(_id, params) {
        const blocked = isBlocked(params.command);
        if (blocked) return { content: toolContent('Blocked: ' + blocked), isError: true };
        const r = await apiFetch('/sessions/' + getSid() + '/executions/command', {
          method: 'POST', body: JSON.stringify({ command: params.command, timeout: params.timeout }),
        });
        const isErr = r.exit_code != null && r.exit_code !== 0;
        const out = [r.stdout_preview ? 'STDOUT:\n' + r.stdout_preview : '',
          r.stderr_preview ? 'STDERR:\n' + r.stderr_preview : ''].filter(Boolean).join('\n\n') || '(no output)';
        return { content: toolContent(out), details: { exit_code: r.exit_code, duration_ms: r.duration_ms }, isError: isErr };
      },
    },
    {
      name: 'skill_view', label: 'View skill',
      description: 'Load a skill by name (document-parser, data-analysis, sql-query).',
      parameters: {
        type: 'object', properties: {
          name: { type: 'string', description: 'Skill name' },
          file_path: { type: 'string', description: 'Optional file within skill' },
        }, required: ['name'],
      },
      async execute(_id, params) {
        const r = await apiFetch('/skills/' + params.name + (params.file_path ? '?file=' + encodeURI(params.file_path) : ''));
        return { content: toolContent(r.content || 'Not found') };
      },
    },
  ];
}

// ── Storage ────────────────────────────────────────────────────────────

function setupStorage() {
  const settings = new SettingsStore();
  const pkeys = new ProviderKeysStore();
  const sessions = new SessionsStore();
  const cproviders = new CustomProvidersStore();
  const configs = [settings.getConfig(), SessionsStore.getMetadataConfig(),
    pkeys.getConfig(), cproviders.getConfig(), sessions.getConfig()];
  const backend = new IndexedDBStorageBackend({
    dbName: 'pi-enterprise-sandbox', version: 2, stores: configs,
  });
  settings.setBackend(backend);
  pkeys.setBackend(backend);
  cproviders.setBackend(backend);
  sessions.setBackend(backend);
  const storage = new AppStorage(settings, pkeys, sessions, cproviders, backend);
  setAppStorage(storage);
}

// ── Model Config ───────────────────────────────────────────────────────

function makeModel() {
  return {
    id: MODEL_ID, name: MODEL_ID,
    api: 'openai-completions', provider: 'llmio',
    baseUrl: import.meta.env.VITE_LLMIO_BASE_URL || '',
    headers: LLMIO_API_KEY ? { Authorization: 'Bearer ' + LLMIO_API_KEY } : undefined,
    input: ['text'], output: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000, maxTokens: 8192,
    compat: { supportsStore: false, supportsDeveloperRole: false,
      maxTokensField: 'max_tokens', requiresAssistantAfterToolResult: true },
  };
}

// ── Init ───────────────────────────────────────────────────────────────

async function initApp() {
  const app = document.getElementById('app');
  if (!app) throw new Error('No app container');

  setupStorage();

  const chatPanel = new ChatPanel();
  const agent = new Agent({
    initialState: {
      systemPrompt: 'You are the Pi Enterprise Sandbox Agent — a secure code execution assistant.\n'
        + 'You have access to a sandboxed execution environment that is network-isolated.\n'
        + 'Always use the available tools rather than describing what you would do.\n'
        + 'Available skills: document-parser, data-analysis, sql-query, sample-skill',
      model: makeModel(),
      thinkingLevel: 'off',
      messages: [],
      tools: [],
    },
    getApiKey: (provider) => provider === 'llmio' ? (LLMIO_API_KEY || null) : null,
    convertToLlm: defaultConvertToLlm,
  });

  let sandboxSessionId = null;

  await chatPanel.setAgent(agent, {
    onApiKeyRequired: async () => true,
    toolsFactory: () => makeTools(() => {
      if (!sandboxSessionId) throw new Error('No sandbox session');
      return sandboxSessionId;
    }),
    sandboxUrlProvider: () => '/',
  });

  // Create sandbox session on first message
  agent.subscribe((event) => {
    if (event.type === 'turn_start' && !sandboxSessionId) {
      apiFetch('/sessions', {
        method: 'POST',
        body: JSON.stringify({ caller_id: 'pi-webui', metadata: { source: 'pi-web-ui' } }),
      }).then((s) => { sandboxSessionId = s.session_id; })
        .catch((e) => console.error('[sandbox] Session create failed:', e));
    }
  });

  app.appendChild(chatPanel);
}

initApp().catch(console.error);
