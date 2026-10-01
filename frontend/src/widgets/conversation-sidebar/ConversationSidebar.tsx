import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useChat, type AuthConfigState } from '../../features/chat/ChatContext';
import { conversationTitle } from '../../shared/state';
import { useTheme } from '../../shared/ui/theme';
import { noLoginMethodMessage } from '../../shared/schemas/auth';
import { localLoginErrorMessage, ssoLoginUrl, takeSsoError } from '../../shared/api/sso';
import { conversationRunMarkers, listPendingApprovals } from '../runtime-timeline/buildTimeline';
import {
  IconCheck,
  IconChevronDown,
  IconCompose,
  IconFilter,
  IconHistory,
  IconLayers,
  IconPanel,
  IconSearch,
  IconTrash,
} from '../../shared/ui/Icons';
import {
  agentTone,
  filterConversations,
  groupConversations,
  isDefaultAgentName,
} from './sidebarModel';
import { SettingsDialog } from '../settings/SettingsDialog';
import { CommandPalette, type PaletteAction } from '../command-palette/CommandPalette';
import { listCronJobs } from '../../shared/api/cron-jobs';
import { hasUnseenRuns, readSchedulesSeenAt } from '../../pages/schedules/scheduleModel';
import { hasAdminRole, hasReviewerRole } from '../../shared/security/roles';
import s from './sidebar.module.css';

/**
 * 未登录时的底部面板：登录方式完全来自服务端 config 投影。
 *
 * - 加载/失败：显示状态与重试，**绝不**默认成「账号密码可用」；
 *   失败时连表单都不渲染，避免对服务故障做出「未开放登录」的假结论。
 * - `local.enabled` 才渲染账号密码表单；`registration_enabled` 才渲染注册。
 * - SSO 只有服务端明确 `enabled && available` 才渲染可点击入口（整页跳转到 BFF）；
 *   打开但不可用时只显示「暂不可用」，不给假入口。
 * - `mode=sso` 时账号密码只留给管理员：默认收起，点「管理员账号登录」才展开。
 * - SSO 回调失败带回的 `sso_error` 由调用方翻成文案后经 `ssoError` 传入。
 */
