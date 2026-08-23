/**
 * AgentVersion binding rules for the Pi runtime factory.
 *
 * Pure, fail-closed resolution of an immutable Agent Version config into the
 * bindings `PiRuntimeFactory` hands to the SDK:
 * - Full model in config cannot be overridden by a different input.model
 * - Logical modelPolicy references constrain resolver-supplied models
 * - Non-empty extensions/skills/mcpServers/toolPolicy/sandboxPolicy require
 *   explicit bindings
 *
 * No SDK import and no I/O — everything here is deterministic on its inputs.
 */

import { PiRuntimeFactoryError } from './errors.js';
import {
  REQUIRED_EXTENSION_NAMES,
  assertEnterpriseExtensions,
} from '../../extensions/index.js';
import { resolveEnterpriseSystemPrompt } from './enterprise-system-prompt.js';
import {
  LOGICAL_SKILL_ROOT,
  LOGICAL_WORKSPACE_ROOT,
} from '../../extensions/sandbox-bridge/constants.js';
import { primarySkillRoot, normalizeSkillRoots } from '../../skills/paths.js';
import { config as defaultAgentConfig } from '../../../config.js';
import { PINNED_PI_SDK_VERSION } from './pi-runtime-constants.js';

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
 * pi-ai ModelThinkingLevel values accepted in AgentVersion config.
 * @type {readonly string[]}
 */
export const AGENT_VERSION_THINKING_LEVELS = Object.freeze([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);

/**
 * Validate an AgentVersion-declared thinking level.
 * Absent → null (SDK decides). Present but unknown → fail closed, because a
 * typo silently downgrading a reasoning model is exactly the kind of drift a
 * frozen AgentVersion is supposed to prevent.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeThinkingLevel(value) {
  if (value == null || value === '') return null;
  const level = String(value).trim().toLowerCase();
  if (!AGENT_VERSION_THINKING_LEVELS.includes(level)) {
    throw new PiRuntimeFactoryError(
      `AgentVersion thinkingLevel "${String(value)}" is not a pi thinking level ` +
        `(${AGENT_VERSION_THINKING_LEVELS.join(', ')})`,
      { code: 'PI_THINKING_LEVEL_INVALID' },
    );
  }
  return level;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
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

  // Arrays are rejected rather than accepted as objects. `typeof [] === 'object'`
  // used to let `toolPolicy: ["bash"]` through as `{0: "bash"}`, which the
  // projection in tool-risk-bindings then read as empty — so the Run failed
  // with "no binding provided" instead of naming the malformed config.
  if (configJson.toolPolicy != null && !isPlainObject(configJson.toolPolicy)) {
    throw new PiRuntimeFactoryError(
      'AgentVersion.toolPolicy must be an object (e.g. { "tools": { "bash": "deny" } })',
      { code: 'PI_TOOL_POLICY_INVALID' },
    );
  }
  const toolPolicy =
    /** @type {Record<string, unknown>} */ (configJson.toolPolicy) ?? {};
  const sandboxPolicy =
    configJson.sandboxPolicy && typeof configJson.sandboxPolicy === 'object'
      ? /** @type {Record<string, unknown>} */ (configJson.sandboxPolicy)
      : {};
  // Compaction policy. Absent → Pi SDK defaults (auto-compact on, 16k reserve,
  // 20k kept recent), which is what production has always run with.
  const contextPolicy =
    configJson.contextPolicy && typeof configJson.contextPolicy === 'object'
      ? /** @type {Record<string, unknown>} */ (configJson.contextPolicy)
      : {};

  // Model parameter overrides. maxOutputTokens is applied onto the resolved
  // Model.maxTokens (the SDK caps each provider response with it). temperature
  // is validated and carried for future SDK plumbing — pi-ai StreamOptions
  // supports it, but the coding-agent loop does not surface it per-session
  // yet, so we fail closed on bad values and document the wire gap.
  const maxOutputTokens = optionalPositiveInt(
    modelPolicy.maxOutputTokens ?? configJson.maxOutputTokens,
    'modelPolicy.maxOutputTokens',
  );
  const temperature = optionalFiniteNumber(
    modelPolicy.temperature ?? configJson.temperature,
    'modelPolicy.temperature',
  );

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
    maxOutputTokens,
    temperature,
    // Reasoning depth for this Agent. Accepted at either level so a logical
    // modelPolicy reference and a flat config express it the same way.
    // `null` (not 'off') means "unset — let the SDK decide".
    thinkingLevel: normalizeThinkingLevel(
      modelPolicy.thinkingLevel ?? configJson.thinkingLevel,
    ),
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
    contextPolicy: Object.freeze({ ...contextPolicy }),
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
    if (bound.maxOutputTokens != null) {
      return { ...bound.model, maxTokens: bound.maxOutputTokens };
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
  // Apply the AgentVersion-declared max output tokens onto the resolved Model.
  // Model.maxTokens is the SDK's per-response cap, so this is the correct
  // single knob — never mutate the caller's model object.
  if (bound.maxOutputTokens != null) {
    return { ...inputModel, maxTokens: bound.maxOutputTokens };
  }
  return inputModel;
}

/**
 * Parse an optional positive integer with fail-closed validation.
 *
 * @param {unknown} value
 * @param {string} field
 * @returns {number | undefined}
 */
function optionalPositiveInt(value, field) {
  if (value == null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new PiRuntimeFactoryError(`${field} must be a positive integer`, {
      code: 'PI_MODEL_PARAM_INVALID',
    });
  }
  return n;
}

/**
 * Parse an optional finite number (temperature) with fail-closed validation.
 *
 * @param {unknown} value
 * @param {string} field
 * @returns {number | undefined}
 */
function optionalFiniteNumber(value, field) {
  if (value == null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 2) {
    throw new PiRuntimeFactoryError(
      `${field} must be a finite number in [0, 2]`,
      { code: 'PI_MODEL_PARAM_INVALID' },
    );
  }
  return n;
}

/**
 * Build the Pi `skillsOverride` that realises `AgentVersion.skills`.
 *
 * The field is an allowlist: the ResourceLoader still discovers every skill
 * under the run's skill roots, and this narrows what the model is told about.
 * A requested skill that this caller cannot see (wrong tier, not installed)
 * is reported as a warning rather than failing the Run — absence is a normal
 * per-user state, not a misconfiguration.
 *
 * @param {readonly unknown[]} allowedSkills
 * @returns {(base: { skills?: object[], diagnostics?: object[] }) => { skills: object[], diagnostics: object[] }}
 */
export function createSkillAllowlistOverride(allowedSkills) {
  const allowed = new Set(
    (Array.isArray(allowedSkills) ? allowedSkills : [])
      .map((entry) => {
        if (typeof entry === 'string') return entry.trim();
        if (entry && typeof entry === 'object' && typeof (/** @type {any} */ (entry).name) === 'string') {
          return String(/** @type {any} */ (entry).name).trim();
        }
        return '';
      })
      .filter(Boolean),
  );

  return function skillAllowlistOverride(base) {
    const skills = Array.isArray(base?.skills) ? base.skills : [];
    const diagnostics = Array.isArray(base?.diagnostics) ? [...base.diagnostics] : [];
    const kept = skills.filter((skill) =>
      allowed.has(String(/** @type {any} */ (skill)?.name ?? '')),
    );
    const seen = new Set(
      kept.map((skill) => String(/** @type {any} */ (skill)?.name ?? '')),
    );
    for (const name of allowed) {
      if (seen.has(name)) continue;
      diagnostics.push({
        type: 'warning',
        message: `AgentVersion.skills requests "${name}", which is not available on this run's skill roots`,
      });
    }
    return { skills: kept, diagnostics };
  };
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
 *   additionalSkillPaths?: string[],
 *   workspaceRoot?: string,
 *   skillRoot?: string,
 *   productSystemPrompt?: string,
 * }} [options]
 */
