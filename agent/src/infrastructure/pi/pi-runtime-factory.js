/**
 * PiRuntimeFactory (PR-05) — create managed Pi runtimes from immutable Agent Version config.
 *
 * Canonical path only: createAgentSessionRuntime once, with createAgentSessionFromServices
 * invoked exactly once per runtime factory invocation. Injected services are reused
 * inside the createRuntime closure — never a direct createFromServices bypass.
 *
 * The fail-closed AgentVersion binding rules live in `agent-version-bindings.js`
 * and are re-exported here so this stays the single entry point; systemPrompt is
 * passed via createAgentSessionServices.resourceLoaderOptions.systemPrompt.
 *
 * Public root exports only from @earendil-works/pi-coding-agent@0.80.3.
 */

import { PiRuntimeFactoryError } from './errors.js';
import { PiSessionAdapter } from './pi-session-adapter.js';
import { createRunSettingsManager } from '../../application/context-policy-service.js';
import { LOGICAL_WORKSPACE_ROOT } from '../../extensions/sandbox-bridge/constants.js';
import { PINNED_PI_SDK_VERSION } from './pi-runtime-constants.js';
import {
  bindAgentVersionConfig,
  resolveAgentVersionBindings,
  resolveConcreteModel,
} from './agent-version-bindings.js';

// Re-exported so existing importers keep a single entry point for the factory
// and the binding rules it enforces.
export {
  LOCAL_FILESYSTEM_TOOL_NAMES,
  PINNED_PI_SDK_VERSION,
} from './pi-runtime-constants.js';
export {
  AGENT_VERSION_THINKING_LEVELS,
  assertModelShape,
  bindAgentVersionConfig,
  createSkillAllowlistOverride,
  deepFreezeClone,
  modelIdentityEqual,
  normalizeThinkingLevel,
  resolveAgentVersionBindings,
  resolveConcreteModel,
} from './agent-version-bindings.js';

async function defaultLoadSdk() {
  return import('@earendil-works/pi-coding-agent');
}

/**
 * Fail closed unless installed package VERSION matches pin.
 * @param {any} sdk
 */
export function assertSdkVersionPinned(sdk) {
  const version = sdk?.VERSION != null ? String(sdk.VERSION) : '';
  if (version !== PINNED_PI_SDK_VERSION) {
    throw new PiRuntimeFactoryError(
      `Installed @earendil-works/pi-coding-agent VERSION is ${version || '(missing)'}, expected exact ${PINNED_PI_SDK_VERSION}`,
      { code: 'PI_SDK_VERSION_MISMATCH' },
    );
  }
}

/**
 * Build ExtensionBindings for session.bindExtensions (Pi public API).
 * @param {{
 *   mode?: string,
 *   abortHandler?: () => void,
 *   shutdownHandler?: () => void | Promise<void>,
 *   onError?: (err: object) => void,
 *   uiContext?: object,
 *   commandContextActions?: object,
 * }} [opts]
 */
export function buildExtensionBindings(opts = {}) {
  /** @type {Record<string, unknown>} */
  const bindings = {
    mode: opts.mode ?? 'rpc',
  };
  if (opts.uiContext !== undefined) bindings.uiContext = opts.uiContext;
  if (opts.commandContextActions !== undefined) {
    bindings.commandContextActions = opts.commandContextActions;
  }
  if (typeof opts.abortHandler === 'function') {
    bindings.abortHandler = opts.abortHandler;
  } else {
    bindings.abortHandler = () => {};
  }
  if (typeof opts.shutdownHandler === 'function') {
    bindings.shutdownHandler = opts.shutdownHandler;
  } else {
    bindings.shutdownHandler = () => {};
  }
  if (typeof opts.onError === 'function') {
    bindings.onError = opts.onError;
  } else {
    bindings.onError = () => {};
  }
  return bindings;
}

/**
 * Fail-closed check: resource loader / services must not report extension errors.
 * @param {any} services
 * @param {any} session
 */
