/**
 * 平台角色账本（design `docs/design/rbac-roles.md` §2.1/§2.2）。
 *
 * ## 这一层只做账本，不做判定
 *
 * 「最后 admin 不能撤销」「部署锁定的 admin 不能撤销」是**业务规则**，属于
 * `MemberRoleService`；这里提供它们需要的原语：`listAdminUserIds({forUpdate})`
 * 返回**加锁后**该 org 的 admin 集合，`insertGrant` / `deleteGrant` 返回「是否真的
 * 改了行」以便幂等，`insertEvent` 只在同一事务里被调用。
 *
 * ## 为什么撤销是删行
 *
 * 主键 `(org_id, user_id, role)` 让一个人可以同时持有 `admin` 与 `reviewer`；
 * 单值列表达不了集合。「授予」天然幂等——重复插入撞主键，这里先查后插并返回
 * `false` 表示「本来就有」。
 *
 * ## 成员列表为什么要有 `auth_credentials` 这一段
 *
 * 成员列表要展示用户名与最近登录，而这两样属于浏览器凭据表；org 成员关系只回答
 * 「谁在这个 org」。两边的桥是 `users.external_subject = 'bff:' + auth_credentials
 * .external_user_id`（`container`/`browser-auth-service` 写入的那条映射）。用 LEFT JOIN：
 * 凭据行缺失时成员仍然列出来，只是没有用户名，而不是凭空消失。
 */

import { physicalTableName } from '../schema-tables.js';
import { assertUlid, isUlid } from '../../../domain/shared/ulid.js';
import { formatDateTime, toMysqlDateTime } from '../row-mappers.js';
import { isKnownRole, type KnownRole } from '../../../domain/identity/roles.js';

/** 过渡期宽松类型：注入的依赖多数还是 JS 类，形状由各自的模块负责。 */
type Loose = any;

const ROLES = physicalTableName('member_roles');
const EVENTS = physicalTableName('member_role_events');
const USERS = physicalTableName('users');
const MEMBERSHIPS = physicalTableName('organization_memberships');
const AUTH_CREDENTIALS = physicalTableName('auth_credentials');

/** `users.external_subject` 的 provider 前缀，与 `formatUserExternalSubject()` 同口径。 */
const BFF_PROVIDER = 'bff';

/** 列表默认 / 上限（与其它管理端列表一致的量级）。 */
export const MEMBER_LIST_DEFAULT_LIMIT = 50;
export const MEMBER_LIST_MAX_LIMIT = 200;
export const ROLE_EVENT_DEFAULT_LIMIT = 50;
export const ROLE_EVENT_MAX_LIMIT = 200;

/** 授予来源：界面授予 / 环境变量引导 / 数据迁移。 */
export type RoleSource = 'console' | 'bootstrap' | 'migration';

export interface MemberRow {
  readonly userId: string;
  readonly username: string | null;
  readonly displayName: string | null;
  readonly email: string | null;
  readonly lastLoginAt: string | null;
}

/** 角色变更记录的仓储行（内部口径 camelCase；对外投影在应用层）。 */
export interface RoleEventRow {
  readonly eventId: string;
  readonly role: string;
  readonly action: string;
  readonly source: string;
  readonly actorUserId: string | null;
  readonly actorUsername: string | null;
  readonly actorDisplayName: string | null;
  readonly createdAt: string | null;
}

export interface MemberListQuery {
  readonly q?: string | null;
  readonly role?: string | null;
  readonly cursor?: string | null;
  readonly limit?: number | null;
}

/**
 * 把请求里的 limit 收敛到 `[1, MAX]`；非法值用默认值而不是抛错——列表的
 * `limit` 拼错不该让管理页整个打不开。
 */
export function resolveMemberListLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return MEMBER_LIST_DEFAULT_LIMIT;
  return Math.min(parsed, MEMBER_LIST_MAX_LIMIT);
}

/** 同上，用于角色变更记录。 */
export function resolveRoleEventLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return ROLE_EVENT_DEFAULT_LIMIT;
  return Math.min(parsed, ROLE_EVENT_MAX_LIMIT);
}

