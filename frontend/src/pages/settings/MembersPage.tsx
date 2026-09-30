import { useCallback, useEffect, useRef, useState } from 'react';
import { useChat } from '../../features/chat/ChatContext';
import {
  grantAdminMemberRole,
  listAdminMemberRoleEvents,
  listAdminMembers,
  revokeAdminMemberRole,
  type AdminMember,
  type AdminMemberRoleEvent,
} from '../../shared/api/adminMembers';
import { hasRole } from '../../shared/security/roles';
import {
  ROLE_PINNED_TOOLTIP,
  formatMemberTimestamp,
  isRolePinned,
  isSelfMember,
  memberDisplayName,
  memberRoleErrorMessage,
  memberSecondaryName,
  membersListState,
  roleEventActionLabel,
  roleEventActorLabel,
  roleEventSourceLabel,
  withRole,
} from './memberRoles';
import a from './adminPage.module.css';
import s from './membersAdmin.module.css';

/** 列表筛选；`role` 只发服务端白名单值（未知值会得到 422 ROLE_UNKNOWN）。 */
const ROLE_FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'admin', label: 'admin' },
  { id: 'reviewer', label: 'reviewer' },
] as const;
type RoleFilter = (typeof ROLE_FILTERS)[number]['id'];

/** 一期固定角色（design §0）：`reviewer` 本期只落账本与界面。 */
type KnownRole = 'admin' | 'reviewer';

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;

/**
 * 一个角色开关。部署锁定的 admin 开关置灰，并用 tooltip 说明原因——置灰而不解释
 * 会让人以为是页面坏了（design §6）。
 */
function RoleToggle({
  member,
  role,
  busy,
  onToggle,
}: {
  member: AdminMember;
  role: KnownRole;
  busy: boolean;
  onToggle: (member: AdminMember, role: KnownRole, next: boolean) => void;
}) {
  const pinned = role === 'admin' && isRolePinned(member, 'admin');
  return (
    <label className={s.switch} title={pinned ? ROLE_PINNED_TOOLTIP : undefined}>
      <input
        type="checkbox"
        checked={hasRole(member, role)}
        disabled={pinned || busy}
        aria-label={`${memberDisplayName(member)} 的 ${role} 角色`}
        onChange={(e) => onToggle(member, role, e.target.checked)}
      />
      <span className={s.slider} aria-hidden="true" />
    </label>
  );
}

/**
 * 角色变更记录抽屉（design §6）：原生 `<dialog showModal()>` 负责焦点锁与 Esc 关闭，
 * 视觉上定位到右侧。
 */
