/**
 * 「成员与角色」页的纯逻辑（design `docs/design/rbac-roles.md` §6）。
 *
 * 抽出来是为了能直接单测：错误码到中文提示的映射、列表三态（加载 / 错误 / 空），
 * 以及乐观更新时的角色集合运算。这些正是「把 409 显示成操作失败」或「加载失败
 * 显示成无成员」会悄悄写错的地方。
 */
import type { RoleUserInput } from '../../shared/security/roles';

/** 部署锁定的 admin 开关的 tooltip 文案（变量名要与部署文档一致）。 */
export const ROLE_PINNED_TOOLTIP =
  '该管理员由部署环境变量 SANDBOX_AUTH_ADMIN_USERNAMES 锁定，不能在界面撤销';

/** 服务端错误码 → 可行动的中文提示；未列出的码用服务端 `error` 文案兜底。 */
export const MEMBER_ROLE_ERROR_ZH: Record<string, string> = {
  LAST_ADMIN: '不能撤销本组织的最后一个管理员',
  ROLE_PINNED_BY_DEPLOYMENT: '该管理员由部署锁定，不能撤销',
  ROLE_UNKNOWN: '服务端不认这个角色，无法授予或撤销',
  NOT_FOUND: '成员不存在，或不属于本组织',
  ADMIN_REQUIRED: '需要管理员权限',
  DEPENDENCY: '角色服务暂时不可用，请稍后重试',
};

/** 角色变更记录的来源 → 中文。未知来源原样显示，不猜。 */
export const ROLE_EVENT_SOURCE_ZH: Record<string, string> = {
  console: '管理界面',
  bootstrap: '部署引导',
  migration: '数据迁移',
};

/** 角色变更记录的动作 → 中文。 */
export const ROLE_EVENT_ACTION_ZH: Record<string, string> = {
  grant: '授予',
  revoke: '撤销',
};

/**
 * 角色代码 → 界面上的中文名（§3.1）。
 *
 * 列头、筛选页签、变更记录都显示它；需要时把原始代码放进 `title`，别让人对着
 * `admin` / `reviewer` 猜这是什么。未知代码原样显示，不猜。
 */
export const ROLE_LABEL_ZH: Record<string, string> = {
  admin: '管理员',
  reviewer: '审核员',
};

export function roleLabel(role: unknown): string {
  const key = typeof role === 'string' ? role.trim().toLowerCase() : '';
  return ROLE_LABEL_ZH[key] || key || '—';
}

/** 部门展示：空值返回「—」。 */
export function formatMemberDepartment(department?: string | null): string {
  const text = typeof department === 'string' ? department.trim() : '';
  return text || '—';
}

/**
 * 「最近登录」为空的说明。
 *
 * 成员名单来自**已开通的成员账号**（`memberships`），不是「登录过的人」：脚本或部署
 * 引导创建、还没有走平台登录的账号 `last_login_at` 就是 NULL。页面的说明文字必须与
 * 这个口径一致（§3.1.4），所以空值给它一个 tooltip，而不是让人以为是数据没加载出来。
 */
export const NO_LOGIN_RECORD_TOOLTIP = '这个账号还没有平台登录记录（可能是脚本或部署引导创建的）';

/**
 * 角色变更记录按时间倒序（§3.1.5）。
 *
 * 服务端的 `listEvents` 已经是 `created_at desc, event_id desc`；这里再兜一次，界面
 * 顺序不依赖单点实现（同一毫秒的行用 `event_id` 倒序做稳定的第二键）。
 */
export function sortRoleEventsDesc<T extends { created_at?: unknown; event_id?: unknown }>(
  events: readonly T[],
): T[] {
  const time = (row: T) => (typeof row.created_at === 'string' ? row.created_at : '');
  const id = (row: T) => (typeof row.event_id === 'string' ? row.event_id : '');
  return [...events].sort((a, b) => {
    if (time(a) !== time(b)) return time(a) < time(b) ? 1 : -1;
    if (id(a) === id(b)) return 0;
    return id(a) < id(b) ? 1 : -1;
  });
}

/**
 * 把一个失败翻译成给管理员看的一句话。
 * 先认 `code`（`LAST_ADMIN` 这类），认不出来再用服务端的 `error`，最后才用兜底文案。
 */
