/**
 * AgentVersion config rules used by the DSH runtime factory.
 *
 * Pure, fail-closed resolution of an immutable Agent Version config into the
 * model/config values the worker hands to the SDK:
 * - Full model in config cannot be overridden by a different input.model
 * - Logical modelPolicy references constrain resolver-supplied models
 * - model policy and execution-related limits are validated before use
 *
 * No SDK import and no I/O — everything here is deterministic on its inputs.
 */

import { DshRuntimeFactoryError } from './errors.js';
import { resolveToolNameAlias } from './constants.js';
import { parseDelegationConfig } from '../../domain/agent/delegation-config.js';
import {
  loadMcpConfigFromAgentVersion,
  mcpToolName,
  parseAgentVersionConfigJson,
} from '../mcp/mcp-config-loader.js';

export type AgentToolDecision = 'allow' | 'require_approval' | 'deny';

export interface AgentVersionMcpAuthorization {
  readonly enabledTools: readonly string[];
  /** DSH public name → raw MCP tool name; never recover this by splitting. */
  readonly publicToolNames?: Readonly<Record<string, string>>;
  readonly decisions: Readonly<Record<string, AgentToolDecision>>;
  readonly defaultDecision: AgentToolDecision;
}

/**
 * The execution authorization projected from one immutable AgentVersion.
 * `mcpConfigured` deliberately remains true for an empty/omitted MCP list:
 * an AgentVersion is an allowlist boundary, so legacy empty MCP config cannot
 * inherit whatever servers happen to be registered in the process.
 */
export interface AgentVersionAuthorization {
  readonly mcpConfigured: true;
  readonly decisions: Readonly<Record<string, AgentToolDecision>>;
  readonly mcpServers: Readonly<Record<string, AgentVersionMcpAuthorization>>;
  /** DSH public name → stable server/raw identity. */
  readonly mcpTools?: Readonly<Record<string, { serverId: string; toolName: string }>>;
}

/**
 * Deep-clone then freeze plain JSON-compatible structures.
 * @param value
 * @returns {unknown}
 */
export function deepFreezeClone<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const arr: unknown[] = (value as unknown[]).map((v) => deepFreezeClone(v));
    return Object.freeze(arr) as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = deepFreezeClone(v);
  }
  return Object.freeze(out) as T;
}

/**
 * Require the full Model descriptor fields whenever a model is supplied.
 * @param model
 */
export function assertModelShape(model: unknown) {
  if (model == null) {
    throw new DshRuntimeFactoryError('model is required when supplied to runtime create', {
      code: 'DSH_MODEL_SHAPE_INVALID',
    });
  }
  if (typeof model !== 'object' || Array.isArray(model)) {
    throw new DshRuntimeFactoryError('model must be an object', {
      code: 'DSH_MODEL_SHAPE_INVALID',
    });
  }
  const m = (model as Record<string, unknown>);
  for (const key of Object.keys(m)) {
    if (key === 'headers') continue;
    if (/(?:apiKey|api_key|secret|password)/i.test(key)) {
      throw new DshRuntimeFactoryError(
        'model must not embed credential fields at top level',
        { code: 'DSH_MODEL_SHAPE_INVALID' },
      );
    }
  }
  if (typeof m.id !== 'string' || !m.id.trim()) {
    throw new DshRuntimeFactoryError('model.id is required', {
      code: 'DSH_MODEL_SHAPE_INVALID',
    });
  }
  if (typeof m.name !== 'string' || !m.name.trim()) {
    throw new DshRuntimeFactoryError('model.name is required', {
      code: 'DSH_MODEL_SHAPE_INVALID',
    });
  }
  if (typeof m.api !== 'string' || !m.api.trim()) {
    throw new DshRuntimeFactoryError('model.api is required', {
      code: 'DSH_MODEL_SHAPE_INVALID',
    });
  }
  if (typeof m.provider !== 'string' || !m.provider.trim()) {
    throw new DshRuntimeFactoryError('model.provider is required', {
      code: 'DSH_MODEL_SHAPE_INVALID',
    });
  }
  if (typeof m.baseUrl !== 'string') {
    throw new DshRuntimeFactoryError('model.baseUrl must be a string', {
      code: 'DSH_MODEL_SHAPE_INVALID',
    });
  }
  if (typeof m.reasoning !== 'boolean') {
    throw new DshRuntimeFactoryError('model.reasoning must be a boolean', {
      code: 'DSH_MODEL_SHAPE_INVALID',
    });
  }
  if (!Array.isArray(m.input)) {
    throw new DshRuntimeFactoryError('model.input must be an array', {
      code: 'DSH_MODEL_SHAPE_INVALID',
    });
  }
  if (!m.cost || typeof m.cost !== 'object') {
    throw new DshRuntimeFactoryError('model.cost is required', {
      code: 'DSH_MODEL_SHAPE_INVALID',
    });
  }
  if (!Number.isFinite(Number(m.contextWindow))) {
    throw new DshRuntimeFactoryError('model.contextWindow must be a number', {
      code: 'DSH_MODEL_SHAPE_INVALID',
    });
  }
  if (!Number.isFinite(Number(m.maxTokens))) {
    throw new DshRuntimeFactoryError('model.maxTokens must be a number', {
      code: 'DSH_MODEL_SHAPE_INVALID',
    });
  }
  if ('output' in m) {
    throw new DshRuntimeFactoryError(
      'model.output is not a chat Model descriptor field (remove non-Model output)',
      { code: 'DSH_MODEL_SHAPE_INVALID' },
    );
  }
}

