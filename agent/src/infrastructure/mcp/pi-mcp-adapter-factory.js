/**
 * Production binding for pi-mcp-adapter (plan section 2.3 / 21).
 *
 * The vendor package remains the only MCP protocol/client implementation. This
 * module owns the enterprise boundary around it: logical AgentVersion refs,
 * deployment registry lookup, secret resolution, private config materialization,
 * and exact mcp__server__tool registration.
 */

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { Type } from 'typebox';
import {
  loadMcpConfig,
  loadMcpConfigFromAgentVersion,
  McpConfigError,
  mcpToolName,
} from './mcp-config-loader.js';
import {
  assertW3cTraceId,
  createTraceHeaders,
  normalizeW3cTracestate,
} from '../sandbox/trace-context.js';
import {
  redactInlineSecrets,
  redactPayload,
} from '../pi/event-redaction.js';
import {
  MCP_DISCOVERY_DEFAULT_CONCURRENCY,
  MCP_DISCOVERY_DEFAULT_OVERALL_TIMEOUT_MS,
  MCP_DISCOVERY_DEFAULT_PER_SERVER_ATTEMPTS,
  MCP_DISCOVERY_DEFAULT_PER_SERVER_TIMEOUT_MS,
  MCP_DISCOVERY_DEFAULT_RETRY_BACKOFF_MS,
  MCP_TOOL_ARGS_MAX_JSON_BYTES,
  MCP_TOOL_DESCRIPTION_MAX_CHARS,
  MCP_TOOL_NAME_PATTERN,
  MCP_TOOL_RESULT_MAX_JSON_BYTES,
  MCP_TOOL_SNIPPET_MAX_CHARS,
  PINNED_PI_MCP_ADAPTER_VERSION,
  PI_MCP_ADAPTER_PACKAGE,
  PiMcpAdapterError,
  RESERVED_TRACE_ENV_NAMES,
  RESERVED_TRACE_HEADER_NAMES,
  SECRET_REF_PATTERN,
  SERVER_ID_PATTERN,
} from './mcp-constants.js';
import { cloneJson, loadMcpServerRegistry } from './mcp-server-registry.js';
import {
  assertMcpToolArgsAgainstSchema,
  mcpToolArgumentError,
  normalizeMcpToolParameters,
  sanitizeMcpToolDescription,
} from './mcp-tool-schema.js';

// Re-exported so this module stays the single entry point for the MCP boundary.
export {
  MCP_DISCOVERY_DEFAULT_CONCURRENCY,
  MCP_DISCOVERY_DEFAULT_OVERALL_TIMEOUT_MS,
  MCP_DISCOVERY_DEFAULT_PER_SERVER_ATTEMPTS,
  MCP_DISCOVERY_DEFAULT_PER_SERVER_TIMEOUT_MS,
  MCP_DISCOVERY_DEFAULT_RETRY_BACKOFF_MS,
  MCP_TOOL_ARGS_MAX_JSON_BYTES,
  MCP_TOOL_DESCRIPTION_MAX_CHARS,
  MCP_TOOL_RESULT_MAX_JSON_BYTES,
  MCP_TOOL_SNIPPET_MAX_CHARS,
  MCP_TRANSPORT_VALUES,
  PI_MCP_ADAPTER_PACKAGE,
  PINNED_PI_MCP_ADAPTER_VERSION,
  PiMcpAdapterError,
} from './mcp-constants.js';
export { loadMcpServerRegistry } from './mcp-server-registry.js';
export {
  assertMcpToolArgsAgainstSchema,
  mcpToolArgumentError,
  normalizeMcpToolParameters,
  sanitizeMcpToolDescription,
} from './mcp-tool-schema.js';

const require = createRequire(import.meta.url);

/**
 * Load the connection manager shipped by the pinned adapter.  The adapter is
 * the sole MCP protocol implementation in this product; this preflight only
 * asks it to connect and run its built-in tools/list discovery before a Pi
 * session is created.  The adapter is TypeScript-only, so reuse the Jiti
 * loader that is pinned with our Pi SDK rather than adding another MCP client.
 */
function loadPinnedAdapterConnectionManager() {
  let adapterPackageJson;
  try {
    adapterPackageJson = require.resolve(`${PI_MCP_ADAPTER_PACKAGE}/package.json`);
    const adapterRoot = path.dirname(adapterPackageJson);
    const jitiPath = path.join(
      path.dirname(adapterRoot),
      '@earendil-works',
      'pi-coding-agent',
      'node_modules',
      'jiti',
    );
    // Jiti is part of the exact Pi SDK installation.  Resolve it by absolute
    // path because the SDK deliberately does not export package internals.
    const { createJiti } = require(jitiPath);
    if (typeof createJiti !== 'function') throw new Error('createJiti unavailable');
    const jiti = createJiti(path.join(adapterRoot, 'index.ts'), {
      interopDefault: true,
    });
    const mod = jiti(path.join(adapterRoot, 'server-manager.ts'));
    if (typeof mod?.McpServerManager !== 'function') {
      throw new Error('McpServerManager unavailable');
    }
    return mod.McpServerManager;
  } catch (cause) {
    throw new PiMcpAdapterError(
      'Pinned pi-mcp-adapter discovery implementation is unavailable',
      { code: 'PI_MCP_ADAPTER_API_UNVERIFIED', cause },
    );
  }
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Resolve environment-backed secret references without ever including values in
 * diagnostics. Other providers can be injected at the composition root.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 */
export function createEnvironmentSecretResolver(env = process.env) {
  return async function resolveEnvironmentSecret(rawRef) {
    let ref = String(rawRef ?? '').trim();
    if (ref.startsWith('env://')) ref = ref.slice('env://'.length);
    if (!SECRET_REF_PATTERN.test(ref)) {
      throw new PiMcpAdapterError('MCP secret reference is unsupported', {
        code: 'MCP_SECRET_REF_UNSUPPORTED',
      });
    }
    const value = env[ref];
    if (typeof value !== 'string' || value.length === 0) {
      throw new PiMcpAdapterError(`MCP secret reference ${ref} is not configured`, {
        code: 'MCP_SECRET_NOT_FOUND',
      });
    }
    return value;
  };
}

/**
 * Race a promise against a hard timeout (clears timer on settle).
 * @template T
 * @param {Promise<T>} promise
 * @param {number} timeoutMs
 * @param {string} label
 * @returns {Promise<T>}
 */
function withTimeout(promise, timeoutMs, label) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer;
  return new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new PiMcpAdapterError(`${label} timed out after ${timeoutMs}ms`, {
          code: 'MCP_DISCOVERY_TIMEOUT',
        }),
      );
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Bounded parallel map (fixed worker pool).
 * @template T, R
 * @param {readonly T[]} items
 * @param {number} concurrency
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapPool(items, concurrency, fn) {
  /** @type {R[]} */
  const results = new Array(items.length);
  let next = 0;
  const workers = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        results[index] = await fn(items[index], index);
      }
    }),
  );
  return results;
}


