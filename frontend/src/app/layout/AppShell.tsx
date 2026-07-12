import { useCallback, useState, type ReactNode } from 'react';
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

/**
 * Shell interaction model:
 * - Left: navigation + conversations (drawer on mobile)
 * - Center: page content (workbench owns its own toolbar)
 * - Right: context inspector (workbench only; opens on entity select)
 *
 * Management pages keep a slim global header; the chat workbench uses
 * ConversationHeader as the single top chrome so we don't stack bars.
 */
function isManagementPath(pathname: string): boolean {
  return (
    pathname === '/runs' ||
    pathname === '/approvals' ||
    pathname.startsWith('/settings')
  );
}

function managementTitle(pathname: string): string {
  if (pathname === '/runs') return 'Active Runs';
  if (pathname === '/approvals') return 'Approvals';
  if (pathname.startsWith('/settings')) return 'Capabilities';
  return 'Sandbox';
}

export function AppShell({ children }: { children: ReactNode }) {
  const location = useLocation();
  const management = isManagementPath(location.pathname);
  const { state, toggleSidebar, inspectorOpen, setInspectorOpen } = useChat();

  const [inspectorTab, setInspectorTab] = useState<InspectorTabId>('overview');
  const [selected, setSelected] = useState<SelectedEntity>(null);
  const [consoleProcessId, setConsoleProcessId] = useState<string | null>(null);
  const [activityOpen, setActivityOpen] = useState(false);

  const toggleActivity = useCallback(() => {
    setActivityOpen((v) => !v);
  }, []);

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
        activityOpen,
        setActivityOpen,
        toggleActivity,
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
                ☰
              </button>
              <div className="logo" aria-hidden="true">
                π
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
            </header>
          ) : null}

          <div className="workbench-center">{children}</div>
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
