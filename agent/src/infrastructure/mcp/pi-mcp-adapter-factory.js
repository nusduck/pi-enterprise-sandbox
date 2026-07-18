/**
 * pi-mcp-adapter factory seam (plan §2.3 / §21 / PR-06).
 *
 * Strict offline rules:
 * - Does NOT implement MCP protocol (no fetch, JSON-RPC, SSE, tools/list).
 * - Does NOT fall back to legacy McpConnectionManager.
 * - Does NOT guess real package export names or parameter shapes.
 * - Zero MCP config → no load.
 * - Non-empty config without injected adapterBinder → fail closed.
 *
 * Production default (no adapterBinder): after confirming the module can be
 * loaded (or fails with UNAVAILABLE), throws PI_MCP_ADAPTER_API_UNVERIFIED
 * because the locked package API has not been approved from its .d.ts yet.
 *
 * Real binding is only via explicit injected `adapterBinder` — a **project
 * port**, not a claim about the vendor package surface.
 */

import { loadMcpConfig, McpConfigError } from './mcp-config-loader.js';

export class PiMcpAdapterError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, details?: object }} [opts]
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = 'PiMcpAdapterError';
    this.code = opts.code ?? 'PI_MCP_ADAPTER_ERROR';
    this.details = opts.details ?? undefined;
  }
}

/** Logical package id for the locked adapter (not claimed installed). */
export const PI_MCP_ADAPTER_PACKAGE = 'pi-mcp-adapter';

/**
 * @param {string} [specifier]
 * @returns {Promise<any>}
 */
async function defaultLoadAdapterModule(specifier = PI_MCP_ADAPTER_PACKAGE) {
  return import(specifier);
}

/**
 * Platform MCP binding result (project port — not vendor API).
 * @typedef {{
 *   enabled: boolean,
 *   config: ReturnType<typeof loadMcpConfig>,
 *   module: any | null,
 *   tools: unknown[],
 *   mcpResolver: ((...args: any[]) => any) | object | null,
 *   binding: any | null,
 * }} McpBindingResult
 */

/**
 * Resolve MCP binding from validated config.
 *
 * @param {{
 *   mcpServers?: unknown,
 *   loadAdapter?: (specifier?: string) => Promise<any>,
 *   adapterPackage?: string,
 *   adapterBinder?: (input: {
 *     module: any,
 *     config: ReturnType<typeof loadMcpConfig>,
 *     secretResolver?: Function | null,
 *   }) => Promise<{
 *     tools?: unknown[],
 *     mcpResolver?: any,
 *     binding?: any,
 *   }> | {
 *     tools?: unknown[],
 *     mcpResolver?: any,
 *     binding?: any,
 *   },
 *   secretResolver?: (secretRef: string) => Promise<unknown> | unknown,
 * }} [options]
 * @returns {Promise<McpBindingResult>}
 */
export async function createPiMcpAdapter(options = {}) {
  const config = loadMcpConfig(options.mcpServers ?? []);
  if (config.length === 0) {
    return {
      enabled: false,
      config,
      module: null,
      tools: [],
      mcpResolver: null,
      binding: null,
    };
  }

  const loadAdapter = options.loadAdapter ?? defaultLoadAdapterModule;
  const pkg = options.adapterPackage ?? PI_MCP_ADAPTER_PACKAGE;
  const binder = options.adapterBinder;

  // 1) Confirm module presence only (no export probing).
  let mod;
  try {
    mod = await loadAdapter(pkg);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new PiMcpAdapterError(
      `pi-mcp-adapter is unavailable while AgentVersion declares MCP servers (${config.length}). Install/lock ${pkg} or clear mcpServers. Underlying: ${msg}`,
      {
        code: 'PI_MCP_ADAPTER_UNAVAILABLE',
        details: {
          package: pkg,
          serverIds: config.map((s) => s.serverId),
        },
      },
    );
  }

  if (mod == null) {
    throw new PiMcpAdapterError(
      'pi-mcp-adapter module loaded but is empty/invalid',
      { code: 'PI_MCP_ADAPTER_UNAVAILABLE' },
    );
  }

  // 2) Real binding requires an explicit project-port binder.
  //    Without it, even if the module exists, production must not invent API.
  if (typeof binder !== 'function') {
    throw new PiMcpAdapterError(
      'pi-mcp-adapter package module is present (or loadable) but its public API is not yet verified against locked .d.ts. Inject adapterBinder (project port) after final approval, or clear mcpServers. Do not guess create* exports.',
      {
        code: 'PI_MCP_ADAPTER_API_UNVERIFIED',
        details: {
          package: pkg,
          serverIds: config.map((s) => s.serverId),
        },
      },
    );
  }

  // secretResolver is passed through; binder decides whether secrets are needed.
  // Never log secret values.
  let bound;
  try {
    bound = await binder({
      module: mod,
      config,
      secretResolver: options.secretResolver ?? null,
    });
  } catch (err) {
    if (err instanceof PiMcpAdapterError || err instanceof McpConfigError) {
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new PiMcpAdapterError(`adapterBinder failed: ${msg}`, {
      code: 'PI_MCP_ADAPTER_BIND_FAILED',
    });
  }

  if (!bound || typeof bound !== 'object') {
    throw new PiMcpAdapterError(
      'adapterBinder must return an object { tools?, mcpResolver?, binding? }',
      { code: 'PI_MCP_ADAPTER_BIND_FAILED' },
    );
  }

  const tools = Array.isArray(bound.tools) ? bound.tools : [];
  const mcpResolver =
    bound.mcpResolver !== undefined ? bound.mcpResolver : null;

  return {
    enabled: true,
    config,
    module: mod,
    tools,
    mcpResolver,
    binding: bound.binding ?? bound,
  };
}

/**
 * Fail-closed binding helper for PiRuntimeFactory mcpResolver.
 *
 * @param {unknown} mcpServers
 * @param {Parameters<typeof createPiMcpAdapter>[0]} [options]
 */
export async function resolveMcpBinding(mcpServers, options = {}) {
  try {
    return await createPiMcpAdapter({ ...options, mcpServers });
  } catch (err) {
    if (err instanceof McpConfigError || err instanceof PiMcpAdapterError) {
      throw err;
    }
    throw new PiMcpAdapterError(
      err instanceof Error ? err.message : String(err),
      { code: 'PI_MCP_ADAPTER_ERROR' },
    );
  }
}

// Explicitly document: do not import McpConnectionManager here.
// Legacy agent/infrastructure/mcp-connection-manager.js is non-production.
