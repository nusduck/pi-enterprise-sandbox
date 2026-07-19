/**
 * PiRuntimeFactory (PR-05) — create managed Pi runtimes from immutable Agent Version config.
 *
 * Canonical path only: createAgentSessionRuntime once, with createAgentSessionFromServices
 * invoked exactly once per runtime factory invocation. Injected services are reused
 * inside the createRuntime closure — never a direct createFromServices bypass.
 *
 * AgentVersion bindings are fail-closed:
 * - Full model in config cannot be overridden by a different input.model
 * - Logical modelPolicy references constrain resolver-supplied models
 * - Non-empty extensions/skills/mcpServers/toolPolicy/sandboxPolicy require explicit bindings
 * - systemPrompt is passed via createAgentSessionServices.resourceLoaderOptions.systemPrompt
 *
 * Public root exports only from @earendil-works/pi-coding-agent@0.80.3.
 */

import { PiRuntimeFactoryError } from './errors.js';
import { PiSessionAdapter } from './pi-session-adapter.js';
import {
  ENTERPRISE_EXTENSION_NAMES,
  assertExactEnterpriseExtensions,
} from '../../extensions/index.js';

/** Exact SDK pin for this factory revision. */
export const PINNED_PI_SDK_VERSION = '0.80.3';

/** @type {readonly string[]} */
export const REQUIRED_ENTERPRISE_EXTENSIONS = ENTERPRISE_EXTENSION_NAMES;

/**
 * Deep-clone then freeze plain JSON-compatible structures.
 * @param {unknown} value
 * @returns {unknown}
 */
export function deepFreezeClone(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const arr = value.map((v) => deepFreezeClone(v));
    return Object.freeze(arr);
  }
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, v] of Object.entries(/** @type {object} */ (value))) {
    out[k] = deepFreezeClone(v);
  }
  return Object.freeze(out);
}

/**
 * Require actual pi-ai Model fields whenever a model is supplied.
 * @param {unknown} model
 */
export function assertModelShape(model) {
  if (model == null) {
    throw new PiRuntimeFactoryError('model is required when supplied to runtime create', {
      code: 'PI_MODEL_SHAPE_INVALID',
    });
  }
  if (typeof model !== 'object' || Array.isArray(model)) {
    throw new PiRuntimeFactoryError('model must be an object', {
      code: 'PI_MODEL_SHAPE_INVALID',
    });
  }
  const m = /** @type {Record<string, unknown>} */ (model);
  for (const key of Object.keys(m)) {
    if (key === 'headers') continue;
    if (/(?:apiKey|api_key|secret|password)/i.test(key)) {
      throw new PiRuntimeFactoryError(
        'model must not embed credential fields at top level',
        { code: 'PI_MODEL_SHAPE_INVALID' },
      );
    }
  }
  if (typeof m.id !== 'string' || !m.id.trim()) {
    throw new PiRuntimeFactoryError('model.id is required', {
      code: 'PI_MODEL_SHAPE_INVALID',
    });
  }
  if (typeof m.name !== 'string' || !m.name.trim()) {
    throw new PiRuntimeFactoryError('model.name is required', {
      code: 'PI_MODEL_SHAPE_INVALID',
    });
  }
  if (typeof m.api !== 'string' || !m.api.trim()) {
    throw new PiRuntimeFactoryError('model.api is required', {
      code: 'PI_MODEL_SHAPE_INVALID',
    });
  }
  if (typeof m.provider !== 'string' || !m.provider.trim()) {
    throw new PiRuntimeFactoryError('model.provider is required', {
      code: 'PI_MODEL_SHAPE_INVALID',
    });
  }
  if (typeof m.baseUrl !== 'string') {
    throw new PiRuntimeFactoryError('model.baseUrl must be a string', {
      code: 'PI_MODEL_SHAPE_INVALID',
    });
  }
  if (typeof m.reasoning !== 'boolean') {
    throw new PiRuntimeFactoryError('model.reasoning must be a boolean', {
      code: 'PI_MODEL_SHAPE_INVALID',
    });
  }
  if (!Array.isArray(m.input)) {
    throw new PiRuntimeFactoryError('model.input must be an array', {
      code: 'PI_MODEL_SHAPE_INVALID',
    });
  }
  if (!m.cost || typeof m.cost !== 'object') {
    throw new PiRuntimeFactoryError('model.cost is required', {
      code: 'PI_MODEL_SHAPE_INVALID',
    });
  }
  if (!Number.isFinite(Number(m.contextWindow))) {
    throw new PiRuntimeFactoryError('model.contextWindow must be a number', {
      code: 'PI_MODEL_SHAPE_INVALID',
    });
  }
  if (!Number.isFinite(Number(m.maxTokens))) {
    throw new PiRuntimeFactoryError('model.maxTokens must be a number', {
      code: 'PI_MODEL_SHAPE_INVALID',
    });
  }
  if ('output' in m) {
    throw new PiRuntimeFactoryError(
      'model.output is not a pi-ai chat Model field (remove non-Model output)',
      { code: 'PI_MODEL_SHAPE_INVALID' },
    );
  }
}