export function assertExtensionsLoadedClean(services, session) {
  const loader = services?.resourceLoader;
  const extResult =
    loader && typeof loader.getExtensions === 'function'
      ? loader.getExtensions()
      : loader?.extensionsResult ?? null;
  const errors = Array.isArray(extResult?.errors) ? extResult.errors : [];
  if (errors.length > 0) {
    const msg = errors
      .map((e) => `${e.path || '?'}: ${e.error || e.message || 'error'}`)
      .join('; ');
    throw new PiRuntimeFactoryError(
      `Extension discovery/load failed (fail-closed): ${msg}`,
      { code: 'PI_EXTENSION_LOAD_FAILED' },
    );
  }
  const diagnostics = Array.isArray(services?.diagnostics)
    ? services.diagnostics.filter((item) => item?.type === 'error')
    : [];
  if (diagnostics.length > 0) {
    throw new PiRuntimeFactoryError(
      `Extension service initialization failed (fail-closed): ${diagnostics
        .map((item) => String(item.message || 'error'))
        .join('; ')}`,
      { code: 'PI_EXTENSION_LOAD_FAILED' },
    );
  }
  // If factories were requested, ensure runner exists after bind path.
  void session;
}

export class PiRuntimeFactory {
  /**
   * @param {{
   *   loadSdk?: () => Promise<any>,
   *   sessionAdapter?: PiSessionAdapter,
   *   createServices?: (opts: object) => Promise<any>,
   *   createFromServices?: (opts: object) => Promise<any>,
   *   createRuntime?: (factory: any, opts: object) => Promise<any>,
   *   extensionFactories?: unknown[],
   *   skillsOverride?: Function,
   *   customTools?: unknown[],
   *   tools?: string[],
   *   mcpResolver?: Function | object | null,
   *   toolPolicyBinding?: object | null,
     *   defaultCwd?: string,
   *   agentDir?: string,
   *   additionalSkillPaths?: string[],
   *   skillRoot?: string,
   *   workspaceRoot?: string,
   *   bindExtensions?: boolean,
   *   extensionMode?: string,
   * }} [deps]
   */
  constructor(deps = {}) {
    this.loadSdk = deps.loadSdk ?? defaultLoadSdk;
    this.sessionAdapter = deps.sessionAdapter ?? new PiSessionAdapter();
    this.createServices = deps.createServices ?? null;
    this.createFromServices = deps.createFromServices ?? null;
    this.createRuntime = deps.createRuntime ?? null;
    // Constructor defaults only — each create() prefers input.extensionFactories
    // (per-run resolved bundle; no process-global mutable state).
    this.extensionFactories = deps.extensionFactories ?? [];
    this.skillsOverride = deps.skillsOverride ?? null;
    this.customTools = deps.customTools ?? null;
    this.tools = deps.tools ?? null;
    this.mcpResolver = deps.mcpResolver ?? null;
    this.toolPolicyBinding = deps.toolPolicyBinding ?? null;
    this.excludeTools = Array.isArray(deps.excludeTools)
      ? [...deps.excludeTools]
      : null;
    this.defaultCwd = deps.defaultCwd ?? process.cwd();
    this.agentDir = deps.agentDir ?? null;
    this.additionalSkillPaths = Array.isArray(deps.additionalSkillPaths)
      ? [...deps.additionalSkillPaths]
      : [];
    this.skillRoot = deps.skillRoot ?? null;
    this.workspaceRoot = deps.workspaceRoot ?? LOGICAL_WORKSPACE_ROOT;
    this.bindExtensionsEnabled = deps.bindExtensions !== false;
    this.extensionMode = deps.extensionMode ?? 'rpc';
  }