/**
 * Thinking levels accepted in AgentVersion config (projected onto the routed
 * adapter's reasoning efforts by `reasoning-efforts.ts`).
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
 * @param value
 * @returns {string | null}
 */
export function normalizeThinkingLevel(value: unknown) {
  if (value == null || value === '') return null;
  const level = String(value).trim().toLowerCase();
  if (!AGENT_VERSION_THINKING_LEVELS.includes(level)) {
    throw new DshRuntimeFactoryError(
      `AgentVersion thinkingLevel "${String(value)}" is not a dsh thinking level ` +
        `(${AGENT_VERSION_THINKING_LEVELS.join(', ')})`,
      { code: 'DSH_THINKING_LEVEL_INVALID' },
    );
  }
  return level;
}

/**
 * @param value
 * @returns {boolean}
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

const AGENT_DECISIONS = Object.freeze(['allow', 'require_approval', 'deny']);
const AGENT_DECISION_RANK: Readonly<Record<AgentToolDecision, number>> = Object.freeze({
  allow: 0,
  require_approval: 1,
  deny: 2,
});
const AUTH_RISK_FIELDS = Object.freeze([
  'riskLevels',
  'riskApproval',
  'classRiskLevels',
]);

function normalizeAgentDecision(value: unknown, field: string): AgentToolDecision {
  const candidate =
    isPlainObject(value) && Object.hasOwn(value as object, 'decision')
      ? (value as Record<string, unknown>).decision
      : value;
  const decision = String(candidate ?? '').trim().toLowerCase();
  if (!AGENT_DECISIONS.includes(decision)) {
    throw new DshRuntimeFactoryError(
      `${field} must be allow|require_approval|deny`,
      { code: 'DSH_TOOL_POLICY_INVALID' },
    );
  }
  return decision as AgentToolDecision;
}

/**
 * Merge two explicit decisions without allowing a legacy spelling to loosen a
 * canonical one.  AgentVersion snapshots predating schema v1 may contain both
 * `toolPolicy.tools` and flat entries, or both a current name and an old alias.
 * Those are one logical rule after alias projection, so the stricter value is
 * the only safe deterministic result.
 */
function putStrictestDecision(
  table: Record<string, AgentToolDecision>,
  toolName: string,
  decision: AgentToolDecision,
) {
  const current = table[toolName];
  if (
    current === undefined ||
    AGENT_DECISION_RANK[decision] > AGENT_DECISION_RANK[current]
  ) {
    table[toolName] = decision;
  }
}

