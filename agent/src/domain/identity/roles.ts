/**
 * 平台角色（一期固定角色 `admin` / `reviewer`）的**唯一解析口径**。
 *
 * ## 为什么单独一个模块
 *
 * `X-Acting-Role` 的线格式从单值变成了**逗号分隔的角色集合**（design
 * `docs/design/rbac-roles.md` §4.2），服务端有 6 处要做「是不是 admin」的判定。
 * 每处各写一遍 `role === 'admin'` 就会各写错一遍解析（大小写、空格、未知值、
 * 重复项），而角色判定判错的代价是越权。所以解析只在这里做一次，其余各处调用
 * `hasRole()`。
 *
 * ## fail-closed 的两条
 *
 * - **未知值视为无角色**：`'root'`、`'Admin '`（已 trim）之外的脏值不会碰巧命中。
 * - **解析不出角色就是没有角色**：`null` / `''` / 只有未知值时 `hasRole` 一律 `false`。
 *   角色缺失（BFF 没解析出来）必须拒绝，不能当成普通用户放行管理面。
 *
 * api-server 有一份**同形实现**（`api-server/src/domain/roles.ts`）：两个包不共享
 * 依赖，口径由 `tests/fixtures/contracts/platform-roles-v1.json` 的同一组用例锁定。
 */

/** 一期固定角色白名单（design §0）。 */
export const KNOWN_ROLES = Object.freeze(['admin', 'reviewer'] as const);

export type KnownRole = (typeof KNOWN_ROLES)[number];

export const ROLE_ADMIN: KnownRole = 'admin';
export const ROLE_REVIEWER: KnownRole = 'reviewer';

/**
 * 没有任何授予时在 `X-Acting-Role` 与兼容 `role` 字段里的哨兵值。
 * 普通用户是默认身份，**不是**一条授权，所以它不在白名单里。
 */
export const NO_ROLE = 'user';

/** 白名单判定；大小写不敏感，未知值一律不认。 */
export function isKnownRole(value: unknown): value is KnownRole {
  if (typeof value !== 'string') return false;
  const role = value.trim().toLowerCase();
  return (KNOWN_ROLES as readonly string[]).includes(role);
}

/**
 * 归一化成一个**去重、按字典序、只含白名单值**的角色集合。
 *
 * 入参可以是线格式字符串（`'admin,reviewer'`）或已经是数组（`me` 的输出）。
 * 未知值被丢弃而不是抛错：脏值出现在线格式里只该降低权限，不该让整个请求 500。
 */
export function parseRoleSet(value: unknown): KnownRole[] {
  const items: unknown[] = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  const known = new Set<KnownRole>();
  for (const item of items) {
    if (typeof item !== 'string') continue;
    const role = item.trim().toLowerCase();
    if ((KNOWN_ROLES as readonly string[]).includes(role)) known.add(role as KnownRole);
  }
  return [...known].sort();
}

/**
 * 调用者是否持有某个角色。
 *
 * 接受 `AuthSubjects`（取 `.role`）或裸的线格式字符串。解析不出来返回 `false`
 * ——这是管理面的 fail-closed 底线。
 */
export function hasRole(
  actor: { readonly role?: unknown } | string | null | undefined,
  role: KnownRole,
): boolean {
  const value =
    typeof actor === 'string'
      ? actor
      : actor && typeof actor === 'object'
        ? actor.role
        : undefined;
  return parseRoleSet(value).includes(role);
}

/**
 * 兼容主角色：`auth_credentials.role` / JWT `role` / BFF `actingRole` 三处仍在用的
 * 单值投影。含 `admin` 即 `admin`，否则 `user`（design §4.1）。
 */
export function primaryRole(roles: unknown): 'admin' | 'user' {
  return parseRoleSet(roles).includes(ROLE_ADMIN) ? 'admin' : 'user';
}

/**
 * `X-Acting-Role` / JWT 里的线格式：逗号分隔的角色集合，没有角色时是 `user`
 * （与改造前的单值格式保持兼容，读旧值的判定最坏只是拒绝）。
 */
export function formatActingRole(roles: unknown): string {
  const parsed = parseRoleSet(roles);
  return parsed.length ? parsed.join(',') : NO_ROLE;
}
