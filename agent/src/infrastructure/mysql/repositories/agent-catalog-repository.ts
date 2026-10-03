/**
 * Agent definition + version catalog (plan §8.4–8.5).
 *
 * Used by RunParentProvisioner to ensure a tenant default agent definition and
 * immutable version exist before Conversation / Agent Session / Run creation.
 * Existing catalog tables had no repository prior to PR-04 T2.
 */

import { toMysqlDateTime, parseJsonColumn, formatDateTime } from '../row-mappers.js';
import { ConflictError, NotFoundError } from '../errors.js';
import { assertUlid } from '../../../domain/shared/ulid.js';
import { createHash } from 'node:crypto';

/** Default tenant agent definition name (stable per org). */
export const DEFAULT_AGENT_DEFINITION_NAME = '通用智能体';

/**
 * @param err
 * @returns {boolean}
 */
function isDuplicateKeyError(err: unknown) {
  const code = (err as { code?: string, errno?: number })?.code;
  const errno = (err as { errno?: number })?.errno;
  return code === 'ER_DUP_ENTRY' || errno === 1062;
}

export function mapAgentDefinition(row: Record<string, unknown>) {
  return {
    agentId: String(row.agent_id),
    orgId: String(row.org_id),
    name: String(row.name),
    description: row.description == null ? null : String(row.description),
    status: String(row.status),
    activeVersionId:
      row.active_version_id == null ? null : String(row.active_version_id),
    // 可见范围（design agent-visibility §3）：缺列的旧库视同 `org`，即迁移前的行为。
    visibility: row.visibility === 'restricted' ? 'restricted' : 'org',
    createdBy: String(row.created_by),
    createdAt: formatDateTime(row.created_at),
    updatedAt: formatDateTime(row.updated_at),
  };
}

export function mapAgentVersion(row: Record<string, unknown>) {
  return {
    agentVersionId: String(row.agent_version_id),
    agentId: String(row.agent_id),
    versionNo: Number(row.version_no),
    configJson: parseJsonColumn(row.config_json),
    configHash: String(row.config_hash),
    status: String(row.status),
    createdBy: String(row.created_by),
    createdAt: formatDateTime(row.created_at),
  };
}

/**
 * Stable config hash for agent version config JSON.
 * @param configJson
 * @returns {string}
 */