export function resolveAgentVersionBindings(bound, options = {}) {
  const extensionFactories = options.extensionFactories;
  // AgentVersion.skills is realised here rather than by every caller: the
  // allowlist is fully determined by the frozen config, so requiring callers
  // to hand-build the same override made the field unusable in production.
  // An explicit override still wins (tests, future non-allowlist semantics).
  const skillsOverride =
    typeof options.skillsOverride === 'function'
      ? options.skillsOverride
      : bound.skills.length > 0
        ? createSkillAllowlistOverride(bound.skills)
        : undefined;
  const customTools = options.customTools;
  const tools = options.tools;
  const mcpResolver = options.mcpResolver;
  const toolPolicyBinding = options.toolPolicyBinding;

  /** @type {readonly string[]} Extensions actually loaded for this binding. */
  let resolvedExtensionNames = Object.freeze([]);

  if (bound.extensions.length > 0) {
    // Non-empty must resolve against the first-party registry (not legacy 12).
    /** @type {{ names: readonly string[] }} */
    let resolved;
    try {
      resolved = assertEnterpriseExtensions(bound.extensions);
      resolvedExtensionNames = resolved.names;
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
    if (extensionFactories.length !== resolved.names.length) {
      throw new PiRuntimeFactoryError(
        `extensionFactories must match resolved AgentVersion.extensions (${resolved.names.join(', ')}); got ${extensionFactories.length} factories`,
        { code: 'PI_EXTENSIONS_COUNT' },
      );
    }
    // Each factory must carry extensionName in resolved load order.
    for (let i = 0; i < resolved.names.length; i += 1) {
      const factory = extensionFactories[i];
      const expected = resolved.names[i];
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
  if (bound.skills.length > 0 && typeof skillsOverride !== 'function') {
    // Unreachable while the allowlist default above stands; kept so a future
    // change to that default cannot silently drop the skill restriction.
    throw new PiRuntimeFactoryError(
      'AgentVersion.skills is non-empty but no skillsOverride binding was resolved (fail closed)',
      { code: 'PI_BINDING_REQUIRED' },
    );
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
    // Unconditional, unlike the bindings above. Those ask "did a caller wire
    // the thing that enforces this field?"; here nothing in this build can
    // enforce it at all — the Sandbox service takes its quotas from deployment
    // env — so accepting a binding would let a caller wave through a policy
    // that this very message says is unenforced.
    throw new PiRuntimeFactoryError(
      'AgentVersion.sandboxPolicy is not supported by this build: sandbox limits are ' +
        'deployment-level (SANDBOX_* environment variables), not per-AgentVersion. ' +
        'Remove sandboxPolicy from configJson.',
      { code: 'PI_FEATURE_NOT_ENABLED' },
    );
  }

  // Enterprise system prompt (mirrors pi buildSystemPrompt shape) so we never
  // fall through to the SDK default that points at node_modules docs paths.
  // Skills progressive disclosure: additionalSkillPaths → ResourceLoader →
  // formatSkillsForPrompt when `read` is available.
  const skillPathsRaw = Array.isArray(options.additionalSkillPaths)
    ? options.additionalSkillPaths.filter(
        (p) => typeof p === 'string' && String(p).trim(),
      )
    : [];
  // Default formal skill mount so progressive disclosure works without
  // every caller remembering to pass additionalSkillPaths.
  const skillPaths =
    skillPathsRaw.length > 0
      ? skillPathsRaw
      : normalizeSkillRoots([
          options.skillRoot || LOGICAL_SKILL_ROOT,
        ]);
  const productSystemPrompt =
    typeof options.productSystemPrompt === 'string'
      ? options.productSystemPrompt
      : typeof defaultAgentConfig?.PRODUCT_SYSTEM_PROMPT === 'string'
        ? defaultAgentConfig.PRODUCT_SYSTEM_PROMPT
        : '';
  const enterpriseSystemPrompt = resolveEnterpriseSystemPrompt(
    typeof bound.systemPrompt === 'string' ? bound.systemPrompt : '',
    {
      productSystemPrompt,
      workspaceRoot: options.workspaceRoot || LOGICAL_WORKSPACE_ROOT,
      skillRoot:
        options.skillRoot || primarySkillRoot(skillPaths) || LOGICAL_SKILL_ROOT,
      extensionNames: [
        ...(resolvedExtensionNames.length > 0
          ? resolvedExtensionNames
          : REQUIRED_EXTENSION_NAMES),
      ],
    },
  );

  // Exact AgentVersion string, including '' — never collapse empty to SDK defaults.
  // noExtensions: true prevents agentDir auto-discovery of legacy package extensions.
  // Only explicit extensionFactories (resolved enterprise three) are loaded.
  /** @type {Record<string, unknown>} */
  const resourceLoaderOptions = {
    systemPrompt: enterpriseSystemPrompt,
    noExtensions: true,
  };
  if (skillPaths.length) {
    resourceLoaderOptions.additionalSkillPaths = Object.freeze([...skillPaths]);
  }
  if (Array.isArray(extensionFactories) && extensionFactories.length) {
    resourceLoaderOptions.extensionFactories = extensionFactories;
  }
  if (typeof skillsOverride === 'function') {
    resourceLoaderOptions.skillsOverride = skillsOverride;
  }

  return Object.freeze({
    systemPrompt: enterpriseSystemPrompt,
    resourceLoaderOptions: Object.freeze({ ...resourceLoaderOptions }),
    extensionFactories: Object.freeze(
      Array.isArray(extensionFactories) ? [...extensionFactories] : [],
    ),
    skillsOverride: typeof skillsOverride === 'function' ? skillsOverride : null,
    additionalSkillPaths: Object.freeze([...skillPaths]),
    customTools: Array.isArray(customTools)
      ? Object.freeze([...customTools])
      : null,
    tools: Array.isArray(tools) ? Object.freeze([...tools]) : null,
    // Caller-supplied denials only. `ls`/`find`/`grep` used to be pinned here,
    // but the SDK applies excludeTools to extension tools as well, so the
    // sandbox-bridge replacements were denied along with the built-ins they
    // shadow. The container-filesystem boundary is enforced after bind by
    // findUnshadowedLocalTools() instead — see pi-runtime-constants.js.
    excludeTools: Object.freeze([
      ...new Set(
        Array.isArray(options.excludeTools)
          ? options.excludeTools.filter(
              (name) => typeof name === 'string' && name.trim(),
            )
          : [],
      ),
    ]),
    mcpResolver: mcpResolver ?? null,
    // null → omit the option so the SDK resolves from settings, then clamps to
    // the model. Never coerce to a concrete level here.
    thinkingLevel: bound.thinkingLevel ?? null,
    toolPolicyBinding: toolPolicyBinding ?? null,
    // Compaction policy is applied to the run's settings manager, so unlike
    // toolPolicy/sandboxPolicy it needs no separate caller-supplied binding.
    contextPolicy: Object.freeze({ ...(bound.contextPolicy || {}) }),
  });
}