function SignInPanel({
  config,
  authError,
  logoutWarning,
  username,
  password,
  authErrorText,
  onRetry,
  onUsername,
  onPassword,
  onSubmit,
  onRegister,
  ssoError,
}: {
  config: AuthConfigState;
  authError: string | null;
  /** 退出后服务端撤销未确认的可见提示；普通退出为 null。 */
  logoutWarning: string | null;
  username: string;
  password: string;
  authErrorText: string;
  onRetry: () => void;
  onUsername: (value: string) => void;
  onPassword: (value: string) => void;
  onSubmit: (e: FormEvent) => void;
  onRegister: () => void;
  /** SSO 回调失败的文案（来自 `?sso_error=`）；没有为 null。 */
  ssoError: string | null;
}) {
  const [localError, setLocalError] = useState('');
  const [adminFormOpen, setAdminFormOpen] = useState(false);

  // 服务端身份/能力状态一变就清掉上一次的表单级提示（例如 503 后重试成功）。
  useEffect(() => {
    setLocalError('');
  }, [authError, config.error, config.config, config.loading]);

  // 撤销未确认的提示在任何未登录形态下都要可见：这是「本机已退出，但服务端
  // 撤销没确认」的安全事实，不能因为 config/身份检查失败而消失。
  const revocationNotice = logoutWarning ? (
    <p className={s.authError} role="alert">{logoutWarning}</p>
  ) : null;

  if (authError) {
    return (
      <div className={s.auth}>
        {revocationNotice}
        <p className={s.authError} role="alert">{authError}</p>
        <div className={s.authActions}>
          <button type="button" className={s.btn} onClick={onRetry}>重试</button>
        </div>
      </div>
    );
  }

  if (config.loading) {
    return (
      <div className={s.auth}>
        {revocationNotice}
        <p className={s.authNotice}>正在加载登录方式…</p>
      </div>
    );
  }

  if (config.error) {
    return (
      <div className={s.auth}>
        {revocationNotice}
        <p className={s.authError} role="alert">{config.error}</p>
        <div className={s.authActions}>
          <button type="button" className={s.btn} onClick={onRetry}>重试</button>
        </div>
      </div>
    );
  }

  const caps = config.capabilities;
  if (!caps) {
    return (
      <div className={s.auth}>
        {revocationNotice}
        <p className={s.authError} role="alert">登录方式不可用，请重试。</p>
        <div className={s.authActions}>
          <button type="button" className={s.btn} onClick={onRetry}>重试</button>
        </div>
      </div>
    );
  }

  const showLocalForm = caps.localEnabled && (!caps.localAdminOnly || adminFormOpen);
  const returnTo = `${window.location.pathname}${window.location.search}`;

  return (
    <form className={s.auth} onSubmit={onSubmit} autoComplete="on">
      {revocationNotice}
      {ssoError ? <p className={s.authError} role="alert">{ssoError}</p> : null}
      {caps.ssoAvailable ? (
        <a className={s.ssoBtn} href={ssoLoginUrl(returnTo)}>
          使用{caps.ssoLabel} 登录
        </a>
      ) : null}
      {showLocalForm ? (
        <>
          <input
            name="username"
            placeholder={caps.localAdminOnly ? '管理员用户名' : '用户名'}
            autoComplete="username"
            minLength={2}
            required
            value={username}
            onChange={(e) => onUsername(e.target.value)}
          />
          <input
            type="password"
            name="password"
            placeholder="密码"
            autoComplete="current-password"
            minLength={6}
            required
            value={password}
            onChange={(e) => onPassword(e.target.value)}
          />
          <div className={s.authActions}>
            <button type="submit" className={caps.localAdminOnly ? s.btn : s.primary}>登录</button>
            {caps.registrationEnabled ? (
              <button type="button" onClick={onRegister}>注册</button>
            ) : null}
          </div>
        </>
      ) : null}
      {caps.localEnabled && caps.localAdminOnly && !adminFormOpen ? (
        <button type="button" className={s.linkBtn} onClick={() => setAdminFormOpen(true)}>
          管理员账号登录
        </button>
      ) : null}
      {caps.ssoAvailable ? null : caps.ssoEnabled ? (
        <p className={s.empty}>{caps.ssoLabel} 暂不可用，请稍后重试或联系管理员。</p>
      ) : (
        <p className={s.empty}>
          {noLoginMethodMessage(caps) || `${caps.ssoLabel} 尚未开放，本次仅支持账号密码登录。`}
        </p>
      )}
      {localError || authErrorText ? (
        <p className={s.authError} role="alert">{localError || authErrorText}</p>
      ) : null}
    </form>
  );
}

/**
 * Left rail: brand, primary navigation, search, the conversation list grouped
 * by day, and the account menu. Conversations show which agent they are bound
 * to (the org default carries no tag) and whether a run is live or waiting.
 */
