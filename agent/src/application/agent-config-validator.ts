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
import {
  MCP_ENTRY_V1_KEYS,
  MCP_TOOL_POLICY_KEYS,
  MODEL_POLICY_V1_KEYS,
  SIMPLE_NAME,
  TOOL_POLICY_V1_KEYS,
  canonicalObject,
  decisionsOf,
  loadHostArgumentDeclarations,
  loadPlatformMcpServers,
  modelIdOf,
  safeMcpServers,
  safeModel,
  type McpReadiness,
} from './agent-config-projection.js';
import { selectableReasoningEfforts } from '../infrastructure/dsh/reasoning-efforts.js';
import { ENTERPRISE_DEFAULT_TOOLS } from '../runtime/policy/tool-names.js';
import { RISK_CLASSES } from '../infrastructure/dsh/tool-risk-policy.js';
import { stableStringify } from './canonical-json.js';
import {
  DELEGATION_MAX_ENTRIES,
  normalizedDelegation,
  parseDelegationConfig,
} from '../domain/agent/delegation-config.js';
import { normalizedDataSources, parseDataSourceConfig, unknownDataSources } from '../domain/agent/data-source-config.js';
import {
  DEFAULT_DELIVERY_POLICY,
  DELIVERY_POLICY_KEY,
  normalizedDeliveryPolicy,
  parseDeliveryPolicy,
} from '@dsh/contract/delivery-policy.js';
import { ENABLED_DATA_SOURCES_MAX, catalogEntryOf, readDataSourceCatalog, type DataSourceCatalogEntry } from '@dsh/contract/data-sources.js';
import { parseRemoteAgentRegistry } from '../runtime/providers/a2a-remote-registry.js';
import {
  parseToolArguments,
  readHostArgumentDeclarations,
  type HostArgumentSpec,
} from '../domain/agent/mcp-host-arguments.js';
import { SystemSkillCatalog, type SystemSkillEntry } from '../skills/system-catalog.js';
import { parseSkillPolicy, SKILL_POLICY_LAYER_MAX } from '@dsh/contract/skill-policy.js';
import {
  resolveSystemSkillRoot,
  skillPlatformConstraints,
  validateSkillPolicySemantics,
  type OrgSkillEntry,
  type SkillConfigDiagnostic,
} from './skill-policy-config.js';

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
  'delegation',
  'dataSources',
  // ADR 0015：Skill 目录与绑定。v1 增量可选字段，不升 schemaVersion。
  'skillPolicy',
  // ADR 0016：交付物人工审核。同样是 v1 增量可选字段。
  'deliveryPolicy',
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

