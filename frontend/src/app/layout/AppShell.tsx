import { useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { ConversationSidebar } from '../../widgets/conversation-sidebar/ConversationSidebar';
import { ContextInspector } from '../../widgets/context-inspector/ContextInspector';
import { useChat } from '../../features/chat/ChatContext';
import {
  selectionToInspectorTab,
  type InspectorTabId,
  type SelectedEntity,
} from '../../widgets/runtime-timeline/buildTimeline';
import { WorkbenchSelectionContext } from './WorkbenchSelectionContext';
import { SettingsLayout } from './SettingsSubnav';
import { IconMenu, IconSun, IconMoon } from '../../shared/ui/Icons';
import { useTheme } from '../../shared/ui/theme';

/**
 * Shell interaction model:
 * - Left: navigation + conversations (drawer on mobile)
 * - Center: page content (workbench owns its own toolbar)
 * - Right: context inspector (workbench only; opens on entity select)
 */
function isManagementPath(pathname: string): boolean {
  return (
    pathname === '/runs' ||
    pathname === '/approvals' ||
    pathname === '/schedules' ||
    pathname.startsWith('/settings')
  );
}

function managementTitle(pathname: string): string {
  if (pathname.startsWith('/settings/runs') || pathname === '/runs') return 'Active Runs';
  if (pathname.startsWith('/settings/approvals') || pathname === '/approvals') return 'Approval Center';
  if (pathname === '/schedules') return 'Scheduled Runs';
  if (pathname.startsWith('/settings/agents')) return 'Agents';
  if (pathname.startsWith('/settings/a2a')) return 'A2A Access';
  if (pathname.startsWith('/settings/capabilities') || pathname === '/settings') return 'Capabilities';
  return 'UPRC Agent';
}

export function AppShell({ children }: { children: ReactNode }) {
  const location = useLocation();
  const management = isManagementPath(location.pathname);
  const { state, toggleSidebar, inspectorOpen, setInspectorOpen } = useChat();
  const [theme, toggleTheme] = useTheme();

  const [inspectorTab, setInspectorTab] = useState<InspectorTabId>('overview');
  const [selected, setSelected] = useState<SelectedEntity>(null);
  const [consoleProcessId, setConsoleProcessId] = useState<string | null>(null);

  if (!state.authReady) {
    return (
      <div id="app" className="app-shell session-bootstrap" role="status" aria-live="polite">
        Restoring session…
      </div>
    );
  }

  function handleSelect(sel: SelectedEntity) {
    setSelected(sel);
    if (sel) {
      setInspectorTab(selectionToInspectorTab(sel.kind));
      setInspectorOpen(true);
    }
  }

  function openProcessConsole(processId: string) {
    setConsoleProcessId(processId);
    setSelected({ kind: 'process', id: processId });
    setInspectorTab('processes');
    setInspectorOpen(true);
  }

  function closeProcessConsole() {
    setConsoleProcessId(null);
  }

  return (
    <WorkbenchSelectionContext.Provider
      value={{
        selected,
        setSelected: handleSelect,
        inspectorTab,
        setInspectorTab,
        consoleProcessId,
        openProcessConsole,
        closeProcessConsole,
      }}
    >
      <div
        id="app"
        className={`app-shell workbench-shell${management ? ' mgmt-shell' : ' chat-shell'}`}
      >
        <ConversationSidebar />

        <div className="main-col">
          {management ? (
            <header className="header header-mgmt">
              <button
                type="button"
                className="btn-icon"
                id="btn-sidebar-toggle"
                title="Toggle sidebar"
                aria-label="Toggle sidebar"
                onClick={toggleSidebar}
              >
                <IconMenu size={18} />
              </button>
              <div className="logo" aria-hidden="true">
                <img src="/brand/uprc-icon.png" alt="" width={26} height={26} />
              </div>
              <h1>{managementTitle(location.pathname)}</h1>
              <div className="badge" aria-live="polite">
                <span
                  className="dot"
                  aria-hidden="true"
                  style={{ background: state.statusColor }}
                />
                <span id="status-label">{state.statusLabel}</span>
              </div>
              <button
                type="button"
                className="btn-icon"
                title={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
                aria-label="Toggle color theme"
                onClick={() => toggleTheme()}
              >
                {theme === 'light' ? <IconMoon size={16} /> : <IconSun size={16} />}
              </button>
            </header>
          ) : null}

          {location.pathname.startsWith('/settings') ? (
            <SettingsLayout>{children}</SettingsLayout>
          ) : (
            <div className="workbench-center">{children}</div>
          )}
        </div>

        {!management ? (
          <ContextInspector
            open={inspectorOpen}
            onClose={() => setInspectorOpen(false)}
            tab={inspectorTab}
            onTabChange={setInspectorTab}
            selected={selected}
          />
        ) : null}
      </div>
    </WorkbenchSelectionContext.Provider>
  );
}
