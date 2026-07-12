import { useChat } from '../../features/chat/ChatContext';

export function FlashZone() {
  const { state, approvePending, rejectPending, clearFlash } = useChat();
  const approval = state.pendingApproval;

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

      {approval ? (
        <div
          className="approval-banner"
          role="alertdialog"
          aria-modal="false"
          data-approval-id={approval.id}
          tabIndex={-1}
        >
          <span id={`approval-label-${approval.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`}>
            {`⚠ Approval required: ${approval.reason || approval.id}`}
          </span>
          <button
            type="button"
            className="btn-approve"
            onClick={() => void approvePending()}
          >
            Approve
          </button>
          <button
            type="button"
            className="btn-reject"
            onClick={() => void rejectPending()}
          >
            Reject
          </button>
        </div>
      ) : null}
    </div>
  );
}
