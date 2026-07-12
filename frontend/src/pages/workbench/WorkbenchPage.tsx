import { useEffect, useMemo, useRef } from 'react';
import { FlashZone } from '../../widgets/flash/FlashZone';
import { ConversationHeader } from '../../widgets/conversation-header/ConversationHeader';
import { MessageList } from '../../widgets/message-list/MessageList';
import { RuntimeTimeline } from '../../widgets/runtime-timeline/RuntimeTimeline';
import { DeliverablesPanel } from '../../widgets/deliverables/DeliverablesPanel';
import { Composer } from '../../widgets/composer/Composer';
import { ProcessConsole } from '../../widgets/process-console/ProcessConsole';
import { useChat } from '../../features/chat/ChatContext';
import { useWorkbenchSelection } from '../../app/layout/WorkbenchSelectionContext';
import { buildRunTimeline } from '../../widgets/runtime-timeline/buildTimeline';

/**
 * Agent Runtime Workbench — interaction model:
 * 1. Single toolbar (title + live run + Activity/Details toggles)
 * 2. Chat is the primary surface (messages scroll alone)
 * 3. Runtime activity is a collapsible drawer above the composer
 * 4. Inspector (right) opens for deep detail when a card is selected
 */
export function WorkbenchPage() {
  const { setDropzoneVisible, handleFilesSelected, entityStore, activeRunId } =
    useChat();
  const {
    selected,
    setSelected,
    consoleProcessId,
    openProcessConsole,
    closeProcessConsole,
    activityOpen,
    setActivityOpen,
  } = useWorkbenchSelection();

  const timelineCount = useMemo(
    () => buildRunTimeline(entityStore, activeRunId).length,
    [entityStore, activeRunId],
  );

  // Auto-open only on empty → has-items edge (respect user closing the drawer).
  const prevTimelineCount = useRef(0);
  useEffect(() => {
    if (prevTimelineCount.current === 0 && timelineCount > 0) {
      setActivityOpen(true);
    }
    prevTimelineCount.current = timelineCount;
  }, [timelineCount, setActivityOpen]);

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

        <div
          className={`activity-drawer${activityOpen ? ' open' : ''}${timelineCount === 0 ? ' empty' : ''}`}
          hidden={!activityOpen}
        >
          <div className="activity-drawer-head">
            <span className="activity-drawer-title">Runtime activity</span>
            {timelineCount > 0 ? (
              <span className="activity-drawer-count">{timelineCount}</span>
            ) : null}
            <button
              type="button"
              className="btn-icon activity-drawer-close"
              aria-label="Close activity"
              title="Close activity"
              onClick={() => setActivityOpen(false)}
            >
              ✕
            </button>
          </div>
          <div className="activity-drawer-body">
            <RuntimeTimeline
              selected={selected}
              onSelect={setSelected}
              onOpenProcessConsole={openProcessConsole}
              embedded
            />
          </div>
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
