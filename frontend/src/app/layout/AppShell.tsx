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
 * Workbench shell (conversations and user pages; the admin console has its
 * own AdminShell):
 * - Left: navigation + conversations (drawer on mobile)
 * - Center: page content (the workbench owns its title bar)
 * - Right: conversation resources drawer (artifacts, files, datasets,
 *   processes) on conversation pages, opened from the title bar
 */
function isConversationPath(pathname: string): boolean {
  return pathname === '/' || pathname.startsWith('/c/');
}

export function AppShell({ children }: { children: ReactNode }) {
  const location = useLocation();
  const onConversation = isConversationPath(location.pathname);
  const { state, inspectorOpen, setInspectorOpen } = useChat();

  const [inspectorTab, setInspectorTab] = useState<InspectorTabId>('artifacts');
  const [selected, setSelected] = useState<SelectedEntity>(null);
  const [consoleProcessId, setConsoleProcessId] = useState<string | null>(null);

  if (!state.authReady) {
    return (
      <div id="app" className="app-shell session-bootstrap" role="status" aria-live="polite">
        正在恢复会话…
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
    // The console is its own sheet; the resources drawer stays as the user left it.
    setConsoleProcessId(processId);
    setSelected({ kind: 'process', id: processId });
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
      <div id="app" className="app-shell workbench-shell chat-shell">
        <ConversationSidebar />
        <div className="main-col" aria-live="polite">
          <div className="workbench-center">{children}</div>
        </div>
        {onConversation ? (
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
