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
  NO_LOGIN_RECORD_TOOLTIP,
  ROLE_PINNED_TOOLTIP,
  formatMemberDepartment,
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
  roleLabel,
  sortRoleEventsDesc,
  withRole,
} from './memberRoles';
import { PageHeader } from '../../shared/ui/PageHeader';
import { Toolbar } from '../../shared/ui/Toolbar';
import { Pager, useCursorPagination } from '../../shared/ui/Pager';
import { EmptyState } from '../../shared/ui/EmptyState';
import a from './adminPage.module.css';
import s from './membersAdmin.module.css';

/** 列表筛选；`role` 只发服务端白名单值（未知值会得到 422 ROLE_UNKNOWN）。标签用中文。 */
const ROLE_FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'admin', label: roleLabel('admin') },
  { id: 'reviewer', label: roleLabel('reviewer') },
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
    <label className={s.switch} title={pinned ? ROLE_PINNED_TOOLTIP : `角色代码：${role}`}>
      <input
        type="checkbox"
        checked={hasRole(member, role)}
        disabled={pinned || busy}
        aria-label={`${memberDisplayName(member)} 的「${roleLabel(role)}」角色`}
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
        if (generation === generationRef.current) setEvents(sortRoleEventsDesc(rows));
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
                <span className={a.mono} title={`角色代码：${event.role}`}>{roleLabel(event.role)}</span>
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
 * 成员身份：显示名为主，用户名/邮箱为辅（§3.1.2）。表格与窄屏卡片共用。
 */
function MemberIdentity({ member }: { member: AdminMember }) {
  const secondary = memberSecondaryName(member);
  return (
    <div className={s.memberCell}>
      <b>{memberDisplayName(member)}</b>
      {secondary ? <small className={a.mono}>{secondary}</small> : null}
      {member.email ? <small className={a.muted}>{member.email}</small> : null}
    </div>
  );
}

/** 最近登录：空值是「—」+ tooltip（§3.1.4，名单口径见 `NO_LOGIN_RECORD_TOOLTIP`）。 */
function MemberLastLogin({ member }: { member: AdminMember }) {
  if (!member.last_login_at) return <span title={NO_LOGIN_RECORD_TOOLTIP}>—</span>;
  return <>{formatMemberTimestamp(member.last_login_at)}</>;
}

