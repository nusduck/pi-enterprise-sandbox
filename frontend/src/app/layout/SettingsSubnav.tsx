import { useMemo } from 'react';
import { NavLink } from 'react-router-dom';
import { useChat } from '../../features/chat/ChatContext';
import { listActiveRuns } from '../../entities';
import { IconPuzzle, IconApprovals, IconRuns, IconA2a } from '../../shared/ui/Icons';

export function SettingsSubnav() {
  const { state, entityStore } = useChat();
  const isAdmin = String(state.authUser?.role || '').toLowerCase() === 'admin';

  const activeRuns = useMemo(() => listActiveRuns(entityStore), [entityStore]);
  const pendingApprovals = useMemo(
    () => Object.values(entityStore.approvalsById || {}).filter((a) => a.status === 'pending'),
    [entityStore],
  );

  return (
    <nav className="settings-subnav" aria-label="Settings secondary navigation">
      <div className="settings-subnav-inner">
        <NavLink
          to="/settings/capabilities"
          className={({ isActive }) =>
            `settings-subnav-link${isActive ? ' active' : ''}`
          }
        >
          <IconPuzzle size={15} />
          <span>Capabilities</span>
        </NavLink>

        <NavLink
          to="/settings/approvals"
          className={({ isActive }) =>
            `settings-subnav-link${isActive ? ' active' : ''}`
          }
        >
          <IconApprovals size={15} />
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
            `settings-subnav-link${isActive ? ' active' : ''}`
          }
        >
          <IconRuns size={15} />
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
            to="/settings/a2a"
            className={({ isActive }) =>
              `settings-subnav-link${isActive ? ' active' : ''}`
            }
          >
            <IconA2a size={15} />
            <span>A2A Access</span>
          </NavLink>
        ) : null}
      </div>
    </nav>
  );
}
