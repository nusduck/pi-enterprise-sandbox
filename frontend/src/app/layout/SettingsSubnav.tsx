import { useMemo, type ReactNode } from 'react';
import { NavLink, Link } from 'react-router-dom';
import { useChat } from '../../features/chat/ChatContext';
import { listActiveRuns } from '../../entities';
import {
  IconPuzzle,
  IconApprovals,
  IconRuns,
  IconA2a,
  IconSubagent,
  IconArrowLeft,
  IconSettings,
} from '../../shared/ui/Icons';

export function SettingsLayout({ children }: { children: ReactNode }) {
  const { state, entityStore } = useChat();
  const isAdmin = String(state.authUser?.role || '').toLowerCase() === 'admin';

  const activeRuns = useMemo(() => listActiveRuns(entityStore), [entityStore]);
  const pendingApprovals = useMemo(
    () => Object.values(entityStore.approvalsById || {}).filter((a) => a.status === 'pending'),
    [entityStore],
  );

  return (
    <div className="settings-layout">
      <aside className="settings-sidebar settings-subnav" aria-label="Settings categories">
        <div className="settings-sidebar-header">
          <Link to="/" className="settings-back-btn" title="Back to Chat">
            <IconArrowLeft size={15} />
            <span>Back to Chat</span>
          </Link>
          <div className="settings-sidebar-title-block">
            <IconSettings size={18} className="settings-sidebar-icon" />
            <span className="settings-sidebar-title">Settings</span>
          </div>
        </div>

        <nav className="settings-nav-list settings-subnav-inner" aria-label="Settings navigation">
          <NavLink
            to="/settings/capabilities"
            className={({ isActive }) =>
              `settings-nav-item${isActive ? ' active' : ''}`
            }
          >
            <IconPuzzle size={16} />
            <span>Capabilities</span>
          </NavLink>

          <NavLink
            to="/settings/approvals"
            className={({ isActive }) =>
              `settings-nav-item${isActive ? ' active' : ''}`
            }
          >
            <IconApprovals size={16} />
            <span>Approvals</span>
            {pendingApprovals.length > 0 ? (
              <span
                className="settings-badge warn"
                aria-label={`${pendingApprovals.length} pending`}
              >
                {pendingApprovals.length}
              </span>
            ) : null}
          </NavLink>

          <NavLink
            to="/settings/runs"
            className={({ isActive }) =>
              `settings-nav-item${isActive ? ' active' : ''}`
            }
          >
            <IconRuns size={16} />
            <span>Runs</span>
            {activeRuns.length > 0 ? (
              <span
                className="settings-badge"
                aria-label={`${activeRuns.length} active`}
              >
                {activeRuns.length}
              </span>
            ) : null}
          </NavLink>

          {isAdmin ? (
            <NavLink
              to="/settings/agents"
              className={({ isActive }) =>
                `settings-nav-item${isActive ? ' active' : ''}`
              }
            >
              <IconSubagent size={16} />
              <span>Agents</span>
            </NavLink>
          ) : null}

          {isAdmin ? (
            <NavLink
              to="/settings/a2a"
              className={({ isActive }) =>
                `settings-nav-item${isActive ? ' active' : ''}`
              }
            >
              <IconA2a size={16} />
              <span>A2A Access</span>
            </NavLink>
          ) : null}
        </nav>
      </aside>

      <div className="settings-content">
        {children}
      </div>
    </div>
  );
}

/** Backward-compatible export */
export function SettingsSubnav() {
  return null;
}
