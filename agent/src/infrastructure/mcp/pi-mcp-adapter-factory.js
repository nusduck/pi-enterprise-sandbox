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

export class PiMcpAdapterError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, details?: object, cause?: unknown }} [opts]
   */
  constructor(message, opts = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'PiMcpAdapterError';
    this.code = opts.code ?? 'PI_MCP_ADAPTER_ERROR';
    this.details = opts.details ?? undefined;
  }
}

export const PI_MCP_ADAPTER_PACKAGE = 'pi-mcp-adapter';
export const PINNED_PI_MCP_ADAPTER_VERSION = '2.11.0';

const require = createRequire(import.meta.url);
const SECRET_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SERVER_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SENSITIVE_QUERY_KEY = /(?:token|secret|password|api[_-]?key|authorization)/i;
const RESERVED_TRACE_HEADER_NAMES = new Set([
  'traceparent',
  'tracestate',
  'x-trace-id',
]);
const RESERVED_TRACE_ENV_NAMES = new Set([
  'traceparent',
  'tracestate',
  'trace_id',
  'trace_state',
]);

/** @param {unknown} value */
function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

/**
 * @param {unknown} raw
 * @returns {unknown[]}
 */
function parseRegistryInput(raw) {
  if (raw == null || raw === '') return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('must be an array');
      return parsed;
    } catch (error) {
      throw new PiMcpAdapterError('MCP_SERVERS_JSON must be valid JSON array', {
        code: 'MCP_SERVER_REGISTRY_INVALID',
        cause: error,
      });
    }
  }
  throw new PiMcpAdapterError('MCP server registry must be an array or JSON array', {
    code: 'MCP_SERVER_REGISTRY_INVALID',
  });
}

/**
 * @param {unknown} raw
 * @param {string} field
 * @param {RegExp} keyPattern
 */
function parseReferenceMap(raw, field, keyPattern) {
  if (raw == null) return Object.freeze({});
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PiMcpAdapterError(`${field} must be an object of secret references`, {
      code: 'MCP_SERVER_REGISTRY_INVALID',
    });
  }
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const ref = String(value ?? '').trim();
    if (!keyPattern.test(key) || !ref) {
      throw new PiMcpAdapterError(`${field} contains an invalid key or secret reference`, {
        code: 'MCP_SERVER_REGISTRY_INVALID',
      });
    }
    out[key] = ref;
  }
  return Object.freeze(out);
}

/**
 * Validate the deployment-owned MCP registry. Plaintext credential-bearing
 * fields are rejected; values must be referenced through authTokenRef,
 * envRefs, or headerRefs.
 *
 * @param {unknown} raw
 * @returns {ReadonlyMap<string, Readonly<Record<string, unknown>>>}
 */