  /**
   * @param {{
   *   context?: object,
   *   agentVersion: object,
   *   agentSession: { agentSessionId: string, workspaceId?: string },
   *   piSnapshot?: { snapshotJson: object, checksum?: string } | null,
   *   cwd?: string,
   *   agentDir?: string,
   *   model?: object | null,
   *   requestAuth?: { provider?: string, apiKey?: string } | null,
   *   sessionManager?: any,
   *   services?: any,
   *   extensionFactories?: unknown[],
   *   skillsOverride?: Function,
   *   customTools?: unknown[],
   *   tools?: string[],
   *   mcpResolver?: Function | object | null,
   *   toolPolicyBinding?: object | null,
     *   bindExtensions?: boolean,
   *   abortHandler?: () => void,
   *   shutdownHandler?: () => void | Promise<void>,
   *   onExtensionError?: (err: object) => void,
   *   runEventRecorder?: object | null,
   * }} input
   */
  async create(input) {
    if (!input?.agentSession?.agentSessionId) {
      throw new PiRuntimeFactoryError('agentSession.agentSessionId is required', {
        code: 'PI_RUNTIME_INPUT_INVALID',
      });
    }
    const agentDir = String(input.agentDir ?? this.agentDir ?? '').trim();
    if (!agentDir) {
      throw new PiRuntimeFactoryError(
        'agentDir is required (concrete string; set AGENT_PI_AGENT_DIR or pass agentDir)',
        { code: 'PI_AGENT_DIR_REQUIRED' },
      );
    }

    // Per-create resolved factories (never mutate constructor defaults mid-flight).
    const resolvedExtensionFactories =
      input.extensionFactories !== undefined
        ? input.extensionFactories
        : this.extensionFactories;

    const bound = bindAgentVersionConfig(input.agentVersion);
    const cwd = input.cwd || this.defaultCwd;
    const agentSessionId = String(input.agentSession.agentSessionId);

    // Immutable AgentVersion model pin + policy constraints.
    const model = resolveConcreteModel(bound, input.model ?? null);

    let sessionManager = input.sessionManager ?? null;
    /** @type {string | null} */
    let ownedSessionDir = null;
    /** @type {any} */
    let runtime = null;
    /** @type {any} */
    let mcpBinding = null;
    /** @type {ReturnType<typeof resolveAgentVersionBindings> | null} */
    let bindings = null;
    let disposed = false;
    /** @type {number} */
    let bindCount = 0;

    const cleanupOwned = async () => {
      if (mcpBinding && typeof mcpBinding.cleanup === 'function') {
        try {
          await mcpBinding.cleanup();
        } catch {
          /* best-effort */
        }
        mcpBinding = null;
      }
      if (ownedSessionDir) {
        try {
          await this.sessionAdapter.dispose({ paths: [ownedSessionDir] });
        } catch {
          /* best-effort */
        }
        ownedSessionDir = null;
      }
    };

    const disposeRuntimeBestEffort = async (rt) => {
      if (rt && typeof rt.dispose === 'function') {
        try {
          await rt.dispose();
        } catch {
          /* best-effort */
        }
      }
    };

    let shouldBind = false;

    /**
     * bindExtensions exactly once per session instance; re-invoked on rebind.
     * @param {any} session
     * @param {any} runtimeHost
     */
    const bindSessionExtensions = async (session, runtimeHost) => {
      if (!shouldBind) return;
      if (!session || typeof session.bindExtensions !== 'function') {
        throw new PiRuntimeFactoryError(
          'session.bindExtensions is required when extensionFactories are configured',
          { code: 'PI_BIND_EXTENSIONS_MISSING' },
        );
      }
      // Fail-closed on every (re)bind, not just initial creation: fork()/
      // newSession()/switchSession() rebind through this same helper via
      // runtime.setRebindSession(), and must not silently continue if the
      // resource loader recorded extension load errors.
      assertExtensionsLoadedClean(runtimeHost?.services, session);
      const extensionBindings = buildExtensionBindings({
        mode: this.extensionMode,
        abortHandler:
          input.abortHandler ??
          (() => {
            try {
              session.abort?.();
            } catch {
              /* best-effort */
            }
          }),
        shutdownHandler: input.shutdownHandler,
        onError: input.onExtensionError,
        commandContextActions: runtimeHost
          ? {
              waitForIdle: () =>
                session.agent?.waitForIdle?.() ?? Promise.resolve(),
              newSession: async (options) =>
                runtimeHost.newSession?.(options) ?? { cancelled: true },
              fork: async (entryId, forkOptions) =>
                runtimeHost.fork?.(entryId, forkOptions) ?? {
                  cancelled: true,
                },
              navigateTree: async (targetId, options) =>
                session.navigateTree?.(targetId, options) ?? {
                  cancelled: true,
                },
              switchSession: async (sessionPath, options) =>
                runtimeHost.switchSession?.(sessionPath, options) ?? {
                  cancelled: true,
                },
              reload: async () => {
                await session.reload?.();
              },
            }
          : undefined,
      });
      await session.bindExtensions(extensionBindings);
      bindCount += 1;
    };

    try {
      const configuredMcpResolver = input.mcpResolver ?? this.mcpResolver;
      const defaultMcpServers =
        configuredMcpResolver &&
        typeof configuredMcpResolver === 'function' &&
        Array.isArray(configuredMcpResolver.defaultMcpServers)
          ? configuredMcpResolver.defaultMcpServers
          : [];
      const requestedMcpServers =
        defaultMcpServers.length > 0 ? defaultMcpServers : bound.mcpServers;
      if (requestedMcpServers.length > 0) {
        try {
          mcpBinding =
            typeof configuredMcpResolver === 'function'
              ? await configuredMcpResolver({
                  mcpServers: requestedMcpServers,
                  agentVersion: input.agentVersion,
                  agentSession: input.agentSession,
                  cwd,
                  agentDir,
                  context: input.context ?? null,
                })
              : configuredMcpResolver;
        } catch (error) {
          throw new PiRuntimeFactoryError(
            error instanceof Error
              ? `MCP runtime binding failed: ${error.message}`
              : 'MCP runtime binding failed',
            { code: /** @type {any} */ (error)?.code ?? 'PI_MCP_BIND_FAILED' },
          );
        }
        if (
          !mcpBinding ||
          mcpBinding.enabled !== true ||
          typeof mcpBinding.extensionPath !== 'string' ||
          !mcpBinding.extensionPath ||
          !(mcpBinding.extensionFlagValues instanceof Map) ||
          typeof mcpBinding.extensionsOverride !== 'function'
        ) {
          throw new PiRuntimeFactoryError(
            'MCP resolver must return an enabled vendor extension binding',
            { code: 'PI_MCP_BIND_FAILED' },
          );
        }
      }

      const skillPaths =
        Array.isArray(input.additionalSkillPaths) &&
        input.additionalSkillPaths.length
          ? input.additionalSkillPaths
          : this.additionalSkillPaths;
      bindings = resolveAgentVersionBindings(bound, {
        extensionFactories: resolvedExtensionFactories,
        skillsOverride: input.skillsOverride ?? this.skillsOverride ?? undefined,
        customTools: input.customTools ?? this.customTools ?? undefined,
        tools: input.tools ?? this.tools ?? undefined,
        mcpResolver: mcpBinding,
        toolPolicyBinding: input.toolPolicyBinding ?? this.toolPolicyBinding,
        excludeTools: input.excludeTools ?? this.excludeTools ?? undefined,
        additionalSkillPaths: skillPaths,
        skillRoot: input.skillRoot ?? this.skillRoot ?? undefined,
        workspaceRoot:
          input.workspaceRoot ?? this.workspaceRoot ?? LOGICAL_WORKSPACE_ROOT,
      });
      shouldBind =
        (input.bindExtensions ?? this.bindExtensionsEnabled) !== false &&
        ((Array.isArray(bindings.extensionFactories) &&
          bindings.extensionFactories.length > 0) ||
          mcpBinding?.enabled === true);

      if (!sessionManager) {
        if (input.piSnapshot?.snapshotJson) {
          const opened = await this.sessionAdapter.openFromSnapshot({
            agentSessionId,
            payload: input.piSnapshot.snapshotJson,
            cwd,
            expectedChecksum: input.piSnapshot.checksum ?? null,
          });
          sessionManager = opened.sessionManager;
          ownedSessionDir = opened.sessionDir;
        } else {
          const created = await this.sessionAdapter.createNew({
            agentSessionId,
            cwd,
          });
          sessionManager = created.sessionManager;
          ownedSessionDir = created.sessionDir;
        }
      }

      const sdk = await this.loadSdk();
      assertSdkVersionPinned(sdk);

      // Pi resolves provider credentials through ModelRegistry. Keep the key in
      // request-owned in-memory AuthStorage, never in the model descriptor.
      let authStorage = input.authStorage ?? null;
      const requestAuth = input.requestAuth;
      if (!authStorage && requestAuth?.apiKey) {
        const provider = String(
          requestAuth.provider || model?.provider || '',
        ).trim();
        if (!provider) {
          throw new PiRuntimeFactoryError(
            'requestAuth.provider is required when an API key is supplied',
            { code: 'PI_REQUEST_AUTH_INVALID' },
          );
        }
        if (model?.provider && provider !== String(model.provider)) {
          throw new PiRuntimeFactoryError(
            'requestAuth.provider must match model.provider',
            { code: 'PI_REQUEST_AUTH_INVALID' },
          );
        }
        if (typeof sdk.AuthStorage?.inMemory !== 'function') {
          throw new PiRuntimeFactoryError(
            'SDK AuthStorage.inMemory is required for request-scoped provider auth',
            { code: 'PI_REQUEST_AUTH_UNAVAILABLE' },
          );
        }
        authStorage = sdk.AuthStorage.inMemory({
          [provider]: { type: 'api_key', key: String(requestAuth.apiKey) },
        });
      }

      const createServices = this.createServices ?? sdk.createAgentSessionServices;
      const createFromServices =
        this.createFromServices ?? sdk.createAgentSessionFromServices;
      const createAgentSessionRuntime =
        this.createRuntime ?? sdk.createAgentSessionRuntime;

      if (
        typeof createServices !== 'function' ||
        typeof createFromServices !== 'function' ||
        typeof createAgentSessionRuntime !== 'function'
      ) {
        throw new PiRuntimeFactoryError(
          'SDK missing createAgentSessionServices / createAgentSessionFromServices / createAgentSessionRuntime',
          { code: 'PI_SDK_EXPORT_MISSING' },
        );
      }

      const injectedServices = input.services ?? null;

      const createRuntime = async (opts) => {
        const resourceLoaderOptions = {
          ...bindings.resourceLoaderOptions,
        };
        if (mcpBinding?.enabled) {
          resourceLoaderOptions.additionalExtensionPaths = [
            ...(Array.isArray(resourceLoaderOptions.additionalExtensionPaths)
              ? resourceLoaderOptions.additionalExtensionPaths
              : []),
            mcpBinding.extensionPath,
          ];
          const existingOverride = resourceLoaderOptions.extensionsOverride;
          resourceLoaderOptions.extensionsOverride = (base) =>
            mcpBinding.extensionsOverride(
              typeof existingOverride === 'function'
                ? existingOverride(base)
                : base,
            );
        }
        // AgentVersion owns compaction policy, so the settings manager is built
        // here rather than left to the SDK default. It must be injected — not
        // patched after the fact: SettingsManager.save() rebuilds its effective
        // settings from globalSettings/projectSettings, so anything layered on
        // top afterwards is dropped the first time a Run persists any setting
        // (setModel, setThinkingLevel, setAutoCompactionEnabled, …).
        const settingsManager =
          typeof sdk.SettingsManager?.inMemory === 'function'
            ? createRunSettingsManager(sdk.SettingsManager, {
                cwd: opts.cwd,
                agentDir: opts.agentDir,
                policy: bindings.contextPolicy,
                defaults: sdk.DEFAULT_COMPACTION_SETTINGS,
              })
            : null;

        const services =
          injectedServices ??
          (await createServices({
            cwd: opts.cwd,
            agentDir: opts.agentDir,
            ...(authStorage ? { authStorage } : {}),
            ...(settingsManager ? { settingsManager } : {}),
            resourceLoaderOptions,
            ...(mcpBinding?.enabled
              ? { extensionFlagValues: mcpBinding.extensionFlagValues }
              : {}),
          }));

        // Fail-closed on extension load errors before session create.
        assertExtensionsLoadedClean(services, null);

        /** @type {Record<string, unknown>} */
        const fromServicesOpts = {
          services,
          sessionManager: opts.sessionManager,
          model,
          sessionStartEvent: opts.sessionStartEvent,
        };
        if (bindings.tools) fromServicesOpts.tools = bindings.tools;
        if (bindings.customTools) {
          fromServicesOpts.customTools = bindings.customTools;
        }
        // Applied after `tools` by the SDK, so it holds even if an AgentVersion
        // ever ships a tool allowlist that names a local filesystem tool.
        if (bindings.excludeTools?.length) {
          fromServicesOpts.excludeTools = [...bindings.excludeTools];
        }
        // The SDK clamps this against the model's thinkingLevelMap, so an
        // AgentVersion asking for more depth than its model offers degrades
        // to the nearest supported level rather than failing the Run.
        if (bindings.thinkingLevel) {
          fromServicesOpts.thinkingLevel = bindings.thinkingLevel;
        }
        const result = await createFromServices(fromServicesOpts);
        if (!result?.session) {
          throw new PiRuntimeFactoryError(
            'createAgentSessionFromServices did not return a session',
            { code: 'PI_RUNTIME_CREATE_FAILED' },
          );
        }
        return {
          ...result,
          services,
          diagnostics: services.diagnostics ?? [],
        };
      };

      runtime = await createAgentSessionRuntime(createRuntime, {
        cwd,
        agentDir,
        sessionManager,
      });

      if (!runtime || typeof runtime !== 'object' || !runtime.session) {
        throw new PiRuntimeFactoryError(
          'createAgentSessionRuntime did not return a valid runtime with session',
          { code: 'PI_RUNTIME_CREATE_FAILED' },
        );
      }

      assertExtensionsLoadedClean(runtime.services, runtime.session);

      // bindExtensions exactly once after createFromServices path completed.
      try {
        await bindSessionExtensions(runtime.session, runtime);
      } catch (bindErr) {
        await disposeRuntimeBestEffort(runtime);
        runtime = null;
        throw bindErr instanceof PiRuntimeFactoryError
          ? bindErr
          : new PiRuntimeFactoryError(
              bindErr instanceof Error ? bindErr.message : String(bindErr),
              { code: 'PI_BIND_EXTENSIONS_FAILED' },
            );
      }

      // Session replacement must re-bind on the new session (not stale host).
      if (
        shouldBind &&
        runtime &&
        typeof runtime.setRebindSession === 'function'
      ) {
        runtime.setRebindSession(async () => {
          const next = runtime.session;
          await bindSessionExtensions(next, runtime);
        });
      }

      const dispose = async () => {
        if (disposed) return;
        disposed = true;
        try {
          if (typeof runtime.dispose === 'function') {
            await runtime.dispose();
          }
        } finally {
          await cleanupOwned();
        }
      };

      return {
        session: runtime.session,
        runtime,
        services: runtime.services,
        sessionManager,
        cwd: runtime.cwd ?? cwd,
        diagnostics: runtime.diagnostics ?? [],
        agentVersionId: bound.agentVersionId,
        bindings,
        bound,
        mcpBinding,
        model,
        bindCount,
        dispose,
      };
    } catch (err) {
      await disposeRuntimeBestEffort(runtime);
      await cleanupOwned();
      throw err;
    }
  }
}
