/**
 * 智能体可见范围的账本（design `docs/design/agent-visibility.md` §3）：
 * `tbl_agsvc_agent_definitions.visibility` + `tbl_agsvc_agent_user_grants`。
 *
 * 判定（谁能用）在 `AgentAccessService`；这里只读写事实。授予按内部 `user_id`，
 * 列表时 join 凭据把工号（用户名）与姓名带出来给管理页展示。
 */

import { assertUlid } from '../../../domain/shared/ulid.js';
import { formatDateTime, toMysqlDateTime } from '../row-mappers.js';
import type { Knex } from 'knex';

const DEFINITIONS = 'tbl_agsvc_agent_definitions';
const GRANTS = 'tbl_agsvc_agent_user_grants';
const USERS = 'tbl_agsvc_users';
const MEMBERSHIPS = 'tbl_agsvc_organization_memberships';
const AUTH_CREDENTIALS = 'tbl_agsvc_auth_credentials';

export type AgentVisibility = 'org' | 'restricted';

export interface AgentGrantRow {
  readonly userId: string;
  readonly username: string | null;
  readonly displayName: string | null;
  readonly grantedAt: string | null;
}

export class AgentAccessRepository {
  db: Knex | Knex.Transaction;
  now: () => Date;

  constructor(db: Knex | Knex.Transaction, { now = () => new Date() }: { now?: () => Date } = {}) {
    if (!db) throw new Error('AgentAccessRepository requires a knex executor');
    this.db = db;
    this.now = now;
  }

  async hasGrant(agentId: string, userId: string): Promise<boolean> {
    const row = await this.db(GRANTS)
      .where({ agent_id: assertUlid(agentId, 'agentId'), user_id: assertUlid(userId, 'userId') })
      .first('agent_id');
    return Boolean(row);
  }

  /** 这个成员在本 org 被授予的智能体（列表过滤一次查出）。 */
  async listGrantedAgentIds(orgId: string, userId: string): Promise<Set<string>> {
    const rows = await this.db(GRANTS)
      .where({ org_id: assertUlid(orgId, 'orgId'), user_id: assertUlid(userId, 'userId') })
      .select('agent_id');
    return new Set(rows.map((row: Record<string, unknown>) => String(row.agent_id)));
  }

  async listGrants(agentId: string): Promise<AgentGrantRow[]> {
    const rows = await this.db(`${GRANTS} as g`)
      .join(`${USERS} as u`, 'u.user_id', 'g.user_id')
      .joinRaw(`left join ${AUTH_CREDENTIALS} as ac on concat('bff:', ac.external_user_id) = u.external_subject`)
      .where('g.agent_id', assertUlid(agentId, 'agentId'))
      .orderBy('g.created_at', 'asc')
      .select('g.user_id', 'ac.username', 'ac.display_name', 'u.display_name as user_display_name', 'g.created_at');
    return rows.map((row: Record<string, unknown>) => ({
      userId: String(row.user_id),
      username: row.username == null ? null : String(row.username),
      displayName:
        row.display_name != null ? String(row.display_name)
          : row.user_display_name != null ? String(row.user_display_name) : null,
      grantedAt: formatDateTime(row.created_at),
    }));
  }

  /** 这些 user_id 中，哪些是本 org 的**活跃**成员（授予只能给本 org 的人）。 */
  async activeMemberIds(orgId: string, userIds: readonly string[]): Promise<Set<string>> {
    if (!userIds.length) return new Set();
    const rows = await this.db(MEMBERSHIPS)
      .where({ org_id: assertUlid(orgId, 'orgId'), status: 'active' })
      .whereIn('user_id', userIds.map((id) => assertUlid(id, 'userId')))
      .select('user_id');
    return new Set(rows.map((row: Record<string, unknown>) => String(row.user_id)));
  }

  /**
   * 整体替换可见范围与授予名单（调用方在事务里调用）。`org` 时清空授予：
   * 名单只对 `restricted` 有意义，留着旧名单会在下次改回受限时悄悄复活。
   */
  async replaceAccess(input: {
    agentId: string;
    orgId: string;
    visibility: AgentVisibility;
    userIds: readonly string[];
    grantedBy: string | null;
  }): Promise<void> {
    const agentId = assertUlid(input.agentId, 'agentId');
    const orgId = assertUlid(input.orgId, 'orgId');
    const updated = await this.db(DEFINITIONS)
      .where({ agent_id: agentId, org_id: orgId })
      .update({ visibility: input.visibility, updated_at: toMysqlDateTime(this.now()) });
    if (Number(updated) !== 1) throw new Error('agent definition not found for access update');
    await this.db(GRANTS).where({ agent_id: agentId }).delete();
    if (input.visibility !== 'restricted' || !input.userIds.length) return;
    const createdAt = toMysqlDateTime(this.now());
    await this.db(GRANTS).insert(
      input.userIds.map((userId) => ({
        agent_id: agentId,
        user_id: assertUlid(userId, 'userId'),
        org_id: orgId,
        granted_by: input.grantedBy,
        created_at: createdAt,
      })),
    );
  }
}
