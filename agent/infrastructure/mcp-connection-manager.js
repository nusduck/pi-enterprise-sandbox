import { randomUUID } from 'node:crypto';

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid MCP server configuration JSON: ${error.message}`);
  }
}

export function loadMcpServerConfig(env = process.env) {
  const parsed = parseJson(env.MCP_SERVERS_JSON, []);
  if (!Array.isArray(parsed)) throw new Error('MCP_SERVERS_JSON must be an array');
  return parsed.map((server) => ({
    transport: 'streamable-http',
    timeoutMs: 30_000,
    retries: 1,
    enabled: true,
    ...server,
  }));
}

export function createEnvironmentCredentialResolver(env = process.env) {
  return {
    resolve(authTokenRef) {
      if (!authTokenRef) return null;
      const value = env[authTokenRef];
      if (!value) throw new Error(`MCP credential reference is unavailable: ${authTokenRef}`);
      return value;
    },
  };
}

function typeOf(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

/** Strict recursive JSON Schema validation used immediately before invoke. */
export function validateJsonSchema(schema, value, path = '$') {
  if (!schema || schema === true) return [];
  if (schema === false) return [`${path}: schema rejects all values`];
  const errors = [];

  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((candidate) =>
      validateJsonSchema(candidate, value, path).length === 0,
    );
    if (matches.length !== 1) errors.push(`${path}: must match exactly one oneOf schema`);
  }
  if (Array.isArray(schema.anyOf)) {
    const matches = schema.anyOf.some(
      (candidate) => validateJsonSchema(candidate, value, path).length === 0,
    );
    if (!matches) errors.push(`${path}: must match at least one anyOf schema`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value))) {
    errors.push(`${path}: value is not in enum`);
  }

  const expected = schema.type;
  if (expected) {
    const actual = typeOf(value);
    const allowed = Array.isArray(expected) ? expected : [expected];
    const numberMatch = allowed.includes('number') && (actual === 'number' || actual === 'integer');
    if (!allowed.includes(actual) && !numberMatch) {
      errors.push(`${path}: expected ${allowed.join('|')}, got ${actual}`);
      return errors;
    }
  }

  if ((expected === 'object' || schema.properties) && value && typeof value === 'object' && !Array.isArray(value)) {
    for (const name of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, name)) {
        errors.push(`${path}.${name}: required property is missing`);
      }
    }
    for (const [name, child] of Object.entries(schema.properties || {})) {
      if (Object.prototype.hasOwnProperty.call(value, name)) {
        errors.push(...validateJsonSchema(child, value[name], `${path}.${name}`));
      }
    }
    if (schema.additionalProperties === false) {
      const known = new Set(Object.keys(schema.properties || {}));
      for (const name of Object.keys(value)) {
        if (!known.has(name)) errors.push(`${path}.${name}: additional property is not allowed`);
      }
    }
  }

  if ((expected === 'array' || schema.items) && Array.isArray(value)) {
    value.forEach((item, index) => {
      errors.push(...validateJsonSchema(schema.items || true, item, `${path}[${index}]`));
    });
  }
  return errors;
}

function normalizeTool(server, tool) {
  const rawName = tool.name || tool.toolName;
  if (!rawName) return null;
  const annotations = tool.annotations || {};
  const destructive = annotations.destructiveHint === true;
  const sideEffect = Boolean(
    (tool.sideEffect ?? tool.side_effect ?? destructive) ||
    annotations.readOnlyHint === false,
  );
  return {
    key: `${server.id}:${rawName}`,
    serverId: server.id,
    name: rawName,
    description: tool.description || '',
    inputSchema: tool.inputSchema || tool.input_schema || tool.parameters || { type: 'object' },
    riskLevel: tool.riskLevel || tool.risk_level || (destructive ? 'high' : sideEffect ? 'medium' : 'low'),
    sideEffect,
  };
}

const SENSITIVE_KEY = /(?:authorization|api[-_]?key|token|secret|password|cookie|credential)/i;

function redactSensitive(value, seen = new WeakSet()) {
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item, seen));
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactSensitive(child, seen),
    ]),
  );
}

export function normalizeMcpResult(value, options = {}) {
  const maxBytes = options.maxBytes ?? 64 * 1024;
  const redacted = redactSensitive(value);
  const serialized = JSON.stringify(redacted);
  const resultRef = `mcp_result_${randomUUID()}`;
  const timestamp = new Date().toISOString();
  if (Buffer.byteLength(serialized, 'utf8') <= maxBytes) {
    return { value: redacted, resultRef, timestamp, truncated: false };
  }
  const preview = Buffer.from(serialized, 'utf8').subarray(0, maxBytes).toString('utf8');
  return {
    value: {
      truncated: true,
      preview,
      original_bytes: Buffer.byteLength(serialized, 'utf8'),
      result_ref: resultRef,
    },
    resultRef,
    timestamp,
    truncated: true,
  };
}

async function readProtocolResponse(response) {
  const contentType = response.headers?.get?.('content-type') || '';
  const text = await response.text();
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${text.slice(0, 500)}`);
  if (contentType.includes('text/event-stream')) {
    const data = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter(Boolean)
      .at(-1);
    return data ? JSON.parse(data) : {};
  }
  return text ? JSON.parse(text) : {};
}