/**
 * Optional model: null/undefined allowed; if present must be full shape.
 * @param {unknown} model
 */
export function assertOptionalModelShape(model) {
  if (model == null) return;
  assertModelShape(model);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isNonEmptyObject(value) {
  return (
    value != null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(/** @type {object} */ (value)).length > 0
  );
}

/**
 * Identity fields that pin a Model to AgentVersion policy.
 * @param {object} a
 * @param {object} b
 */
export function modelIdentityEqual(a, b) {
  return (
    String(a.id) === String(b.id) &&
    String(a.provider) === String(b.provider) &&
    String(a.api) === String(b.api) &&
    String(a.baseUrl) === String(b.baseUrl)
  );
}

/**
 * Bind Agent Version config (immutable deep-freeze clone).
 *
 * @param {object} agentVersion
 */
export function bindAgentVersionConfig(agentVersion) {
  if (!agentVersion || typeof agentVersion !== 'object') {
    throw new PiRuntimeFactoryError('agentVersion is required', {
      code: 'PI_AGENT_VERSION_REQUIRED',
    });
  }
  const v = /** @type {Record<string, unknown>} */ (agentVersion);
  const agentVersionId = String(v.agentVersionId ?? v.agent_version_id ?? '');
  if (!agentVersionId) {
    throw new PiRuntimeFactoryError('agentVersion.agentVersionId is required', {
      code: 'PI_AGENT_VERSION_REQUIRED',
    });
  }
  const rawConfig =
    v.configJson && typeof v.configJson === 'object'
      ? /** @type {Record<string, unknown>} */ (v.configJson)
      : v.config_json && typeof v.config_json === 'object'
        ? /** @type {Record<string, unknown>} */ (v.config_json)
        : {};
  // Never re-embed runtime credentials into frozen Agent Version config.
  const configJson = /** @type {Record<string, unknown>} */ (
    deepFreezeClone(JSON.parse(JSON.stringify(rawConfig)))
  );

  const piSdkVersion = String(
    v.piSdkVersion ?? v.pi_sdk_version ?? PINNED_PI_SDK_VERSION,
  );
  if (piSdkVersion !== PINNED_PI_SDK_VERSION) {
    throw new PiRuntimeFactoryError(
      `Agent Version piSdkVersion ${piSdkVersion} must equal exact pin ${PINNED_PI_SDK_VERSION}`,
      { code: 'PI_SDK_VERSION_INCOMPATIBLE' },
    );
  }

  const modelPolicy =
    configJson.modelPolicy && typeof configJson.modelPolicy === 'object'
      ? /** @type {Record<string, unknown>} */ (configJson.modelPolicy)
      : {};
  // Full Model only when present; incomplete policy references are not models.
  let model = null;
  const candidate = modelPolicy.model ?? configJson.model ?? null;
  if (candidate != null) {
    assertModelShape(candidate);
    model = candidate;
  }

  const toolPolicy =
    configJson.toolPolicy && typeof configJson.toolPolicy === 'object'
      ? /** @type {Record<string, unknown>} */ (configJson.toolPolicy)
      : {};
  const sandboxPolicy =
    configJson.sandboxPolicy && typeof configJson.sandboxPolicy === 'object'
      ? /** @type {Record<string, unknown>} */ (configJson.sandboxPolicy)
      : {};

  return Object.freeze({
    agentVersionId,
    piSdkVersion,
    configJson,
    configHash:
      typeof v.configHash === 'string'
        ? v.configHash
        : typeof v.config_hash === 'string'
          ? v.config_hash
          : '',
    modelPolicy: Object.freeze({ ...modelPolicy }),
    model,
    systemPrompt:
      typeof configJson.systemPrompt === 'string' ? configJson.systemPrompt : '',
    extensions: Array.isArray(configJson.extensions)
      ? Object.freeze([...configJson.extensions])
      : Object.freeze([]),
    skills: Array.isArray(configJson.skills)
      ? Object.freeze([...configJson.skills])
      : Object.freeze([]),
    mcpServers: Array.isArray(configJson.mcpServers)
      ? Object.freeze([...configJson.mcpServers])
      : Object.freeze([]),
    toolPolicy: Object.freeze({ ...toolPolicy }),
    sandboxPolicy: Object.freeze({ ...sandboxPolicy }),
  });
}

/**
 * Resolve concrete Model from bound AgentVersion + optional input.model.
 *
 * Rules:
 * - If AgentVersion embeds a full model: that model is authoritative; input.model
 *   may only match identity (or be omitted). Different models are rejected.
 * - If modelPolicy is a logical reference: input.model is required and must match
 *   available provider/id/api constraints from the policy.
 * - If neither full model nor constraints: input.model is required as concrete model.
 *
 * @param {ReturnType<typeof bindAgentVersionConfig>} bound
 * @param {object | null | undefined} inputModel
 */
export function resolveConcreteModel(bound, inputModel) {
  if (bound.model) {
    if (inputModel != null) {
      assertModelShape(inputModel);
      if (!modelIdentityEqual(bound.model, inputModel)) {
        throw new PiRuntimeFactoryError(
          'input.model cannot override AgentVersion embedded model (immutable pin)',
          { code: 'PI_MODEL_OVERRIDE_FORBIDDEN' },
        );
      }
    }
    return bound.model;
  }

  const policy = bound.modelPolicy || {};
  const ref =
    policy.reference && typeof policy.reference === 'object'
      ? /** @type {Record<string, unknown>} */ (policy.reference)
      : policy.modelRef && typeof policy.modelRef === 'object'
        ? /** @type {Record<string, unknown>} */ (policy.modelRef)
        : {};
  const constraintProvider =
    (typeof policy.provider === 'string' && policy.provider) ||
    (typeof ref.provider === 'string' && ref.provider) ||
    null;
  const constraintId =
    (typeof policy.modelId === 'string' && policy.modelId) ||
    (typeof policy.id === 'string' && policy.id) ||
    (typeof ref.modelId === 'string' && ref.modelId) ||
    (typeof ref.id === 'string' && ref.id) ||
    null;
  const constraintApi =
    (typeof policy.api === 'string' && policy.api) ||
    (typeof ref.api === 'string' && ref.api) ||
    null;
  const hasConstraints = Boolean(
    constraintProvider || constraintId || constraintApi,
  );

  if (inputModel == null) {
    throw new PiRuntimeFactoryError(
      hasConstraints
        ? 'modelResolver must supply a concrete model matching AgentVersion modelPolicy constraints'
        : 'A concrete full pi-ai Model is required (pass input.model or AgentVersion modelPolicy.model). Do not rely on SDK default model selection.',
      { code: 'PI_MODEL_REQUIRED' },
    );
  }
  assertModelShape(inputModel);
  const m = /** @type {Record<string, unknown>} */ (inputModel);
  if (constraintProvider && String(m.provider) !== constraintProvider) {
    throw new PiRuntimeFactoryError(
      `resolved model.provider ${String(m.provider)} does not match AgentVersion constraint ${constraintProvider}`,
      { code: 'PI_MODEL_POLICY_MISMATCH' },
    );
  }
  if (constraintId && String(m.id) !== constraintId) {
    throw new PiRuntimeFactoryError(
      `resolved model.id ${String(m.id)} does not match AgentVersion constraint ${constraintId}`,
      { code: 'PI_MODEL_POLICY_MISMATCH' },
    );
  }
  if (constraintApi && String(m.api) !== constraintApi) {
    throw new PiRuntimeFactoryError(
      `resolved model.api ${String(m.api)} does not match AgentVersion constraint ${constraintApi}`,
      { code: 'PI_MODEL_POLICY_MISMATCH' },
    );
  }
  return inputModel;
}

/**
 * Explicit, testable resolved bindings seam for AgentVersion config.
 * Non-empty config without a corresponding binding fails closed.
 *
 * Wired to official SDK parameters only:
 * - resourceLoaderOptions.systemPrompt / extensionFactories / skillsOverride
 * - createAgentSessionFromServices tools / customTools
 *
 * @param {ReturnType<typeof bindAgentVersionConfig>} bound
 * @param {{
 *   extensionFactories?: unknown[],
 *   skillsOverride?: Function,
 *   customTools?: unknown[],
 *   tools?: string[],
 *   mcpResolver?: Function | object | null,
 *   toolPolicyBinding?: object | null,
 *   sandboxPolicyBinding?: object | null,
 * }} [options]
 */
export function resolveAgentVersionBindings(bound, options = {}) {
  const extensionFactories = options.extensionFactories;
  const skillsOverride = options.skillsOverride;
  const customTools = options.customTools;
  const tools = options.tools;
  const mcpResolver = options.mcpResolver;
  const toolPolicyBinding = options.toolPolicyBinding;
  const sandboxPolicyBinding = options.sandboxPolicyBinding;

  if (bound.extensions.length > 0) {
    // Non-empty must be exactly the three enterprise logical names (not legacy 12).
    try {
      assertExactEnterpriseExtensions(bound.extensions);
    } catch (err) {
      throw new PiRuntimeFactoryError(
        err instanceof Error ? err.message : String(err),
        { code: 'PI_EXTENSIONS_INVALID' },
      );
    }
    if (!Array.isArray(extensionFactories) || extensionFactories.length === 0) {
      throw new PiRuntimeFactoryError(
        'AgentVersion.extensions is non-empty but no extensionFactories binding was provided (fail closed; PR-06 supplies real factories)',
        { code: 'PI_BINDING_REQUIRED' },
      );
    }
    if (extensionFactories.length !== ENTERPRISE_EXTENSION_NAMES.length) {
      throw new PiRuntimeFactoryError(
        `extensionFactories must be exactly ${ENTERPRISE_EXTENSION_NAMES.length} (sandbox-bridge, enterprise-policy, observability); got ${extensionFactories.length}`,
        { code: 'PI_EXTENSIONS_COUNT' },
      );
    }
    // Each factory must carry extensionName in fixed enterprise order.
    for (let i = 0; i < ENTERPRISE_EXTENSION_NAMES.length; i += 1) {
      const factory = extensionFactories[i];
      const expected = ENTERPRISE_EXTENSION_NAMES[i];
      if (typeof factory !== 'function') {
        throw new PiRuntimeFactoryError(
          `extensionFactories[${i}] must be a function (${expected})`,
          { code: 'PI_EXTENSIONS_NAME_MISMATCH' },
        );
      }
      const name =
        typeof factory.extensionName === 'string'
          ? factory.extensionName
          : null;
      if (name !== expected) {
        throw new PiRuntimeFactoryError(
          `extensionFactories[${i}].extensionName must be "${expected}" (got ${name == null ? 'missing' : JSON.stringify(name)}); anonymous/forged factories are rejected`,
          { code: 'PI_EXTENSIONS_NAME_MISMATCH' },
        );
      }
    }
  }
  if (bound.skills.length > 0) {
    if (typeof skillsOverride !== 'function') {
      throw new PiRuntimeFactoryError(
        'AgentVersion.skills is non-empty but no skillsOverride binding was provided (fail closed)',
        { code: 'PI_BINDING_REQUIRED' },
      );
    }
  }
  if (bound.mcpServers.length > 0) {
    if (mcpResolver == null) {
      throw new PiRuntimeFactoryError(
        'AgentVersion.mcpServers is non-empty but no mcpResolver binding was provided (fail closed; PR-06 wires pi-mcp-adapter)',
        { code: 'PI_BINDING_REQUIRED' },
      );
    }
  }
  if (isNonEmptyObject(bound.toolPolicy)) {
    const hasToolBinding =
      toolPolicyBinding != null ||
      (Array.isArray(tools) && tools.length > 0) ||
      (Array.isArray(customTools) && customTools.length > 0);
    if (!hasToolBinding) {
      throw new PiRuntimeFactoryError(
        'AgentVersion.toolPolicy is non-empty but no tools/customTools/toolPolicyBinding was provided (fail closed)',
        { code: 'PI_BINDING_REQUIRED' },
      );
    }
  }
  if (isNonEmptyObject(bound.sandboxPolicy)) {
    if (sandboxPolicyBinding == null) {
      throw new PiRuntimeFactoryError(
        'AgentVersion.sandboxPolicy is non-empty but no sandboxPolicyBinding was provided (fail closed; PR-06/07)',
        { code: 'PI_BINDING_REQUIRED' },
      );
    }
  }

  // Exact AgentVersion string, including '' — never collapse empty to SDK defaults.
  // noExtensions: true prevents agentDir auto-discovery of legacy package extensions.
  // Only explicit extensionFactories (resolved enterprise three) are loaded.
  /** @type {Record<string, unknown>} */
  const resourceLoaderOptions = {
    systemPrompt:
      typeof bound.systemPrompt === 'string' ? bound.systemPrompt : '',
    noExtensions: true,
  };
  if (Array.isArray(extensionFactories) && extensionFactories.length) {
    resourceLoaderOptions.extensionFactories = extensionFactories;
  }
  if (typeof skillsOverride === 'function') {
    resourceLoaderOptions.skillsOverride = skillsOverride;
  }

  return Object.freeze({
    systemPrompt:
      typeof bound.systemPrompt === 'string' ? bound.systemPrompt : '',
    resourceLoaderOptions: Object.freeze({ ...resourceLoaderOptions }),
    extensionFactories: Object.freeze(
      Array.isArray(extensionFactories) ? [...extensionFactories] : [],
    ),
    skillsOverride: typeof skillsOverride === 'function' ? skillsOverride : null,
    customTools: Array.isArray(customTools)
      ? Object.freeze([...customTools])
      : null,
    tools: Array.isArray(tools) ? Object.freeze([...tools]) : null,
    mcpResolver: mcpResolver ?? null,
    toolPolicyBinding: toolPolicyBinding ?? null,
    sandboxPolicyBinding: sandboxPolicyBinding ?? null,
  });
}

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
   *   sandboxPolicyBinding?: object | null,
   *   defaultCwd?: string,
   *   agentDir?: string,
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
    this.sandboxPolicyBinding = deps.sandboxPolicyBinding ?? null;
    this.defaultCwd = deps.defaultCwd ?? process.cwd();
    this.agentDir = deps.agentDir ?? null;
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
   *   sandboxPolicyBinding?: object | null,
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
      if (bound.mcpServers.length > 0) {
        try {
          mcpBinding =
            typeof configuredMcpResolver === 'function'
              ? await configuredMcpResolver({
                  mcpServers: bound.mcpServers,
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

      bindings = resolveAgentVersionBindings(bound, {
        extensionFactories: resolvedExtensionFactories,
        skillsOverride: input.skillsOverride ?? this.skillsOverride ?? undefined,
        customTools: input.customTools ?? this.customTools ?? undefined,
        tools: input.tools ?? this.tools ?? undefined,
        mcpResolver: mcpBinding,
        toolPolicyBinding: input.toolPolicyBinding ?? this.toolPolicyBinding,
        sandboxPolicyBinding:
          input.sandboxPolicyBinding ?? this.sandboxPolicyBinding,
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
        const services =
          injectedServices ??
          (await createServices({
            cwd: opts.cwd,
            agentDir: opts.agentDir,
            ...(authStorage ? { authStorage } : {}),
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
