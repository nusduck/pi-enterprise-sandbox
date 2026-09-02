import { useMemo, useState, type FormEvent } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useChat } from '../../features/chat/ChatContext';
import { conversationTitle } from '../../shared/state';
import {
  conversationRunMarkers,
  formatRunStatusLabel,
  listPendingApprovals,
} from '../runtime-timeline/buildTimeline';
import { listActiveRuns } from '../../entities';
import {
  IconChat,
  IconRuns,
  IconApprovals,
  IconSchedules,
  IconSettings,
  IconA2a,
  IconClose,
  IconPlus,
  IconTrash,
  IconSparkles,
} from '../../shared/ui/Icons';

function shortDate(iso?: string | null): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return `${d.getMonth() + 1}/${d.getDate()}`;
  } catch {
    return '';
  }
}

function runMarkerLabel(status: string | null, hasApproval: boolean): string {
  if (hasApproval) return 'Needs approval';
  if (!status) return '';
  return formatRunStatusLabel(status);
}

export function ConversationSidebar() {
  const navigate = useNavigate();
  const {
    state,
    entityStore,
    selectConversation,
    startNewChat,
    removeConversation,
    closeSidebar,
    login,
    register,
    logout,
  } = useChat();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [authOpen, setAuthOpen] = useState(false);

  const open = state.sidebarOpen !== false;
  const isMobile =
    typeof window !== 'undefined' &&
    window.matchMedia('(max-width: 768px)').matches;

  const markers = useMemo(
    () => conversationRunMarkers(entityStore),
    [entityStore],
  );
  const activeRuns = useMemo(() => listActiveRuns(entityStore), [entityStore]);
  const pendingApprovals = useMemo(
    () => listPendingApprovals(entityStore),
    [entityStore],
  );

  const signedIn = Boolean(state.authUser?.username);
  const isAdmin =
    String(state.authUser?.role || '').toLowerCase() === 'admin';
  const conversations = useMemo(
    () =>
      [...(state.conversations || [])].sort((a, b) => {
        const ta = Date.parse(a.updated_at || a.created_at || '');
        const tb = Date.parse(b.updated_at || b.created_at || '');
        if (ta !== tb) return tb - ta;
        return String(a.id).localeCompare(String(b.id));
      }),
    [state.conversations],
  );

  const sidebarClass = [
    'sidebar',
    !isMobile && !open ? 'collapsed' : '',
    isMobile && open ? 'open-mobile' : '',
  ]
    .filter(Boolean)
    .join(' ');

  async function onLogin(e: FormEvent) {
    e.preventDefault();
    if (!username.trim() || !password) return;
    try {
      setAuthError('');
      await login(username.trim(), password);
      setAuthOpen(false);
    } catch (err) {
      setAuthError((err as Error).message || 'Login failed');
    }
  }

  async function onRegister() {
    if (!username.trim() || !password) {
      setAuthError('Username and password required');
      return;
    }
    try {
      setAuthError('');
      await register(username.trim(), password);
      setAuthOpen(false);
    } catch (err) {
      setAuthError((err as Error).message || 'Register failed');
    }
  }

  async function onLogout() {
    setUsername('');
    setPassword('');
    setAuthError('');
    setAuthOpen(false);
    await logout();
  }

  function onNewChat() {
    void startNewChat();
    navigate('/');
    if (isMobile) closeSidebar();
  }

  return (
    <>
      <aside id="sidebar" className={sidebarClass}>
        <div className="sidebar-head">
          <div className="sidebar-brand">
            <span className="sidebar-brand-mark" aria-hidden="true">
              <img src="/brand/uprc-icon.png" alt="" width={26} height={26} />
            </span>
            <div className="sidebar-brand-text">
              <span className="sidebar-brand-name">UPRC Agent</span>
              <span className="sidebar-brand-badge">PRO</span>
            </div>
          </div>
          <button
            type="button"
            className="btn-icon sidebar-close-btn"
            title="Close sidebar"
            aria-label="Close sidebar"
            onClick={closeSidebar}
          >
            <IconClose size={16} />
          </button>
        </div>

        <div className="sidebar-actions">
          <button
            type="button"
            className="btn-new-chat"
            title="New conversation (Ctrl+L)"
            onClick={onNewChat}
          >
            <IconPlus size={16} className="btn-new-chat-icon" />
            <span>New Chat</span>
            <kbd className="btn-new-chat-kbd">Ctrl+L</kbd>
          </button>
        </div>

        <nav className="sidebar-nav sidebar-nav-primary" aria-label="Primary">
          <NavLink
            to="/"
            end
            className={({ isActive }) =>
              `sidebar-nav-link${isActive ? ' active' : ''}`
            }
            onClick={() => {
              if (isMobile) closeSidebar();
            }}
          >
            <span className="sidebar-nav-icon" aria-hidden="true">
              <IconChat size={17} />
            </span>
            <span className="sidebar-nav-text">Chat</span>
          </NavLink>
          <NavLink
            to="/schedules"
            className={({ isActive }) =>
              `sidebar-nav-link${isActive ? ' active' : ''}`
            }
            onClick={() => {
              if (isMobile) closeSidebar();
            }}
          >
            <span className="sidebar-nav-icon" aria-hidden="true">
              <IconSchedules size={17} />
            </span>
            <span className="sidebar-nav-text">Schedules</span>
          </NavLink>
        </nav>

        <div className="sidebar-section-divider" />
        <div className="sidebar-section-label">Recent Conversations</div>

        <div className="sidebar-list" role="list">
          {conversations.length === 0 ? (
            <div className="sidebar-empty">
              <IconSparkles size={20} className="sidebar-empty-icon" />
              <span>No conversations yet.</span>
              <small>Start a new chat to begin.</small>
            </div>
          ) : (
            conversations.map((conv) => {
              const marker = markers[conv.id];
              const hasRun = Boolean(marker?.runStatus);
              const hasApproval = Boolean(marker?.hasPendingApproval);
              const markerText = runMarkerLabel(
                marker?.runStatus || null,
                hasApproval,
              );
              return (
                <div
                  key={conv.id}
                  className={`conv-item${conv.id === state.conversationId ? ' active' : ''}${hasApproval ? ' needs-approval' : ''}${hasRun && !hasApproval ? ' has-active-run' : ''}`}
                  role="listitem"
                  tabIndex={0}
                  onClick={() => {
                    void selectConversation(conv.id);
                    if (isMobile) closeSidebar();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      void selectConversation(conv.id);
                      if (isMobile) closeSidebar();
                    }
                  }}
                >
                  <span className="conv-title" title={conversationTitle(conv)}>
                    {conversationTitle(conv)}
                  </span>
                  <span className="conv-meta">
                    {markerText ? (
                      <span
                        className={`conv-run-marker${hasApproval ? ' warn' : ' active'}`}
                        title={markerText}
                      >
                        {hasApproval ? '!' : '●'}
                      </span>
                    ) : null}
                    {shortDate(conv.updated_at || conv.created_at)}
                  </span>
                  <button
                    type="button"
                    className="btn-del-conv"
                    title="Delete conversation"
                    aria-label="Delete conversation"
                    onClick={(e) => {
                      e.stopPropagation();
                      void removeConversation(conv.id);
                    }}
                  >
                    <IconTrash size={13} />
                  </button>
                </div>
              );
            })
          )}
        </div>

        <div className="sidebar-footer">
          <nav className="sidebar-nav sidebar-nav-footer" aria-label="Account">
            <NavLink
              to="/settings/capabilities"
              className={({ isActive }) =>
                `sidebar-nav-link${isActive ? ' active' : ''}`
              }
              onClick={() => {
                if (isMobile) closeSidebar();
              }}
            >
              <span className="sidebar-nav-icon" aria-hidden="true">
                <IconSettings size={17} />
              </span>
              <span className="sidebar-nav-text">Settings</span>
            </NavLink>
            <NavLink
              to="/settings/approvals"
              className={({ isActive }) =>
                `sidebar-nav-link${isActive ? ' active' : ''}`
              }
              onClick={() => {
                if (isMobile) closeSidebar();
              }}
            >
              <span className="sidebar-nav-icon" aria-hidden="true">
                <IconApprovals size={17} />
              </span>
              <span className="sidebar-nav-text">Approvals</span>
              {pendingApprovals.length > 0 ? (
                <span
                  className="sidebar-nav-badge warn"
                  aria-label={`${pendingApprovals.length} pending`}
                >
                  {pendingApprovals.length}
                </span>
              ) : null}
            </NavLink>
            <NavLink
              to="/settings/runs"
              className={({ isActive }) =>
                `sidebar-nav-link${isActive ? ' active' : ''}`
              }
              onClick={() => {
                if (isMobile) closeSidebar();
              }}
            >
              <span className="sidebar-nav-icon" aria-hidden="true">
                <IconRuns size={17} />
              </span>
              <span className="sidebar-nav-text">Runs</span>
              {activeRuns.length > 0 ? (
                <span
                  className="sidebar-nav-badge"
                  aria-label={`${activeRuns.length} active`}
                >
                  {activeRuns.length}
                </span>
              ) : null}
            </NavLink>
            {isAdmin ? (
              <NavLink
                to="/settings/a2a"
                className={({ isActive }) =>
                  `sidebar-nav-link${isActive ? ' active' : ''}`
                }
                onClick={() => {
                  if (isMobile) closeSidebar();
                }}
              >
                <span className="sidebar-nav-icon" aria-hidden="true">
                  <IconA2a size={17} />
                </span>
                <span className="sidebar-nav-text">A2A</span>
              </NavLink>
            ) : null}
          </nav>

          <div className="sidebar-auth" id="auth-panel">
            {signedIn ? (
              <button
                type="button"
                className="sidebar-user"
                title="Click to expand session options"
                onClick={() => setAuthOpen((v) => !v)}
              >
                <span className="sidebar-user-avatar" aria-hidden="true">
                  {(state.authUser?.username || '?').slice(0, 1).toUpperCase()}
                </span>
                <span className="sidebar-user-meta">
                  <span className="sidebar-user-name">
                    {state.authUser?.username}
                  </span>
                  <span className="sidebar-user-role">
                    {String(state.authUser?.role || 'user')}
                  </span>
                </span>
              </button>
            ) : (
              <button
                type="button"
                className="sidebar-auth-toggle"
                aria-expanded={authOpen}
                onClick={() => setAuthOpen((v) => !v)}
              >
                Sign In / Register
              </button>
            )}
            {authOpen && !signedIn ? (
              <form className="auth-form" onSubmit={onLogin} autoComplete="on">
                <input
                  type="text"
                  name="username"
                  placeholder="Username"
                  autoComplete="username"
                  minLength={2}
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
                <input
                  type="password"
                  name="password"
                  placeholder="Password"
                  autoComplete="current-password"
                  minLength={6}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <div className="auth-actions">
                  <button type="submit" className="btn-auth">
                    Login
                  </button>
                  <button
                    type="button"
                    className="btn-auth secondary"
                    onClick={() => void onRegister()}
                  >
                    Register
                  </button>
                </div>
                {authError ? (
                  <p
                    className="auth-hint"
                    style={{ color: 'var(--color-danger)' }}
                  >
                    {authError}
                  </p>
                ) : (
                  <p className="auth-hint">Optional when AUTH_ENABLED</p>
                )}
              </form>
            ) : null}
            {authOpen && signedIn ? (
              <button
                type="button"
                className="btn-auth secondary sidebar-logout"
                onClick={() => void onLogout()}
              >
                Log Out
              </button>
            ) : null}
          </div>
        </div>
      </aside>
      <div
        id="sidebar-backdrop"
        className="sidebar-backdrop"
        hidden={!isMobile || !open}
        onClick={closeSidebar}
      />
    </>
  );
}