export function hashAgentConfig(configJson: Record<string, unknown>) {
  const body = JSON.stringify(configJson ?? {});
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/**
 * Minimal default agent config (plan §8.5 shape).
 * @returns {Record<string, unknown>}
 */
export function defaultAgentConfigJson() {
  return {
    schemaVersion: 1,
    modelPolicy: {},
    systemPrompt: '',
    mcpServers: [],
    toolPolicy: {},
  };
}

/**
 * 租户默认「通用智能体」首个版本的 persona：只讲角色与 Skill 用法，
 * 通用做事规范在平台的 task-contract 节里，不在这里重复。
 */
export const TENANT_DEFAULT_AGENT_PERSONA = [
  '你是企业内的通用智能体，面向日常办公、文档处理、数据分析与工程类任务。',
  '- 本 Run 可用的 Skill（平台系统 Skill 与调用者已启用的个人 Skill）会列在技能目录中。任务与某个 Skill 的描述匹配时，先读取它的 SKILL.md，再按其中的步骤执行；没有匹配的 Skill 时直接用可用工具完成。',
  '- Word、Excel、PowerPoint、PDF、Markdown/HTML 等文件类交付优先使用对应 Skill，产出后检查内容与格式。',
  '- 多步骤或范围较大的任务先给出简短计划，再逐步执行。',
].join('\n');

/**
 * 租户默认 Agent 的首个版本配置：显式绑定全部系统 Skill + 调用者已启用的个人 Skill
 * （ADR 0015 D2；与省略 `skillPolicy` 的运行语义相同，但配置面能如实展示）。
 * org 层按设计只能钉摘要（D3），没有「全部」，由管理员在配置页按需加入。
 *
 * 只用于 `ensureTenantDefaultAgent`；用户新建的 Agent 仍从 `defaultAgentConfigJson()` 起步，
 * 不继承这份 persona。
 */
export function tenantDefaultAgentConfigJson() {
  return {
    ...defaultAgentConfigJson(),
    systemPrompt: TENANT_DEFAULT_AGENT_PERSONA,
    skillPolicy: {
      system: { mode: 'all', names: [] },
      org: [],
      user: 'allow',
    },
  };
}

export class AgentCatalogRepository {
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  db: import('knex').Knex | import('knex').Knex.Transaction;
  now: () => Date;

  constructor(db: import('knex').Knex | import('knex').Knex.Transaction, opts: { now?: () => Date } = {}) {
    if (!db) throw new Error('AgentCatalogRepository requires a knex executor');
    this.db = db;
    this.now = opts.now ?? (() => new Date());
  }

  async getDefinitionById(agentId: string) {
    const id = assertUlid(agentId, 'agentId');
    const row = await this.db('tbl_agsvc_agent_definitions').where({ agent_id: id }).first();
    return row ? mapAgentDefinition(row) : null;
  }

  /**
   * `lockForShare`: 加锁读（LOCK IN SHARE MODE）读最新已提交版本，不受 REPEATABLE READ
   * 快照影响。撞唯一键后的重读必须用它——普通读看不到并发事务刚提交的那一行。
   */
  async getDefinitionByOrgAndName(orgId: string, name: string, opts: { lockForShare?: boolean } = {}) {
    const oid = assertUlid(orgId, 'orgId');
    if (typeof name !== 'string' || !name.trim()) {
      throw new Error('name must be a non-empty string');
    }
    let q = this.db('tbl_agsvc_agent_definitions').where({ org_id: oid, name: name.trim() });
    if (opts.lockForShare) q = q.forShare();
    const row = await q.first();
    return row ? mapAgentDefinition(row) : null;
  }

  async listDefinitionsByOrg(orgId: string, opts: { limit?: number } = {}) {
    const oid = assertUlid(orgId, 'orgId');
    const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 100);
    const rows = await this.db('tbl_agsvc_agent_definitions')
      .where({ org_id: oid })
      .orderBy('created_at', 'desc')
      .limit(limit);
    return rows.map(mapAgentDefinition);
  }

  /**
   * @param {{
   *   agentId: string,
   *   orgId: string,
   *   name: string,
   *   description?: string | null,
   *   status?: string,
   *   activeVersionId?: string | null,
   *   createdBy: string,
   *   createdAt?: Date | string,
   *   updatedAt?: Date | string,
   * }} input
   */
  async createDefinition(input: { agentId: string, orgId: string, name: string, description?: string | null, status?: string, activeVersionId?: string | null, createdBy: string, createdAt?: Date | string, updatedAt?: Date | string, }) {
    const agentId = assertUlid(input.agentId, 'agentId');
    const orgId = assertUlid(input.orgId, 'orgId');
    const createdBy = assertUlid(input.createdBy, 'createdBy');
    if (typeof input.name !== 'string' || !input.name.trim()) {
      throw new Error('name must be a non-empty string');
    }
    const now = toMysqlDateTime(input.createdAt || this.now());
    const updated = toMysqlDateTime(
      input.updatedAt || input.createdAt || this.now(),
    );
    const name = input.name.trim();
    try {
      await this.db('tbl_agsvc_agent_definitions').insert({
        agent_id: agentId,
        org_id: orgId,
        name,
        description: input.description ?? null,
        status: input.status ?? 'active',
        active_version_id: input.activeVersionId
          ? assertUlid(input.activeVersionId, 'activeVersionId')
          : null,
        created_by: createdBy,
        created_at: now,
        updated_at: updated,
      });
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        // ind_agsvc_ad_a1 (org_id, name) or primary key collision.
        const msg = String((err as { message?: string })?.message || '');
        if (
          msg.includes('ind_agsvc_ad_a1') ||
          msg.includes("for key 'org_id'") ||
          msg.includes('org_id_name')
        ) {
          throw new ConflictError('Agent definition name conflict', {
            resource: 'agent_definitions',
            id: `${orgId}:${name}`,
          });
        }
        throw new ConflictError('Agent definition id conflict', {
          resource: 'agent_definitions',
          id: agentId,
        });
      }
      throw err;
    }
    return this.getDefinitionById(agentId);
  }

  /**
   * Version line of one Agent, newest first. Callers scope by agent ownership
   * before calling: this repository does not know about orgs.
   */
  async listVersionsByAgent(agentId: string, opts: { limit?: number } = {}) {
    const aid = assertUlid(agentId, 'agentId');
    const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 100);
    const rows = await this.db('tbl_agsvc_agent_versions')
      .where({ agent_id: aid })
      .orderBy('version_no', 'desc')
      .limit(limit);
    return rows.map(mapAgentVersion);
  }

  /**
   * Next `version_no` for an Agent. Racy by itself — the caller relies on
   * ind_agsvc_av_a1 (agent_id, version_no) to reject a lost race, which is
   * why createVersion surfaces ConflictError instead of overwriting.
   */
  async nextVersionNo(agentId: string) {
    const aid = assertUlid(agentId, 'agentId');
    const row = await this.db('tbl_agsvc_agent_versions')
      .where({ agent_id: aid })
      .orderBy('version_no', 'desc')
      .first();
    return row ? Number(row.version_no) + 1 : 1;
  }

  async getVersionById(agentVersionId: string) {
    const id = assertUlid(agentVersionId, 'agentVersionId');
    const row = await this.db('tbl_agsvc_agent_versions')
      .where({ agent_version_id: id })
      .first();
    return row ? mapAgentVersion(row) : null;
  }

  /**
   * @param {{
   *   agentVersionId: string,
   *   agentId: string,
   *   versionNo: number,
   *   configJson?: Record<string, unknown>,
   *   configHash?: string,
   *   status?: string,
   *   createdBy: string,
   *   createdAt?: Date | string,
   * }} input
   */
  async createVersion(input: { agentVersionId: string, agentId: string, versionNo: number, configJson?: Record<string, unknown>, configHash?: string, status?: string, createdBy: string, createdAt?: Date | string, }) {
    const agentVersionId = assertUlid(input.agentVersionId, 'agentVersionId');
    const agentId = assertUlid(input.agentId, 'agentId');
    const createdBy = assertUlid(input.createdBy, 'createdBy');
    if (!Number.isInteger(input.versionNo) || input.versionNo < 1) {
      throw new Error('versionNo must be a positive integer');
    }
    const configJson = input.configJson ?? defaultAgentConfigJson();
    const configHash = input.configHash ?? hashAgentConfig(configJson);
    if (typeof configHash !== 'string' || configHash.length !== 64) {
      throw new Error('configHash must be 64 hex characters');
    }
    try {
      await this.db('tbl_agsvc_agent_versions').insert({
        agent_version_id: agentVersionId,
        agent_id: agentId,
        version_no: input.versionNo,
        config_json: JSON.stringify(configJson),
        config_hash: configHash.toLowerCase(),
        status: input.status ?? 'active',
        created_by: createdBy,
        created_at: toMysqlDateTime(input.createdAt || this.now()),
      });
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        throw new ConflictError('Agent version id or (agent_id, version_no) conflict', {
          resource: 'agent_versions',
          id: agentVersionId,
        });
      }
      throw err;
    }
    return this.getVersionById(agentVersionId);
  }

  async setActiveVersion(agentId: string, activeVersionId: string) {
    const aid = assertUlid(agentId, 'agentId');
    const vid = assertUlid(activeVersionId, 'activeVersionId');
    const n = await this.db('tbl_agsvc_agent_definitions')
      .where({ agent_id: aid })
      .update({
        active_version_id: vid,
        updated_at: toMysqlDateTime(this.now()),
      });
    if (!n) {
      throw new NotFoundError('Agent definition not found', {
        resource: 'agent_definitions',
        id: agentId,
      });
    }
    return this.getDefinitionById(aid);
  }

  /**
   * Ensure tenant default agent definition + version exist.
   * Caller should hold a stable parent lock (e.g. organization FOR UPDATE).
   *
   * @param {{
   *   orgId: string,
   *   createdBy: string,
   *   generateId: () => string,
   *   name?: string,
   *   configJson?: Record<string, unknown>,
   * }} input
   */
  async ensureTenantDefaultAgent(input: { orgId: string, createdBy: string, generateId: () => string, name?: string, configJson?: Record<string, unknown>, }) {
    const orgId = assertUlid(input.orgId, 'orgId');
    const createdBy = assertUlid(input.createdBy, 'createdBy');
    if (typeof input.generateId !== 'function') {
      throw new Error('generateId is required');
    }
    const name = (input.name ?? DEFAULT_AGENT_DEFINITION_NAME).trim();

    let def = await this.getDefinitionByOrgAndName(orgId, name);
    if (!def) {
      const agentId = input.generateId();
      try {
        def = await this.createDefinition({
          agentId,
          orgId,
          name,
          description: '通用智能体：带全部系统 Skill 与调用者已启用的个人 Skill',
          status: 'active',
          createdBy,
        });
      } catch (err) {
        if (!(err instanceof ConflictError)) throw err;
        def = await this.getDefinitionByOrgAndName(orgId, name, { lockForShare: true });
        if (!def) throw err;
      }
    }

    if (def.activeVersionId) {
      const ver = await this.getVersionById(def.activeVersionId);
      if (ver) {
        return { definition: def, version: ver };
      }
    }

    // No active version (or dangling pointer): create version 1.
    const existingV1 = await this.db('tbl_agsvc_agent_versions')
      .where({ agent_id: def.agentId, version_no: 1 })
      .first();
    let version;
    if (existingV1) {
      version = mapAgentVersion(existingV1);
    } else {
      const agentVersionId = input.generateId();
      try {
        version = await this.createVersion({
          agentVersionId,
          agentId: def.agentId,
          versionNo: 1,
          configJson: input.configJson ?? tenantDefaultAgentConfigJson(),
          status: 'active',
          createdBy,
        });
      } catch (err) {
        if (!(err instanceof ConflictError)) throw err;
        // 同上：加锁读才能看到并发事务刚提交的版本 1。
        const raced = await this.db('tbl_agsvc_agent_versions')
          .where({ agent_id: def.agentId, version_no: 1 })
          .forShare()
          .first();
        if (!raced) throw err;
        version = mapAgentVersion(raced);
      }
    }

    if (def.activeVersionId !== version.agentVersionId) {
      def = await this.setActiveVersion(def.agentId, version.agentVersionId);
    }

    return { definition: def, version };
  }
}
