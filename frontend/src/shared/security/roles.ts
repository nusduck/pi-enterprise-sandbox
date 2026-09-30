/**
 * 平台角色判定（design `docs/design/rbac-roles.md` §4.1 / §4.3）。
 *
 * `me` 的权威角色是 `roles: string[]`；`role` 只是兼容主角色（含 admin 即 `admin`，
 * 否则 `user`）。前端只在这里判一次，四处 UI 闸门都走 `hasAdminRole`，
 * 不再各自写 `role === 'admin'` 字面比较。
 *
 * **fail-closed**：解析不出来就是没有这个角色。宁可让管理员看不见入口（由服务端
 * 403 兜底），也不能因为一个读不懂的字段把普通用户放进来。
 */

/** 只带角色信息的用户投影；`authUser` / `profile` / 单值 `role` 都能喂进来。 */
export interface RoleBearingUser {
  roles?: unknown;
  role?: unknown;
}

/**
 * 实际入参：状态对象（如 `ChatState.authUser`）是**带索引签名**的对象类型，
 * TypeScript 的 weak-type 检查不接受它匹配 `RoleBearingUser` 的可选属性，
 * 所以这里额外接受任意 `Record<string, unknown>`。运行时语义不变。
 */
export type RoleUserInput = RoleBearingUser | Record<string, unknown> | null | undefined;

/** 逗号或空白分隔都接受（`admin,reviewer` / `admin reviewer` 同样解析）。 */
const ROLE_SEPARATORS = /[,\s]+/;

/**
 * 把角色的任一表示拆成规范化集合：小写、去空白、去重、丢掉空串。
 * 未知类型（数字、对象、布尔…）贡献不了任何角色，而不是猜一个。
 */
function collectRoles(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectRoles(entry, into);
    return;
  }
  if (typeof value !== 'string') return;
  for (const token of value.split(ROLE_SEPARATORS)) {
    const normalized = token.trim().toLowerCase();
    if (normalized) into.add(normalized);
  }
}

/**
 * 解析一个用户当前持有的角色集合。
 *
 * 优先看 `roles`，而且**只有它真的是数组才算数**：它一旦是数组就只以它为准，
 * 即使为空数组也不回退到 `role`——服务端说「这个人没有角色」时，兼容字段里的旧值
 * 不该把人提权。`roles` 缺失（`undefined` / `null`）时才回退到单值 `role`
 * （含 `admin,reviewer` 这样的集合）；类型不对的值按「没有角色」处理，宁可拒绝。
 */
export function rolesOf(user: RoleUserInput): Set<string> {
  const out = new Set<string>();
  if (!user || typeof user !== 'object') return out;
  const shape = user as RoleBearingUser;
  const explicit = shape.roles;
  if (explicit === undefined || explicit === null) {
    collectRoles(shape.role, out);
    return out;
  }
  if (!Array.isArray(explicit)) return out;
  collectRoles(explicit, out);
  return out;
}

/** 是否持有 `role`（大小写不敏感）。未知角色名一律 false。 */
export function hasRole(user: RoleUserInput, role: string): boolean {
  const wanted = String(role ?? '').trim().toLowerCase();
  if (!wanted) return false;
  return rolesOf(user).has(wanted);
}

/** 是否管理员。这是四处管理控制台闸门唯一的判定入口。 */
export function hasAdminRole(user: RoleUserInput): boolean {
  return hasRole(user, 'admin');
}
