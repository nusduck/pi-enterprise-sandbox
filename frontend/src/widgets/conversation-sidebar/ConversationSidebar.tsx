import { useMemo, useState, type FormEvent } from 'react';
import { NavLink } from 'react-router-dom';
import { useChat } from '../../features/chat/ChatContext';
import { conversationTitle } from '../../shared/state';
import {
  conversationRunMarkers,
  formatRunStatusLabel,
  listPendingApprovals,
} from '../runtime-timeline/buildTimeline';
import { listActiveRuns } from '../../entities';

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

/**
 * Sidebar hierarchy (top → bottom):
 * 1. Brand + new conversation
 * 2. Conversation list (primary content)
 * 3. Footer: app sections + compact auth
 */
export function ConversationSidebar() {
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

  return (
    <>
      <aside id="sidebar" className={sidebarClass}>
        <div className="sidebar-head">
          <div className="sidebar-brand">
            <span className="sidebar-brand-mark" aria-hidden="true">
              <img src="/brand/uprc-icon.svg" alt="" width={28} height={28} />
            </span>
            <span className="sidebar-brand-name">UPRC Agent</span>
          </div>
          <button
            type="button"
            className="btn-icon sidebar-close-btn"
            title="Close sidebar"
            aria-label="Close sidebar"
            onClick={closeSidebar}
          >
            ✕
          </button>
        </div>

        <div className="sidebar-actions">
          <button
            type="button"
            className="btn-new-chat"
            title="New conversation"
            onClick={() => void startNewChat()}
          >
            New Conversation
          </button>
        </div>

        <div className="sidebar-section-label">Conversations</div>

        <div className="sidebar-list" role="list">
          {(state.conversations || []).length === 0 ? (
            <div className="sidebar-empty">
              No conversations yet.
              <br />
              Start a new one above.
            </div>
          ) : (
            state.conversations.map((conv) => {
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
                    ×
                  </button>
                </div>
              );
            })
          )}
        </div>

        <div className="sidebar-footer">
          <nav className="sidebar-nav" aria-label="Primary">
            <NavLink
              to="/"
              end
              className={({ isActive }) =>
                `sidebar-nav-link${isActive ? ' active' : ''}`
              }
            >
              Chat
            </NavLink>
            <NavLink
              to="/runs"
              className={({ isActive }) =>
                `sidebar-nav-link${isActive ? ' active' : ''}`
              }
            >
              <span>Runs</span>
              {activeRuns.length > 0 ? (
                <span
                  className="sidebar-nav-badge"
                  aria-label={`${activeRuns.length} active`}
                >
                  {activeRuns.length}
                </span>
              ) : null}
            </NavLink>
            <NavLink
              to="/approvals"
              className={({ isActive }) =>
                `sidebar-nav-link${isActive ? ' active' : ''}`
              }
            >
              <span>Approvals</span>
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
              to="/settings/capabilities"
              className={({ isActive }) =>
                `sidebar-nav-link${isActive ? ' active' : ''}`
              }
            >
              Settings
            </NavLink>
            {String(state.authUser?.role || '').toLowerCase() === 'admin' ? (
              <NavLink
                to="/settings/a2a"
                className={({ isActive }) =>
                  `sidebar-nav-link${isActive ? ' active' : ''}`
                }
              >
                A2A
              </NavLink>
            ) : null}
          </nav>

          <div className="sidebar-auth" id="auth-panel">
            {signedIn ? (
              <button
                type="button"
                className="sidebar-user"
                title="Double-click to log out"
                onDoubleClick={() => void logout()}
                onClick={() => setAuthOpen((v) => !v)}
              >
                <span className="sidebar-user-dot" aria-hidden="true" />
                <span className="sidebar-user-name">
                  {state.authUser?.username}
                </span>
              </button>
            ) : (
              <button
                type="button"
                className="sidebar-auth-toggle"
                aria-expanded={authOpen}
                onClick={() => setAuthOpen((v) => !v)}
              >
                Sign in
              </button>
            )}
            {authOpen && !signedIn ? (
              <form className="auth-form" onSubmit={onLogin} autoComplete="on">
                <input
                  type="text"
                  name="username"
                  placeholder="Username"
                  minLength={2}
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
                <input
                  type="password"
                  name="password"
                  placeholder="Password"
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
                className="btn-auth secondary"
                onClick={() => void logout()}
              >
                Log out
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