/**
 * Discover tools for every enabled deployment server once during process
 * startup.  The returned logical config is process-scoped at startup, but the
 * Agent re-reads MCP_SERVERS_JSON on every discovery call: with
 * AGENT_MCP_REFRESH_INTERVAL_MS > 0 the container's refresh loop periodically
 * force-re-discovers, so registry changes become visible to subsequent Runs
 * without a process restart (see ServiceContainer.#ensureMcpRediscoveryLoop).
 *
 * Discovery is parallel with a bounded concurrency and hard overall timeout
 * so one hung command-based server cannot block Agent readiness for minutes
 * (triage A5).
 *
 * @param {{
 *   serverRegistry?: unknown,
 *   secretResolver?: (ref: string) => unknown | Promise<unknown>,
 *   cwd?: string,
 *   concurrency?: number,
 *   overallTimeoutMs?: number,
 *   perServerTimeoutMs?: number,
 * }} [options]
 */
export async function discoverEnabledMcpServers(options = {}) {
  const registry = loadMcpServerRegistry(options.serverRegistry ?? []);
  const enabled = [...registry.values()].filter((server) => server.enabled !== false);
  if (enabled.length === 0) {
    return Object.freeze({
      ready: true,
      serverCount: 0,
      toolCount: 0,
      servers: Object.freeze([]),
      mcpServers: Object.freeze([]),
    });
  }

  const concurrency = Math.max(
    1,
    Math.min(
      16,
      Number.isFinite(options.concurrency)
        ? Number(options.concurrency)
        : MCP_DISCOVERY_DEFAULT_CONCURRENCY,
    ),
  );
  const overallTimeoutMs = Math.max(
    1_000,
    Number.isFinite(options.overallTimeoutMs)
      ? Number(options.overallTimeoutMs)
      : MCP_DISCOVERY_DEFAULT_OVERALL_TIMEOUT_MS,
  );
  const perServerTimeoutMs = Math.max(
    500,
    Number.isFinite(options.perServerTimeoutMs)
      ? Number(options.perServerTimeoutMs)
      : MCP_DISCOVERY_DEFAULT_PER_SERVER_TIMEOUT_MS,
  );
  const perServerAttempts = Math.max(
    1,
    Math.min(
      5,
      Number.isFinite(options.perServerAttempts)
        ? Number(options.perServerAttempts)
        : MCP_DISCOVERY_DEFAULT_PER_SERVER_ATTEMPTS,
    ),
  );
  const retryBackoffMs = Math.max(
    0,
    Number.isFinite(options.retryBackoffMs)
      ? Number(options.retryBackoffMs)
      : MCP_DISCOVERY_DEFAULT_RETRY_BACKOFF_MS,
  );

  const McpServerManager = loadPinnedAdapterConnectionManager();
  const manager = new McpServerManager(options.cwd);
  const secretResolver =
    options.secretResolver ?? createEnvironmentSecretResolver(process.env);

  /**
   * @param {ReturnType<typeof loadMcpServerRegistry> extends Map<string, infer V> ? V : never} server
   */
  async function discoverOneAttempt(server) {
    /** @type {Record<string, unknown>} */
    const definition = {
      ...(server.url ? { url: server.url } : {}),
      ...(server.command
        ? {
            command: server.command,
            args: [...server.args],
            ...(server.cwd ? { cwd: server.cwd } : {}),
          }
        : {}),
      lifecycle: 'eager',
      directTools: false,
      exposeResources: false,
      requestTimeoutMs: Math.min(server.timeoutMs ?? 60_000, perServerTimeoutMs),
      debug: false,
    };
    const env = {};
    for (const [name, ref] of Object.entries(server.envRefs)) {
      env[name] = await resolveSecretValue(ref, secretResolver);
    }
    if (Object.keys(env).length > 0) definition.env = env;
    const headers = {};
    for (const [name, ref] of Object.entries(server.headerRefs)) {
      headers[name] = await resolveSecretValue(ref, secretResolver);
    }
    if (Object.keys(headers).length > 0) definition.headers = headers;
    if (server.authTokenRef) {
      definition.auth = 'bearer';
      definition.bearerToken = await resolveSecretValue(
        server.authTokenRef,
        secretResolver,
      );
    } else {
      definition.auth = false;
    }

    // Use a distinct manager name per attempt so a failed connect (SSE 405
    // after streamable probe) does not poison reuse of a half-open entry.
    const attemptName = `${server.serverId}__discover_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;

    // McpServerManager.connect performs MCP initialization and tools/list
    // (including pagination) before it resolves successfully.
    const connection = await withTimeout(
      manager.connect(attemptName, definition),
      Math.min(server.timeoutMs ?? 60_000, perServerTimeoutMs),
      `MCP discovery ${server.serverId}`,
    );
    try {
      if (connection.status !== 'connected') {
        throw new PiMcpAdapterError(
          `MCP server ${server.serverId} requires interactive authentication`,
          { code: 'MCP_SERVER_AUTH_REQUIRED' },
        );
      }
      /** @type {Record<string, unknown>} */
      const toolInputSchemas = {};
      /** @type {Record<string, string>} */
      const toolDescriptions = {};
      const toolNames = [];
      for (const tool of connection.tools ?? []) {
        const name = String(tool?.name ?? '').trim();
        if (!MCP_TOOL_NAME_PATTERN.test(name) || name.startsWith('mcp__')) continue;
        toolNames.push(name);
        if (tool?.inputSchema != null && typeof tool.inputSchema === 'object') {
          toolInputSchemas[name] = tool.inputSchema;
        }
        if (typeof tool?.description === 'string') {
          const desc = tool.description.trim();
          if (desc) {
            toolDescriptions[name] = desc.slice(0, MCP_TOOL_DESCRIPTION_MAX_CHARS);
          }
        }
      }
      const uniqueNames = [...new Set(toolNames)].sort();
      const rejectedToolCount = (connection.tools ?? []).length - uniqueNames.length;
      return Object.freeze({
        serverId: server.serverId,
        status: 'connected',
        toolNames: Object.freeze(uniqueNames),
        toolInputSchemas: Object.freeze(toolInputSchemas),
        toolDescriptions: Object.freeze(toolDescriptions),
        toolCount: uniqueNames.length,
        rejectedToolCount,
        error: null,
        transport: server.transport ?? null,
      });
    } finally {
      // Drop the probe connection; runtime binding opens a fresh one.
      if (typeof manager.close === 'function') {
        await manager.close(attemptName).catch(() => {});
      }
    }
  }

  /**
   * @param {ReturnType<typeof loadMcpServerRegistry> extends Map<string, infer V> ? V : never} server
   */
  async function discoverOne(server) {
    /** @type {unknown} */
    let lastError = null;
    for (let attempt = 1; attempt <= perServerAttempts; attempt += 1) {
      try {
        return await discoverOneAttempt(server);
      } catch (error) {
        lastError = error;
        if (attempt < perServerAttempts) {
          await sleep(retryBackoffMs * attempt);
        }
      }
    }
    const rawMessage =
      lastError instanceof Error ? lastError.message : 'MCP discovery failed';
    const safeMessage = redactPayload(
      { message: rawMessage.slice(0, 512) },
      { maxString: 512 },
    ).message;
    return Object.freeze({
      serverId: server.serverId,
      status: 'unreachable',
      toolNames: Object.freeze([]),
      toolInputSchemas: Object.freeze({}),
      toolDescriptions: Object.freeze({}),
      toolCount: 0,
      rejectedToolCount: 0,
      error: typeof safeMessage === 'string' ? safeMessage : 'MCP discovery failed',
      transport: server.transport ?? null,
    });
  }

  /** @type {Awaited<ReturnType<typeof discoverOne>>[]} */
  let servers = [];
  /** Partial results if overall budget expires mid-flight. */
  const partialById = new Map();
  try {
    servers = await withTimeout(
      mapPool(enabled, concurrency, async (server) => {
        const result = await discoverOne(server);
        partialById.set(server.serverId, result);
        return result;
      }),
      overallTimeoutMs,
      'MCP discovery overall',
    );
  } catch (error) {
    // Overall budget exceeded: keep whatever finished, mark the rest unreachable.
    const msg =
      error instanceof Error ? error.message.slice(0, 512) : 'MCP discovery timed out';
    servers = enabled.map((server) => {
      const done = partialById.get(server.serverId);
      if (done) return done;
      return Object.freeze({
        serverId: server.serverId,
        status: 'unreachable',
        toolNames: Object.freeze(/** @type {string[]} */ ([])),
        toolInputSchemas: Object.freeze({}),
        toolDescriptions: Object.freeze({}),
        toolCount: 0,
        rejectedToolCount: 0,
        error: msg,
      });
    });
  } finally {
    await manager.closeAll().catch(() => {});
  }

  const connected = servers.filter((server) => server.status === 'connected');
  const mcpServers = connected.map((server) =>
    Object.freeze({
      serverId: server.serverId,
      enabledTools: server.toolNames,
      toolInputSchemas: server.toolInputSchemas,
      toolDescriptions: server.toolDescriptions,
      toolPolicy: Object.freeze({ default: 'require_approval' }),
      timeoutSec: Math.max(
        1,
        Math.min(300, Math.ceil((registry.get(server.serverId)?.timeoutMs ?? 60_000) / 1000)),
      ),
      secretRef: registry.get(server.serverId)?.authTokenRef ?? null,
    }),
  );
  return Object.freeze({
    ready: connected.length === enabled.length,
    serverCount: enabled.length,
    toolCount: connected.reduce((total, server) => total + server.toolCount, 0),
    servers: Object.freeze(servers),
    mcpServers: Object.freeze(mcpServers),
  });
}

/** @param {string} ref @param {(ref: string) => unknown | Promise<unknown>} resolver */
async function resolveSecretValue(ref, resolver) {
  let value;
  try {
    value = await resolver(ref);
  } catch (error) {
    if (error instanceof PiMcpAdapterError) throw error;
    throw new PiMcpAdapterError('MCP secret provider failed', {
      code: 'MCP_SECRET_RESOLUTION_FAILED',
      cause: error,
    });
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw new PiMcpAdapterError('MCP secret provider returned an empty/non-string value', {
      code: 'MCP_SECRET_RESOLUTION_FAILED',
    });
  }
  return value;
}

/**
 * @param {unknown} context
 * @param {((size: number) => Uint8Array) | undefined} spanRandomBytes
 */
function normalizeMcpTraceContext(context, spanRandomBytes) {
  if (
    context === null ||
    typeof context !== 'object' ||
    Array.isArray(context)
  ) {
    throw new PiMcpAdapterError(
      'Run context with a W3C trace id is required for MCP binding',
      { code: 'MCP_TRACE_CONTEXT_INVALID' },
    );
  }
  try {
    return Object.freeze({
      traceId: assertW3cTraceId(context.traceId, 'context.traceId'),
      traceState: normalizeW3cTracestate(context.traceState),
      spanRandomBytes,
    });
  } catch (error) {
    throw new PiMcpAdapterError('MCP run trace context is invalid', {
      code: 'MCP_TRACE_CONTEXT_INVALID',
      cause: error,
    });
  }
}

/**
 * Propagation fields are owned by the runtime and are case-insensitive for
 * HTTP. A deployment secret reference must not replace them.
 *
 * @param {Record<string, string>} bindings
 * @param {Set<string>} reserved
 * @param {string} field
 */
function assertNoReservedTraceBindings(bindings, reserved, field) {
  for (const name of Object.keys(bindings)) {
    if (reserved.has(name.toLowerCase())) {
      throw new PiMcpAdapterError(
        `${field}.${name} is reserved for runtime trace propagation`,
        { code: 'MCP_TRACE_BINDING_RESERVED' },
      );
    }
  }
}

/**
 * @param {ReadonlyArray<ReturnType<typeof loadMcpConfig>[number]>} logicalServers
 * @param {ReadonlyMap<string, Readonly<Record<string, unknown>>>} registry
 * @param {(ref: string) => unknown | Promise<unknown>} secretResolver
 * @param {{ traceId: string, traceState?: string | null, spanRandomBytes?: (size: number) => Uint8Array }} traceContext
 */
async function buildVendorConfig(
  logicalServers,
  registry,
  secretResolver,
  traceContext,
) {
  /** @type {Record<string, Record<string, unknown>>} */
  const mcpServers = {};
  const tools = [];

  for (const logical of logicalServers) {
    const definition = registry.get(logical.serverId);
    if (!definition) {
      throw new PiMcpAdapterError(
        `AgentVersion references unknown MCP server: ${logical.serverId}`,
        { code: 'MCP_SERVER_NOT_REGISTERED' },
      );
    }
    if (definition.enabled === false) {
      throw new PiMcpAdapterError(
        `AgentVersion references disabled MCP server: ${logical.serverId}`,
        { code: 'MCP_SERVER_DISABLED' },
      );
    }
    if (logical.secretRef && logical.secretRef !== definition.authTokenRef) {
      throw new PiMcpAdapterError(
        `AgentVersion secretRef does not match the deployment binding for ${logical.serverId}`,
        { code: 'MCP_SECRET_REF_MISMATCH' },
      );
    }

    /** @type {Record<string, unknown>} */
    const vendor = {
      lifecycle: 'lazy',
      requestTimeoutMs: logical.timeoutSec * 1000,
      exposeResources: false,
      directTools: false,
      debug: false,
    };
    if (definition.url) vendor.url = definition.url;
    if (definition.command) {
      vendor.command = definition.command;
      vendor.args = [...definition.args];
      if (definition.cwd) vendor.cwd = definition.cwd;
    }

    // pi-mcp-adapter 2.11.0 reads HTTP headers when it creates a server
    // connection. The binding is created per Run, so this is a Run-scoped
    // child span, not a new span for every call on a reused connection.
    const traceHeaders = createTraceHeaders(traceContext.traceId, {
      randomBytes: traceContext.spanRandomBytes,
      traceState: traceContext.traceState,
    });

    /** @type {Record<string, string>} */
    const resolvedEnv = {};
    assertNoReservedTraceBindings(
      definition.envRefs,
      RESERVED_TRACE_ENV_NAMES,
      `${logical.serverId}.envRefs`,
    );
    for (const [name, ref] of Object.entries(definition.envRefs)) {
      resolvedEnv[name] = await resolveSecretValue(ref, secretResolver);
    }
    if (definition.command) {
      vendor.env = {
        ...resolvedEnv,
        TRACEPARENT: traceHeaders.traceparent,
        ...(traceHeaders.tracestate
          ? { TRACESTATE: traceHeaders.tracestate }
          : {}),
        TRACE_ID: traceContext.traceId,
      };
    } else if (Object.keys(resolvedEnv).length > 0) {
      vendor.env = resolvedEnv;
    }

    /** @type {Record<string, string>} */
    const resolvedHeaders = {};
    assertNoReservedTraceBindings(
      definition.headerRefs,
      RESERVED_TRACE_HEADER_NAMES,
      `${logical.serverId}.headerRefs`,
    );
    for (const [name, ref] of Object.entries(definition.headerRefs)) {
      resolvedHeaders[name] = await resolveSecretValue(ref, secretResolver);
    }
    if (definition.url) {
      vendor.headers = {
        ...resolvedHeaders,
        ...traceHeaders,
      };
    } else if (Object.keys(resolvedHeaders).length > 0) {
      vendor.headers = resolvedHeaders;
    }

    if (definition.authTokenRef) {
      vendor.auth = 'bearer';
      vendor.bearerToken = await resolveSecretValue(
        definition.authTokenRef,
        secretResolver,
      );
    } else if (definition.auth === 'oauth') {
      vendor.auth = 'oauth';
    } else {
      // Headless production must not auto-start an interactive OAuth flow.
      vendor.auth = false;
    }

    mcpServers[logical.serverId] = vendor;
    const schemas =
      logical.toolInputSchemas != null &&
      typeof logical.toolInputSchemas === 'object' &&
      !Array.isArray(logical.toolInputSchemas)
        ? /** @type {Record<string, unknown>} */ (logical.toolInputSchemas)
        : null;
    const descriptions =
      logical.toolDescriptions != null &&
      typeof logical.toolDescriptions === 'object' &&
      !Array.isArray(logical.toolDescriptions)
        ? /** @type {Record<string, unknown>} */ (logical.toolDescriptions)
        : null;
    for (const toolName of logical.enabledTools) {
      tools.push(
        Object.freeze({
          serverId: logical.serverId,
          toolName,
          name: mcpToolName(logical.serverId, toolName),
          inputSchema: schemas?.[toolName] ?? null,
          description:
            typeof descriptions?.[toolName] === 'string'
              ? descriptions[toolName]
              : null,
        }),
      );
    }
  }

  return {
    mcpServers,
    settings: {
      // Enterprise wrappers already provide collision-free mcp__server__tool
      // names and always pass serverOverride to the vendor proxy.
      toolPrefix: 'none',
      directTools: false,
      disableProxyTool: false,
      sampling: false,
      elicitation: false,
      outputGuard: true,
      authRequiredMessage: 'MCP authentication is unavailable in this headless runtime.',
    },
    tools: Object.freeze(tools),
  };
}

/**
 * pi-mcp-adapter merges global/project discovery sources even when mcp-config is
 * supplied. Enterprise runtimes reject those ambient sources so they cannot
 * override a deployment registry endpoint or add an unapproved server.
 *
 * @param {{ cwd?: string, agentDir?: string, fsImpl?: typeof fs }} options
 */
async function assertNoAmbientMcpConfig(options) {
  const fsApi = options.fsImpl ?? fs;
  const candidates = new Set([
    path.join(os.homedir(), '.config', 'mcp', 'mcp.json'),
    path.join(
      path.resolve(
        process.env.PI_CODING_AGENT_DIR ||
          options.agentDir ||
          path.join(os.homedir(), '.pi', 'agent'),
      ),
      'mcp.json',
    ),
  ]);
  for (const cwd of [process.cwd(), options.cwd]) {
    if (!cwd) continue;
    candidates.add(path.resolve(cwd, '.mcp.json'));
    candidates.add(path.resolve(cwd, '.pi', 'mcp.json'));
  }
  for (const candidate of candidates) {
    try {
      await fsApi.access(candidate);
    } catch {
      continue;
    }
    throw new PiMcpAdapterError(
      `Ambient MCP config is forbidden in enterprise runtime: ${candidate}`,
      { code: 'MCP_AMBIENT_CONFIG_FORBIDDEN' },
    );
  }
}

/**
 * Verify the installed vendor package without importing its TypeScript root with
 * Node. Pi's own Jiti extension loader will load index.ts.
 *
 * @param {{ resolvePackageJson?: () => string, readFile?: typeof fs.readFile, access?: typeof fs.access }} [deps]
 */
export async function resolvePiMcpAdapterPackage(deps = {}) {
  let packageJsonPath;
  try {
    packageJsonPath =
      deps.resolvePackageJson?.() ?? require.resolve(`${PI_MCP_ADAPTER_PACKAGE}/package.json`);
  } catch (error) {
    throw new PiMcpAdapterError(
      `Installed ${PI_MCP_ADAPTER_PACKAGE}@${PINNED_PI_MCP_ADAPTER_VERSION} is required`,
      { code: 'PI_MCP_ADAPTER_UNAVAILABLE', cause: error },
    );
  }
  let manifest;
  try {
    manifest = JSON.parse(
      await (deps.readFile ?? fs.readFile)(packageJsonPath, 'utf8'),
    );
  } catch (error) {
    throw new PiMcpAdapterError('pi-mcp-adapter package manifest is unreadable', {
      code: 'PI_MCP_ADAPTER_UNAVAILABLE',
      cause: error,
    });
  }
  if (manifest?.version !== PINNED_PI_MCP_ADAPTER_VERSION) {
    throw new PiMcpAdapterError(
      `Installed pi-mcp-adapter version is ${String(manifest?.version || '(missing)')}; expected ${PINNED_PI_MCP_ADAPTER_VERSION}`,
      { code: 'PI_MCP_ADAPTER_VERSION_MISMATCH' },
    );
  }
  const declared = manifest?.pi?.extensions;
  if (!Array.isArray(declared) || declared.length !== 1 || declared[0] !== './index.ts') {
    throw new PiMcpAdapterError('pi-mcp-adapter manifest has an unexpected Pi extension surface', {
      code: 'PI_MCP_ADAPTER_API_UNVERIFIED',
    });
  }
  const extensionPath = path.join(path.dirname(packageJsonPath), 'index.ts');
  try {
    await (deps.access ?? fs.access)(extensionPath);
  } catch (error) {
    throw new PiMcpAdapterError('pi-mcp-adapter index.ts is unavailable', {
      code: 'PI_MCP_ADAPTER_UNAVAILABLE',
      cause: error,
    });
  }
  return Object.freeze({
    packageJsonPath,
    extensionPath,
    version: manifest.version,
  });
}

/**
 * The vendor exposes one proxy tool. Keep its protocol implementation and
 * replace its model-facing surface with immutable AgentVersion allowlisted
 * wrappers using the required enterprise names.
 *
 * @param {{ extensionPath: string, tools: readonly {
 *   serverId: string,
 *   toolName: string,
 *   name: string,
 *   inputSchema?: unknown,
 *   description?: string | null,
 * }[] }} binding
 */
export function createMcpExtensionsOverride(binding) {
  return function projectMcpTools(base) {
    const matches = (base?.extensions || []).filter(
      (extension) => path.resolve(extension.resolvedPath) === path.resolve(binding.extensionPath),
    );
    if (matches.length !== 1) {
      throw new PiMcpAdapterError(
        `Expected exactly one pi-mcp-adapter extension, found ${matches.length}`,
        { code: 'PI_MCP_ADAPTER_BIND_FAILED' },
      );
    }
    const extension = matches[0];
    const proxyRegistration = extension.tools.get('mcp');
    const proxy = proxyRegistration?.definition;
    if (!proxy || typeof proxy.execute !== 'function') {
      throw new PiMcpAdapterError('pi-mcp-adapter did not register its public mcp proxy tool', {
        code: 'PI_MCP_ADAPTER_API_UNVERIFIED',
      });
    }

    // Do not expose vendor proxy/direct tools: they would bypass the immutable
    // AgentVersion server/tool allowlist and enterprise mcp__ naming policy.
    extension.tools.clear();
    for (const mapping of binding.tools) {
      const fallbackDescription = `Call allowlisted MCP tool ${mapping.toolName} on ${mapping.serverId}`;
      const description = sanitizeMcpToolDescription(
        mapping.description,
        fallbackDescription,
      );
      const snippetSource =
        typeof mapping.description === 'string' && mapping.description.trim()
          ? description
          : `MCP tool ${mapping.name}`;
      const promptSnippet =
        snippetSource.length <= MCP_TOOL_SNIPPET_MAX_CHARS
          ? snippetSource
          : `${snippetSource.slice(0, MCP_TOOL_SNIPPET_MAX_CHARS - 1)}…`;
      const definition = {
        name: mapping.name,
        label: `MCP: ${mapping.serverId}/${mapping.toolName}`,
        description,
        promptSnippet,
        parameters: normalizeMcpToolParameters(mapping.inputSchema),
        async execute(toolCallId, params, signal, onUpdate, context) {
          // Argument-shape failures are certain (server not invoked). Return
          // isError so approved-tool replay can continue instead of failing
          // the run as APPROVED_TOOL_REPLAY_UNCERTAIN.
          if (params != null && (typeof params !== 'object' || Array.isArray(params))) {
            return mcpToolArgumentError('MCP tool arguments must be a plain object');
          }
          if (mapping.inputSchema) {
            try {
              assertMcpToolArgsAgainstSchema(mapping.inputSchema, params ?? {});
            } catch (error) {
              return mcpToolArgumentError(
                error instanceof Error ? error.message : 'invalid MCP tool arguments',
              );
            }
          }
          let args;
          try {
            args = JSON.stringify(params ?? {});
          } catch {
            return mcpToolArgumentError('MCP tool arguments are not JSON serializable');
          }
          if (Buffer.byteLength(args, 'utf8') > MCP_TOOL_ARGS_MAX_JSON_BYTES) {
            throw new PiMcpAdapterError('MCP tool arguments exceed size limit', {
              code: 'MCP_TOOL_ARGUMENTS_TOO_LARGE',
            });
          }
          const safeUpdate =
            typeof onUpdate === 'function'
              ? (update) =>
                  onUpdate(redactPayload(update, { maxString: 32_768 }))
              : onUpdate;
          const result = await proxy.execute(
            toolCallId,
            {
              server: mapping.serverId,
              tool: mapping.toolName,
              args,
            },
            signal,
            safeUpdate,
            context,
          );
          // Bound result size before deep redact (A4): still fully buffered by
          // the vendor proxy, but reject multi-megabyte payloads early.
          let serialized;
          try {
            serialized = JSON.stringify(result);
          } catch (error) {
            throw new PiMcpAdapterError('MCP tool result is not JSON serializable', {
              code: 'MCP_TOOL_RESULT_INVALID',
              cause: error,
            });
          }
          if (
            typeof serialized === 'string' &&
            Buffer.byteLength(serialized, 'utf8') > MCP_TOOL_RESULT_MAX_JSON_BYTES
          ) {
            throw new PiMcpAdapterError('MCP tool result exceeds size limit', {
              code: 'MCP_TOOL_RESULT_TOO_LARGE',
            });
          }
          // MCP is outside the trust boundary. Its result is model-visible, so
          // sanitize both structured credential fields and credentials embedded
          // in free text before Pi receives it.
          return redactPayload(result, { maxString: 32_768 });
        },
      };
      extension.tools.set(mapping.name, {
        definition,
        sourceInfo: proxyRegistration.sourceInfo ?? extension.sourceInfo,
      });
    }
    return base;
  };
}

/**
 * Materialize one run/session-scoped vendor binding.
 *
 * @param {{
 *   mcpServers?: unknown,
 *   serverRegistry?: unknown,
 *   secretResolver?: (ref: string) => unknown | Promise<unknown>,
 *   agentSessionId?: string,
 *   cwd?: string,
 *   agentDir?: string,
 *   runtimeRoot?: string,
 *   context?: { traceId?: string, traceState?: string|null },
 *   spanRandomBytes?: (size: number) => Uint8Array,
 *   packageResolver?: typeof resolvePiMcpAdapterPackage,
 *   fsImpl?: typeof fs,
 * }} [options]
 */
export async function createPiMcpAdapter(options = {}) {
  const config = loadMcpConfig(options.mcpServers ?? []);
  if (config.length === 0) {
    return Object.freeze({
      enabled: false,
      config,
      extensionPath: null,
      configPath: null,
      extensionFlagValues: null,
      extensionsOverride: null,
      tools: Object.freeze([]),
      cleanup: async () => {},
    });
  }

  const agentSessionId = String(options.agentSessionId ?? '').trim();
  if (!SERVER_ID_PATTERN.test(agentSessionId)) {
    throw new PiMcpAdapterError('agentSessionId is required for MCP runtime binding', {
      code: 'PI_MCP_ADAPTER_BIND_FAILED',
    });
  }
  const registry = loadMcpServerRegistry(options.serverRegistry ?? []);
  const secretResolver =
    options.secretResolver ?? createEnvironmentSecretResolver(process.env);
  await assertNoAmbientMcpConfig(options);
  const traceContext = normalizeMcpTraceContext(
    options.context,
    options.spanRandomBytes,
  );
  const vendor = await buildVendorConfig(
    config,
    registry,
    secretResolver,
    traceContext,
  );
  const pkg = await (options.packageResolver ?? resolvePiMcpAdapterPackage)();

  const fsApi = options.fsImpl ?? fs;
  const root = path.resolve(
    options.runtimeRoot ?? path.join(os.tmpdir(), 'pi-enterprise-mcp-runtime'),
  );
  let runtimeDir = null;
  try {
    await fsApi.mkdir(root, { recursive: true, mode: 0o700 });
    runtimeDir = await fsApi.mkdtemp(path.join(root, `${agentSessionId}-`));
    await fsApi.chmod(runtimeDir, 0o700);
    const configPath = path.join(runtimeDir, 'mcp.json');
    await fsApi.writeFile(
      configPath,
      `${JSON.stringify({
        mcpServers: vendor.mcpServers,
        settings: vendor.settings,
      })}\n`,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );
    await fsApi.chmod(configPath, 0o600);

    const binding = {
      enabled: true,
      config,
      adapterVersion: pkg.version,
      extensionPath: pkg.extensionPath,
      configPath,
      extensionFlagValues: new Map([['mcp-config', configPath]]),
      tools: vendor.tools,
      cleanup: async () => {
        if (!runtimeDir) return;
        const owned = runtimeDir;
        runtimeDir = null;
        await fsApi.rm(owned, { recursive: true, force: true });
      },
    };
    binding.extensionsOverride = createMcpExtensionsOverride(binding);
    return binding;
  } catch (error) {
    if (runtimeDir) {
      await fsApi.rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    }
    if (error instanceof PiMcpAdapterError || error instanceof McpConfigError) {
      throw error;
    }
    throw new PiMcpAdapterError('Failed to materialize private MCP runtime config', {
      code: 'PI_MCP_ADAPTER_BIND_FAILED',
      cause: error,
    });
  }
}

/** Alias retained for existing infrastructure callers. */
export async function resolveMcpBinding(mcpServers, options = {}) {
  return createPiMcpAdapter({ ...options, mcpServers });
}

/**
 * Restrict an AgentVersion's declared mcpServers/enabledTools to the
 * intersection with the deployment registry's discovered surface. The
 * registry is the connectivity catalog (what CAN be reached); the
 * AgentVersion's declaration can only narrow that surface, never widen it.
 * Servers the AgentVersion references that are absent from the registry
 * surface are dropped rather than granted.
 *
 * @param {ReadonlyArray<ReturnType<typeof loadMcpConfig>[number]>} declared
 * @param {ReadonlyArray<ReturnType<typeof loadMcpConfig>[number]>} registrySurface
 */
function intersectMcpConfigWithRegistry(declared, registrySurface) {
  const bySurfaceId = new Map(
    registrySurface.map((server) => [server.serverId, server]),
  );
  const out = [];
  for (const server of declared) {
    const surfaced = bySurfaceId.get(server.serverId);
    if (!surfaced) continue;
    const allowedTools = new Set(surfaced.enabledTools);
    const enabledTools = Object.freeze(
      server.enabledTools.filter((tool) => allowedTools.has(tool)),
    );
    // Prefer discovery schemas (registry surface) for allowed tools.
    const surfaceSchemas =
      surfaced.toolInputSchemas != null &&
      typeof surfaced.toolInputSchemas === 'object'
        ? /** @type {Record<string, unknown>} */ (surfaced.toolInputSchemas)
        : null;
    const declaredSchemas =
      server.toolInputSchemas != null && typeof server.toolInputSchemas === 'object'
        ? /** @type {Record<string, unknown>} */ (server.toolInputSchemas)
        : null;
    /** @type {Record<string, unknown> | null} */
    let toolInputSchemas = null;
    if (surfaceSchemas || declaredSchemas) {
      /** @type {Record<string, unknown>} */
      const merged = {};
      for (const tool of enabledTools) {
        if (surfaceSchemas?.[tool] != null) merged[tool] = surfaceSchemas[tool];
        else if (declaredSchemas?.[tool] != null) merged[tool] = declaredSchemas[tool];
      }
      toolInputSchemas = Object.freeze(merged);
    }
    const surfaceDescriptions =
      surfaced.toolDescriptions != null &&
      typeof surfaced.toolDescriptions === 'object'
        ? /** @type {Record<string, unknown>} */ (surfaced.toolDescriptions)
        : null;
    const declaredDescriptions =
      server.toolDescriptions != null && typeof server.toolDescriptions === 'object'
        ? /** @type {Record<string, unknown>} */ (server.toolDescriptions)
        : null;
    /** @type {Record<string, string> | null} */
    let toolDescriptions = null;
    if (surfaceDescriptions || declaredDescriptions) {
      /** @type {Record<string, string>} */
      const merged = {};
      for (const tool of enabledTools) {
        if (typeof surfaceDescriptions?.[tool] === 'string') {
          merged[tool] = surfaceDescriptions[tool];
        } else if (typeof declaredDescriptions?.[tool] === 'string') {
          merged[tool] = declaredDescriptions[tool];
        }
      }
      toolDescriptions = Object.freeze(merged);
    }
    out.push(
      Object.freeze({
        ...server,
        enabledTools,
        toolInputSchemas,
        toolDescriptions,
      }),
    );
  }
  return Object.freeze(out);
}

/**
 * Build the per-create resolver consumed by PiRuntimeFactory.
 *
 * @param {{
 *   serverRegistry?: unknown,
 *   secretResolver?: (ref: string) => unknown | Promise<unknown>,
 *   runtimeRoot?: string,
 *   spanRandomBytes?: (size: number) => Uint8Array,
 *   packageResolver?: typeof resolvePiMcpAdapterPackage,
 *   defaultMcpServers?: unknown,
 * }} [options]
 */
export function createPiMcpResolver(options = {}) {
  // Validate deployment config during assembly, before the first model request.
  const registry = loadMcpServerRegistry(options.serverRegistry ?? []);
  /**
   * Live catalog of discovered MCP servers. Prefer a getter so a later
   * rediscovery (worker recovered after a cold-start SSE 405) is visible to
   * every subsequent run without rebuilding the Pi runtime factory.
   * @returns {unknown}
   */
  const readDefaultMcpServers = () => {
    if (typeof options.getDefaultMcpServers === 'function') {
      return options.getDefaultMcpServers();
    }
    return options.defaultMcpServers ?? [];
  };
  const resolveDefaultMcpServers = () => loadMcpConfig(readDefaultMcpServers() ?? []);

  const resolver = async function resolveForRuntime(input) {
    // The deployment registry's discovered surface (defaultMcpServers) is the
    // connectivity catalog. When it is empty (no discovery wired), defer to
    // whatever the caller requested, unchanged. When it is populated: an
    // AgentVersion that declares its own mcpServers/enabledTools allowlist is
    // ALWAYS intersected with that surface -- it must never inherit the full
    // registry just because the registry happens to be non-empty. Re-derive
    // the declaration from the raw AgentVersion (not `input.mcpServers`,
    // which the caller may have already collapsed to the registry default)
    // so an absent/null declaration -- nothing to restrict to -- still
    // inherits the full surface.
    const defaultMcpServers = resolveDefaultMcpServers();
    const declaredMcpServers = loadMcpConfigFromAgentVersion(
      input.agentVersion ?? null,
    );
    const mcpServers =
      defaultMcpServers.length === 0
        ? input.mcpServers
        : declaredMcpServers.length > 0
          ? intersectMcpConfigWithRegistry(declaredMcpServers, defaultMcpServers)
          : defaultMcpServers;
    return createPiMcpAdapter({
      mcpServers,
      serverRegistry: [...registry.values()].map((entry) => ({
        id: entry.serverId,
        enabled: entry.enabled,
        url: entry.url,
        command: entry.command,
        args: [...entry.args],
        cwd: entry.cwd,
        auth: entry.auth,
        authTokenRef: entry.authTokenRef,
        envRefs: cloneJson(entry.envRefs),
        headerRefs: cloneJson(entry.headerRefs),
        timeoutMs: entry.timeoutMs,
        transport: entry.transport,
      })),
      secretResolver: options.secretResolver,
      runtimeRoot: options.runtimeRoot,
      packageResolver: options.packageResolver,
      agentSessionId: input.agentSession?.agentSessionId,
      cwd: input.cwd,
      agentDir: input.agentDir,
      context: input.context,
      spanRandomBytes: options.spanRandomBytes,
    });
  };
  // PiRuntimeFactory reads this before it decides whether to materialize the
  // extension. Use a live getter so rediscovery can unlock MCP mid-process.
  Object.defineProperty(resolver, 'defaultMcpServers', {
    enumerable: true,
    configurable: true,
    get: () => resolveDefaultMcpServers(),
  });
  return resolver;
}

/**
 * Convert AgentVersion server policies into the existing enterprise-policy
 * input shape. Only enabled tools are projected.
 *
 * Also projects `toolPolicy.riskLevel` / `toolPolicy.toolRiskLevels` into the
 * AgentVersion risk-table layer, so an MCP server's risk is configured next to
 * the rest of its policy instead of in a second unrelated file.
 *
 * @param {unknown} raw
 */
export function buildMcpPolicyBindings(raw) {
  const logical =
    raw &&
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    (Object.hasOwn(raw, 'configJson') || Object.hasOwn(raw, 'config_json'))
      ? loadMcpConfigFromAgentVersion(raw)
      : loadMcpConfig(raw ?? []);
  /** @type {Record<string, Record<string, unknown>>} */
  const mcpServerPolicies = {};
  /** @type {Record<string, { riskLevel?: string, tools?: Record<string, string> }>} */
  const riskServers = {};
  for (const server of logical) {
    mcpServerPolicies[server.serverId] = {
      ...server.toolPolicy,
      tools:
        server.toolPolicy.tools && typeof server.toolPolicy.tools === 'object'
          ? { ...server.toolPolicy.tools }
          : undefined,
    };

    const riskLevel = server.toolPolicy.riskLevel;
    const toolRiskLevels = server.toolPolicy.toolRiskLevels;
    if (riskLevel || toolRiskLevels) {
      riskServers[server.serverId] = {
        ...(riskLevel ? { riskLevel: String(riskLevel) } : {}),
        ...(toolRiskLevels && typeof toolRiskLevels === 'object'
          ? { tools: { .../** @type {object} */ (toolRiskLevels) } }
          : {}),
      };
    }
  }
  return Object.freeze({
    mcpServerPolicies: Object.freeze(mcpServerPolicies),
    mcpToolRiskPolicy: Object.freeze(
      Object.keys(riskServers).length > 0
        ? { mcpServers: Object.freeze(riskServers) }
        : {},
    ),
  });
}