/** 一个角色的开关格：开关 + （部署锁定时）说明 pill。表格与窄屏卡片共用。 */
function RoleCell({
  member,
  role,
  busyKey,
  onToggle,
}: {
  member: AdminMember;
  role: KnownRole;
  busyKey: string | null;
  onToggle: (member: AdminMember, role: KnownRole, next: boolean) => void;
}) {
  const pinned = role === 'admin' && isRolePinned(member, 'admin');
  return (
    <div className={s.roleCell}>
      <RoleToggle
        member={member}
        role={role}
        busy={busyKey === `${member.user_id}:${role}`}
        onToggle={onToggle}
      />
      {pinned ? (
        <span className={`${a.pill} ${a.mute}`} title={ROLE_PINNED_TOOLTIP}>
          部署锁定
        </span>
      ) : null}
    </div>
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
  const pagination = useCursorPagination({ initialPageSize: PAGE_SIZE });
  const [members, setMembers] = useState<AdminMember[] | null>(null);
  const [loading, setLoading] = useState(true);
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

  useEffect(() => {
    pagination.reset();
  }, [appliedQuery, roleFilter]);

  const load = useCallback(async () => {
    const generation = ++loadGenerationRef.current;
    setLoading(true);
    setLoadError(null);
    setActionError(null);
    try {
      const page = await listAdminMembers({
        q: appliedQuery || null,
        role: roleFilter === 'all' ? null : roleFilter,
        cursor: pagination.currentCursor,
        limit: pagination.pageSize,
      });
      // 过期响应（筛选已变）直接丢弃，别覆盖新结果。
      if (generation !== loadGenerationRef.current) return;
      setMembers(page.members);
      pagination.setPageData(page.next_cursor ?? null);
    } catch (err: unknown) {
      if (generation !== loadGenerationRef.current) return;
      const message = memberRoleErrorMessage(err);
      // 读取失败不能清成空列表：那看起来像「本组织没有成员」。
      setMembers(null);
      setLoadError(message);
      pagination.setPageData(null);
    } finally {
      if (generation === loadGenerationRef.current) {
        setLoading(false);
      }
    }
  }, [appliedQuery, roleFilter, pagination.currentCursor, pagination.pageSize, pagination.setPageData]);

  useEffect(() => { void load(); }, [load]);

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
      <PageHeader
        title="成员与角色"
        description="角色挂在本组织的成员关系上，授予与撤销在下一个请求即生效。名单包含本组织全部已开通的成员账号（平台创建或在本平台首次登录时自动开通）；「最近登录」显示「—」表示这个账号还没有平台登录记录，通常是脚本或部署引导创建的，不代表它不是成员。由部署环境变量名单锁定的管理员不能在界面撤销。"
        action={
          <button
            type="button"
            className={a.btn}
            onClick={() => {
              pagination.reset();
              void load();
            }}
            disabled={loading}
          >
            {loading ? '刷新中…' : '刷新'}
          </button>
        }
      />

      <Toolbar>
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
          已列出 {members?.length ?? 0} 位成员{pagination.hasNext ? '（还有更多）' : ''}
        </span>
      </Toolbar>

      {notice ? <p className={a.notice} role="status">{notice}</p> : null}
      {actionError ? <p className={a.error} role="alert">{actionError}</p> : null}

      {listState === 'error' ? (
        <div className={s.errorBox} role="alert">
          <b>读取成员列表失败</b>
          <p className={a.error} style={{ margin: 0 }}>{loadError}</p>
          <div className={a.cardActions}>
            <button type="button" className={a.btn} onClick={() => void load()}>
              重试
            </button>
          </div>
        </div>
      ) : null}

      {listState === 'loading' ? <p className={a.muted}>正在读取…</p> : null}

      {listState === 'empty' ? (
        <EmptyState
          variant="empty"
          title="未找到成员"
          description={appliedQuery || roleFilter !== 'all' ? '没有匹配的成员。' : '本组织还没有已登录过的成员。'}
        />
      ) : null}

      {listState === 'ready' ? (
        <>
          <div className={s.tableOnly}>
            <div className={a.tableCard}>
              <div className={a.tableWrap}>
                <table className={a.table}>
                  <thead>
                    <tr>
                      <th>成员</th>
                      <th>部门</th>
                      <th>最近登录</th>
                      <th title="角色代码：admin">{roleLabel('admin')}</th>
                      <th title="角色代码：reviewer">{roleLabel('reviewer')}</th>
                      <th className={a.right}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {members?.map((member) => (
                      <tr key={member.user_id}>
                        <td>
                          <MemberIdentity member={member} />
                        </td>
                        <td>
                          {formatMemberDepartment(member.department)}
                        </td>
                        <td className={`${a.num} ${a.muted}`}>
                          <MemberLastLogin member={member} />
                        </td>
                        <td>
                          <RoleCell
                            member={member}
                            role="admin"
                            busyKey={busyKey}
                            onToggle={(m, r, next) => void toggleRole(m, r, next)}
                          />
                        </td>
                        <td>
                          <RoleCell
                            member={member}
                            role="reviewer"
                            busyKey={busyKey}
                            onToggle={(m, r, next) => void toggleRole(m, r, next)}
                          />
                        </td>
                        <td className={a.right}>
                          <button type="button" className={a.btn} onClick={() => setEventsMember(member)}>
                            变更记录
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {members && members.length > 0 ? (
                <Pager
                  page={pagination.page}
                  count={members.length}
                  pageSize={pagination.pageSize}
                  onPageSizeChange={pagination.setPageSize}
                  onPrev={pagination.goToPrevPage}
                  onNext={pagination.goToNextPage}
                  hasPrev={pagination.hasPrev}
                  hasNext={pagination.hasNext}
                  loading={loading}
                />
              ) : null}
            </div>
          </div>

          {/* 窄屏（≤900px）用卡片式行：表格在 ~490px 的可用宽度里放不下 5 列，
              「操作」会被挤到屏幕外、按钮竖排把整行撑高（返工单 R4）。 */}
          <div className={s.cardsOnly}>
            <ul className={s.memberCards}>
              {members?.map((member) => (
                <li key={member.user_id} className={s.memberCard}>
                  <MemberIdentity member={member} />
                  <dl className={s.memberCardMeta}>
                    <div>
                      <dt>部门</dt>
                      <dd>{formatMemberDepartment(member.department)}</dd>
                    </div>
                    <div>
                      <dt>最近登录</dt>
                      <dd className={a.num}>
                        <MemberLastLogin member={member} />
                      </dd>
                    </div>
                    <div>
                      <dt title="角色代码：admin">{roleLabel('admin')}</dt>
                      <dd>
                        <RoleCell
                          member={member}
                          role="admin"
                          busyKey={busyKey}
                          onToggle={(m, r, next) => void toggleRole(m, r, next)}
                        />
                      </dd>
                    </div>
                    <div>
                      <dt title="角色代码：reviewer">{roleLabel('reviewer')}</dt>
                      <dd>
                        <RoleCell
                          member={member}
                          role="reviewer"
                          busyKey={busyKey}
                          onToggle={(m, r, next) => void toggleRole(m, r, next)}
                        />
                      </dd>
                    </div>
                  </dl>
                  <div className={s.memberCardActions}>
                    <button type="button" className={a.btn} onClick={() => setEventsMember(member)}>
                      变更记录
                    </button>
                  </div>
                </li>
              ))}
            </ul>

            {members && members.length > 0 ? (
              <Pager
                page={pagination.page}
                count={members.length}
                pageSize={pagination.pageSize}
                onPageSizeChange={pagination.setPageSize}
                onPrev={pagination.goToPrevPage}
                onNext={pagination.goToNextPage}
                hasPrev={pagination.hasPrev}
                hasNext={pagination.hasNext}
                loading={loading}
              />
            ) : null}
          </div>
        </>
      ) : null}

      {eventsMember ? (
        <RoleEventsDrawer member={eventsMember} onClose={() => setEventsMember(null)} />
      ) : null}
    </div>
  );
}