function RoleEventsDrawer({ member, onClose }: { member: AdminMember; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [events, setEvents] = useState<AdminMemberRoleEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);

  const load = useCallback(() => {
    const generation = ++generationRef.current;
    setEvents(null);
    setError(null);
    listAdminMemberRoleEvents(member.user_id)
      .then((rows) => {
        if (generation === generationRef.current) setEvents(rows);
      })
      .catch((err: unknown) => {
        if (generation === generationRef.current) setError(memberRoleErrorMessage(err));
      });
  }, [member.user_id]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  useEffect(() => {
    load();
    return () => { generationRef.current += 1; };
  }, [load]);

  return (
    <dialog
      ref={dialogRef}
      className={s.drawer}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      aria-label={`${memberDisplayName(member)} 的角色变更记录`}
    >
      <div className={s.drawerInner}>
        <div className={s.drawerHead}>
          <div>
            <b>{memberDisplayName(member)}</b>
            {memberSecondaryName(member) ? <div className={a.mono}>{memberSecondaryName(member)}</div> : null}
          </div>
          <button type="button" className={s.closeBtn} onClick={onClose} aria-label="关闭">×</button>
        </div>
        <div className={s.drawerBody}>
          {error ? (
            <div className={s.eventError} role="alert">
              <p className={a.error} style={{ margin: 0 }}>读取变更记录失败：{error}</p>
              <button type="button" className={a.btn} onClick={load}>重试</button>
            </div>
          ) : null}
          {!error && events === null ? <p className={a.muted}>正在读取…</p> : null}
          {!error && events !== null && events.length === 0 ? (
            <p className={a.empty}>还没有任何角色变更记录。</p>
          ) : null}
          {events?.map((event) => (
            <div key={event.event_id} className={s.eventRow}>
              <div className={s.eventLine}>
                <span className={`${a.pill} ${event.action === 'grant' ? a.ok : a.warn}`}>
                  {roleEventActionLabel(event.action)}
                </span>
                <span className={a.mono}>{event.role}</span>
                <span className={a.sp} />
                <span className={`${a.muted} ${a.num}`}>{formatMemberTimestamp(event.created_at)}</span>
              </div>
              <div className={a.muted} style={{ fontSize: '12.5px' }}>
                来源：{roleEventSourceLabel(event.source)} · 操作者：{roleEventActorLabel(event)}
              </div>
            </div>
          ))}
        </div>
      </div>
    </dialog>
  );
}

/**
 * 成员与角色（design `docs/design/rbac-roles.md` §6）。
 *
 * 角色判定、org 作用域与两条 409 都在服务端；这个页面只负责投影与把错误码翻译成
 * 管理员能行动的一句话。开关先乐观更新、失败回滚——请求失败绝不能被显示成
 * 「这个人没有这个角色」。
 */
export function MembersPage() {
  const { state, refreshAuthUser } = useChat();
  const [query, setQuery] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('all');
  const [members, setMembers] = useState<AdminMember[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [eventsMember, setEventsMember] = useState<AdminMember | null>(null);
  const loadGenerationRef = useRef(0);

  // 搜索防抖：每敲一个字都打一次列表接口既浪费又会闪烁。
  useEffect(() => {
    const timer = setTimeout(() => setAppliedQuery(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const load = useCallback(
    async (opts: { cursor?: string | null; append?: boolean } = {}) => {
      const generation = ++loadGenerationRef.current;
      if (opts.append) setLoadingMore(true);
      else {
        setLoading(true);
        setLoadError(null);
      }
      setActionError(null);
      try {
        const page = await listAdminMembers({
          q: appliedQuery || null,
          role: roleFilter === 'all' ? null : roleFilter,
          cursor: opts.cursor ?? null,
          limit: PAGE_SIZE,
        });
        // 过期响应（筛选已变）直接丢弃，别覆盖新结果。
        if (generation !== loadGenerationRef.current) return;
        setMembers((prev) => (opts.append && prev ? [...prev, ...page.members] : page.members));
        setNextCursor(page.next_cursor ?? null);
      } catch (err: unknown) {
        if (generation !== loadGenerationRef.current) return;
        const message = memberRoleErrorMessage(err);
        if (opts.append) {
          setActionError(message);
        } else {
          // 读取失败不能清成空列表：那看起来像「本组织没有成员」。
          setMembers(null);
          setLoadError(message);
        }
      } finally {
        if (generation === loadGenerationRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [appliedQuery, roleFilter],
  );

  useEffect(() => { void load({ cursor: null }); }, [load]);

  async function toggleRole(member: AdminMember, role: KnownRole, next: boolean) {
    const self = isSelfMember(member, state.authUser);
    if (!next && role === 'admin' && self) {
      const confirmed =
        typeof window !== 'undefined' &&
        window.confirm('撤销你自己的管理员角色后，你会立即退出管理控制台。确定继续？');
      if (!confirmed) return;
    }
    const before = [...member.roles];
    setBusyKey(`${member.user_id}:${role}`);
    setActionError(null);
    setNotice(null);
    // 乐观更新：开关立刻跟手。
    setMembers(
      (prev) =>
        prev?.map((m) => (m.user_id === member.user_id ? { ...m, roles: withRole(m.roles, role, next) } : m)) ??
        prev,
    );
    try {
      const updated = next
        ? await grantAdminMemberRole(member.user_id, role)
        : await revokeAdminMemberRole(member.user_id, role);
      setMembers((prev) => prev?.map((m) => (m.user_id === updated.user_id ? updated : m)) ?? prev);
      if (!next && role === 'admin' && self) {
        // 角色权威在服务端：刷新 me，AdminShell 的 isAdmin 闸门随即变 false。
        const refreshed = await refreshAuthUser();
        setNotice(
          refreshed
            ? '已撤销你自己的管理员角色，界面已退出管理控制台。'
            : '已撤销你自己的管理员角色，但账户信息刷新失败，请手动刷新页面。',
        );
      }
    } catch (err: unknown) {
      // 回滚到请求前的角色集合，并把服务端给的原因显示出来。
      setMembers(
        (prev) => prev?.map((m) => (m.user_id === member.user_id ? { ...m, roles: before } : m)) ?? prev,
      );
      setActionError(`${next ? '授予' : '撤销'}失败：${memberRoleErrorMessage(err)}`);
    } finally {
      setBusyKey(null);
    }
  }

  const listState = membersListState({ loading, error: loadError, count: members?.length ?? 0 });

  return (
    <div className={a.page}>
      <div className={a.head}>
        <div>
          <h1>成员与角色</h1>
          <p>
            角色挂在本组织的成员关系上，授予与撤销在下一个请求即生效。名单里只包含至少登录过一次的成员；
            由部署环境变量名单锁定的管理员不能在界面撤销。
          </p>
        </div>
        <span className={a.sp} />
        <button
          type="button"
          className={a.btn}
          onClick={() => void load({ cursor: null })}
          disabled={loading}
        >
          {loading ? '刷新中…' : '刷新'}
        </button>
      </div>

      <div className={a.toolbar}>
        <input
          className={a.search}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索用户名或显示名"
          aria-label="搜索成员"
        />
        <div className={a.seg} role="tablist" aria-label="按角色筛选">
          {ROLE_FILTERS.map((filter) => (
            <button
              key={filter.id}
              type="button"
              role="tab"
              aria-selected={roleFilter === filter.id}
              aria-pressed={roleFilter === filter.id}
              onClick={() => setRoleFilter(filter.id)}
            >
              {filter.label}
            </button>
          ))}
        </div>
        <span className={a.muted} style={{ fontSize: '12.5px' }}>
          已列出 {members?.length ?? 0} 位成员{nextCursor ? '（还有更多）' : ''}
        </span>
      </div>

      {notice ? <p className={a.notice} role="status">{notice}</p> : null}
      {actionError ? <p className={a.error} role="alert">{actionError}</p> : null}

      {listState === 'error' ? (
        <div className={s.errorBox} role="alert">
          <b>读取成员列表失败</b>
          <p className={a.error} style={{ margin: 0 }}>{loadError}</p>
          <div className={a.cardActions}>
            <button type="button" className={a.btn} onClick={() => void load({ cursor: null })}>
              重试
            </button>
          </div>
        </div>
      ) : null}

      {listState === 'loading' ? <p className={a.muted}>正在读取…</p> : null}

      {listState === 'empty' ? (
        <p className={a.empty}>
          {appliedQuery || roleFilter !== 'all' ? '没有匹配的成员。' : '本组织还没有已登录过的成员。'}
        </p>
      ) : null}

      {listState === 'ready' ? (
        <>
          <div className={a.tableWrap}>
            <table className={a.table}>
              <thead>
                <tr>
                  <th>成员</th>
                  <th>最近登录</th>
                  <th>admin</th>
                  <th>reviewer</th>
                  <th className={a.right}>操作</th>
                </tr>
              </thead>
              <tbody>
                {members?.map((member) => {
                  const pinned = isRolePinned(member, 'admin');
                  const secondary = memberSecondaryName(member);
                  return (
                    <tr key={member.user_id}>
                      <td>
                        <div className={s.memberCell}>
                          <b>{memberDisplayName(member)}</b>
                          {secondary ? <small className={a.mono}>{secondary}</small> : null}
                          {member.email ? <small className={a.muted}>{member.email}</small> : null}
                        </div>
                      </td>
                      <td className={`${a.num} ${a.muted}`}>{formatMemberTimestamp(member.last_login_at)}</td>
                      <td>
                        <div className={s.roleCell}>
                          <RoleToggle
                            member={member}
                            role="admin"
                            busy={busyKey === `${member.user_id}:admin`}
                            onToggle={(m, r, next) => void toggleRole(m, r, next)}
                          />
                          {pinned ? (
                            <span className={`${a.pill} ${a.mute}`} title={ROLE_PINNED_TOOLTIP}>
                              部署锁定
                            </span>
                          ) : null}
                        </div>
                      </td>
                      <td>
                        <RoleToggle
                          member={member}
                          role="reviewer"
                          busy={busyKey === `${member.user_id}:reviewer`}
                          onToggle={(m, r, next) => void toggleRole(m, r, next)}
                        />
                      </td>
                      <td className={a.right}>
                        <button type="button" className={a.btn} onClick={() => setEventsMember(member)}>
                          变更记录
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {nextCursor ? (
            <div className={s.more}>
              <button
                type="button"
                className={a.btn}
                disabled={loadingMore}
                onClick={() => void load({ cursor: nextCursor, append: true })}
              >
                {loadingMore ? '正在加载…' : '加载更多'}
              </button>
            </div>
          ) : null}
        </>
      ) : null}

      {eventsMember ? (
        <RoleEventsDrawer member={eventsMember} onClose={() => setEventsMember(null)} />
      ) : null}
    </div>
  );
}
