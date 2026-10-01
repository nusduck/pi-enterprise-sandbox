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
 * - **fail-closed 的角色判定**：写操作要求 `X-Acting-Role` 集合里含 `admin`
 *   （`hasRole()`：白名单 + 大小写不敏感，`admin,reviewer` 也算）；解析不出来时
 *   拒绝，不回退到「默认允许」。校验放在这一层而不是 handler，因为
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
  type AgentConfigDiagnostic,
  type AgentConfigOptions,
  type AgentConfigValidation,
} from './agent-config-validator.js';
import { validateSkillPolicySemantics } from './skill-policy-config.js';
import { parseSkillPolicy } from '@dsh/contract/skill-policy.js';
import type { OrgSkillEntry } from './skill-policy-config.js';
import {
  ExternalIdentityResolver,
  type ExternalAuth,
} from './parent/external-identity-resolver.js';
import { bindAgentVersionConfig } from '../infrastructure/dsh/agent-version-bindings.js';
import { parseDeliveryPolicy } from '@dsh/contract/delivery-policy.js';
import {
  defaultAgentConfigJson,
  hashAgentConfig,
} from '../infrastructure/mysql/repositories/agent-catalog-repository.js';
import { ConflictError } from '../infrastructure/mysql/errors.js';
import { assertUlid, isUlid } from '../domain/shared/ulid.js';
import { parseDelegationConfig } from '../domain/agent/delegation-config.js';
import { parseDataSourceConfig, unknownDataSources } from '../domain/agent/data-source-config.js';
import { ROLE_ADMIN, hasRole } from '../domain/identity/roles.js';

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
    if (!hasRole(auth, ROLE_ADMIN)) {
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
   * 从配置算出这个 AgentVersion 的 Skill 引用集合（ADR 0015 D5，design §5.2）。
   *
   * **用户层不进引用账本**：它属于调用者、随启用账本变化，不随 AgentVersion 固定。
   * 所以这里只产出 `system` 与 `org` 两种 scope。
   *
   * `system.mode: all` 要展开成当前 release 的全部名字——引用账本记的是「这个版本实际
   * 点名了哪些包」，而不是「它说的是 all」：只有展开后才能回答「release 删掉某个包时
   * 谁受影响」，而那个问题在设计 §12 里是明确要能回答的。
   */
  async #skillRefsFor(configJson: Record<string, unknown>): Promise<Array<{
    scope: 'system' | 'org';
    name: string;
    contentDigest?: string;
  }>> {
    const policy = parseSkillPolicy(configJson.skillPolicy).policy;
    // 形状非法时保存路径已经在别处拒绝过；这里返回空集合而不是抛错，
    // 免得一个引用账本的问题把版本创建整个带下去。
    if (!policy) return [];
    const refs: Array<{ scope: 'system' | 'org'; name: string; contentDigest?: string }> = [];
    if (policy.system.mode === 'allowlist') {
      for (const name of policy.system.names) refs.push({ scope: 'system', name });
    } else if (policy.system.mode === 'all') {
      for (const name of await this.configValidator.systemSkillNames()) {
        refs.push({ scope: 'system', name });
      }
    }
    for (const entry of policy.org) {
      refs.push({ scope: 'org', name: entry.name, contentDigest: entry.contentDigest });
    }
    return refs;
  }

  /**
   * 本 org 可被新绑定的 org 层版本，投影成配置面校验要的形状（ADR 0015 D5/D8）。
   *
   * 只取 `active` / `deprecated`：`revoked` 在配置面**等于不存在**——它必须在保存时
   * 就被判成「没这个版本」，而不是等到 Run 解析才静默排除。`currentDigest` 取自
   * `org_skills` 的当前指针，供 UI 默认选中（**不影响已钉住的版本**，D3）。
   */
  async #orgSkillEntries(repos: Loose, orgId: string): Promise<OrgSkillEntry[]> {
    const rows = await repos.orgSkills.listForOrg({ orgId });
    return rows.flatMap((group) => group.versions
      .filter((version) => version.status !== 'revoked')
      .map((version) => ({
        name: version.name,
        contentDigest: version.contentDigest,
        status: version.status,
        description: version.description,
        currentDigest: group.currentDigest,
        publishedAt: version.publishedAt,
      })));
  }

  /**
   * 写入即校验：非法 config 在这里失败，不允许落库后在 Run 期爆炸。
   * `agentVersionId` 只是让 binding 的必填校验成立，并不落库。
   *
   * `skillPolicy` 的语义（名字在不在当前 release）与配置面校验**共用**
   * `validateSkillPolicySemantics`：只在一处判，另一处就会把「保存成功但起 Run 必失败」
   * 的配置写进库。这里依赖 `refreshSkills()` 已经刷过目录投影，所以是 async。
   */
  async #validateConfig(config: unknown, repos: Loose, orgId: string): Promise<Record<string, unknown>> {
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
      });
    } catch (err) {
      throw new ValidationError(
        (err as Error)?.message || 'Agent config is invalid',
        { code: (err as { code?: string })?.code || 'AGENT_CONFIG_INVALID' },
      );
    }
    // 数据源必须在平台目录里：写错的 id 在保存时拒绝，而不是等 Run 起来后 exec 报错。
    const [unknownSource] = unknownDataSources(
      parseDataSourceConfig(configJson.dataSources).ids ?? [],
      this.configValidator.dataSources,
    );
    if (unknownSource) {
      throw new ValidationError(`${unknownSource.path}: ${unknownSource.message}`, { code: unknownSource.code });
    }
    // Skill 目录是异步扫盘 + 读 org 账本，刷新后再判——否则「今天合法、明天 release
    // 换掉」的名字会被静默写库。
    const orgSkillEntries = await this.#orgSkillEntries(repos, orgId);
    await this.configValidator.refreshSkills();
    const skillPolicyParsed = parseSkillPolicy(configJson.skillPolicy);
    const [skillError] = skillPolicyParsed.errors;
    if (skillError) {
      throw new ValidationError(`${skillError.path}: ${skillError.message}`, { code: skillError.code });
    }
    const [semanticError] = validateSkillPolicySemantics(
      skillPolicyParsed.policy,
      this.configValidator.systemSkillEntries(),
      orgSkillEntries,
    ).errors;
    if (semanticError) {
      throw new ValidationError(`${semanticError.path}: ${semanticError.message}`, { code: semanticError.code });
    }
    return configJson;
  }

  /**
   * `delegation.agents` 里的每个名字必须是本 org 已有的 Agent（agent-delegation.md D2）。
   * 按 (org, name) 查，别的 org 的同名 Agent 查不到，与不存在同一个码。
   * 目标之后被停用或删除由 spawn 在运行时再判一次，这里只挡写错的名字。
   */
  async #unknownDelegationTargets(
    repos: Loose,
    orgId: string,
    configJson: Record<string, unknown>,
  ): Promise<Array<{ path: string, code: string, message: string }>> {
    const parsed = parseDelegationConfig(configJson.delegation);
    const out = [];
    for (const [index, name] of (parsed.config?.agents ?? []).entries()) {
      const definition = await repos.catalog.getDefinitionByOrgAndName(orgId, name);
      if (!definition) {
        out.push({
          path: `delegation.agents[${index}]`,
          code: 'DELEGATION_AGENT_UNKNOWN',
          message: `No agent named "${name}" exists in this organization`,
        });
      }
    }
    return out;
  }

  async #assertDelegationTargets(repos: Loose, orgId: string, configJson: Record<string, unknown>) {
    const [first] = await this.#unknownDelegationTargets(repos, orgId, configJson);
    if (first) {
      throw new ValidationError(`${first.path}: ${first.message}`, { code: first.code });
    }
  }

  /**
   * `deliveryPolicy.mode === "review"` 与「A2A 暴露」互斥（ADR 0016 D3、design §2）。
   *
   * 外部 A2A 调用方期望**直接拿到产物**，而审核工作区里的产物在放行前对 owner
   * 一律不可见。两者叠在一起只有两种结局：外部调用方永远 404，或者有人把审核
   * 关掉。所以保存时就拒绝，不让它在第一次外部调用时才暴露。
   *
   * 判定依据是**当前有效**的 A2A 凭据。已撤销/过期的凭据不再暴露这个 Agent，
   * 不该阻止它改成审核模式。
   *
   * 反方向（给审核模式的 Agent 签新凭据）由
   * `a2a/credential-service.ts#assertAgentNotUnderArtifactReview` 拦——两边都判，
   * 因为「互斥」是双边的，只判一边等于留了一条后门。
   *
   * 返回诊断而不是直接抛：**预览与保存必须给同一个答案**。预览
   * （`validateConfig`）说 valid、保存却 400，正是 AGENTS.md §3 说的
   * 「保存、预览、执行各自猜语义」。
   */
  async #reviewVsA2aDiagnostic(
    repos: Loose,
    orgId: string,
    agentId: string,
    configJson: Record<string, unknown>,
  ): Promise<AgentConfigDiagnostic | null> {
    if (parseDeliveryPolicy(configJson.deliveryPolicy).policy?.mode !== 'review') return null;
    const credentials = await repos.a2aCredentials.listByOrg(orgId, { agentId });
    const active = (credentials as Loose[]).filter(
      (credential) => String(credential?.status ?? '').toLowerCase() === 'active',
    );
    if (active.length === 0) return null;
    return {
      path: 'deliveryPolicy',
      code: 'CONFIG_INVALID',
      message:
        'deliveryPolicy.mode "review" cannot be combined with A2A exposure: ' +
        'revoke this agent\'s active A2A credentials first, or use a separate agent for review delivery',
    };
  }

  async #assertNoA2aExposureForReview(
    repos: Loose,
    orgId: string,
    agentId: string,
    configJson: Record<string, unknown>,
  ) {
    const diagnostic = await this.#reviewVsA2aDiagnostic(repos, orgId, agentId, configJson);
    if (diagnostic) {
      throw new ValidationError(`${diagnostic.path}: ${diagnostic.message}`, {
        code: diagnostic.code,
      });
    }
  }

  /**
   * 配置面的能力投影（admin）。只描述「这个部署支持什么、上限在哪」，
   * 不返回连接地址、密钥引用、宿主物理路径或别的用户的技能。
   */
  async configOptions(auth: CatalogAuth): Promise<AgentConfigOptions> {
    this.#requireAdmin(auth);
    // 归属仍要解析：没有 provision 的调用方不该拿到平台目录。
    const repos = this.createRepositories(this.db);
    const owner = await this.#resolveOwner(auth, repos);
    // Skill 目录是异步扫盘 + 读 org 账本，`options()` 本身是同步的（保持既有契约），
    // 所以在这里先刷一次投影。`capabilityRevision` 随之反映当前系统包名集合与 org 层
    // `(name, digest, status)` 集合（design §4.2）。
    const orgSkillEntries = await this.#orgSkillEntries(repos, owner.orgId);
    await this.configValidator.refreshSkills();
    return this.configValidator.options(orgSkillEntries);
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
    // 与 `configOptions` 同源：校验 `skillPolicy.system` 的名字是否在**当前** release 里、
    // `skillPolicy.org` 的版本是否可绑，依赖的是同一份刷新过的目录投影。
    const orgSkillEntries = await this.#orgSkillEntries(repos, owner.orgId);
    await this.configValidator.refreshSkills();
    let result: AgentConfigValidation;
    try {
      result = this.configValidator.validate(input.config, orgSkillEntries);
    } catch (err) {
      // 结构性问题（非 JSON 可序列化等）是 400；字段级语义结果走 200 + valid=false。
      throw new ValidationError(
        (err as Error)?.message || 'Agent config is invalid',
        { code: 'AGENT_CONFIG_INVALID' },
      );
    }
    if (!result.valid) return result;
    const unknown = await this.#unknownDelegationTargets(
      repos,
      owner.orgId,
      result.normalizedConfig ?? {},
    );
    // A2A 互斥要读凭据账本，所以只能在有 repos 的这一层判（纯校验器没有 I/O）。
    // 判出来就与保存路径给同一个 valid:false，避免「预览通过、保存 400」。
    const a2aConflict =
      input.agentId != null && input.agentId !== ''
        ? await this.#reviewVsA2aDiagnostic(
            repos,
            owner.orgId,
            assertUlid(String(input.agentId), 'agentId'),
            result.normalizedConfig ?? {},
          )
        : null;
    if (unknown.length === 0 && a2aConflict === null) return result;
    // valid:false 必然不带 normalizedConfig（api.md 配置契约）。
    const { normalizedConfig: _dropped, ...rest } = result;
    return {
      ...rest,
      valid: false,
      errors: [...result.errors, ...unknown, ...(a2aConflict ? [a2aConflict] : [])],
    };
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
    // 归属在事务外先解析：`skillPolicy.org` 的校验要读本 org 的账本，而账本读取
    // 不该被创建事务的成败影响（失败回滚也不该让校验看到半个状态）。
    const owner = await this.#resolveOwner(auth, this.createRepositories(this.db));
    const configJson = await this.#validateConfig(
      input.config,
      this.createRepositories(this.db),
      owner.orgId,
    );

    return this.tx.run(async (trx: Loose) => {
      const repos = this.createRepositories(trx);
      const owner = await this.#resolveOwner(auth, repos);
      await this.#assertDelegationTargets(repos, owner.orgId, configJson);
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
        status: 'active',
        createdBy: owner.userId,
      });
      // 引用账本与版本**同一个事务**（design §5.3）：分开写会留下「版本存在但引用
      // 缺失」的中间态，而那时 GC 会认为某个 org 版本没人引用并回收它。
      await repos.agentVersionSkillRefs.insertForVersion({
        agentVersionId: version.agentVersionId,
        orgId: owner.orgId,
        refs: await this.#skillRefsFor(configJson),
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
    const owner = await this.#resolveOwner(auth, this.createRepositories(this.db));
    const configJson = await this.#validateConfig(
      input.config,
      this.createRepositories(this.db),
      owner.orgId,
    );
    const activate = input.activate !== false;

    let lastConflict: unknown = null;
    for (let attempt = 0; attempt < MAX_VERSION_ATTEMPTS; attempt += 1) {
      try {
        return await this.tx.run(async (trx: Loose) => {
          const repos = this.createRepositories(trx);
          const owner = await this.#resolveOwner(auth, repos);
          let definition = await this.#requireOwnedAgent(repos, owner, agentId);
          await this.#assertDelegationTargets(repos, owner.orgId, configJson);
          await this.#assertNoA2aExposureForReview(
            repos,
            owner.orgId,
            definition.agentId,
            configJson,
          );
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
            status: 'active',
            createdBy: owner.userId,
          });
          // 与版本同一个事务：引用缺失会让 GC 误回收还在用的 org 版本。
          await repos.agentVersionSkillRefs.insertForVersion({
            agentVersionId: version.agentVersionId,
            orgId: owner.orgId,
            refs: await this.#skillRefsFor(configJson),
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
        // ind_agsvc_av_a1（agent_id, version_no）抢号失败：另一个 admin 拿走了同一个 version_no。
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
