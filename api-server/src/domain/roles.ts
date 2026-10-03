/**
 * 平台角色（`admin` / `reviewer`）的解析与判定 —— **api-server 侧的实现**。
 *
 * 与 `agent/src/domain/identity/roles.ts` 同源但不是共享包：BFF 与 Agent
 * 是两个独立部署单元，不给它们引入互相依赖。解析口径（`parseRoleSet` /
 * `hasRole` / `formatActingRole` 与常量）由
 * `tests/fixtures/contracts/platform-roles-v1.json` 的同一组用例锁定。
 * Agent 侧独有的 `isKnownRole` / `primaryRole` / `ROLE_REVIEWER` 在 BFF 没有
 * 生产调用者，已删除（BFF 只保留 `ROLE_ADMIN` + 集合判定）；跨包夹具文件本身
 * 留给 Agent 侧继续使用。
 *
 * BFF 用它的地方是 `X-Acting-Role` 的线格式与本地 admin 闸门（A2A 管理面）；
 * 真正的权威判定仍在 agent/。
 *
 * fail-closed：解析不出角色就是没有角色——`null` / `''` / 只有未知值时 `hasRole`
 * 一律 `false`。
 */

/** 一期固定角色白名单（design `docs/design/rbac-roles.md` §0）。 */
export const KNOWN_ROLES = Object.freeze(['admin', 'reviewer'] as const);

export type KnownRole = (typeof KNOWN_ROLES)[number];

export const ROLE_ADMIN: KnownRole = 'admin';

/** 没有任何授予时线格式里的哨兵值；普通用户不是一条授权。 */
export const NO_ROLE = 'user';

/** 归一化成去重、按字典序、只含白名单值的角色集合。 */
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

/** 调用者是否持有某个角色；`actor` 可以是 `{ role }` 形状或裸的线格式字符串。 */
export function hasRole(
  actor: { readonly role?: unknown; readonly actingRole?: unknown } | string | null | undefined,
  role: KnownRole,
): boolean {
  let value: unknown;
  if (typeof actor === 'string') {
    value = actor;
  } else if (actor && typeof actor === 'object') {
    // `TrustedAuthContext` 用的字段名是 actingRole；`X-Acting-Role` 解析出来的
    // 是 role。两个都认，免得调用方各自记住一个。
    value = actor.role !== undefined ? actor.role : actor.actingRole;
  }
  return parseRoleSet(value).includes(role);
}

/** `X-Acting-Role` 的线格式：逗号分隔的集合，没有角色时是 `user`。 */
export function formatActingRole(roles: unknown): string {
  const parsed = parseRoleSet(roles);
  return parsed.length ? parsed.join(',') : NO_ROLE;
}