export function memberRoleErrorMessage(error: unknown): string {
  const candidate = error as { code?: unknown; message?: unknown } | null | undefined;
  const code = typeof candidate?.code === 'string' ? candidate.code : null;
  if (code && MEMBER_ROLE_ERROR_ZH[code]) return MEMBER_ROLE_ERROR_ZH[code];
  const raw = candidate?.message;
  const message = typeof raw === 'string' ? raw.trim() : '';
  return message || '操作失败';
}

export type MembersListState = 'loading' | 'error' | 'empty' | 'ready';

/**
 * 列表三态。**错误优先**：加载失败时哪怕上一份数据是空的、哪怕 `loading` 还是 true，
 * 也算错误态——绝不允许渲染成「无成员」。
 */
export function membersListState(input: {
  loading: boolean;
  error: string | null | undefined;
  count: number;
}): MembersListState {
  if (input.error) return 'error';
  if (input.loading) return 'loading';
  if (!Number.isFinite(input.count) || input.count <= 0) return 'empty';
  return 'ready';
}

/** 乐观更新用：加上或去掉一个角色，返回规范化（小写、去重、字典序）的集合。 */
export function withRole(roles: readonly string[], role: string, enabled: boolean): string[] {
  const wanted = String(role ?? '').trim().toLowerCase();
  const next = new Set<string>();
  for (const entry of roles) {
    const normalized = String(entry ?? '').trim().toLowerCase();
    if (normalized) next.add(normalized);
  }
  if (!wanted) return [...next].sort();
  if (enabled) next.add(wanted);
  else next.delete(wanted);
  return [...next].sort();
}

/** 成员的展示名：显示名优先，缺了用用户名，都没有才是 em dash。 */
export function memberDisplayName(member: {
  display_name?: unknown;
  username?: unknown;
}): string {
  for (const value of [member.display_name, member.username]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '—';
}

/** 次要标识（用户名）：与展示名相同时不重复显示。 */
export function memberSecondaryName(member: {
  display_name?: unknown;
  username?: unknown;
}): string | null {
  const username = typeof member.username === 'string' ? member.username.trim() : '';
  if (!username) return null;
  return username === memberDisplayName(member) ? null : username;
}

/** 时间戳展示；空值是 em dash，解析不了就原样显示。 */
export function formatMemberTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}

/** 该角色是否被部署锁定（`pinned_roles` 里出现即锁定）。 */
export function isRolePinned(member: { pinned_roles?: readonly string[] }, role: string): boolean {
  return Array.isArray(member.pinned_roles) && member.pinned_roles.includes(role);
}

/** 变更记录的操作者：显示名 → 用户名 → 「系统」（引导写入的 actor 是 NULL）。 */
export function roleEventActorLabel(event: {
  actor_display_name?: unknown;
  actor_username?: unknown;
}): string {
  for (const value of [event.actor_display_name, event.actor_username]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '系统';
}

export function roleEventSourceLabel(source: unknown): string {
  const key = typeof source === 'string' ? source : '';
  return ROLE_EVENT_SOURCE_ZH[key] || key || '—';
}

export function roleEventActionLabel(action: unknown): string {
  const key = typeof action === 'string' ? action : '';
  return ROLE_EVENT_ACTION_ZH[key] || key || '—';
}

/**
 * 是否是当前登录者本人（撤销自己的 admin 要二次确认）。
 *
 * **先按用户名比对，id 只作兜底**：`me.id` 是浏览器凭据 id
 * （`auth_credentials.external_user_id`），而成员列表的 `user_id` 是内部 ULID
 * （design §2.1）——两者不是同一个 id 空间，拿它们相等做判断永远不成立。
 * 用户名在 `auth_credentials` 上有唯一索引，是这里唯一可靠的同一个键。
 */
export function isSelfMember(
  member: { user_id?: unknown; username?: unknown },
  viewer: RoleUserInput,
): boolean {
  if (!viewer || typeof viewer !== 'object') return false;
  const shape = viewer as { id?: unknown; username?: unknown };
  const viewerName = typeof shape.username === 'string' ? shape.username.trim() : '';
  const memberName = typeof member.username === 'string' ? member.username.trim() : '';
  if (viewerName && memberName) return viewerName === memberName;
  const viewerId = shape.id === undefined || shape.id === null ? '' : String(shape.id);
  const memberId = member.user_id === undefined || member.user_id === null ? '' : String(member.user_id);
  return Boolean(viewerId) && viewerId === memberId;
}
