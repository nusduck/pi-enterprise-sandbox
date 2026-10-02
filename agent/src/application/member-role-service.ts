/**
 * 平台角色管理（design `docs/design/rbac-roles.md`）。admin 的授予/撤销面 +
 * `me` 需要的角色读取 + 环境变量引导。
 *
 * ## 这一层负责的四件事
 *
 * 1. **鉴权**：只有持有 `admin` 的调用者能管角色。判定走 `hasRole()`（解析逗号
 *    集合、白名单、fail-closed），不是 `role === 'admin'` 的字面比较——`X-Acting-Role`
 *    现在是集合，字面比较遇到 `admin,reviewer` 只会误拒。
 * 2. **作用域**：目标成员按 `(调用者 org, userId)` 定位。别的 org 的 userId 与不存在
 *    的 userId 走同一条 404（存在性本身不能泄漏，AGENTS.md §2）。
 * 3. **两条业务锁**：撤销 org 的最后一个 admin 与撤销部署锁定的 admin 都是 409。
 *    「最后一个 admin」的判定在事务里对该 org 的 admin 行加 `SELECT … FOR UPDATE`
 *    后计数——两个 admin 同时互相撤销时，后提交的一方必须拿到 409，不能出现 0 个 admin。
 * 4. **引导不降级**：环境变量名单只授予、不降级；名单内的人不能被界面撤销
 *    （否则下一个请求又被引导回来，形成假成功）。
 *
 * ## 为什么撤销用删行而不是改列
 *
 * 一个人可以同时持有 `admin` 与 `reviewer`（design §0）。单值列表达不了集合，
 * 而「集合」正是判定要问的问题。审计由只追加的 `member_role_events` 承担，
 * 和授予/撤销在同一事务里写。
 */

import { ulid } from '../domain/shared/ulid.js';
import { isUlid } from '../domain/shared/ulid.js';
import {
  ROLE_ADMIN,
  hasRole,
  isKnownRole,
  parseRoleSet,
  type KnownRole,
} from '../domain/identity/roles.js';
import { ExternalIdentityResolver } from './parent/external-identity-resolver.js';
import type {
  MemberRoleRepository,
  MemberRow,
  RoleEventRow,
  RoleSource,
} from '../infrastructure/mysql/repositories/member-role-repository.js';

/** 过渡期宽松类型：注入的依赖多数还是 JS 类，形状由各自的模块负责。 */
type Loose = any;

/** 与 `AuthSubjects` 兼容的最小形状（BFF 服务端写入的 `X-Acting-*`）。 */
export interface MemberRoleActor {
  readonly externalOrgId: string;
  readonly externalUserId: string;
  readonly role: string | null;
}

/** 对外投影：一个成员 + 它在本 org 的角色。字段名与 design §5 的响应一致。 */
export interface MemberView {
  readonly user_id: string;
  readonly username: string | null;
  readonly display_name: string | null;
  readonly email: string | null;
  readonly department: string | null;
  readonly roles: string[];
  readonly pinned_roles: string[];
  readonly last_login_at: string | null;
}

export interface RoleEventView {
  readonly event_id: string;
  readonly role: string;
  readonly action: string;
  readonly source: string;
  readonly actor_user_id: string | null;
  readonly actor_username: string | null;
  readonly actor_display_name: string | null;
  readonly created_at: string | null;
}

/** 管理面错误：`status` / `code` 由 HTTP 层原样映射。 */
export class MemberRoleError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'MemberRoleError';
    this.status = status;
    this.code = code;
  }
}

const adminRequired = () => new MemberRoleError(403, 'ADMIN_REQUIRED', 'This operation requires an administrator');
const memberNotFound = () => new MemberRoleError(404, 'NOT_FOUND', 'Member not found');
const roleUnknown = () => new MemberRoleError(422, 'ROLE_UNKNOWN', 'Unknown role');
const lastAdmin = () => new MemberRoleError(409, 'LAST_ADMIN', 'Cannot revoke the last administrator of this organization');
const pinnedByDeployment = () => new MemberRoleError(409, 'ROLE_PINNED_BY_DEPLOYMENT', 'This administrator is pinned by the deployment (SANDBOX_AUTH_ADMIN_USERNAMES)');

