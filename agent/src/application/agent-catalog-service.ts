/**
 * Agent 目录的写入面：**一个 org 下并列的多个智能体**，每个智能体自带一条
 * 不可变的版本线（`docs/design/multi-agent-selection.md` §1）。
 *
 * 两条容易搞混的语义，代码里按它们分开：
 * - 「多一个可选的智能体」= 新增一行 `agent_definitions`（自带 v1）。
 * - 「改一个智能体的配置」= 给它加一行 `agent_versions`，旧行永不原地改写（D4）。
 *
 * 三条不可退让的约束（AGENTS.md §2）：
 * - **跨租户一律 404**：别的 org 的 agentId 与不存在的 agentId 返回同一个响应，
 *   存在性本身不能泄漏。
 * - **fail-closed 的角色判定**：写操作要求 `X-Acting-Role: admin`；角色解析不出
 *   来时拒绝，不回退到「默认允许」。校验放在这一层而不是 handler，因为
 *   agent/ 才是目录的权威——换个入口挂上来也绕不过它。
 * - **写入即校验**：config 在建版本时就跑一遍 `bindAgentVersionConfig()`，
 *   非法配置在这里失败，而不是等到 Run 起不来。
 */

import {
  ActiveVersionConflictError,
  AdminRoleRequiredError,
  OwnerScopedNotFoundError,
  ValidationError,
} from './errors.js';
import {
  AgentConfigValidator,
  type AgentConfigOptions,
  type AgentConfigValidation,
} from './agent-config-validator.js';
import {
  ExternalIdentityResolver,
  type ExternalAuth,
} from './parent/external-identity-resolver.js';
import { bindAgentVersionConfig } from '../infrastructure/dsh/agent-version-bindings.js';
import {
  DEFAULT_PI_SDK_VERSION,
  defaultAgentConfigJson,
  hashAgentConfig,
} from '../infrastructure/mysql/repositories/agent-catalog-repository.js';
import { ConflictError } from '../infrastructure/mysql/errors.js';
import { assertUlid, isUlid } from '../domain/shared/ulid.js';

/** 过渡期宽松类型：注入的依赖多数还是 JS 类，形状由各自的模块负责。 */
type Loose = any;

/** 建版本时最多重试的次数——只用于 (agent_id, version_no) 的并发抢号。 */
const MAX_VERSION_ATTEMPTS = 3;

/** 调用方带角色的 auth；`role` 由 BFF 解析后写头，浏览器伪造的会被剥掉。 */
export interface CatalogAuth extends ExternalAuth {
  role?: string | null;
}

export interface AgentConfigInput {
  readonly name?: unknown;
  readonly description?: unknown;
  readonly config?: unknown;
}

function requireName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ValidationError('name is required');
  }
  const name = value.trim();
  if (name.length > 255) {
    throw new ValidationError('name exceeds max length 255');
  }
  return name;
}

function normalizeDescription(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') {
    throw new ValidationError('description must be a string');
  }
  const description = value.trim();
  if (description.length > 2000) {
    throw new ValidationError('description exceeds max length 2000');
  }
  return description || null;
}

/** 目录对外的 Agent 视图。`active_version_no` 让 UI 不必再查一次版本表。 */
export function presentAgent(
  definition: Record<string, any>,
  activeVersion: Record<string, any> | null = null,
) {
  return {
    agent_id: definition.agentId,
    name: definition.name,
    description: definition.description ?? null,
    status: definition.status,
    active_version_id: definition.activeVersionId ?? null,
    active_version_no: activeVersion ? Number(activeVersion.versionNo) : null,
    created_at: definition.createdAt ?? null,
    updated_at: definition.updatedAt ?? null,
  };
}

export function presentAgentVersion(version: Record<string, any>) {
  return {
    agent_version_id: version.agentVersionId,
    agent_id: version.agentId,
    version_no: Number(version.versionNo),
    config: version.configJson ?? {},
    config_hash: version.configHash,
    pi_sdk_version: version.piSdkVersion,
    status: version.status,
    created_at: version.createdAt ?? null,
  };
}

export class AgentCatalogService {
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  tx: Loose;
  createRepositories: Loose;
  db: Loose;
  generateId: Loose;
  now: Loose;
  configValidator: AgentConfigValidator;

