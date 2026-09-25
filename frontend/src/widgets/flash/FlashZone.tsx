import { useChat } from '../../features/chat/ChatContext';

export function FlashZone() {
  const { state, entityStore, activeRunId, clearFlash } = useChat();
  const approval = Object.values(entityStore.approvalsById).find(
    (item) => item.runId === activeRunId && item.status === 'pending',
  );

  return (
    <div
      id="flash-zone"
      className="flash-zone"
      role="status"
      aria-live="assertive"
      aria-relevant="additions text"
    >
      {state.flashMessage ? (
        <div
          className="flash"
          role="alert"
          tabIndex={-1}
          onClick={clearFlash}
        >
          {state.flashMessage}
        </div>
      ) : null}

      {/* Approvals are decided in the turn stream; this only announces them. */}
      {approval ? (
        <span className="sr-only" data-approval-id={approval.id}>
          需要你批准：{approval.reason || approval.command || '一次工具调用'}
        </span>
      ) : null}
    </div>
  );
}
