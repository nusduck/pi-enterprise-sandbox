/**
 * AgentVersion configuration contract used by the catalog write and preview
 * paths.
 *
 * This module deliberately has no runtime, MCP client, or model request side
 * effects.  It only projects the capabilities already available to the Agent
 * process and validates a JSON object against that projection.
 */
import { createHash } from 'node:crypto';
import {
  buildRegistry,
  resolveDefaultModelId,
  type ModelEntry,
} from '../infrastructure/model-registry.js';
import { selectableReasoningEfforts } from '../infrastructure/dsh/reasoning-efforts.js';
import { ENTERPRISE_DEFAULT_TOOLS } from '../runtime/policy/tool-names.js';
import { RISK_CLASSES } from '../infrastructure/dsh/tool-risk-policy.js';
import { stableStringify } from './canonical-json.js';

export const AGENT_CONFIG_SCHEMA_VERSION = 1 as const;

export type AgentConfigDiagnostic = {
  readonly path: string;
  readonly code: string;
  readonly message: string;
};

export type AgentConfigOptions = {
  readonly schemaVersion: 1;
  readonly fieldSupport: Record<string, unknown>;
  readonly platformConstraints: Record<string, unknown>;
  readonly capabilityRevision: string;
};

export type AgentConfigValidation = {
  readonly valid: boolean;
  readonly errors: AgentConfigDiagnostic[];
  readonly warnings: AgentConfigDiagnostic[];
  readonly normalizedConfig?: Record<string, unknown>;
  readonly effectiveSummary: Record<string, unknown>;
  readonly capabilityRevision: string;
};

type Loose = any;

const TOP_LEVEL_V1_KEYS = Object.freeze([
  'schemaVersion',
  'systemPrompt',
  'modelPolicy',
  'toolPolicy',
  'mcpServers',
]);

const LEGACY_TOP_LEVEL_KEYS = Object.freeze([
  'extensions',
  'skills',
  'sandboxPolicy',
  'a2a',
]);

const MODEL_POLICY_V1_KEYS = Object.freeze([
  'modelId',
  'maxOutputTokens',
  'thinkingLevel',
  'temperature',
]);

const TOOL_POLICY_V1_KEYS = Object.freeze([
  'tools',
  'riskLevels',
  'classRiskLevels',
  'riskApproval',
]);

const MCP_ENTRY_V1_KEYS = Object.freeze([
  'serverId',
  'enabledTools',
  'toolPolicy',
]);

const MCP_TOOL_POLICY_KEYS = Object.freeze([
  'default',
  'tools',
  'riskLevel',
  'toolRiskLevels',
]);

const MCP_FORBIDDEN_V1_KEYS = Object.freeze([
  // Connection material belongs to MCP_SERVERS_JSON, not AgentVersion.
  'secretRef',
  'timeoutSec',
  'timeout',
  'timeoutSeconds',
  'url',
  'command',
  'args',
  'cwd',
  // Discovery output is process state, never a saved authorization snapshot.
  'toolInputSchemas',
  'toolDescriptions',
  'headers',
  'env',
]);

const DECISIONS = Object.freeze(['allow', 'require_approval', 'deny']);
const RISK_LEVELS = Object.freeze(['low', 'medium', 'high', 'critical']);
const SIMPLE_NAME = /^[A-Za-z0-9._-]+$/;
/** `mcp__server__tool`, plus the trailing-`*` prefix form the resolver accepts. */
const RISK_TOOL_KEY = /^[A-Za-z0-9._-]+(::[A-Za-z0-9._-]+)?\*?$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function cloneJson(value: unknown): Record<string, unknown> {
  try {
    const cloned = JSON.parse(JSON.stringify(value));
    if (!isPlainObject(cloned)) throw new Error('object expected');
    return cloned;
  } catch {
    throw new Error('config must be JSON-serializable');
  }
}

function diagnostic(path: string, code: string, message: string): AgentConfigDiagnostic {
  return Object.freeze({ path, code, message });
}

function pushUnknown(
  target: AgentConfigDiagnostic[],
  path: string,
  key: string,
) {
  target.push(diagnostic(
    path ? `${path}.${key}` : key,
    'CONFIG_UNKNOWN_FIELD',
    `Unknown configuration field "${key}"`,
  ));
}

function canonicalObject(
  value: unknown,
  preferred: readonly string[] = [],
): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalObject(item));
  if (!isPlainObject(value)) return value;
  const rank = new Map(preferred.map((key, index) => [key, index]));
  const keys = Object.keys(value).sort((left, right) => {
    const l = rank.has(left) ? rank.get(left)! : Number.MAX_SAFE_INTEGER;
    const r = rank.has(right) ? rank.get(right)! : Number.MAX_SAFE_INTEGER;
    return l === r ? left.localeCompare(right) : l - r;
  });
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const nestedPreferred = key === 'modelPolicy'
      ? MODEL_POLICY_V1_KEYS
      : key === 'toolPolicy'
        ? TOOL_POLICY_V1_KEYS
        : key === 'mcpServers'
          ? MCP_ENTRY_V1_KEYS
          : key === 'tools'
            ? []
            : key === 'riskLevels' || key === 'classRiskLevels' || key === 'riskApproval'
              ? []
              : key === 'toolPolicy'
                ? MCP_TOOL_POLICY_KEYS
                : [];
    out[key] = canonicalObject(value[key], nestedPreferred);
  }
  return out;
}

