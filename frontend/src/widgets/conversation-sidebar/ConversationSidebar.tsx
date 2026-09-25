import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useChat } from '../../features/chat/ChatContext';
import { conversationTitle } from '../../shared/state';
import { useTheme } from '../../shared/ui/theme';
import { conversationRunMarkers, listPendingApprovals } from '../runtime-timeline/buildTimeline';
import {
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
import s from './sidebar.module.css';

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
  } = useChat();
  const [theme, toggleTheme] = useTheme();

  const [query, setQuery] = useState('');
  const [agentFilter, setAgentFilter] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [listOpen, setListOpen] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const footRef = useRef<HTMLDivElement>(null);

  const open = state.sidebarOpen !== false;
  const isMobile =
    typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches;
  const signedIn = Boolean(state.authUser?.username);
  const isAdmin = String(state.authUser?.role || '').toLowerCase() === 'admin';

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
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

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
    try {
      setAuthError('');
      await login(username.trim(), password);
    } catch (err) {
      setAuthError((err as Error).message || '登录失败');
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
          </button>
          <button
            type="button"
            onClick={() => go('/artifacts')}
            aria-current={location.pathname.startsWith('/artifacts') ? 'page' : undefined}
          >
            <IconLayers size={18} />
            产物库
          </button>
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
          <kbd>⌘K</kbd>
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
            <form className={s.auth} onSubmit={onLogin} autoComplete="on">
              <input
                name="username"
                placeholder="用户名"
                autoComplete="username"
                minLength={2}
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
              <input
                type="password"
                name="password"
                placeholder="密码"
                autoComplete="current-password"
                minLength={6}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <div className={s.authActions}>
                <button type="submit" className={s.primary}>登录</button>
                <button type="button" onClick={() => void onRegister()}>注册</button>
              </div>
              {authError ? <p className={s.authError}>{authError}</p> : null}
            </form>
          )}
        </div>
      </aside>
      <div id="sidebar-backdrop" className={s.backdrop} hidden={!isMobile || !open} onClick={closeSidebar} />
      {signedIn ? <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} /> : null}
    </>
  );
}