/**
 * Preserve the read-time aliases used by old snapshots without changing the
 * frozen config or its hash. When multiple spellings resolve to one current
 * name, the stricter decision wins.
 */
function projectAuthorizationToolNames(table: Record<string, unknown>) {
  const out: Record<string, AgentToolDecision> = {};
  for (const [rawKey, rawValue] of Object.entries(table)) {
    const key = String(rawKey).trim();
    if (key.includes('::') || key.endsWith('*')) {
      throw new DshRuntimeFactoryError(
        `toolPolicy.tools.${rawKey} must be an exact tool name; wildcard and server::tool entries belong in riskLevels`,
        { code: 'DSH_TOOL_POLICY_INVALID' },
      );
    }
    const projected = key.startsWith('mcp__') ? key : resolveToolNameAlias(key);
    if (projected === null) continue;
    putStrictestDecision(
      out,
      projected,
      normalizeAgentDecision(rawValue, `toolPolicy.tools.${rawKey}`),
    );
  }
  return out;
}

function buildAgentVersionAuthorization(
  configJson: Record<string, unknown>,
): AgentVersionAuthorization {
  const rawPolicy = configJson.toolPolicy;
  if (rawPolicy != null && !isPlainObject(rawPolicy)) {
    // bindAgentVersionConfig performs the same shape check for its model path;
    // keep this local check so direct authorization callers fail closed too.
    throw new DshRuntimeFactoryError('AgentVersion.toolPolicy must be an object', {
      code: 'DSH_TOOL_POLICY_INVALID',
    });
  }
  const policy = (rawPolicy as Record<string, unknown> | undefined) ?? {};
  const decisions: Record<string, AgentToolDecision> = {};
  if (policy.tools != null && !isPlainObject(policy.tools)) {
    throw new DshRuntimeFactoryError('AgentVersion.toolPolicy.tools must be an object', {
      code: 'DSH_TOOL_POLICY_INVALID',
    });
  }
  if (isPlainObject(policy.tools)) {
    Object.assign(
      decisions,
      projectAuthorizationToolNames(policy.tools as Record<string, unknown>),
    );
  }
  // Legacy snapshots also used flat toolName → decision entries. Risk-table
  // fields are deliberately excluded; they are consumed by the risk resolver.
  const flat: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(policy)) {
    if (key === 'tools' || AUTH_RISK_FIELDS.includes(key)) continue;
    flat[key] = value;
  }
  for (const [toolName, decision] of Object.entries(
    projectAuthorizationToolNames(flat),
  )) {
    putStrictestDecision(decisions, toolName, decision);
  }

  const mcpServers: Record<string, AgentVersionMcpAuthorization> = {};
  const mcpTools: Record<string, { serverId: string; toolName: string }> = {};
  for (const server of loadMcpConfigFromAgentVersion({ configJson })) {
    const nested = server.toolPolicy as Record<string, unknown>;
    const nestedDecisions: Record<string, AgentToolDecision> = {};
    const nestedTools = nested.tools;
    if (nestedTools != null && !isPlainObject(nestedTools)) {
      throw new DshRuntimeFactoryError(
        `mcpServers.${server.serverId}.toolPolicy.tools must be an object`,
        { code: 'DSH_TOOL_POLICY_INVALID' },
      );
    }
    if (isPlainObject(nestedTools)) {
      for (const [tool, value] of Object.entries(nestedTools)) {
        if (!/^[A-Za-z0-9._-]+$/.test(tool)) {
          throw new DshRuntimeFactoryError(
            `mcpServers.${server.serverId}.toolPolicy.tools.${tool} must be a bare tool name`,
            { code: 'DSH_TOOL_POLICY_INVALID' },
          );
        }
        nestedDecisions[tool] = normalizeAgentDecision(
          value,
          `mcpServers.${server.serverId}.toolPolicy.tools.${tool}`,
        );
      }
    }
    const publicToolNames: Record<string, string> = {};
    for (const toolName of server.enabledTools) {
      const publicName = mcpToolName(server.serverId, toolName);
      publicToolNames[publicName] = toolName;
      mcpTools[publicName] = { serverId: server.serverId, toolName };
      // Project nested defaults/decisions into the complete DSH public name
      // map. Explicit top-level toolPolicy entries are applied below by the
      // execution resolver and remain the stricter layer when both exist.
      putStrictestDecision(
        decisions,
        publicName,
        normalizeAgentDecision(
          nestedDecisions[toolName] ?? nested.default ?? 'allow',
          `mcpServers.${server.serverId}.toolPolicy.${toolName}`,
        ),
      );
    }
    mcpServers[server.serverId] = {
      enabledTools: Object.freeze([...server.enabledTools]),
      publicToolNames: Object.freeze(publicToolNames),
      decisions: Object.freeze(nestedDecisions),
      defaultDecision: normalizeAgentDecision(
        nested.default ?? 'allow',
        `mcpServers.${server.serverId}.toolPolicy.default`,
      ),
    };
  }

  return Object.freeze({
    mcpConfigured: true,
    decisions: Object.freeze(decisions),
    mcpServers: Object.freeze(mcpServers),
    mcpTools: Object.freeze(mcpTools),
  });
}