export interface MemberRoleServiceDeps {
  readonly db: Loose;
  readonly createRepositories: (db?: Loose) => Loose;
  readonly transactionManager: { run: <T>(work: (trx: Loose) => Promise<T>) => Promise<T> };
  /**
   * 当前进程的 `SANDBOX_AUTH_ADMIN_USERNAMES`（大小写归一后）。
   *
   * 这是「部署锁定」的**唯一**依据：从名单里移除某人并重启后，他的授予还在
   * 库里，但界面解除锁定、可以撤销（design §3.3 / §9）。
   */
  readonly pinnedAdminUsernames?: readonly string[];
  /** 审计行的 `event_id`；省略时用 `ulid()`。 */
  readonly generateId?: () => string;
}

export class MemberRoleService {
  readonly db: Loose;
  readonly createRepositories: MemberRoleServiceDeps['createRepositories'];
  readonly transactionManager: MemberRoleServiceDeps['transactionManager'];
  readonly pinned: ReadonlySet<string>;
  readonly generateId: () => string;
  /**
   * 绑定在基础 db 上的仓储包，惰性建一次。
   *
   * `createRepositories()` 会构造整套仓储（几十个对象），而 `me` 每请求都要读一次角色；
   * 每次新建就是每请求几十个对象。事务里仍然按 trx 现建（那才是必须的）。
   */
  #baseRepos: Loose = null;

  constructor(deps: MemberRoleServiceDeps) {
    if (!deps?.db) throw new Error('MemberRoleService requires db');
    if (typeof deps.createRepositories !== 'function') {
      throw new Error('MemberRoleService requires createRepositories');
    }
    if (typeof deps.transactionManager?.run !== 'function') {
      throw new Error('MemberRoleService requires transactionManager.run');
    }
    this.db = deps.db;
    this.createRepositories = deps.createRepositories;
    this.transactionManager = deps.transactionManager;
    this.pinned = new Set(
      (deps.pinnedAdminUsernames ?? [])
        .map((name) => String(name || '').trim().toLowerCase())
        .filter(Boolean),
    );
    this.generateId = deps.generateId ?? (() => ulid());
  }

  /** 名单内的用户名 = 部署锁定。名单为空时没有任何人被锁定（design §3.4）。 */
  isDeploymentPinned(username: string | null | undefined): boolean {
    const name = String(username || '').trim().toLowerCase();
    return Boolean(name) && this.pinned.has(name);
  }

  #repos(): Loose {
    if (!this.#baseRepos) this.#baseRepos = this.createRepositories(this.db);
    return this.#baseRepos;
  }