/**
 * Shapes older snapshots used to name a model before `modelPolicy.modelId`
 * existed. They are read-only history; §3 of the integration plan only allows
 * upgrading one when it maps onto the current model catalog.
 */
const LEGACY_MODEL_REF_KEYS = Object.freeze([
  'model',
  'reference',
  'modelRef',
  'model_ref',
  'id',
]);

/** Extract the model id a legacy reference names, or null when unreadable. */
function legacyModelReference(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (!isPlainObject(value)) return null;
  for (const key of ['modelId', 'model_id', 'id', 'name']) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return null;
}

function modelIdOf(entry: ModelEntry | null | undefined): string | null {
  return entry?.model_id ? String(entry.model_id) : null;
}

function safeModel(entry: ModelEntry) {
  return {
    modelId: entry.model_id,
    provider: entry.provider,
    maxOutputTokens: entry.max_output_tokens,
    contextWindow: entry.context_window,
    thinkingLevels: [...selectableReasoningEfforts(entry)],
    supportsReasoning: Boolean(entry.supports_reasoning),
    // The current DSH loop has no temperature call-config seam.  Keep this
    // explicit so a future adapter must opt in before the UI exposes it.
    supportsTemperature: Boolean((entry as Loose).supports_temperature),
    ...(Number.isFinite(Number((entry as Loose).temperature_min))
      ? { temperatureMin: Number((entry as Loose).temperature_min) }
      : {}),
    ...(Number.isFinite(Number((entry as Loose).temperature_max))
      ? { temperatureMax: Number((entry as Loose).temperature_max) }
      : {}),
  };
}

function safeMcpServers(raw: unknown): Array<{
  serverId: string;
  toolNames: string[];
}> {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const output: Array<{ serverId: string; toolNames: string[] }> = [];
  for (const value of raw) {
    if (!isPlainObject(value)) continue;
    const serverId = String(value.serverId ?? value.server_id ?? value.id ?? '').trim();
    if (!SIMPLE_NAME.test(serverId) || seen.has(serverId)) continue;
    seen.add(serverId);
    const candidates = value.tools ?? value.toolNames ?? value.tool_names;
    const toolNames = Array.isArray(candidates)
      ? [...new Set(candidates.map((item) => {
          if (typeof item === 'string') return item.trim();
          return isPlainObject(item)
            ? String(item.name ?? item.toolName ?? item.tool_name ?? '').trim()
            : '';
        }).filter((name) => SIMPLE_NAME.test(name)))]
      : [];
    output.push({ serverId, toolNames });
  }
  return output;
}

export type McpReadiness = {
  /**
   * `ready`   — the process knows the full server/tool inventory.
   * `not_configured` — the deployment declares no MCP server at all.
   * `unknown` — discovery has not completed or failed; the inventory below is
   *             *not* evidence that a server or tool is absent.
   */
  readonly status: 'ready' | 'not_configured' | 'unknown';
  /**
   * 稳定原因码，供 UI 与文档映射文案。**不放进程环境变量名或连接材料**——
   * 这个 DTO 是给组织管理员看的，不是运维排障日志。
   */
  readonly reason?: 'DISCOVERY_PENDING' | 'INVENTORY_UNREADABLE' | 'NO_SERVER_DECLARED';
};

/**
 * Project the process MCP inventory *with* its readiness. An empty array and
 * "we could not ask yet" are different facts: the first authorizes nothing,
 * the second must block edits that depend on the catalog rather than be
 * rendered as an empty capability set.
 */
function loadPlatformMcpServers(env: Record<string, string | undefined>): {
  servers: Array<{ serverId: string; toolNames: string[] }>;
  readiness: McpReadiness;
} {
  const raw = env.MCP_SERVERS_JSON;
  if (raw === undefined) {
    return { servers: [], readiness: { status: 'unknown', reason: 'DISCOVERY_PENDING' } };
  }
  if (!String(raw).trim()) {
    return { servers: [], readiness: { status: 'not_configured', reason: 'NO_SERVER_DECLARED' } };
  }
  try {
    const servers = safeMcpServers(JSON.parse(String(raw)));
    return {
      servers,
      readiness: servers.length > 0
        ? { status: 'ready' }
        : { status: 'not_configured', reason: 'NO_SERVER_DECLARED' },
    };
  } catch {
    // Startup already rejects malformed MCP_SERVERS_JSON. Here the inventory
    // is simply unknown; it must not read as "no MCP server exists".
    return { servers: [], readiness: { status: 'unknown', reason: 'INVENTORY_UNREADABLE' } };
  }
}