export function ConversationSidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const {
    state,
    entityStore,
    agents,
    agentNameById,
    startNewChat,
    removeConversation,
    closeSidebar,
    toggleSidebar,
    login,
    register,
    logout,
    authConfig,
    retryAuth,
    logoutWarning,
  } = useChat();
  const [theme, toggleTheme] = useTheme();

  const [query, setQuery] = useState('');
  const [agentFilter, setAgentFilter] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [listOpen, setListOpen] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [schedulesDot, setSchedulesDot] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');
  // SSO 回调失败时 BFF 带回 `?sso_error=`：读出一次、从地址栏抹掉，再在登录面板展示。
  // 放在 effect 里（不是 useState 初始化）：它会改 history，StrictMode 的二次调用无副作用。
  const [ssoError, setSsoError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const footRef = useRef<HTMLDivElement>(null);

  const open = state.sidebarOpen !== false;
  const isMobile =
    typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches;
  const signedIn = Boolean(state.authUser?.username);
  const isAdmin = hasAdminRole(state.authUser);
  // 审核工作台只对 reviewer 显示（真正判定在服务端：非 reviewer 会拿到 403）。
  const isReviewer = hasReviewerRole(state.authUser);

  const markers = useMemo(() => conversationRunMarkers(entityStore), [entityStore]);
  const pendingApprovals = useMemo(() => listPendingApprovals(entityStore), [entityStore]);
  const taggedAgents = useMemo(
    () => agents.filter((agent) => !isDefaultAgentName(agent.name)),
    [agents],
  );
  const groups = useMemo(
    () =>
      groupConversations(
        filterConversations(state.conversations || [], query, agentFilter, conversationTitle),
      ),
    [state.conversations, query, agentFilter],
  );

  useEffect(() => {
    const message = takeSsoError();
    if (message) setSsoError(message);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // "New results" dot on 定时任务: a job ran after the viewer last opened the page.
  const signedInForDot = Boolean(state.authUser?.username);
  useEffect(() => {
    if (!signedInForDot) return;
    let alive = true;
    const check = () => {
      listCronJobs()
        .then((jobs) => { if (alive) setSchedulesDot(hasUnseenRuns(jobs, readSchedulesSeenAt())); })
        .catch(() => { if (alive) setSchedulesDot(false); });
    };
    check();
    const timer = window.setInterval(check, 5 * 60_000);
    const onSeen = () => setSchedulesDot(false);
    window.addEventListener('schedules-seen', onSeen);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener('schedules-seen', onSeen);
    };
  }, [signedInForDot]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!footRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  function go(path: string) {
    navigate(path);
    setMenuOpen(false);
    if (isMobile) closeSidebar();
  }

  function onNewChat() {
    void startNewChat();
    go('/');
  }

  function onSelectConv(convId: string) {
    // The workbench selects the conversation named by /c/<id>.
    go(`/c/${encodeURIComponent(convId)}`);
  }

  async function onLogin(e: FormEvent) {
    e.preventDefault();
    if (!username.trim() || !password) return;
    // 新的一次登录尝试：上一次 SSO 回调的错误不再相关，避免两条错误叠在一起。
    setSsoError(null);
    try {
      setAuthError('');
      await login(username.trim(), password);
    } catch (err) {
      setAuthError(localLoginErrorMessage(err, '登录失败'));
    }
  }

  async function onRegister() {
    if (!username.trim() || !password) {
      setAuthError('请填写用户名和密码');
      return;
    }
    try {
      setAuthError('');
      await register(username.trim(), password);
    } catch (err) {
      setAuthError((err as Error).message || '注册失败');
    }
  }

  async function onLogout() {
    setMenuOpen(false);
    setUsername('');
    setPassword('');
    await logout();
  }

  const paletteActions: PaletteAction[] = [
    { id: 'act:new', group: '操作', label: '新建会话', hint: '⌘L', keywords: 'new chat', run: onNewChat },
    { id: 'act:schedules', group: '操作', label: '打开定时任务', keywords: 'schedule cron', run: () => go('/schedules') },
    { id: 'act:artifacts', group: '操作', label: '打开产物库', keywords: 'artifacts 文件', run: () => go('/artifacts') },
    { id: 'act:settings', group: '操作', label: '打开设置', keywords: 'settings 账户 偏好', run: () => setSettingsOpen(true) },
    ...(isAdmin ? [{ id: 'act:admin', group: '操作' as const, label: '打开管理控制台', keywords: 'admin 运行 审批 智能体', run: () => go('/admin/runs') }] : []),
    { id: 'act:theme', group: '操作', label: theme === 'light' ? '切换到深色' : '切换到浅色', keywords: 'theme 主题', run: () => toggleTheme() },
  ];
  const paletteConversations = (state.conversations || []).map((c) => {
    const name = c.agent_id ? agentNameById(c.agent_id) : null;
    return { id: c.id, title: conversationTitle(c), hint: name && !isDefaultAgentName(name) ? name : undefined };
  });

  const rootClass = [s.side, !isMobile && !open ? s.collapsed : '', isMobile && open ? s.mobileOpen : '']
    .filter(Boolean)
    .join(' ');
  const onChat = location.pathname === '/' || location.pathname.startsWith('/c/');

  return (
    <>
      <aside id="sidebar" className={rootClass} aria-label="导航与会话">
        <div className={s.brand}>
          <span className={s.brandName}>
            <img src="/brand/uprc-icon.png" alt="" width={22} height={22} />
            UPRC Agent
          </span>
          <button type="button" className={s.ghost} onClick={toggleSidebar} aria-label="收起侧栏" title="收起侧栏">
            <IconPanel size={18} />
          </button>
        </div>

        <nav className={s.nav} aria-label="主导航">
          <button type="button" onClick={onNewChat} aria-current={onChat && !state.conversationId ? 'page' : undefined}>
            <IconCompose size={18} />
            新建会话
            <kbd>⌘L</kbd>
          </button>
          <button
            type="button"
            onClick={() => go('/schedules')}
            aria-current={location.pathname.startsWith('/schedules') ? 'page' : undefined}
          >
            <IconHistory size={18} />
            定时任务
            {schedulesDot ? <span className={s.newDot} title="有新的运行结果" aria-label="有新的运行结果" /> : null}
          </button>
          <button
            type="button"
            onClick={() => go('/artifacts')}
            aria-current={location.pathname.startsWith('/artifacts') ? 'page' : undefined}
          >
            <IconLayers size={18} />
            产物库
          </button>
          {isReviewer ? (
            <button
              type="button"
              onClick={() => go('/reviews')}
              aria-current={location.pathname.startsWith('/reviews') ? 'page' : undefined}
            >
              <IconCheck size={18} />
              交付物审核
            </button>
          ) : null}
        </nav>

        <label className={s.search}>
          <IconSearch size={16} />
          <input
            ref={searchRef}
            id="sidebar-search"
            value={query}
            placeholder="搜索会话"
            aria-label="搜索会话"
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="button" className={s.kbdBtn} onClick={() => setPaletteOpen(true)} title="打开命令面板" aria-label="打开命令面板">
            <kbd>⌘K</kbd>
          </button>
        </label>

        <div className={s.groupHead}>
          <button type="button" className={s.groupToggle} aria-expanded={listOpen} onClick={() => setListOpen((v) => !v)}>
            会话
            <IconChevronDown size={13} className={listOpen ? undefined : s.rotated} />
          </button>
          <span className={s.sp} />
          {taggedAgents.length ? (
            <button
              type="button"
              className={`${s.ghost}${agentFilter ? ` ${s.active}` : ''}`}
              aria-label="按智能体筛选"
              title="按智能体筛选"
              aria-expanded={filterOpen}
              onClick={() => setFilterOpen((v) => !v)}
            >
              <IconFilter size={16} />
            </button>
          ) : null}
          {filterOpen ? (
            <div className={s.menu} role="menu" style={{ top: 28, right: 6 }}>
              {[null, ...taggedAgents.map((a) => a.agent_id)].map((id) => (
                <button
                  key={id || 'all'}
                  type="button"
                  role="menuitemradio"
                  aria-checked={agentFilter === id}
                  onClick={() => {
                    setAgentFilter(id);
                    setFilterOpen(false);
                  }}
                >
                  {id ? <span className={`${s.tag} ${s[`t${agentTone(id)}`]}`}>{agentNameById(id)}</span> : '全部智能体'}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className={s.list} role="list" hidden={!listOpen}>
          {!signedIn ? (
            <div className={s.empty}>登录后查看你的会话</div>
          ) : groups.length === 0 ? (
            <div className={s.empty}>{query || agentFilter ? '没有匹配的会话' : '还没有会话'}</div>
          ) : (
            groups.map((group) => (
              <div key={group.label} className={s.group}>
                <div className={s.groupLabel}>{group.label}</div>
                {group.items.map((conv) => {
                  const marker = markers[conv.id];
                  const waiting = Boolean(marker?.hasPendingApproval);
                  const running = Boolean(marker?.runStatus) && !waiting;
                  const agentName = conv.agent_id ? agentNameById(conv.agent_id) : null;
                  return (
                    <div
                      key={conv.id}
                      role="listitem"
                      tabIndex={0}
                      className={`${s.conv}${conv.id === state.conversationId && onChat ? ` ${s.current}` : ''}`}
                      onClick={() => onSelectConv(conv.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onSelectConv(conv.id);
                        }
                      }}
                    >
                      {waiting ? <span className={`${s.dot} ${s.wait}`} title="等待审批" /> : null}
                      {running ? <span className={`${s.dot} ${s.run}`} title="运行中" /> : null}
                      <span className={s.title} title={conversationTitle(conv)}>
                        {conversationTitle(conv)}
                      </span>
                      {conv.agent_id && !isDefaultAgentName(agentName) ? (
                        <span className={`${s.tag} ${s[`t${agentTone(conv.agent_id)}`]}`}>{agentName}</span>
                      ) : null}
                      <button
                        type="button"
                        className={s.del}
                        title="删除会话"
                        aria-label="删除会话"
                        onClick={(e) => {
                          e.stopPropagation();
                          void removeConversation(conv.id);
                        }}
                      >
                        <IconTrash size={13} />
                      </button>
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className={s.foot} ref={footRef}>
          {signedIn ? (
            <>
              {menuOpen ? (
                <div className={s.menu} role="menu" style={{ bottom: 58, left: 8, right: 8 }}>
                  <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); setSettingsOpen(true); }}>设置</button>
                  {isAdmin ? (
                    <button type="button" role="menuitem" onClick={() => go('/admin/runs')}>
                      管理控制台
                      {pendingApprovals.length ? <span className={s.badge}>{pendingApprovals.length} 待审批</span> : null}
                    </button>
                  ) : null}
                  <button type="button" role="menuitem" onClick={() => toggleTheme()}>
                    {theme === 'light' ? '切换到深色' : '切换到浅色'}
                  </button>
                  <hr />
                  <button type="button" role="menuitem" onClick={() => void onLogout()}>退出登录</button>
                </div>
              ) : null}
              <button type="button" className={s.me} aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)}>
                <span className={s.avatar} aria-hidden="true">
                  {(state.authUser?.username || '?').slice(0, 1).toUpperCase()}
                </span>
                <span className={s.meText}>
                  {state.authUser?.username}
                  <small>{isAdmin ? '管理员' : '普通用户'}</small>
                </span>
              </button>
            </>
          ) : (
            <SignInPanel
              config={authConfig}
              authError={state.authError}
              logoutWarning={logoutWarning}
              username={username}
              password={password}
              authErrorText={authError}
              onRetry={() => { void retryAuth(); }}
              onUsername={setUsername}
              onPassword={setPassword}
              onSubmit={onLogin}
              onRegister={() => { void onRegister(); }}
              ssoError={ssoError}
            />
          )}
        </div>
      </aside>
      <div id="sidebar-backdrop" className={s.backdrop} hidden={!isMobile || !open} onClick={closeSidebar} />
      {signedIn ? <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} /> : null}
      {signedIn ? (
        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          conversations={paletteConversations}
          actions={paletteActions}
          onOpenConversation={onSelectConv}
          onOpenArtifact={(a) => {
            const conv = (state.conversations || []).find((c) => String(c.sandbox_session_id || '') === a.session_id);
            go(conv ? `/c/${encodeURIComponent(conv.id)}` : '/artifacts');
          }}
        />
      ) : null}
    </>
  );
}
