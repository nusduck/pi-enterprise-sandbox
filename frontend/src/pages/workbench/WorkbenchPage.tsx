import { useEffect } from 'react';
import { FlashZone } from '../../widgets/flash/FlashZone';
import { ConversationHeader } from '../../widgets/conversation-header/ConversationHeader';
import { RunStatusBar } from '../../widgets/run-status-bar/RunStatusBar';
import { MessageList } from '../../widgets/message-list/MessageList';
import { RuntimeTimeline } from '../../widgets/runtime-timeline/RuntimeTimeline';
import { DeliverablesPanel } from '../../widgets/deliverables/DeliverablesPanel';
import { Composer } from '../../widgets/composer/Composer';
import { ProcessConsole } from '../../widgets/process-console/ProcessConsole';
import { useChat } from '../../features/chat/ChatContext';
import { useWorkbenchSelection } from '../../app/layout/WorkbenchSelectionContext';

/**
 * F3/F4 Agent Runtime Workbench — center pane:
 * Conversation Header · Run Status Bar · Message Timeline ·
 * Runtime Activity Timeline · Composer · Process Console sheet
 *
 * Left nav + right inspector live in AppShell.
 */
export function WorkbenchPage() {
  const { setDropzoneVisible, handleFilesSelected, entityStore } = useChat();
  const {
    selected,
    setSelected,
    consoleProcessId,
    openProcessConsole,
    closeProcessConsole,
  } = useWorkbenchSelection();

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
      <RunStatusBar />
      <FlashZone />
      <div className="workbench-scroll">
        <MessageList />
        <RuntimeTimeline
          selected={selected}
          onSelect={setSelected}
          onOpenProcessConsole={openProcessConsole}
        />
      </div>
      <DeliverablesPanel />
      <Composer />
      <ProcessConsole
        process={consoleProcess}
        open={Boolean(consoleProcessId)}
        onClose={closeProcessConsole}
      />
    </div>
  );
}