function decisionsOf(value: unknown): Record<string, string> {
  if (!isPlainObject(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    const decision = isPlainObject(raw) ? raw.decision : raw;
    const normalized = String(decision ?? '').trim().toLowerCase();
    if (normalized) out[key] = normalized;
  }
  return out;
}

export class AgentConfigValidator {
  readonly registry: Map<string, ModelEntry>;
  readonly mcpServers: Array<{ serverId: string; toolNames: string[] }>;
  readonly mcpReadiness: McpReadiness;
  readonly platformToolNames: readonly string[];
  readonly optionsDto: AgentConfigOptions;

  constructor(opts: {
    registry?: Map<string, ModelEntry>;
    env?: Record<string, string | undefined>;
    mcpServers?: unknown;
    /**
     * Live discovery state from the running MCP registry. `ready: false` means
     * the inventory is not yet knowable — never that it is empty.
     */
    mcpDiscovery?: { ready?: boolean; servers?: unknown; error?: string } | null;
    platformToolNames?: readonly string[];
  } = {}) {
    const env = opts.env ?? process.env;
    this.registry = opts.registry ?? buildRegistry({ env });
    if (opts.mcpDiscovery != null) {
      this.mcpServers = safeMcpServers(opts.mcpDiscovery.servers);
      this.mcpReadiness = Object.freeze(
        opts.mcpDiscovery.ready === true
          ? { status: 'ready' as const }
          : {
              status: 'unknown' as const,
              // 上游的错误文本不进这个 DTO：它可能带内网地址或凭据线索。
              reason: 'DISCOVERY_PENDING' as const,
            },
      );
    } else if (opts.mcpServers !== undefined) {
      this.mcpServers = safeMcpServers(opts.mcpServers);
      this.mcpReadiness = Object.freeze(
        this.mcpServers.length > 0
          ? { status: 'ready' as const }
          : { status: 'not_configured' as const, reason: 'NO_SERVER_DECLARED' as const },
      );
    } else {
      const loaded = loadPlatformMcpServers(env);
      this.mcpServers = loaded.servers;
      this.mcpReadiness = Object.freeze(loaded.readiness);
    }
    this.platformToolNames = Object.freeze([
      ...new Set((opts.platformToolNames ?? ENTERPRISE_DEFAULT_TOOLS).map(String)),
    ]);

    const models = [...this.registry.values()]
      .filter((entry) => entry.enabled)
      .map(safeModel);
    const mcpServers = this.mcpServers.map((server) => ({
      serverId: server.serverId,
      toolNames: [...server.toolNames],
    }));
    const fieldSupport = {
      schemaVersion: { supported: true, required: true, type: 'integer' },
      systemPrompt: { supported: true, type: 'string', maxChars: 64 * 1024 },
      modelPolicy: {
        supported: true,
        fields: {
          modelId: { supported: true, type: 'string' },
          maxOutputTokens: { supported: true, type: 'integer' },
          thinkingLevel: { supported: true, type: 'string' },
          temperature: { supported: false, reason: 'MODEL_TEMPERATURE_UNSUPPORTED' },
        },
      },
      toolPolicy: { supported: true, type: 'object' },
      mcpServers: { supported: true, type: 'array', explicitEnabledTools: true },
      extensions: { supported: false, readOnly: true },
      skills: { supported: false, readOnly: true },
      sandboxPolicy: { supported: false, readOnly: true },
      a2a: { supported: false, readOnly: true },
    };
    const platformConstraints = {
      models,
      modelIds: models.map((model) => model.modelId),
      defaultModelId: resolveDefaultModelId(this.registry),
      tools: [...this.platformToolNames],
      mcpServers,
      mcpReadiness: { ...this.mcpReadiness },
      maxConfigBytes: 256 * 1024,
    };
    const revisionMaterial = canonicalObject({
      schemaVersion: AGENT_CONFIG_SCHEMA_VERSION,
      fieldSupport,
      platformConstraints,
    });
    const capabilityRevision = createHash('sha256')
      .update(stableStringify(revisionMaterial), 'utf8')
      .digest('hex');
    this.optionsDto = Object.freeze({
      schemaVersion: AGENT_CONFIG_SCHEMA_VERSION,
      fieldSupport,
      platformConstraints,
      capabilityRevision,
    });
  }

  options(): AgentConfigOptions {
    // Return a fresh object so callers cannot mutate the process capability
    // projection held by this validator.
    return {
      schemaVersion: this.optionsDto.schemaVersion,
      fieldSupport: JSON.parse(JSON.stringify(this.optionsDto.fieldSupport)),
      platformConstraints: JSON.parse(JSON.stringify(this.optionsDto.platformConstraints)),
      capabilityRevision: this.optionsDto.capabilityRevision,
    };
  }

  validate(rawConfig: unknown): AgentConfigValidation {
    if (!isPlainObject(rawConfig)) {
      throw new Error('config must be an object');
    }
    let config: Record<string, unknown>;
    try {
      config = cloneJson(rawConfig);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : 'config must be JSON-serializable');
    }

    const errors: AgentConfigDiagnostic[] = [];
    const warnings: AgentConfigDiagnostic[] = [];
    const hasSchema = Object.hasOwn(config, 'schemaVersion');
    const schemaVersion = config.schemaVersion;
    const legacy = !hasSchema;
    if (hasSchema && schemaVersion !== AGENT_CONFIG_SCHEMA_VERSION) {
      errors.push(diagnostic(
        'schemaVersion',
        'CONFIG_SCHEMA_VERSION_UNSUPPORTED',
        `schemaVersion must be ${AGENT_CONFIG_SCHEMA_VERSION}`,
      ));
    }
    if (legacy) {
      warnings.push(diagnostic(
        'schemaVersion',
        'LEGACY_CONFIG',
        'Configuration has no schemaVersion and is read using legacy compatibility rules',
      ));
    }

    // Fields a legacy snapshot carries that schemaVersion 1 has no home for.
    // They are recorded so the UI can show a migration diff over the original
    // JSON; they never silently survive an upgrade, because a normalized v1
    // config that still contained them would be rejected by this same
    // validator on the next save.
    const migrationBlockers: AgentConfigDiagnostic[] = [];
    const blockMigration = (path: string, message: string) => {
      const entry = diagnostic(path, 'LEGACY_FIELD_REQUIRES_MIGRATION', message);
      migrationBlockers.push(entry);
      errors.push(entry);
    };

    for (const key of Object.keys(config)) {
      if (TOP_LEVEL_V1_KEYS.includes(key) || LEGACY_TOP_LEVEL_KEYS.includes(key)) continue;
      if (legacy) {
        blockMigration(key, `Legacy field "${key}" has no schemaVersion 1 equivalent; remove it or keep running the existing version`);
      } else {
        pushUnknown(errors, '', key);
      }
    }

    if (config.systemPrompt !== undefined && typeof config.systemPrompt !== 'string') {
      errors.push(diagnostic('systemPrompt', 'CONFIG_TYPE', 'systemPrompt must be a string'));
    } else if (typeof config.systemPrompt === 'string' && config.systemPrompt.length > 64 * 1024) {
      errors.push(diagnostic('systemPrompt', 'CONFIG_LIMIT', 'systemPrompt exceeds 65536 characters'));
    }

    const modelPolicy = config.modelPolicy;
    let normalizedModelPolicy: Record<string, unknown> = {};
    let resolvedModel: ModelEntry | null = null;
    let legacyMappedModelId: string | null = null;
    if (modelPolicy !== undefined && !isPlainObject(modelPolicy)) {
      errors.push(diagnostic('modelPolicy', 'CONFIG_TYPE', 'modelPolicy must be an object'));
    } else {
      const policy = (modelPolicy as Record<string, unknown> | undefined) ?? {};
      for (const key of Object.keys(policy)) {
        if (MODEL_POLICY_V1_KEYS.includes(key)) continue;
        // A legacy model reference is only readable as history. Upgrading it
        // requires it to resolve to a model this platform can actually route;
        // otherwise the upgrade is blocked instead of dropping the reference
        // and silently falling back to the platform default.
        if (legacy && LEGACY_MODEL_REF_KEYS.includes(key)) {
          const referenced = legacyModelReference(policy[key]);
          const mapped = referenced ? this.registry.get(referenced) : null;
          if (mapped && mapped.enabled) {
            warnings.push(diagnostic(
              `modelPolicy.${key}`,
              'LEGACY_MODEL_MAPPED',
              `Legacy modelPolicy.${key} maps to "${mapped.model_id}"; the upgraded version pins that model id`,
            ));
            legacyMappedModelId = mapped.model_id;
          } else {
            const shown = referenced ?? '(unreadable reference)';
            const entry = diagnostic(
              `modelPolicy.${key}`,
              'LEGACY_MODEL_UNMAPPABLE',
              `Legacy model reference "${shown}" does not map to a model available on this platform; pick a supported modelId before upgrading`,
            );
            migrationBlockers.push(entry);
            errors.push(entry);
          }
        } else if (legacy) {
          blockMigration(`modelPolicy.${key}`, `Legacy field "modelPolicy.${key}" has no schemaVersion 1 equivalent; remove it or keep running the existing version`);
        } else {
          pushUnknown(errors, 'modelPolicy', key);
        }
      }

      const requestedModelId = policy.modelId;
      if (requestedModelId !== undefined && requestedModelId !== null && requestedModelId !== '') {
        if (typeof requestedModelId !== 'string' || !requestedModelId.trim()) {
          errors.push(diagnostic('modelPolicy.modelId', 'MODEL_ID_INVALID', 'modelId must be a non-empty string'));
        } else {
          const candidate = this.registry.get(requestedModelId.trim());
          if (!candidate || !candidate.enabled) {
            errors.push(diagnostic('modelPolicy.modelId', 'MODEL_NOT_FOUND', `Model "${requestedModelId}" is not available on this platform`));
          } else {
            resolvedModel = candidate;
            normalizedModelPolicy.modelId = candidate.model_id;
          }
        }
      }
      if (!resolvedModel && legacyMappedModelId) {
        // A mapped legacy reference becomes an explicit v1 pin: the upgraded
        // version must keep routing to the model the old snapshot named, not
        // drift to whatever the platform default happens to be later.
        resolvedModel = this.registry.get(legacyMappedModelId) ?? null;
        if (resolvedModel) normalizedModelPolicy.modelId = resolvedModel.model_id;
      }
      if (!resolvedModel) {
        const defaultId = resolveDefaultModelId(this.registry);
        resolvedModel = this.registry.get(defaultId) ?? null;
      }
      const maxTokens = policy.maxOutputTokens;
      if (maxTokens !== undefined && maxTokens !== null && maxTokens !== '') {
        if (!Number.isSafeInteger(maxTokens) || Number(maxTokens) < 1) {
          errors.push(diagnostic('modelPolicy.maxOutputTokens', 'MODEL_MAX_OUTPUT_TOKENS_INVALID', 'maxOutputTokens must be a positive integer'));
        } else if (resolvedModel && Number(maxTokens) > resolvedModel.max_output_tokens) {
          errors.push(diagnostic('modelPolicy.maxOutputTokens', 'MODEL_MAX_OUTPUT_TOKENS_EXCEEDED', `maxOutputTokens exceeds the selected model limit of ${resolvedModel.max_output_tokens}`));
        } else {
          normalizedModelPolicy.maxOutputTokens = Number(maxTokens);
        }
      }
      const thinking = policy.thinkingLevel;
      if (thinking !== undefined && thinking !== null && thinking !== '') {
        if (typeof thinking !== 'string') {
          errors.push(diagnostic('modelPolicy.thinkingLevel', 'MODEL_THINKING_LEVEL_INVALID', 'thinkingLevel must be a string'));
        } else {
          const normalizedThinking = thinking.trim().toLowerCase();
          // `off` is only offerable when the adapter itself accepts it, so it
          // comes from the same projection rather than being appended here.
          const allowed = new Set(
            resolvedModel ? selectableReasoningEfforts(resolvedModel) : [],
          );
          if (!allowed.has(normalizedThinking)) {
            errors.push(diagnostic('modelPolicy.thinkingLevel', 'MODEL_THINKING_LEVEL_UNSUPPORTED', `thinkingLevel "${thinking}" is not supported by the selected model`));
          } else {
            normalizedModelPolicy.thinkingLevel = normalizedThinking;
          }
        }
      }
      const temperature = policy.temperature;
      if (temperature !== undefined && temperature !== null && temperature !== '') {
        const supportsTemperature = Boolean((resolvedModel as Loose)?.supports_temperature);
        if (!supportsTemperature) {
          errors.push(diagnostic('modelPolicy.temperature', 'MODEL_TEMPERATURE_UNSUPPORTED', 'temperature is not supported by the current model adapter'));
        } else if (typeof temperature !== 'number' || !Number.isFinite(temperature)) {
          errors.push(diagnostic('modelPolicy.temperature', 'MODEL_TEMPERATURE_INVALID', 'temperature must be a finite number'));
        } else {
          const min = Number.isFinite(Number((resolvedModel as Loose)?.temperature_min))
            ? Number((resolvedModel as Loose).temperature_min) : 0;
          const max = Number.isFinite(Number((resolvedModel as Loose)?.temperature_max))
            ? Number((resolvedModel as Loose).temperature_max) : 2;
          if (temperature < min || temperature > max) {
            errors.push(diagnostic('modelPolicy.temperature', 'MODEL_TEMPERATURE_OUT_OF_RANGE', `temperature must be between ${min} and ${max}`));
          } else {
            normalizedModelPolicy.temperature = temperature;
          }
        }
      }
    }

    const toolPolicy = config.toolPolicy;
    let normalizedToolPolicy: Record<string, unknown> = {};
    if (toolPolicy !== undefined && !isPlainObject(toolPolicy)) {
      errors.push(diagnostic('toolPolicy', 'CONFIG_TYPE', 'toolPolicy must be an object'));
    } else if (isPlainObject(toolPolicy)) {
      for (const key of Object.keys(toolPolicy)) {
        if (!TOOL_POLICY_V1_KEYS.includes(key)) {
          if (legacy) warnings.push(diagnostic(`toolPolicy.${key}`, 'LEGACY_FIELD_UNKNOWN', `Unknown legacy field "${key}" is preserved read-only`));
          else pushUnknown(errors, 'toolPolicy', key);
        }
      }
      const rawTools = toolPolicy.tools;
      if (rawTools !== undefined && !isPlainObject(rawTools)) {
        errors.push(diagnostic('toolPolicy.tools', 'CONFIG_TYPE', 'toolPolicy.tools must be an object'));
      } else if (isPlainObject(rawTools)) {
        const normalizedTools: Record<string, unknown> = {};
        const knownTools = new Set(this.platformToolNames);
        for (const [name, raw] of Object.entries(rawTools)) {
          const path = `toolPolicy.tools.${name}`;
          if (!name || name.includes('::') || name.endsWith('*') || !SIMPLE_NAME.test(name)) {
            errors.push(diagnostic(path, 'TOOL_NAME_INVALID', 'tool policy keys must be exact tool names'));
            continue;
          }
          if (name.startsWith('mcp__')) {
            // MCP public names are only valid when the server was explicitly
            // selected below; keeping this as a shape check avoids guessing a
            // server identity from a lossy public name.
          } else if (!knownTools.has(name)) {
            errors.push(diagnostic(path, 'TOOL_NOT_FOUND', `Tool "${name}" is not provided by this platform`));
            continue;
          }
          const decision = isPlainObject(raw) ? raw.decision : raw;
          const normalized = String(decision ?? '').trim().toLowerCase();
          if (!DECISIONS.includes(normalized)) {
            errors.push(diagnostic(path, 'TOOL_DECISION_INVALID', 'decision must be allow, require_approval, or deny'));
          } else {
            normalizedTools[name] = normalized;
          }
        }
        if (Object.keys(normalizedTools).length) normalizedToolPolicy.tools = normalizedTools;
      }
      // The three risk tables have three different key/value contracts.
      // Validating them with one "value must be a risk level" rule rejected a
      // legitimate `riskApproval.high = require_approval` and accepted a
      // misspelled class name, so each is checked against what the runtime
      // resolver actually consumes (`tool-risk-policy.ts`).
      for (const riskKey of ['riskLevels', 'classRiskLevels', 'riskApproval'] as const) {
        const raw = toolPolicy[riskKey];
        if (raw === undefined) continue;
        if (!isPlainObject(raw)) {
          errors.push(diagnostic(`toolPolicy.${riskKey}`, 'CONFIG_TYPE', `${riskKey} must be an object`));
          continue;
        }
        const normalizedRisk: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(raw)) {
          const path = `toolPolicy.${riskKey}.${key}`;
          const normalizedKey = key.trim();
          if (riskKey === 'riskApproval') {
            const level = normalizedKey.toLowerCase();
            if (!RISK_LEVELS.includes(level)) {
              errors.push(diagnostic(path, 'TOOL_RISK_LEVEL_UNKNOWN', `riskApproval keys must be ${RISK_LEVELS.join('|')}`));
              continue;
            }
            const decision = String(value ?? '').trim().toLowerCase();
            if (!DECISIONS.includes(decision)) {
              errors.push(diagnostic(path, 'TOOL_DECISION_INVALID', `riskApproval values must be ${DECISIONS.join('|')}`));
              continue;
            }
            normalizedRisk[level] = decision;
            continue;
          }
          if (riskKey === 'classRiskLevels' && !RISK_CLASSES.includes(normalizedKey)) {
            errors.push(diagnostic(path, 'TOOL_RISK_CLASS_UNKNOWN', `classRiskLevels keys must be ${RISK_CLASSES.join('|')}`));
            continue;
          }
          if (riskKey === 'riskLevels' && !RISK_TOOL_KEY.test(normalizedKey)) {
            errors.push(diagnostic(path, 'TOOL_NAME_INVALID', 'riskLevels keys must be a tool name, server::tool, or a name prefix ending in *'));
            continue;
          }
          const level = String(value ?? '').trim().toLowerCase();
          if (!RISK_LEVELS.includes(level)) {
            errors.push(diagnostic(path, 'TOOL_RISK_INVALID', `risk must be ${RISK_LEVELS.join('|')}`));
          } else normalizedRisk[normalizedKey] = level;
        }
        if (Object.keys(normalizedRisk).length) normalizedToolPolicy[riskKey] = normalizedRisk;
      }
    }

    const mcpServers = config.mcpServers;
    const normalizedMcp: Array<Record<string, unknown>> = [];
    if (mcpServers !== undefined && !Array.isArray(mcpServers)) {
      errors.push(diagnostic('mcpServers', 'CONFIG_TYPE', 'mcpServers must be an array'));
    } else if (Array.isArray(mcpServers)) {
      const seenServers = new Set<string>();
      const platformServers = new Map(this.mcpServers.map((server) => [server.serverId, server]));
      for (let index = 0; index < mcpServers.length; index += 1) {
        const path = `mcpServers[${index}]`;
        const entry = mcpServers[index];
        if (!isPlainObject(entry)) {
          errors.push(diagnostic(path, 'MCP_ENTRY_INVALID', 'MCP server reference must be an object'));
          continue;
        }
        for (const key of Object.keys(entry)) {
          if (MCP_FORBIDDEN_V1_KEYS.includes(key)) {
            errors.push(diagnostic(`${path}.${key}`, 'MCP_FIELD_NOT_SUPPORTED', `${key} is deployment-owned and cannot be saved in AgentVersion`));
          } else if (!MCP_ENTRY_V1_KEYS.includes(key)) {
            if (legacy) warnings.push(diagnostic(`${path}.${key}`, 'LEGACY_FIELD_UNKNOWN', `Unknown legacy field "${key}" is preserved read-only`));
            else pushUnknown(errors, path, key);
          }
        }
        const serverId = entry.serverId;
        if (typeof serverId !== 'string' || !SIMPLE_NAME.test(serverId.trim())) {
          errors.push(diagnostic(`${path}.serverId`, 'MCP_SERVER_ID_INVALID', 'serverId must match [A-Za-z0-9._-]+'));
          continue;
        }
        const normalizedServerId = serverId.trim();
        if (seenServers.has(normalizedServerId)) {
          errors.push(diagnostic(`${path}.serverId`, 'MCP_SERVER_ID_DUPLICATE', `Duplicate MCP server "${normalizedServerId}"`));
          continue;
        }
        seenServers.add(normalizedServerId);
        const platform = platformServers.get(normalizedServerId);
        // Fail closed on both sides of the unknown/empty split: an inventory we
        // could not read must block the reference instead of being validated
        // against as if it were an authoritative empty list, and an inventory
        // we *did* read must reject a server it does not contain — including
        // when the deployment declares no MCP server at all.
        if (this.mcpReadiness.status === 'unknown') {
          errors.push(diagnostic(
            `${path}.serverId`,
            'MCP_CATALOG_UNAVAILABLE',
            `MCP inventory is unavailable (${this.mcpReadiness.reason ?? 'unknown'}); MCP references cannot be validated`,
          ));
        } else if (!platform) {
          errors.push(diagnostic(`${path}.serverId`, 'MCP_SERVER_UNAVAILABLE', `MCP server "${normalizedServerId}" is not available on this platform`));
        }
        if (!Object.hasOwn(entry, 'enabledTools')) {
          errors.push(diagnostic(`${path}.enabledTools`, 'MCP_ENABLED_TOOLS_REQUIRED', 'enabledTools is required; an empty array authorizes no MCP tools'));
          continue;
        }
        if (!Array.isArray(entry.enabledTools)) {
          errors.push(diagnostic(`${path}.enabledTools`, 'MCP_ENABLED_TOOLS_INVALID', 'enabledTools must be an array of bare tool names'));
          continue;
        }
        const enabledTools: string[] = [];
        const discovered = new Set(platform?.toolNames ?? []);
        for (let toolIndex = 0; toolIndex < entry.enabledTools.length; toolIndex += 1) {
          const value = entry.enabledTools[toolIndex];
          const toolPath = `${path}.enabledTools[${toolIndex}]`;
          if (typeof value !== 'string' || !SIMPLE_NAME.test(value.trim()) || value.trim().startsWith('mcp__')) {
            errors.push(diagnostic(toolPath, 'MCP_ENABLED_TOOLS_INVALID', 'enabledTools entries must be bare tool names'));
            continue;
          }
          const tool = value.trim();
          if (enabledTools.includes(tool)) {
            errors.push(diagnostic(toolPath, 'MCP_ENABLED_TOOLS_DUPLICATE', `Duplicate enabled tool "${tool}"`));
            continue;
          }
          if (this.mcpReadiness.status === 'unknown') {
            errors.push(diagnostic(
              toolPath,
              'MCP_CATALOG_UNAVAILABLE',
              `MCP inventory is unavailable (${this.mcpReadiness.reason ?? 'unknown'}); enabled tools cannot be validated`,
            ));
            continue;
          }
          if (!discovered.has(tool)) {
            errors.push(diagnostic(toolPath, 'MCP_TOOL_UNAVAILABLE', `MCP tool "${tool}" is not currently available`));
            continue;
          }
          enabledTools.push(tool);
        }
        const normalizedEntry: Record<string, unknown> = {
          serverId: normalizedServerId,
          enabledTools,
        };
        if (isPlainObject(entry.toolPolicy)) {
          const nested: Record<string, unknown> = {};
          for (const key of Object.keys(entry.toolPolicy)) {
            if (!MCP_TOOL_POLICY_KEYS.includes(key)) {
              if (legacy) warnings.push(diagnostic(`${path}.toolPolicy.${key}`, 'LEGACY_FIELD_UNKNOWN', `Unknown legacy field "${key}" is preserved read-only`));
              else pushUnknown(errors, `${path}.toolPolicy`, key);
            }
          }
          if (entry.toolPolicy.default !== undefined) {
            const decision = String(entry.toolPolicy.default).trim().toLowerCase();
            if (!DECISIONS.includes(decision)) errors.push(diagnostic(`${path}.toolPolicy.default`, 'TOOL_DECISION_INVALID', 'default must be allow, require_approval, or deny'));
            else nested.default = decision;
          }
          if (entry.toolPolicy.tools !== undefined && !isPlainObject(entry.toolPolicy.tools)) {
            errors.push(diagnostic(`${path}.toolPolicy.tools`, 'CONFIG_TYPE', 'toolPolicy.tools must be an object'));
          } else if (isPlainObject(entry.toolPolicy.tools)) {
            const nestedTools: Record<string, unknown> = {};
            for (const [name, raw] of Object.entries(entry.toolPolicy.tools)) {
              const decision = String(isPlainObject(raw) ? raw.decision : raw).trim().toLowerCase();
              if (!SIMPLE_NAME.test(name) || !DECISIONS.includes(decision)) errors.push(diagnostic(`${path}.toolPolicy.tools.${name}`, 'TOOL_DECISION_INVALID', 'tool decision is invalid'));
              else if (enabledTools.includes(name)) nestedTools[name] = decision;
            }
            if (Object.keys(nestedTools).length) nested.tools = nestedTools;
          }
          for (const key of ['riskLevel', 'toolRiskLevels']) {
            if (entry.toolPolicy[key] === undefined) continue;
            if (key === 'riskLevel') {
              const level = String(entry.toolPolicy[key]).trim().toLowerCase();
              if (!RISK_LEVELS.includes(level)) errors.push(diagnostic(`${path}.toolPolicy.${key}`, 'TOOL_RISK_INVALID', `risk must be ${RISK_LEVELS.join('|')}`));
              else nested[key] = level;
            } else if (!isPlainObject(entry.toolPolicy[key])) {
              errors.push(diagnostic(`${path}.toolPolicy.${key}`, 'CONFIG_TYPE', `${key} must be an object`));
            } else nested[key] = canonicalObject(entry.toolPolicy[key]);
          }
          if (Object.keys(nested).length) normalizedEntry.toolPolicy = nested;
        } else if (entry.toolPolicy !== undefined) {
          errors.push(diagnostic(`${path}.toolPolicy`, 'CONFIG_TYPE', 'toolPolicy must be an object'));
        }
        normalizedMcp.push(normalizedEntry);
      }
    }

    for (const key of LEGACY_TOP_LEVEL_KEYS) {
      if (!Object.hasOwn(config, key)) continue;
      const value = config[key];
      const empty = value == null || value === '' || (Array.isArray(value) && value.length === 0) || (isPlainObject(value) && Object.keys(value).length === 0);
      if (empty) {
        // An empty placeholder carries no historical intent; v1 simply drops it.
        warnings.push(diagnostic(key, 'LEGACY_FIELD_READ_ONLY', `${key} is read-only compatibility data and does not add runtime capability`));
      } else if (legacy) {
        blockMigration(key, `Legacy "${key}" is not an executable capability in schemaVersion 1; the upgraded version would drop it, so handle it explicitly`);
      } else {
        errors.push(diagnostic(key, 'CONFIG_FIELD_NOT_SUPPORTED', `${key} is not editable in schemaVersion 1`));
      }
    }

    const toolDecisions = decisionsOf(isPlainObject(toolPolicy) ? toolPolicy.tools : null);
    const summary = {
      model: {
        modelId: modelIdOf(resolvedModel),
        maxOutputTokens: normalizedModelPolicy.maxOutputTokens ?? (resolvedModel?.max_output_tokens ?? null),
        thinkingLevel: normalizedModelPolicy.thinkingLevel ?? null,
        temperature: normalizedModelPolicy.temperature ?? null,
      },
      tools: {
        allow: Object.keys(toolDecisions).filter((name) => toolDecisions[name] === 'allow').sort(),
        requireApproval: Object.keys(toolDecisions).filter((name) => toolDecisions[name] === 'require_approval').sort(),
        deny: Object.keys(toolDecisions).filter((name) => toolDecisions[name] === 'deny').sort(),
        unspecifiedInherit: true,
      },
      mcpServers: normalizedMcp.map((entry) => ({
        serverId: entry.serverId,
        enabledTools: Array.isArray(entry.enabledTools) ? [...entry.enabledTools] : [],
      })),
      persona: {
        configured: typeof config.systemPrompt === 'string' && config.systemPrompt.length > 0,
        chars: typeof config.systemPrompt === 'string' ? config.systemPrompt.length : 0,
      },
      // The migration diff the admin has to resolve before this snapshot can
      // become a schemaVersion 1 version. Empty for anything already on v1.
      migration: {
        schemaVersion: legacy ? null : AGENT_CONFIG_SCHEMA_VERSION,
        blockedPaths: migrationBlockers.map((entry) => entry.path),
      },
    };

    if (errors.length > 0) {
      return {
        valid: false,
        errors,
        warnings,
        effectiveSummary: summary,
        capabilityRevision: this.optionsDto.capabilityRevision,
      };
    }

    // Everything a normalized config contains is a field schemaVersion 1 can
    // execute. Legacy-only material never rides along: it was either empty
    // (dropped with a warning) or it blocked the upgrade above, so a config
    // returned here always re-validates as valid v1 without a round trip
    // silently deleting anything the admin did not see.
    const normalized: Record<string, unknown> = {
      schemaVersion: AGENT_CONFIG_SCHEMA_VERSION,
      systemPrompt: typeof config.systemPrompt === 'string' ? config.systemPrompt : '',
      modelPolicy: normalizedModelPolicy,
      toolPolicy: normalizedToolPolicy,
      mcpServers: normalizedMcp,
    };
    return {
      valid: true,
      errors: [],
      warnings,
      normalizedConfig: canonicalObject(normalized, [
        'schemaVersion',
        'systemPrompt',
        'modelPolicy',
        'toolPolicy',
        'mcpServers',
      ]) as Record<string, unknown>,
      effectiveSummary: summary,
      capabilityRevision: this.optionsDto.capabilityRevision,
    };
  }
}

export function createAgentConfigValidator(opts: ConstructorParameters<typeof AgentConfigValidator>[0] = {}) {
  return new AgentConfigValidator(opts);
}