/** `LIKE` 的通配符要转义，否则用户搜 `%` 会命中所有人。 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export class MemberRoleRepository {
  db: Loose;
  now: () => Date;

  constructor(
    db: import('knex').Knex | import('knex').Knex.Transaction,
    opts: { now?: () => Date } = {},
  ) {
    if (!db) throw new Error('MemberRoleRepository requires a knex executor');
    this.db = db;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * `auth_credentials.external_user_id` ↔ `users.external_subject` 的 join 条件。
   *
   * 用 `joinRaw` 写整条 join，而不是 JoinClause 的 `on(raw, '=', col)`：knex 的
   * `JoinClause` 没有 `onRaw`，而 `on()` 的三参形式会把第一个参数整条当成 on 子句
   * （表达式被丢掉，SQL 静默变成错误的连接）。前缀仍走绑定参数，不拼字符串。
   *
   * @param onColumn 右侧的被连接列，例如 `u.external_subject` 或 `au.external_subject`。
   */
  #joinCredentials(query: Loose, alias: string, onColumn: string): Loose {
    return query.joinRaw(
      `left join ${AUTH_CREDENTIALS} as ${alias} `
        + `on concat(?, ${alias}.external_user_id) = ${onColumn}`,
      [`${BFF_PROVIDER}:`],
    );
  }

  /** 本 org 的成员（已 provisioning 的账号），按 user_id 升序做键集分页。 */
  async listMembers(
    orgId: string,
    query: MemberListQuery = {},
  ): Promise<{ members: MemberRow[]; nextCursor: string | null }> {
    const org = assertUlid(orgId, 'orgId');
    const limit = resolveMemberListLimit(query.limit);
    let q = this.db(`${USERS} as u`)
      .join(`${MEMBERSHIPS} as m`, 'm.user_id', 'u.user_id')
      .where('m.org_id', org)
      .where('m.status', 'active')
      .select(
        'u.user_id as user_id',
        'u.display_name as display_name',
        'u.email as email',
        'ac.username as username',
        'ac.last_login_at as last_login_at',
      );
    q = this.#joinCredentials(q, 'ac', 'u.external_subject');
    const search = typeof query.q === 'string' ? query.q.trim() : '';
    if (search) {
      const pattern = `%${escapeLike(search.slice(0, 200))}%`;
      q = q.where((builder: Loose) => {
        builder
          .where('ac.username', 'like', pattern)
          .orWhere('u.display_name', 'like', pattern);
      });
    }
    if (query.role && isKnownRole(query.role)) {
      // 按角色筛选走 EXISTS 而不是 join：一个成员可能同时持有两个角色，join 会
      // 让同一行出现两次。
      q = q.whereExists(
        this.db(ROLES)
          .select(this.db.raw('1'))
          .whereRaw('?? = m.org_id', [`${ROLES}.org_id`])
          .whereRaw('?? = m.user_id', [`${ROLES}.user_id`])
          .where(`${ROLES}.role`, query.role.trim().toLowerCase()),
      );
    }
    if (query.cursor && isUlid(query.cursor)) q = q.where('u.user_id', '>', query.cursor);
    // 多取一行判断「还有下一页」，避免额外一次 count(*)。
    const rows: Loose[] = await q.orderBy('u.user_id', 'asc').limit(limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      members: page.map((row) => ({
        userId: String(row.user_id),
        username: row.username == null ? null : String(row.username),
        displayName: row.display_name == null ? null : String(row.display_name),
        email: row.email == null ? null : String(row.email),
        lastLoginAt: formatDateTime(row.last_login_at),
      })),
      nextCursor: hasMore ? String(page[page.length - 1].user_id) : null,
    };
  }

  /** 单个成员（本 org 内）。不存在与「别的 org 的成员」都返回 null——调用方一律 404。 */
  async getMember(orgId: string, userId: string): Promise<MemberRow | null> {
    const org = assertUlid(orgId, 'orgId');
    const user = assertUlid(userId, 'userId');
    const q = this.db(`${USERS} as u`)
      .join(`${MEMBERSHIPS} as m`, 'm.user_id', 'u.user_id')
      .where('m.org_id', org)
      .where('m.status', 'active')
      .where('u.user_id', user)
      .select(
        'u.user_id as user_id',
        'u.display_name as display_name',
        'u.email as email',
        'ac.username as username',
        'ac.last_login_at as last_login_at',
      )
      .first();
    const row = await this.#joinCredentials(q, 'ac', 'u.external_subject');
    if (!row) return null;
    return {
      userId: String(row.user_id),
      username: row.username == null ? null : String(row.username),
      displayName: row.display_name == null ? null : String(row.display_name),
      email: row.email == null ? null : String(row.email),
      lastLoginAt: formatDateTime(row.last_login_at),
    };
  }

  /** 一个成员在本 org 持有的角色（含来源，供「部署锁定」判定使用）。 */
  async listRoles(
    orgId: string,
    userId: string,
  ): Promise<Array<{ role: KnownRole; source: string }>> {
    const org = assertUlid(orgId, 'orgId');
    const user = assertUlid(userId, 'userId');
    const rows: Loose[] = await this.db(ROLES)
      .where({ org_id: org, user_id: user })
      .select('role', 'source')
      .orderBy('role', 'asc');
    return rows
      .map((row) => ({ role: String(row.role).toLowerCase(), source: String(row.source || '') }))
      .filter((row): row is { role: KnownRole; source: string } => isKnownRole(row.role));
  }

  /** 批量取角色的版本，给成员列表拼装用（避免每行一次查询）。 */
  async listRolesForUsers(
    orgId: string,
    userIds: readonly string[],
  ): Promise<Map<string, Array<{ role: KnownRole; source: string }>>> {
    const org = assertUlid(orgId, 'orgId');
    const ids = userIds.filter((id) => isUlid(id));
    const out = new Map<string, Array<{ role: KnownRole; source: string }>>();
    if (!ids.length) return out;
    const rows: Loose[] = await this.db(ROLES)
      .where('org_id', org)
      .whereIn('user_id', ids)
      .select('user_id', 'role', 'source')
      .orderBy('role', 'asc');
    for (const row of rows) {
      if (!isKnownRole(row.role)) continue;
      const key = String(row.user_id);
      const list = out.get(key) ?? [];
      list.push({ role: String(row.role).toLowerCase() as KnownRole, source: String(row.source || '') });
      out.set(key, list);
    }
    return out;
  }

  /**
   * 本 org 的 admin 集合。
   *
   * `forUpdate` 走 `SELECT … FOR UPDATE`：撤销 admin 前必须先锁住这些行，否则两个
   * admin 同时互相撤销会各自读到「还有 2 个」而一起删掉，最后剩 0 个 admin
   * （design §5 并发）。
   */
  async listAdminUserIds(orgId: string, opts: { forUpdate?: boolean } = {}): Promise<string[]> {
    const org = assertUlid(orgId, 'orgId');
    let q = this.db(ROLES).where({ org_id: org, role: 'admin' }).select('user_id').orderBy('user_id', 'asc');
    if (opts.forUpdate) q = q.forUpdate();
    const rows: Loose[] = await q;
    return rows.map((row) => String(row.user_id));
  }

  /**
   * 幂等授予。返回 `true` 表示真的插入了新行（调用方才写审计）。
   * 未知角色直接拒绝：账本里不该出现白名单外的值（design §2.1）。
   */
  async insertGrant(input: {
    orgId: string;
    userId: string;
    role: string;
    actorUserId?: string | null;
    source: RoleSource;
  }): Promise<boolean> {
    const org = assertUlid(input.orgId, 'orgId');
    const user = assertUlid(input.userId, 'userId');
    if (!isKnownRole(input.role)) {
      throw new Error(`Unknown role: ${String(input.role)}`);
    }
    const existing = await this.db(ROLES)
      .where({ org_id: org, user_id: user, role: input.role })
      .first();
    if (existing) return false;
    try {
      await this.db(ROLES).insert({
        org_id: org,
        user_id: user,
        role: input.role,
        granted_by: input.actorUserId ?? null,
        source: input.source,
        created_at: toMysqlDateTime(this.now()),
      });
    } catch (err) {
      // 并发下两次授予同一角色：撞主键等价于「已经授予」，不是错误。
      if ((err as Loose)?.code === 'ER_DUP_ENTRY' || (err as Loose)?.errno === 1062) return false;
      throw err;
    }
    return true;
  }

  /** 幂等撤销。返回 `true` 表示真的删掉了行（调用方才写审计）。 */
  async deleteGrant(orgId: string, userId: string, role: string): Promise<boolean> {
    const org = assertUlid(orgId, 'orgId');
    const user = assertUlid(userId, 'userId');
    if (!isKnownRole(role)) {
      throw new Error(`Unknown role: ${String(role)}`);
    }
    const deleted = await this.db(ROLES)
      .where({ org_id: org, user_id: user, role })
      .del();
    return Number(deleted) > 0;
  }

  /**
   * 追加一条审计。**必须**与对应的授予/撤销在同一事务里调用（design §2.2）：
   * 账本改了而审计没记，事后就答不出「谁在什么时候把 admin 给了谁」。
   */
  async insertEvent(input: {
    orgId: string;
    userId: string;
    role: string;
    action: 'grant' | 'revoke';
    actorUserId?: string | null;
    source: RoleSource;
    eventId: string;
  }): Promise<void> {
    const org = assertUlid(input.orgId, 'orgId');
    const user = assertUlid(input.userId, 'userId');
    if (!isKnownRole(input.role)) {
      throw new Error(`Unknown role: ${String(input.role)}`);
    }
    if (input.action !== 'grant' && input.action !== 'revoke') {
      throw new Error(`Unknown role event action: ${String(input.action)}`);
    }
    await this.db(EVENTS).insert({
      event_id: assertUlid(input.eventId, 'eventId'),
      org_id: org,
      user_id: user,
      role: input.role,
      action: input.action,
      actor_user_id: input.actorUserId ?? null,
      source: input.source,
      created_at: toMysqlDateTime(this.now()),
    });
  }

  /**
   * 某个成员的角色变更记录（新到旧）。
   *
   * 操作者只存了 user_id，展示时要变成人看得懂的名字——所以这里 LEFT JOIN 回
   * `users` / `auth_credentials`，而不是把 ULID 丢给界面。
   */
  async listEvents(
    orgId: string,
    userId: string,
    opts: { limit?: unknown } = {},
  ): Promise<RoleEventRow[]> {
    const org = assertUlid(orgId, 'orgId');
    const user = assertUlid(userId, 'userId');
    const limit = resolveRoleEventLimit(opts.limit);
    let q = this.db(`${EVENTS} as e`)
      .leftJoin(`${USERS} as au`, 'au.user_id', 'e.actor_user_id');
    q = this.#joinCredentials(q, 'ac', 'au.external_subject');
    const rows: Loose[] = await q
      .where('e.org_id', org)
      .where('e.user_id', user)
      .select(
        'e.event_id as event_id',
        'e.role as role',
        'e.action as action',
        'e.source as source',
        'e.actor_user_id as actor_user_id',
        'e.created_at as created_at',
        'ac.username as actor_username',
        'au.display_name as actor_display_name',
      )
      .orderBy('e.created_at', 'desc')
      .orderBy('e.event_id', 'desc')
      .limit(limit);
    return rows.map((row) => ({
      eventId: String(row.event_id),
      role: String(row.role),
      action: String(row.action),
      source: String(row.source || ''),
      actorUserId: row.actor_user_id == null ? null : String(row.actor_user_id),
      actorUsername: row.actor_username == null ? null : String(row.actor_username),
      actorDisplayName: row.actor_display_name == null ? null : String(row.actor_display_name),
      createdAt: formatDateTime(row.created_at),
    }));
  }
}
