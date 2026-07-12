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

/**
 * Three-pane Agent Runtime Workbench shell (F3 / ADR §5):
 * Navigation | Conversation / Run Timeline | Context Inspector
 *
 * Desktop: three columns.
 * Tablet/mobile: nav + inspector as drawers over the workbench.
 *
 * Management pages (F5: /runs, /approvals, /settings/*) keep the left nav
 * but hide the context inspector so the center pane can use full width.
 */
function isManagementPath(pathname: string): boolean {
  return (
    pathname === '/runs' ||
    pathname === '/approvals' ||
    pathname.startsWith('/settings')
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const location = useLocation();
  const management = isManagementPath(location.pathname);
  const {
    state,
    toggleSidebar,
    inspectorOpen,
    setInspectorOpen,
    toggleInspector,
  } = useChat();

  const [inspectorTab, setInspectorTab] = useState<InspectorTabId>('overview');
  const [selected, setSelected] = useState<SelectedEntity>(null);
  const [consoleProcessId, setConsoleProcessId] = useState<string | null>(null);

  function handleSelect(sel: SelectedEntity) {
    setSelected(sel);
    if (sel) {
      setInspectorTab(selectionToInspectorTab(sel.kind));
      // Ensure inspector visible when selecting a card (esp. mobile)
      setInspectorOpen(true);
    }
  }

  function openProcessConsole(processId: string) {
    setConsoleProcessId(processId);
    setSelected({ kind: 'process', id: processId });
    setInspectorTab('processes');
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
        className={`app-shell workbench-shell${management ? ' mgmt-shell' : ''}`}
      >
        <ConversationSidebar />

        <div className="main-col">
          <header className="header">
            <button
              type="button"
              className="btn-icon"
              id="btn-sidebar-toggle"
              title="Toggle conversations"
              aria-label="Toggle sidebar"
              onClick={toggleSidebar}
            >
              ☰
            </button>
            <div className="logo">◆</div>
            <h1>Enterprise Sandbox</h1>
            <div className="badge" aria-live="polite">
              <span
                className="dot"
                aria-hidden="true"
                style={{ background: state.statusColor }}
              />
              <span id="status-label">{state.statusLabel}</span>
            </div>
            {!management ? (
              <button
                type="button"
                className="btn-icon"
                id="btn-inspector-toggle"
                title="Toggle context inspector"
                aria-label="Toggle context inspector"
                aria-pressed={inspectorOpen}
                onClick={toggleInspector}
              >
                ▤
              </button>
            ) : null}
          </header>
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
