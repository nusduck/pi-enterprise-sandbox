import { useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { FlashZone } from '../../widgets/flash/FlashZone';
import { ConversationHeader } from '../../widgets/conversation-header/ConversationHeader';
import { MessageList } from '../../widgets/message-list/MessageList';
import { DeliverablesPanel } from '../../widgets/deliverables/DeliverablesPanel';
import { Composer } from '../../widgets/composer/Composer';
import { ProcessConsole } from '../../widgets/process-console/ProcessConsole';
import { useChat } from '../../features/chat/ChatContext';
import { useWorkbenchSelection } from '../../app/layout/WorkbenchSelectionContext';

/**
 * Agent Runtime Workbench — interaction model:
 * 1. Single toolbar (title + live run + Details)
 * 2. Chat is the primary surface; tool/MCP/process steps render inline
 * 3. Inspector (right) opens for deep detail when a step is selected
 * 4. Process console sheet for full log streaming
 */
export function WorkbenchPage() {
  const { state, selectConversation, setDropzoneVisible, handleFilesSelected, entityStore } = useChat();
  const { consoleProcessId, closeProcessConsole } = useWorkbenchSelection();
  const { conversationId: routeId } = useParams();
  const navigate = useNavigate();
  const shownId = useRef<string | null>(null);

  // URL → focus: /c/<id> (sidebar clicks, back / forward) selects that conversation.
  useEffect(() => {
    if (routeId && routeId !== state.conversationId) void selectConversation(routeId);
    // Only a route change should select; state changes are handled below.
  }, [routeId]);

  // Focus → URL: a conversation created by the first message, restored at
  // boot or deleted while open is reflected in the address bar.
  useEffect(() => {
    const current = state.conversationId;
    const previous = shownId.current;
    shownId.current = current;
    if (current && current !== routeId) {
      navigate(`/c/${encodeURIComponent(current)}`, { replace: !routeId });
    } else if (!current && routeId && previous === routeId) {
      navigate('/', { replace: true });
    }
  }, [state.conversationId]);

  useEffect(() => {
    const onDragEnter = (e: DragEvent) => {
      e.preventDefault();
      setDropzoneVisible(true);
    };
    document.addEventListener('dragenter', onDragEnter);
    return () => document.removeEventListener('dragenter', onDragEnter);
  }, [setDropzoneVisible]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'u') {
        e.preventDefault();
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.multiple = true;
        inp.addEventListener('change', () => {
          if (inp.files?.length) void handleFilesSelected(inp.files);
        });
        inp.click();
      }
      if (e.key === 'Escape' && consoleProcessId) {
        closeProcessConsole();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [handleFilesSelected, consoleProcessId, closeProcessConsole]);

  const consoleProcess = consoleProcessId
    ? entityStore.processesById[consoleProcessId] || null
    : null;

  return (
    <div className="workbench-page">
      <ConversationHeader />
      <FlashZone />

      <div className="workbench-body">
        <div className="workbench-scroll">
          <MessageList />
        </div>

        <DeliverablesPanel />
        <Composer />
      </div>

      <ProcessConsole
        process={consoleProcess}
        open={Boolean(consoleProcessId)}
        onClose={closeProcessConsole}
      />
    </div>
  );
}
