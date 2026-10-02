import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useChat } from '../../features/chat/ChatContext';
import { conversationTitle } from '../../shared/state';
import { useTheme } from '../../shared/ui/theme';
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
import { listConversations } from '../../shared/api/client';
import { hasUnseenRuns, readSchedulesSeenAt } from '../../pages/schedules/scheduleModel';
import { hasAdminRole, hasReviewerRole, primaryRoleLabel } from '../../shared/security/roles';
import { LoadMoreSentinel } from '../../shared/ui/LoadMoreSentinel';
import {
  appendConversations,
  normalizeServerConversation,
  CONVERSATION_PAGE_SIZE,
} from '../../features/chat/conversationPaging';
import type { ConversationSummary } from '../../shared/state/types';
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
    logout,
    hasMoreConversations,
    loadingMoreConversations,
    conversationPagingError,
    loadMoreConversations,
  } = useChat();
  const [theme, toggleTheme] = useTheme();

  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ConversationSummary[] | null>(null);
  const [searchNextCursor, setSearchNextCursor] = useState<string | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchLoadingMore, setSearchLoadingMore] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [hasLoadedMoreNormal, setHasLoadedMoreNormal] = useState(false);
  const [searchHasAppended, setSearchHasAppended] = useState(false);
  const searchGenRef = useRef(0);

  useEffect(() => {
    setHasLoadedMoreNormal(false);
  }, [state.authUser?.user_id]);

  const [agentFilter, setAgentFilter] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [listOpen, setListOpen] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [schedulesDot, setSchedulesDot] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const footRef = useRef<HTMLDivElement>(null);

  // 250ms debounce for server-side search (q)
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setSearchResults(null);
      setSearchNextCursor(null);
      setSearchError(null);
      setSearchLoading(false);
      setSearchHasAppended(false);
      return;
    }

    const gen = ++searchGenRef.current;
    setSearchLoading(true);
    setSearchError(null);
    setSearchHasAppended(false);

    const timer = window.setTimeout(async () => {
      try {
        const page = await listConversations({ limit: CONVERSATION_PAGE_SIZE, q: trimmed });
        if (gen !== searchGenRef.current) return;
        setSearchResults((page.conversations || []).map(normalizeServerConversation));
        setSearchNextCursor(page.next_cursor);
      } catch (err) {
        if (gen !== searchGenRef.current) return;
        setSearchError((err as Error).message || '搜索会话失败');
        setSearchResults([]);
      } finally {
        if (gen === searchGenRef.current) {
          setSearchLoading(false);
        }
      }
    }, 250);

    return () => {
      window.clearTimeout(timer);
    };
  }, [query]);

  const loadMoreSearch = useCallback(async () => {
    const trimmed = query.trim();
    if (!trimmed || !searchNextCursor || searchLoadingMore) return;
    const gen = ++searchGenRef.current;
    setSearchLoadingMore(true);
    setSearchError(null);
    try {
      const page = await listConversations({
        limit: CONVERSATION_PAGE_SIZE,
        cursor: searchNextCursor,
        q: trimmed,
      });
      if (gen !== searchGenRef.current) return;
      setSearchResults((prev) => appendConversations(prev, page.conversations || []));
      setSearchNextCursor(page.next_cursor);
      setSearchHasAppended(true);
    } catch (err) {
      if (gen !== searchGenRef.current) return;
      setSearchError((err as Error).message || '加载更多搜索结果失败');
    } finally {
      if (gen === searchGenRef.current) {
        setSearchLoadingMore(false);
      }
    }
  }, [query, searchNextCursor, searchLoadingMore]);

  const isSearching = Boolean(query.trim());
  const activeConversations = isSearching ? searchResults ?? [] : state.conversations || [];

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
        filterConversations(activeConversations, isSearching ? '' : query, agentFilter, conversationTitle),
      ),
    [activeConversations, isSearching, query, agentFilter],
  );

  const sentinelLoading = isSearching ? searchLoadingMore || searchLoading : loadingMoreConversations;
  const sentinelHasMore = isSearching ? Boolean(searchNextCursor) : hasMoreConversations;
  const sentinelError = isSearching ? searchError : conversationPagingError;
  const handleLoadMore = useCallback(async () => {
    if (isSearching) {
      await loadMoreSearch();
    } else {
      await loadMoreConversations();
      setHasLoadedMoreNormal(true);
    }
  }, [isSearching, loadMoreSearch, loadMoreConversations]);

  const sentinelShowEnd = isSearching
    ? searchHasAppended
    : hasLoadedMoreNormal || Boolean(state.conversations && state.conversations.length > CONVERSATION_PAGE_SIZE);

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

  async function onLogout() {
    setMenuOpen(false);
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

  if (!signedIn) {
    return null;
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
          ) : isSearching && searchLoading && (!searchResults || searchResults.length === 0) ? (
            <div className={s.empty}>正在搜索…</div>
          ) : isSearching && searchError && (!searchResults || searchResults.length === 0) ? (
            <div className={s.empty} role="alert">{searchError}</div>
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
          {signedIn && activeConversations.length > 0 ? (
            <LoadMoreSentinel
              onLoadMore={handleLoadMore}
              loading={sentinelLoading}
              hasMore={sentinelHasMore}
              error={sentinelError}
              onRetry={handleLoadMore}
              showEndMessage={sentinelShowEnd}
            />
          ) : null}
        </div>

        <div className={s.foot} ref={footRef}>
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
              <small>{primaryRoleLabel(state.authUser)}</small>
            </span>
          </button>
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