  #roles(): MemberRoleRepository {
    return this.#repos().memberRoles;
  }

  /**
   * 调用者必须是 admin，并且解析成内部 ULID。
   *
   * 顺序是「先鉴权、再解析身份」：不认得的调用者不该拿到「这个 org 存不存在」
   * 这个信息。
   */
  async #adminOwner(actor: MemberRoleActor | null | undefined): Promise<{ orgId: string; userId: string }> {
    if (!actor || !hasRole(actor, ROLE_ADMIN)) throw adminRequired();
    if (!String(actor.externalOrgId ?? '').trim()) throw adminRequired();
    const repos = this.#repos();
    const resolver = new ExternalIdentityResolver({
      organizations: repos.organizations,
      externalRefs: repos.externalRefs,
    });
    const owner = await resolver.resolveOwner({
      externalOrgId: actor.externalOrgId,
      externalUserId: actor.externalUserId,
      role: actor.role,
    });
    return { orgId: owner.orgId, userId: owner.userId };
  }

  #present(
    member: MemberRow,
    roles: ReadonlyArray<{ role: KnownRole; source: string }>,
  ): MemberView {
    const granted = parseRoleSet(roles.map((entry) => entry.role));
    return {
      user_id: member.userId,
      username: member.username,
      display_name: member.displayName,
      email: member.email,
      department: member.department ?? null,
      roles: granted,
      // 只有真的持有 admin 才显示为锁定：否则界面会置灰一个本来就打不开的开关。
      pinned_roles:
        granted.includes(ROLE_ADMIN) && this.isDeploymentPinned(member.username)
          ? [ROLE_ADMIN]
          : [],
      last_login_at: member.lastLoginAt,
    };
  }

  async #view(repos: Loose, orgId: string, member: MemberRow): Promise<MemberView> {
    return this.#present(member, await repos.memberRoles.listRoles(orgId, member.userId));
  }

  /** 本 org 成员列表（含角色与部署锁定），支持 `q` 搜索与按角色筛选。 */
  async listMembers(
    actor: MemberRoleActor | null,
    query: { q?: string | null; role?: string | null; cursor?: string | null; limit?: unknown } = {},
  ): Promise<{ members: MemberView[]; next_cursor: string | null }> {
    const owner = await this.#adminOwner(actor);
    // 未知的 role 过滤条件不做「忽略」，因为静默忽略会让人以为筛过了。
    if (query.role && !isKnownRole(query.role)) throw roleUnknown();
    const repos = this.#repos();
    const { members, nextCursor } = await repos.memberRoles.listMembers(owner.orgId, query);
    const byUser = await repos.memberRoles.listRolesForUsers(
      owner.orgId,
      members.map((m: MemberRow) => m.userId),
    );
    return {
      members: members.map((m: MemberRow) => this.#present(m, byUser.get(m.userId) ?? [])),
      next_cursor: nextCursor,
    };
  }

  /** 幂等授予：已经有这个角色时返回同样的 200 内容，不重复写审计。 */
  async grantRole(
    actor: MemberRoleActor | null,
    userId: string,
    role: string,
  ): Promise<MemberView> {
    const owner = await this.#adminOwner(actor);
    if (!isKnownRole(role)) throw roleUnknown();
    if (!isUlid(userId)) throw memberNotFound();
    return this.transactionManager.run(async (trx) => {
      const repos = this.createRepositories(trx);
      const member: MemberRow | null = await repos.memberRoles.getMember(owner.orgId, userId);
      if (!member) throw memberNotFound();
      const inserted = await repos.memberRoles.insertGrant({
        orgId: owner.orgId,
        userId: member.userId,
        role,
        actorUserId: owner.userId,
        source: 'console' as RoleSource,
      });
      if (inserted) {
        await repos.memberRoles.insertEvent({
          orgId: owner.orgId,
          userId: member.userId,
          role,
          action: 'grant',
          actorUserId: owner.userId,
          source: 'console' as RoleSource,
          eventId: this.generateId(),
        });
      }
      return this.#view(repos, owner.orgId, member);
    });
  }

  /**
   * 幂等撤销：不存在该角色时返回 200（内容与当前一致）。
   *
   * 两条 409 的判定顺序：**先部署锁定、再最后 admin**。锁定是无条件拒绝，先判它
   * 才能让「名单内账号撤销返回 409 ROLE_PINNED_BY_DEPLOYMENT」在任何 admin 数量下
   * 都成立（design §3.2 / §9）。
   */
  async revokeRole(
    actor: MemberRoleActor | null,
    userId: string,
    role: string,
  ): Promise<MemberView> {
    const owner = await this.#adminOwner(actor);
    if (!isKnownRole(role)) throw roleUnknown();
    if (!isUlid(userId)) throw memberNotFound();
    return this.transactionManager.run(async (trx) => {
      const repos = this.createRepositories(trx);
      const member: MemberRow | null = await repos.memberRoles.getMember(owner.orgId, userId);
      if (!member) throw memberNotFound();
      if (role === ROLE_ADMIN && this.isDeploymentPinned(member.username)) {
        throw pinnedByDeployment();
      }
      // 锁住本 org 的 admin 行后再读集合：并发撤销时后提交的一方会看到前一方
      // 已经删掉的那一行，于是 `length <= 1` 成立并被拒绝。
      const admins: string[] = await repos.memberRoles.listAdminUserIds(owner.orgId, { forUpdate: true });
      const held: Array<{ role: KnownRole }> = await repos.memberRoles.listRoles(owner.orgId, member.userId);
      if (!held.some((entry) => entry.role === role)) {
        return this.#view(repos, owner.orgId, member);
      }
      if (role === ROLE_ADMIN && admins.length <= 1) throw lastAdmin();
      const deleted = await repos.memberRoles.deleteGrant(owner.orgId, member.userId, role);
      if (deleted) {
        await repos.memberRoles.insertEvent({
          orgId: owner.orgId,
          userId: member.userId,
          role,
          action: 'revoke',
          actorUserId: owner.userId,
          source: 'console' as RoleSource,
          eventId: this.generateId(),
        });
      }
      return this.#view(repos, owner.orgId, member);
    });
  }

  /** 某成员的角色变更记录（含操作者展示名）。 */
  async listRoleEvents(
    actor: MemberRoleActor | null,
    userId: string,
    opts: { limit?: unknown } = {},
  ): Promise<{ events: RoleEventView[] }> {
    const owner = await this.#adminOwner(actor);
    if (!isUlid(userId)) throw memberNotFound();
    const repos = this.#repos();
    const member: MemberRow | null = await repos.memberRoles.getMember(owner.orgId, userId);
    if (!member) throw memberNotFound();
    const events = await repos.memberRoles.listEvents(owner.orgId, userId, opts);
    // 仓储用内部 camelCase，对外（BFF 与前端）是 snake_case：投影只在这一处做。
    return {
      events: (events as RoleEventRow[]).map((event) => ({
        event_id: event.eventId,
        role: event.role,
        action: event.action,
        source: event.source,
        actor_user_id: event.actorUserId,
        actor_username: event.actorUsername,
        actor_display_name: event.actorDisplayName,
        created_at: event.createdAt,
      })),
    };
  }

  /**
   * `me` 的角色读取。**不在这里鉴权**：调用者已经在身份链路上被验证过，
   * 而且这里只回答「这个人自己有哪些角色」，不是管理面的读。
   */
  async listRolesForMember(orgId: string, userId: string): Promise<KnownRole[]> {
    const roles = await this.#roles().listRoles(orgId, userId);
    return parseRoleSet(roles.map((entry) => entry.role));
  }

  /**
   * 环境变量引导（design §3.1）：名单内、且本 org 还没有他的 admin 授予时插入一行。
   *
   * 三条纪律：
   * - **只授予、不降级**：不在名单里什么都不做，绝不删既有授予。
   * - **已有授予时不写库**：否则每个请求都会写一次（旧 `reconcileRole` 的毛病）。
   * - 引导写的审计 `actor_user_id` 是 NULL：没有具体的人做了这件事。
   */
  async ensureDeploymentGrant(input: {
    orgId: string;
    userId: string;
    username: string | null | undefined;
  }): Promise<void> {
    if (!this.isDeploymentPinned(input.username)) return;
    const orgId = String(input.orgId || '').trim();
    const userId = String(input.userId || '').trim();
    if (!orgId || !userId) return;
    const roles = await this.#roles().listRoles(orgId, userId);
    if (roles.some((entry) => entry.role === ROLE_ADMIN)) return;
    await this.transactionManager.run(async (trx) => {
      const repos = this.createRepositories(trx);
      const inserted = await repos.memberRoles.insertGrant({
        orgId,
        userId,
        role: ROLE_ADMIN,
        actorUserId: null,
        source: 'bootstrap' as RoleSource,
      });
      // 并发下另一个请求可能先插入了：那时不写第二条审计。
      if (!inserted) return;
      await repos.memberRoles.insertEvent({
        orgId,
        userId,
        role: ROLE_ADMIN,
        action: 'grant',
        actorUserId: null,
        source: 'bootstrap' as RoleSource,
        eventId: this.generateId(),
      });
    });
  }
}