/**
 * Identity fields that pin a Model to AgentVersion policy.
 * @param a
 * @param b
 */
export function modelIdentityEqual(a: Record<string, any>, b: Record<string, any>) {
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
 * @param agentVersion
 */
export function bindAgentVersionConfig(agentVersion: Record<string, any>) {
  if (!agentVersion || typeof agentVersion !== 'object') {
    throw new DshRuntimeFactoryError('agentVersion is required', {
      code: 'DSH_AGENT_VERSION_REQUIRED',
    });
  }
  const v = (agentVersion as Record<string, unknown>);
  const agentVersionId = String(v.agentVersionId ?? v.agent_version_id ?? '');
  if (!agentVersionId) {
    throw new DshRuntimeFactoryError('agentVersion.agentVersionId is required', {
      code: 'DSH_AGENT_VERSION_REQUIRED',
    });
  }
  const rawConfig =
    v.configJson != null
      ? parseAgentVersionConfigJson(v.configJson, 'configJson')
      : v.config_json != null
        ? parseAgentVersionConfigJson(v.config_json, 'config_json')
        : {};
  // Never re-embed runtime credentials into frozen Agent Version config.
  const configJson = /** @type {Record<string, unknown>} */ (
    deepFreezeClone(JSON.parse(JSON.stringify(rawConfig)))
  );

  const modelPolicy =
    configJson.modelPolicy && typeof configJson.modelPolicy === 'object'
      ? (configJson.modelPolicy as Record<string, unknown>)
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
    throw new DshRuntimeFactoryError(
      'AgentVersion.toolPolicy must be an object (e.g. { "tools": { "bash": "deny" } })',
      { code: 'DSH_TOOL_POLICY_INVALID' },
    );
  }
  const toolPolicy =
    (configJson.toolPolicy as Record<string, unknown>) ?? {};
  const sandboxPolicy =
    configJson.sandboxPolicy && typeof configJson.sandboxPolicy === 'object'
      ? (configJson.sandboxPolicy as Record<string, unknown>)
      : {};
  // Model parameter overrides. maxOutputTokens is applied onto the resolved
  // Model.maxTokens (the SDK caps each provider response with it). temperature
  // is validated and carried for future plumbing — the DSH runtime factory
  // does not send it per-Run yet, so we fail closed on bad values and
  // document the wire gap.
  const maxOutputTokens = optionalPositiveInt(
    modelPolicy.maxOutputTokens ?? configJson.maxOutputTokens,
    'modelPolicy.maxOutputTokens',
  );
  const temperature = optionalFiniteNumber(
    modelPolicy.temperature ?? configJson.temperature,
    'modelPolicy.temperature',
  );

  // Who this agent may delegate to (docs/design/agent-delegation.md D2).
  // Malformed is fail-closed: a half-read allowlist must never run.
  const delegationParsed = parseDelegationConfig(configJson.delegation);
  if (!delegationParsed.config) {
    const first = delegationParsed.errors[0];
    throw new DshRuntimeFactoryError(
      `AgentVersion.${first?.path ?? 'delegation'}: ${first?.message ?? 'invalid'}`,
      { code: 'DSH_DELEGATION_INVALID' },
    );
  }

  return Object.freeze({
    agentVersionId,
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
    authorization: buildAgentVersionAuthorization(configJson),
    toolPolicy: Object.freeze({ ...toolPolicy }),
    sandboxPolicy: Object.freeze({ ...sandboxPolicy }),
    delegation: delegationParsed.config,
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
 * @param bound
 * @param inputModel
 */
export function resolveConcreteModel(bound: ReturnType<typeof bindAgentVersionConfig>, inputModel: Record<string, any> | null | undefined) {
  if (bound.model) {
    if (inputModel != null) {
      assertModelShape(inputModel);
      if (!modelIdentityEqual(bound.model, inputModel)) {
        throw new DshRuntimeFactoryError(
          'input.model cannot override AgentVersion embedded model (immutable pin)',
          { code: 'DSH_MODEL_OVERRIDE_FORBIDDEN' },
        );
      }
    }
    if (bound.maxOutputTokens != null) {
      return {
        ...(bound.model as Record<string, any>),
        maxTokens: bound.maxOutputTokens,
      };
    }
    return bound.model;
  }

  const policy = bound.modelPolicy || {};
  const ref =
    policy.reference && typeof policy.reference === 'object'
      ? (policy.reference as Record<string, unknown>)
      : policy.modelRef && typeof policy.modelRef === 'object'
        ? (policy.modelRef as Record<string, unknown>)
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
    throw new DshRuntimeFactoryError(
      hasConstraints
        ? 'modelResolver must supply a concrete model matching AgentVersion modelPolicy constraints'
        : 'A concrete full Model descriptor is required (pass input.model or AgentVersion modelPolicy.model). Do not rely on SDK default model selection.',
      { code: 'DSH_MODEL_REQUIRED' },
    );
  }
  assertModelShape(inputModel);
  const m = (inputModel as Record<string, unknown>);
  if (constraintProvider && String(m.provider) !== constraintProvider) {
    throw new DshRuntimeFactoryError(
      `resolved model.provider ${String(m.provider)} does not match AgentVersion constraint ${constraintProvider}`,
      { code: 'DSH_MODEL_POLICY_MISMATCH' },
    );
  }
  if (constraintId && String(m.id) !== constraintId) {
    throw new DshRuntimeFactoryError(
      `resolved model.id ${String(m.id)} does not match AgentVersion constraint ${constraintId}`,
      { code: 'DSH_MODEL_POLICY_MISMATCH' },
    );
  }
  if (constraintApi && String(m.api) !== constraintApi) {
    throw new DshRuntimeFactoryError(
      `resolved model.api ${String(m.api)} does not match AgentVersion constraint ${constraintApi}`,
      { code: 'DSH_MODEL_POLICY_MISMATCH' },
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
 * @param value
 * @param field
 * @returns {number | undefined}
 */
function optionalPositiveInt(value: unknown, field: string) {
  if (value == null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new DshRuntimeFactoryError(`${field} must be a positive integer`, {
      code: 'DSH_MODEL_PARAM_INVALID',
    });
  }
  return n;
}

/**
 * Parse an optional finite number (temperature) with fail-closed validation.
 *
 * @param value
 * @param field
 * @returns {number | undefined}
 */
function optionalFiniteNumber(value: unknown, field: string) {
  if (value == null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 2) {
    throw new DshRuntimeFactoryError(
      `${field} must be a finite number in [0, 2]`,
      { code: 'DSH_MODEL_PARAM_INVALID' },
    );
  }
  return n;
}