export class AgentConfigValidator {
  readonly registry: Map<string, ModelEntry>;
  readonly mcpServers: Array<{ serverId: string; toolNames: string[] }>;
  readonly mcpReadiness: McpReadiness;
  readonly platformToolNames: readonly string[];
  /** `A2A_REMOTE_AGENTS_JSON` 里启用的远端；只留展示字段，地址与凭据引用不进配置面。 */
  readonly remoteAgents: ReadonlyArray<{ id: string; name: string; description: string }>;
  /** serverId → 运维声明的宿主参数（docs/design/mcp-per-agent-arguments.md D1）。 */
  readonly hostArguments: ReadonlyMap<string, HostArgumentSpec>;
  /** 数据源目录投影（`SANDBOX_DATA_SOURCES_JSON`，与 exec 同一解析规则）；目录写错构造即抛。 */
  readonly dataSources: readonly DataSourceCatalogEntry[];
  /** 系统层 Skill 目录（ADR 0015 D4）：`skillPolicy.system` 的「什么名字存在」权威。 */
  readonly systemSkillCatalog: SystemSkillCatalog;
  /** 上一次 `refreshSkills()` 投影到的系统包。 */
  private systemSkills: readonly SystemSkillEntry[] = Object.freeze([]);
  // 注意：**没有** org 层实例字段。它每 org 不同，而本对象是进程级单例；
  // 存成字段会让并发的两个 org 互相看到对方的 org 技能（跨租户泄漏）。
  // 见 `refreshSkills()` 的说明。
  /** 每次 `refreshSkills()` 重建，因此不是 readonly。 */
  optionsDto: AgentConfigOptions;

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
    remoteAgents?: ReadonlyArray<{ id: string; name?: string; description?: string }>;
    hostArguments?: ReadonlyMap<string, HostArgumentSpec>;
    dataSources?: readonly DataSourceCatalogEntry[];
    /**
     * 系统层 Skill 目录（ADR 0015 D4）。默认从 `SKILLS_ROOT`（compose 是 `./skills`）
     * 扫盘；配置面与 Run 解析必须用**同一份**目录。
     */
    systemSkillCatalog?: SystemSkillCatalog;
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
    this.hostArguments = opts.hostArguments ?? loadHostArgumentDeclarations(env);
    this.dataSources = Object.freeze((opts.dataSources ?? readDataSourceCatalog(env).map(catalogEntryOf)).map((e) => ({ ...e })));
    this.remoteAgents = Object.freeze(
      (opts.remoteAgents ?? parseRemoteAgentRegistry(env)).map((agent) => ({
        id: agent.id,
        name: agent.name ?? agent.id,
        description: agent.description ?? '',
      })),
    );
    this.platformToolNames = Object.freeze([
      ...new Set((opts.platformToolNames ?? ENTERPRISE_DEFAULT_TOOLS).map(String)),
    ]);
    this.systemSkillCatalog = opts.systemSkillCatalog ?? new SystemSkillCatalog({ root: resolveSystemSkillRoot(env) });
    // 系统目录是异步扫盘的，构造期只建一个空投影。HTTP 面在每次
    // `options()` / `validate()` 之前 `await refreshSkills()` 把它刷成最新；
    // **不刷新**时 `skillPolicy.system` 会看到空目录（合法名字一律
    // `SKILL_SYSTEM_UNKNOWN`），这是刻意的 fail-closed 方向——不会把未知名字
    // 当成可用，只会把可用名字暂时报成未知。
    this.refreshSkillProjection([]);
    // 构造期先建一份**空 org 层**的投影：没有调用者上下文时就等于「本 org 没有
    // org 技能」。HTTP 面随后按调用者现算（`options(orgSkills)`）。
    this.buildOptionsDto([]);
  }

  /**
   * 刷新**系统层**目录投影（ADR 0015 §4.2）。
   *
   * HTTP 面在每次 `options()` / `validate()` 之前 await 一次：目录是异步扫盘，
   * 而这两个方法本身是同步的（保持既有契约）。
   *
   * **org 层不在这里**：它是**每 org 不同**的数据，而这个校验器是进程级单例
   * （`createHttpServices()` 在启动时建一次）。把 org 层放进实例状态，两个 org 的并发
   * 请求会在 `await` 之间互相覆盖——A 的 `options()` 可能读到 B 的 org 技能列表，
   * 那是跨租户泄漏。所以 org 层作为**参数**逐次传入 `options()` / `validate()`。
   */
  async refreshSkills(): Promise<void> {
    const system = await this.systemSkillCatalog.list();
    this.refreshSkillProjection(system);
  }

  /** 上一次投影到的系统包（`resolveRunSkills` 与配置面共用同一份事实）。 */
  systemSkillEntries(): readonly SystemSkillEntry[] {
    return this.systemSkills;
  }

  /**
   * 当前 release 的系统包名。
   *
   * `skillPolicy.system.mode: all` 要展开成这批名字才能写引用账本——账本记的是
   * 「这个版本实际点名了哪些包」，只有展开后才知道 release 删包时谁受影响。
   */
  systemSkillNames(): readonly string[] {
    return this.systemSkills.map((entry) => entry.name);
  }

  /**
   * 组装 `fieldSupport` + `platformConstraints` + `capabilityRevision`。
   *
   * 构造期与每次 `refreshSkills()` 都走这一条，避免「options() 与 validate() 各自
   * 拼一份平台投影」。
   */
  private buildOptionsDto(orgSkills: readonly OrgSkillEntry[]): void {
    const models = [...this.registry.values()]
      .filter((entry) => entry.enabled)
      .map(safeModel);
    const mcpServers = this.mcpServers.map((server) => ({
      serverId: server.serverId,
      toolNames: [...server.toolNames],
      // 只有名字与描述：哪些参数由平台填，不含任何连接材料。
      hostArguments: Object.entries(this.hostArguments.get(server.serverId) ?? {})
        .map(([name, spec]) => ({ name, description: spec.description })),
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
      mcpServers: {
        supported: true,
        type: 'array',
        explicitEnabledTools: true,
        fields: { toolArguments: { supported: true, type: 'object' } },
      },
      delegation: {
        supported: true,
        type: 'object',
        fields: {
          agents: { supported: true, type: 'array', maxItems: DELEGATION_MAX_ENTRIES },
          remoteAgents: { supported: true, type: 'array', maxItems: DELEGATION_MAX_ENTRIES },
        },
      },
      dataSources: { supported: true, type: 'array', maxItems: ENABLED_DATA_SOURCES_MAX, fields: { id: { supported: true, type: 'string' } } },
      deliveryPolicy: {
        supported: true,
        type: 'object',
        fields: { mode: { supported: true, type: 'string' } },
      },
      skillPolicy: {
        supported: true,
        type: 'object',
        fields: {
          system: { supported: true, type: 'object' },
          org: { supported: true, type: 'array', maxItems: SKILL_POLICY_LAYER_MAX },
          user: { supported: true, type: 'string' },
        },
      },
    };
    const platformConstraints = {
      models,
      modelIds: models.map((model) => model.modelId),
      defaultModelId: resolveDefaultModelId(this.registry),
      tools: [...this.platformToolNames],
      mcpServers,
      mcpReadiness: { ...this.mcpReadiness },
      remoteAgents: this.remoteAgents.map((agent) => ({ ...agent })),
      dataSources: this.dataSources.map((entry) => ({ ...entry })),
      // 只返回本 org 的 org 层与系统层；**不返回**任何用户的个人 Skill、
      // 物理路径或文件内容（design §4.2）。
      skills: skillPlatformConstraints(this.systemSkills, orgSkills),
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

  /** 用一次扫盘结果替换系统目录投影。 */
  private refreshSkillProjection(system: readonly SystemSkillEntry[]): void {
    this.systemSkills = Object.freeze(system.map((entry) => Object.freeze({ ...entry })));
  }

  /**
   * `platformConstraints` 与 `capabilityRevision` 的一次性投影。
   *
   * **每次调用现算、不落实例**：org 层随调用者不同，落成字段就会被并发的另一个 org
   * 覆盖（跨租户泄漏）。`capabilityRevision` 因此也按本次的 org 层计算——它描述的是
   * 「调用者此刻看到的能力集」，这正是 design §4.2 要的语义。
   */
  private optionsProjection(orgSkills: readonly OrgSkillEntry[]): {
    readonly dto: AgentConfigOptions;
  } {
    this.buildOptionsDto(orgSkills);
    return { dto: this.optionsDto };
  }

  options(orgSkills: readonly OrgSkillEntry[] = []): AgentConfigOptions {
    // 现算一次：org 层是调用者维度的事实，不能沿用上一次调用留下的状态。
    this.buildOptionsDto(orgSkills);
    // Return a fresh object so callers cannot mutate the process capability
    // projection held by this validator.
    return {
      schemaVersion: this.optionsDto.schemaVersion,
      fieldSupport: JSON.parse(JSON.stringify(this.optionsDto.fieldSupport)),
      platformConstraints: JSON.parse(JSON.stringify(this.optionsDto.platformConstraints)),
      capabilityRevision: this.optionsDto.capabilityRevision,
    };
  }

  validate(
    rawConfig: unknown,
    orgSkills: readonly OrgSkillEntry[] = [],
  ): AgentConfigValidation {
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
    if (!hasSchema) {
      // 开发阶段无存量旧配置：缺 schemaVersion 不再按 legacy 兼容读取，
      // 直接 fail-closed。历史快照的冻结 JSON 由运行时绑定面只读，
      // 不走这个写入/预览校验器。
      errors.push(diagnostic(
        'schemaVersion',
        'CONFIG_SCHEMA_VERSION_MISSING',
        'schemaVersion is required and must be 1',
      ));
    } else if (schemaVersion !== AGENT_CONFIG_SCHEMA_VERSION) {
      errors.push(diagnostic(
        'schemaVersion',
        'CONFIG_SCHEMA_VERSION_UNSUPPORTED',
        `schemaVersion must be ${AGENT_CONFIG_SCHEMA_VERSION}`,
      ));
    }

    for (const key of Object.keys(config)) {
      if (TOP_LEVEL_V1_KEYS.includes(key)) continue;
      pushUnknown(errors, '', key);
    }

    if (config.systemPrompt !== undefined && typeof config.systemPrompt !== 'string') {
      errors.push(diagnostic('systemPrompt', 'CONFIG_TYPE', 'systemPrompt must be a string'));
    } else if (typeof config.systemPrompt === 'string' && config.systemPrompt.length > 64 * 1024) {
      errors.push(diagnostic('systemPrompt', 'CONFIG_LIMIT', 'systemPrompt exceeds 65536 characters'));
    }

    const modelPolicy = config.modelPolicy;
    let normalizedModelPolicy: Record<string, unknown> = {};
    let resolvedModel: ModelEntry | null = null;
    if (modelPolicy !== undefined && !isPlainObject(modelPolicy)) {
      errors.push(diagnostic('modelPolicy', 'CONFIG_TYPE', 'modelPolicy must be an object'));
    } else {
      const policy = (modelPolicy as Record<string, unknown> | undefined) ?? {};
      for (const key of Object.keys(policy)) {
        if (MODEL_POLICY_V1_KEYS.includes(key)) continue;
        pushUnknown(errors, 'modelPolicy', key);
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
          pushUnknown(errors, 'toolPolicy', key);
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
            pushUnknown(errors, path, key);
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
              pushUnknown(errors, `${path}.toolPolicy`, key);
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
        if (entry.toolArguments !== undefined) {
          const parsedArguments = parseToolArguments(
            entry.toolArguments,
            `${path}.toolArguments`,
            this.hostArguments.get(normalizedServerId) ?? {},
          );
          errors.push(...parsedArguments.errors);
          if (parsedArguments.values && Object.keys(parsedArguments.values).length) {
            normalizedEntry.toolArguments = canonicalObject(parsedArguments.values);
          }
        }
        normalizedMcp.push(normalizedEntry);
      }
    }

    // Shape only: whether each name exists in the org is checked by the
    // catalog service, which owns the org scope (this validator has no I/O).
    const delegation = parseDelegationConfig(config.delegation);
    errors.push(...delegation.errors);
    const registeredRemote = new Set(this.remoteAgents.map((agent) => agent.id));
    delegation.config?.remoteAgents.forEach((id, index) => {
      if (!registeredRemote.has(id)) {
        errors.push(diagnostic(
          `delegation.remoteAgents[${index}]`,
          'DELEGATION_REMOTE_AGENT_UNKNOWN',
          `Remote agent "${id}" is not registered on this platform`,
        ));
      }
    });

    const dataSources = parseDataSourceConfig(config.dataSources);
    errors.push(...dataSources.errors, ...unknownDataSources(dataSources.ids ?? [], this.dataSources));

    // ── deliveryPolicy（ADR 0016 D3，design §2）────────────────────────────
    //
    // 审核模式一期与委派互斥：子 Agent 在自己的工作区提交产物，那些产物无法
    // 归属到发起人的审核任务上，放行就绕过了审核。这里保存即拒绝，而不是
    // 让它到运行期才发生。「A2A 暴露」是 agent 维度的运行时状态（凭据表），
    // 没有 I/O 的本校验器看不到，由 `AgentCatalogService` 保存时另判。
    const deliveryParsed = parseDeliveryPolicy(config[DELIVERY_POLICY_KEY]);
    errors.push(...deliveryParsed.errors);
    const deliveryPolicy = deliveryParsed.policy ?? DEFAULT_DELIVERY_POLICY;
    if (deliveryParsed.policy?.mode === 'review') {
      const delegated = delegation.config;
      if (delegated && (delegated.agents.length > 0 || delegated.remoteAgents.length > 0)) {
        errors.push(diagnostic(
          DELIVERY_POLICY_KEY,
          'CONFIG_INVALID',
          'deliveryPolicy.mode "review" cannot be combined with delegation: a delegated sub-agent delivers artifacts outside this run\'s review',
        ));
      }
    }

    // ── skillPolicy（ADR 0015 D2，design §4.1）───────────────────────────────
    //
    // 形状校验在 contract（两侧共用），语义校验抽在 `validateSkillPolicySemantics`，
    // 与落库前的 `AgentCatalogService.#validateConfig()` 共用同一套判定。
    const skillPolicyParsed = parseSkillPolicy(config.skillPolicy);
    errors.push(...skillPolicyParsed.errors);
    const skillPolicy = skillPolicyParsed.policy;
    const skillSemantics = validateSkillPolicySemantics(
      skillPolicy,
      this.systemSkills,
      orgSkills,
    );
    errors.push(...skillSemantics.errors);
    const effectiveSystemSkills = skillSemantics.effective.system;
    const effectiveOrgSkills = skillSemantics.effective.org;

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
      delegation: {
        agents: delegation.config ? [...delegation.config.agents] : [],
        remoteAgents: delegation.config ? [...delegation.config.remoteAgents] : [],
      },
      dataSources: dataSources.ids ? [...dataSources.ids] : [],
      // 交付策略：`direct` 是省略即得的默认值，但仍显式投影出来——admin 界面
      // 要能区分「这个版本配了审核」和「没配」。
      delivery: { mode: deliveryPolicy.mode },
      // 展开后的有效 Skill 清单（design §4.2）：`system` 是展开后的名单，
      // `org` 是钉住的 (name, digest)，`user` 是开关本身。**不含** user 层具体包名——
      // 它随调用者变化，配置面不为某个用户做投影。
      skills: {
        system: [...effectiveSystemSkills],
        org: effectiveOrgSkills.map((entry) => ({ ...entry })),
        user: skillPolicy ? skillPolicy.user : 'allow',
      },
      persona: {
        configured: typeof config.systemPrompt === 'string' && config.systemPrompt.length > 0,
        chars: typeof config.systemPrompt === 'string' ? config.systemPrompt.length : 0,
      },
      // legacy 升级路径已删除：没有 schemaVersion 一律校验失败，
      // 不再有需要管理员逐项处理的迁移差集，该字段恒为空，仅保留形状。
      migration: {
        schemaVersion: hasSchema ? AGENT_CONFIG_SCHEMA_VERSION : null,
        blockedPaths: [],
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
    // execute. Unknown fields are rejected above, so a config returned here
    // always re-validates as valid v1 without a round trip silently deleting
    // anything the admin did not see.
    const normalized: Record<string, unknown> = {
      schemaVersion: AGENT_CONFIG_SCHEMA_VERSION,
      systemPrompt: typeof config.systemPrompt === 'string' ? config.systemPrompt : '',
      modelPolicy: normalizedModelPolicy,
      toolPolicy: normalizedToolPolicy,
      mcpServers: normalizedMcp,
    };
    const normalizedDelegationConfig = delegation.config
      ? normalizedDelegation(delegation.config)
      : undefined;
    if (normalizedDelegationConfig) normalized.delegation = normalizedDelegationConfig;
    const dataSourceList = normalizedDataSources(dataSources.ids ?? []);
    if (dataSourceList) normalized.dataSources = dataSourceList;
    // 只有显式给出 `skillPolicy` 才写回：省略 = 当前行为，写回一个等价对象会让
    // 既有版本的 `config_hash` 变化（ADR 0015 D2「既有 AgentVersion 不迁移」）。
    if (skillPolicy && Object.hasOwn(config, 'skillPolicy')) {
      normalized.skillPolicy = {
        system: {
          mode: skillPolicy.system.mode,
          ...(skillPolicy.system.mode === 'allowlist'
            ? { names: [...skillPolicy.system.names] }
            : {}),
        },
        org: skillPolicy.org.map((entry) => ({ ...entry })),
        user: skillPolicy.user,
      };
    }
    // 只有 review 才写回：`direct` 等价于省略，写回一个 `{mode:"direct"}` 只会
    // 让既有版本的 `config_hash` 白白变化（与 `skillPolicy` 同一条理由）。
    const normalizedDelivery = normalizedDeliveryPolicy(deliveryPolicy);
    if (normalizedDelivery) normalized[DELIVERY_POLICY_KEY] = normalizedDelivery;
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
        'delegation',
        'dataSources',
        'skillPolicy',
        'deliveryPolicy',
      ]) as Record<string, unknown>,
      effectiveSummary: summary,
      capabilityRevision: this.optionsDto.capabilityRevision,
    };
  }
}