  constructor(deps: {
    transactionManager: Loose,
    createRepositories: Loose,
    db: Loose,
    generateId: () => string,
    now?: () => Date,
    /**
     * 配置契约的唯一解析入口。保存、预览、options 共用同一个实例，
     * 保证「校验通过的东西」和「保存下去的东西」是同一套语义。
     */
    configValidator?: AgentConfigValidator,
  }) {
    if (!deps?.transactionManager?.run || typeof deps.createRepositories !== 'function') {
      throw new Error('AgentCatalogService requires transactionManager and createRepositories');
    }
    if (!deps.db || typeof deps.generateId !== 'function') {
      throw new Error('AgentCatalogService requires db and generateId');
    }
    this.tx = deps.transactionManager;
    this.createRepositories = deps.createRepositories;
    this.db = deps.db;
    this.generateId = deps.generateId;
    this.now = deps.now ?? (() => new Date());
    this.configValidator = deps.configValidator ?? new AgentConfigValidator();
  }

  async #resolveOwner(auth: CatalogAuth, repos: Loose) {
    const resolver = new ExternalIdentityResolver({
      organizations: repos.organizations,
      externalRefs: repos.externalRefs,
    });
    return resolver.resolveOwner(auth);
  }

  /**
   * 写操作的角色闸门。**缺失即拒绝**——`role` 为 null 说明 BFF 没有解析出角色，
   * 那种情况下放行等于把管理面开给任何登录用户。
   */
  #requireAdmin(auth: CatalogAuth) {
    if (String(auth?.role || '').toLowerCase() !== 'admin') {
      throw new AdminRoleRequiredError();
    }
  }

  /** 跨租户与不存在返回同一个 404：存在性本身不能泄漏。 */
  async #requireOwnedAgent(repos: Loose, owner: Loose, agentId: unknown) {
    if (!isUlid(agentId)) {
      throw new OwnerScopedNotFoundError('Agent not found', {
        resource: 'agent_definitions',
        id: String(agentId),
      });
    }
    const definition = await repos.catalog.getDefinitionById(
      assertUlid(agentId, 'agentId'),
    );
    if (!definition || definition.orgId !== owner.orgId) {
      throw new OwnerScopedNotFoundError('Agent not found', {
        resource: 'agent_definitions',
        id: String(agentId),
      });
    }
    return definition;
  }

  /**
   * 活跃指针的乐观并发检查。
   *
   * `expected` 省略（`undefined`）时跳过——旧客户端的兼容窗口，见 `api.md`。
   * 显式传 `null` 表示「我读到的是还没有活跃版本」，与「我没传」不是一回事，
   * 所以两者必须分开判断，不能用 `?? null` 抹平。
   */
  #assertExpectedActiveVersion(definition: Loose, expected: unknown) {
    if (expected === undefined) return;
    const current = definition.activeVersionId ?? null;
    const wanted = expected === null || expected === '' ? null : String(expected);
    if (current !== wanted) {
      throw new ActiveVersionConflictError(current);
    }
  }

  /**
   * 写入即校验：非法 config 在这里失败，不允许落库后在 Run 期爆炸。
   * `agentVersionId` 只是让 binding 的必填校验成立，并不落库。
   */
  #validateConfig(config: unknown): Record<string, unknown> {
    if (config == null) return defaultAgentConfigJson();
    if (typeof config !== 'object' || Array.isArray(config)) {
      throw new ValidationError('config must be an object');
    }
    let configJson: Record<string, unknown>;
    try {
      configJson = JSON.parse(JSON.stringify(config));
    } catch {
      throw new ValidationError('config must be JSON-serializable');
    }
    try {
      bindAgentVersionConfig({
        agentVersionId: 'validation-probe',
        configJson,
        piSdkVersion: DEFAULT_PI_SDK_VERSION,
      });
    } catch (err) {
      throw new ValidationError(
        (err as Error)?.message || 'Agent config is invalid',
        { code: (err as { code?: string })?.code || 'AGENT_CONFIG_INVALID' },
      );
    }
    return configJson;
  }

  /**
   * 配置面的能力投影（admin）。只描述「这个部署支持什么、上限在哪」，
   * 不返回连接地址、密钥引用、宿主物理路径或别的用户的技能。
   */
  async configOptions(auth: CatalogAuth): Promise<AgentConfigOptions> {
    this.#requireAdmin(auth);
    // 归属仍要解析：没有 provision 的调用方不该拿到平台目录。
    const repos = this.createRepositories(this.db);
    await this.#resolveOwner(auth, repos);
    return this.configValidator.options();
  }

  /**
   * 只解析、不落库的配置校验（admin）。**不跑工具、不调模型、不建会话、
   * 不临时装 MCP**——它的唯一副作用是读一次进程能力投影。
   *
   * 带 `agentId` 时按同一条 404 规则确认归属：跨 org 的 agentId 不能靠这个
   * 端点探测存在性。
   */
  async validateConfig(
    auth: CatalogAuth,
    input: { config?: unknown, agentId?: unknown } = {},
  ): Promise<AgentConfigValidation> {
    this.#requireAdmin(auth);
    const repos = this.createRepositories(this.db);
    const owner = await this.#resolveOwner(auth, repos);
    if (input.agentId != null && input.agentId !== '') {
      await this.#requireOwnedAgent(repos, owner, input.agentId);
    }
    if (input.config == null || typeof input.config !== 'object' || Array.isArray(input.config)) {
      throw new ValidationError('config must be an object');
    }
    try {
      return this.configValidator.validate(input.config);
    } catch (err) {
      // 结构性问题（非 JSON 可序列化等）是 400；字段级语义结果走 200 + valid=false。
      throw new ValidationError(
        (err as Error)?.message || 'Agent config is invalid',
        { code: 'AGENT_CONFIG_INVALID' },
      );
    }
  }

  /**
   * org 内的 Agent 列表（member 可读）。
   *
   * 尚未 provision 的调用方返回空列表而不是 404——与 `ConversationService.list`
   * 同一处理：可信主体只是还没有任何数据，不是「查不到别人的东西」。
   */
  async listAgents(auth: CatalogAuth, opts: { limit?: number } = {}) {
    const repos = this.createRepositories(this.db);
    let owner;
    try {
      owner = await this.#resolveOwner(auth, repos);
    } catch (err) {
      if (err instanceof OwnerScopedNotFoundError) return { agents: [] };
      throw err;
    }
    const definitions = await repos.catalog.listDefinitionsByOrg(owner.orgId, {
      limit: opts.limit ?? 50,
    });
    const agents = [];
    for (const definition of definitions) {
      const activeVersion = definition.activeVersionId
        ? await repos.catalog.getVersionById(definition.activeVersionId)
        : null;
      agents.push(presentAgent(definition, activeVersion));
    }
    return { agents };
  }

  /** 某个 Agent 的版本线（admin）。 */
  async listVersions(auth: CatalogAuth, agentId: string, opts: { limit?: number } = {}) {
    this.#requireAdmin(auth);
    const repos = this.createRepositories(this.db);
    const owner = await this.#resolveOwner(auth, repos);
    const definition = await this.#requireOwnedAgent(repos, owner, agentId);
    const versions = await repos.catalog.listVersionsByAgent(definition.agentId, {
      limit: opts.limit ?? 50,
    });
    return {
      agent: presentAgent(
        definition,
        versions.find(
          (v: Loose) => v.agentVersionId === definition.activeVersionId,
        ) ?? null,
      ),
      versions: versions.map(presentAgentVersion),
    };
  }

  /**
   * 新建一个 Agent：definition + v1 + `active_version_id` 指向 v1，单事务内完成。
   * 半成品（有 definition 没 version）会让建会话在 provision 时失败，所以三步
   * 必须同生共死。
   */
  async createAgent(auth: CatalogAuth, input: AgentConfigInput = {}) {
    this.#requireAdmin(auth);
    const name = requireName(input.name);
    const description = normalizeDescription(input.description);
    const configJson = this.#validateConfig(input.config);

    return this.tx.run(async (trx: Loose) => {
      const repos = this.createRepositories(trx);
      const owner = await this.#resolveOwner(auth, repos);
      const agentId = this.generateId();
      const agentVersionId = this.generateId();
      let definition;
      try {
        definition = await repos.catalog.createDefinition({
          agentId,
          orgId: owner.orgId,
          name,
          description,
          status: 'active',
          createdBy: owner.userId,
        });
      } catch (err) {
        if (err instanceof ConflictError) {
          throw new ValidationError(
            `An agent named "${name}" already exists in this organization`,
            { code: 'AGENT_NAME_CONFLICT' },
          );
        }
        throw err;
      }
      const version = await repos.catalog.createVersion({
        agentVersionId,
        agentId: definition.agentId,
        versionNo: 1,
        configJson,
        configHash: hashAgentConfig(configJson),
        piSdkVersion: DEFAULT_PI_SDK_VERSION,
        status: 'active',
        createdBy: owner.userId,
      });
      definition = await repos.catalog.setActiveVersion(
        definition.agentId,
        version.agentVersionId,
      );
      return {
        agent: presentAgent(definition, version),
        version: presentAgentVersion(version),
      };
    });
  }

  /**
   * 改配置 = 建新版本（D4）。`activate` 为真时一并切活跃版本；这只影响**新建的
   * 会话**，正在跑的 Run 与已存在的 AgentSession 继续用它们钉住的版本。
   */
  async createVersion(
    auth: CatalogAuth,
    agentId: string,
    input: {
      config?: unknown,
      activate?: unknown,
      expectedActiveVersionId?: unknown,
    } = {},
  ) {
    this.#requireAdmin(auth);
    const configJson = this.#validateConfig(input.config);
    const activate = input.activate !== false;

    let lastConflict: unknown = null;
    for (let attempt = 0; attempt < MAX_VERSION_ATTEMPTS; attempt += 1) {
      try {
        return await this.tx.run(async (trx: Loose) => {
          const repos = this.createRepositories(trx);
          const owner = await this.#resolveOwner(auth, repos);
          let definition = await this.#requireOwnedAgent(repos, owner, agentId);
          // 只有会改活跃指针的保存才做这项检查：保存一个不激活的版本不与
          // 别人的激活结果竞争，不该因为指针变了就失败。
          if (activate) {
            this.#assertExpectedActiveVersion(definition, input.expectedActiveVersionId);
          }
          const versionNo = await repos.catalog.nextVersionNo(definition.agentId);
          const version = await repos.catalog.createVersion({
            agentVersionId: this.generateId(),
            agentId: definition.agentId,
            versionNo,
            configJson,
            configHash: hashAgentConfig(configJson),
            piSdkVersion: DEFAULT_PI_SDK_VERSION,
            status: 'active',
            createdBy: owner.userId,
          });
          if (activate) {
            definition = await repos.catalog.setActiveVersion(
              definition.agentId,
              version.agentVersionId,
            );
          }
          return {
            agent: presentAgent(definition, activate ? version : null),
            version: presentAgentVersion(version),
          };
        });
      } catch (err) {
        // uk_agent_version 抢号失败：另一个 admin 拿走了同一个 version_no。
        if (!(err instanceof ConflictError)) throw err;
        lastConflict = err;
      }
    }
    throw lastConflict;
  }

  /**
   * 切活跃版本（也是回滚：把指针指回旧版本即可，无需任何数据修复）。
   */
  async setActiveVersion(
    auth: CatalogAuth,
    agentId: string,
    agentVersionId: unknown,
    opts: { expectedActiveVersionId?: unknown } = {},
  ) {
    this.#requireAdmin(auth);
    return this.tx.run(async (trx: Loose) => {
      const repos = this.createRepositories(trx);
      const owner = await this.#resolveOwner(auth, repos);
      const definition = await this.#requireOwnedAgent(repos, owner, agentId);
      this.#assertExpectedActiveVersion(definition, opts.expectedActiveVersionId);
      if (!isUlid(agentVersionId)) {
        throw new OwnerScopedNotFoundError('Agent version not found', {
          resource: 'agent_versions',
          id: String(agentVersionId),
        });
      }
      const version = await repos.catalog.getVersionById(
        assertUlid(agentVersionId, 'agentVersionId'),
      );
      // 版本不属于这个 Agent 与版本不存在同样是 404——否则可以用别人的
      // versionId 探测存在性。
      if (!version || version.agentId !== definition.agentId) {
        throw new OwnerScopedNotFoundError('Agent version not found', {
          resource: 'agent_versions',
          id: String(agentVersionId),
        });
      }
      const updated = await repos.catalog.setActiveVersion(
        definition.agentId,
        version.agentVersionId,
      );
      return {
        agent: presentAgent(updated, version),
        version: presentAgentVersion(version),
      };
    });
  }
}