export function loadMcpServerRegistry(raw) {
  const entries = parseRegistryInput(raw);
  const registry = new Map();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new PiMcpAdapterError(`MCP_SERVERS_JSON[${index}] must be an object`, {
        code: 'MCP_SERVER_REGISTRY_INVALID',
      });
    }
    const value = /** @type {Record<string, unknown>} */ (entry);
    const serverId = String(value.id ?? value.serverId ?? '').trim();
    if (!SERVER_ID_PATTERN.test(serverId)) {
      throw new PiMcpAdapterError(`MCP_SERVERS_JSON[${index}].id is invalid`, {
        code: 'MCP_SERVER_REGISTRY_INVALID',
      });
    }
    if (registry.has(serverId)) {
      throw new PiMcpAdapterError(`duplicate MCP server registry id: ${serverId}`, {
        code: 'MCP_SERVER_REGISTRY_INVALID',
      });
    }
    for (const forbidden of [
      'token',
      'authToken',
      'bearerToken',
      'apiKey',
      'password',
      'secret',
      'headers',
      'env',
    ]) {
      if (Object.hasOwn(value, forbidden)) {
        throw new PiMcpAdapterError(
          `MCP_SERVERS_JSON[${index}].${forbidden} must not contain plaintext credentials; use a *Ref field`,
          { code: 'MCP_PLAINTEXT_SECRET_FORBIDDEN' },
        );
      }
    }

    const url = value.url == null ? null : String(value.url).trim();
    const command = value.command == null ? null : String(value.command).trim();
    if ((url ? 1 : 0) + (command ? 1 : 0) !== 1) {
      throw new PiMcpAdapterError(
        `MCP server ${serverId} must configure exactly one of url or command`,
        { code: 'MCP_SERVER_REGISTRY_INVALID' },
      );
    }
    if (url) {
      let parsed;
      try {
        parsed = new URL(url);
      } catch (error) {
        throw new PiMcpAdapterError(`MCP server ${serverId} has an invalid URL`, {
          code: 'MCP_SERVER_REGISTRY_INVALID',
          cause: error,
        });
      }
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
        throw new PiMcpAdapterError(
          `MCP server ${serverId} URL must be http(s) and must not embed credentials`,
          { code: 'MCP_SERVER_REGISTRY_INVALID' },
        );
      }
      for (const key of parsed.searchParams.keys()) {
        if (SENSITIVE_QUERY_KEY.test(key)) {
          throw new PiMcpAdapterError(
            `MCP server ${serverId} URL must not embed credential query parameters`,
            { code: 'MCP_PLAINTEXT_SECRET_FORBIDDEN' },
          );
        }
      }
    }

    const args = value.args == null ? [] : value.args;
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
      throw new PiMcpAdapterError(`MCP server ${serverId}.args must be strings`, {
        code: 'MCP_SERVER_REGISTRY_INVALID',
      });
    }
    const authTokenRef =
      value.authTokenRef == null ? null : String(value.authTokenRef).trim();
    if (authTokenRef === '') {
      throw new PiMcpAdapterError(`MCP server ${serverId}.authTokenRef is empty`, {
        code: 'MCP_SERVER_REGISTRY_INVALID',
      });
    }
    const auth = value.auth == null ? null : value.auth;
    if (auth !== null && auth !== false && !['bearer', 'oauth'].includes(String(auth))) {
      throw new PiMcpAdapterError(`MCP server ${serverId}.auth is invalid`, {
        code: 'MCP_SERVER_REGISTRY_INVALID',
      });
    }

    const timeoutMs = value.timeoutMs == null ? null : Number(value.timeoutMs);
    if (
      timeoutMs !== null &&
      (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000)
    ) {
      throw new PiMcpAdapterError(
        `MCP server ${serverId}.timeoutMs must be 1000..300000`,
        { code: 'MCP_SERVER_REGISTRY_INVALID' },
      );
    }

    registry.set(
      serverId,
      Object.freeze({
        serverId,
        enabled: value.enabled !== false,
        url,
        command,
        args: Object.freeze([...args]),
        cwd: value.cwd == null ? null : String(value.cwd).trim() || null,
        auth,
        authTokenRef,
        envRefs: parseReferenceMap(value.envRefs, `${serverId}.envRefs`, ENV_NAME_PATTERN),
        headerRefs: parseReferenceMap(
          value.headerRefs,
          `${serverId}.headerRefs`,
          HEADER_NAME_PATTERN,
        ),
        timeoutMs,
      }),
    );
  }
  return registry;
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
    for (const toolName of logical.enabledTools) {
      tools.push(
        Object.freeze({
          serverId: logical.serverId,
          toolName,
          name: mcpToolName(logical.serverId, toolName),
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
 * @param {{ extensionPath: string, tools: readonly {serverId:string,toolName:string,name:string}[] }} binding
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
      const definition = {
        name: mapping.name,
        label: `MCP: ${mapping.serverId}/${mapping.toolName}`,
        description: `Call allowlisted MCP tool ${mapping.toolName} on ${mapping.serverId}`,
        promptSnippet: `MCP tool ${mapping.name}`,
        parameters: Type.Object({}, { additionalProperties: true }),
        async execute(toolCallId, params, signal, onUpdate, context) {
          let args;
          try {
            args = JSON.stringify(params ?? {});
          } catch (error) {
            throw new PiMcpAdapterError('MCP tool arguments are not JSON serializable', {
              code: 'MCP_TOOL_ARGUMENTS_INVALID',
              cause: error,
            });
          }
          return proxy.execute(
            toolCallId,
            {
              server: mapping.serverId,
              tool: mapping.toolName,
              args,
            },
            signal,
            onUpdate,
            context,
          );
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
 * Build the per-create resolver consumed by PiRuntimeFactory.
 *
 * @param {{
 *   serverRegistry?: unknown,
 *   secretResolver?: (ref: string) => unknown | Promise<unknown>,
 *   runtimeRoot?: string,
 *   spanRandomBytes?: (size: number) => Uint8Array,
 *   packageResolver?: typeof resolvePiMcpAdapterPackage,
 * }} [options]
 */
export function createPiMcpResolver(options = {}) {
  // Validate deployment config during assembly, before the first model request.
  const registry = loadMcpServerRegistry(options.serverRegistry ?? []);
  return async function resolveForRuntime(input) {
    return createPiMcpAdapter({
      mcpServers: input.mcpServers,
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
}

/**
 * Convert AgentVersion server policies into the existing enterprise-policy
 * input shape. Only enabled tools are projected.
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
  for (const server of logical) {
    mcpServerPolicies[server.serverId] = {
      ...server.toolPolicy,
      tools:
        server.toolPolicy.tools && typeof server.toolPolicy.tools === 'object'
          ? { ...server.toolPolicy.tools }
          : undefined,
    };
  }
  return Object.freeze({ mcpServerPolicies: Object.freeze(mcpServerPolicies) });
}