export class McpConnectionManager {
  constructor(options = {}) {
    this.servers = new Map((options.servers || []).map((server) => [server.id, server]));
    this.fetch = options.fetch || globalThis.fetch;
    this.credentialResolver = options.credentialResolver || { resolve: () => null };
    this.allowedServers = new Set(options.allowedServers || []);
    this.allowedTools = new Set(options.allowedTools || []);
    this.context = options.context || {};
    this.allowAllServers = options.allowAllServers === true;
    this.maxResultBytes = options.maxResultBytes ?? 64 * 1024;
    this.cache = new Map();
  }

  isServerAllowed(serverId) {
    return this.allowAllServers || this.allowedServers.has(serverId);
  }

  isToolAllowed(key, rawName) {
    return this.allowedTools.size === 0 || this.allowedTools.has(key) || this.allowedTools.has(rawName);
  }

  headers(server) {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    const token = this.credentialResolver.resolve(server.authTokenRef);
    if (token) headers[server.authHeader || 'authorization'] = server.authScheme === 'raw' ? token : `Bearer ${token}`;
    const context = typeof this.context === 'function' ? this.context() : this.context;
    if (context?.user_id) headers['x-user-id'] = String(context.user_id);
    if (context?.tenant_id) headers['x-tenant-id'] = String(context.tenant_id);
    if (context?.conversation_id) headers['x-conversation-id'] = String(context.conversation_id);
    if (context?.run_id) headers['x-agent-run-id'] = String(context.run_id);
    return headers;
  }

  async request(server, method, params, signal) {
    let lastError;
    const attempts = Math.max(1, Number(server.retries ?? 0) + 1);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), server.timeoutMs || 30_000);
      const relayAbort = () => controller.abort();
      signal?.addEventListener?.('abort', relayAbort, { once: true });
      try {
        const response = await this.fetch(server.url, {
          method: 'POST',
          headers: this.headers(server),
          body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
          signal: controller.signal,
        });
        const payload = await readProtocolResponse(response);
        if (payload.error) throw new Error(payload.error.message || 'MCP protocol error');
        return payload.result ?? payload;
      } catch (error) {
        lastError = error;
        if (signal?.aborted || attempt === attempts) throw error;
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener?.('abort', relayAbort);
      }
    }
    throw lastError;
  }

  async discover({ refresh = false, signal } = {}) {
    const discovered = [];
    for (const server of this.servers.values()) {
      if (server.enabled === false || !this.isServerAllowed(server.id)) continue;
      let tools = refresh ? null : this.cache.get(server.id);
      if (!tools) {
        const raw = Array.isArray(server.tools)
          ? { tools: server.tools }
          : await this.request(server, 'tools/list', {}, signal);
        tools = (raw.tools || []).map((tool) => normalizeTool(server, tool)).filter(Boolean);
        this.cache.set(server.id, tools);
      }
      discovered.push(...tools.filter((tool) => this.isToolAllowed(tool.key, tool.name)));
    }
    return discovered;
  }

  async search(query, options = {}) {
    const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    const tools = await this.discover(options);
    return tools
      .map((tool) => {
        const haystack = `${tool.key} ${tool.description}`.toLowerCase();
        const score = words.reduce((total, word) => total + (haystack.includes(word) ? 1 : 0), 0);
        return { tool: tool.key, description: tool.description, risk_level: tool.riskLevel, score };
      })
      .filter((item) => words.length === 0 || item.score > 0)
      .sort((a, b) => b.score - a.score || a.tool.localeCompare(b.tool))
      .slice(0, 20);
  }

  async describe(key, options = {}) {
    const tools = await this.discover(options);
    const matches = tools.filter((tool) => tool.key === key || tool.name === key);
    if (matches.length !== 1) {
      throw new Error(matches.length ? `Ambiguous MCP tool: ${key}` : `Unknown MCP tool: ${key}`);
    }
    return matches[0];
  }

  async invoke(key, args, options = {}) {
    const tool = await this.describe(key, options);
    const errors = validateJsonSchema(tool.inputSchema, args || {});
    if (errors.length) {
      throw new Error(`Invalid MCP arguments: ${errors.join('; ')}`);
    }
    if ((tool.sideEffect || tool.riskLevel === 'high') && !options.approved) {
      return { status: 'approval_required', tool };
    }
    const server = this.servers.get(tool.serverId);
    const result = await this.request(
      server,
      'tools/call',
      { name: tool.name, arguments: args || {} },
      options.signal,
    );
    const normalized = normalizeMcpResult(result, { maxBytes: this.maxResultBytes });
    return {
      status: 'ok',
      tool: tool.key,
      serverId: tool.serverId,
      result: normalized.value,
      resultRef: normalized.resultRef,
      timestamp: normalized.timestamp,
      truncated: normalized.truncated,
    };
  }
}

export function createMcpConnectionManager(options = {}) {
  return new McpConnectionManager({
    servers: options.servers || loadMcpServerConfig(options.env),
    credentialResolver:
      options.credentialResolver || createEnvironmentCredentialResolver(options.env),
    ...options,
  });
}
