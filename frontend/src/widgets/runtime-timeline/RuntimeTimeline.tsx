import { useMemo } from 'react';
import { useChat } from '../../features/chat/ChatContext';
import {
  buildRunTimeline,
  type SelectedEntity,
  type TimelineItem,
} from './buildTimeline';
import { ToolExecutionCard } from './cards/ToolExecutionCard';
import { ProcessCard } from './cards/ProcessCard';
import { ApprovalCard } from './cards/ApprovalCard';
import { ArtifactCard } from './cards/ArtifactCard';
import { SessionEventCard } from './cards/SessionEventCard';

export function RuntimeTimeline({
  selected,
  onSelect,
  onOpenProcessConsole,
  /** When true, parent drawer owns the heading — skip duplicate chrome. */
  embedded = false,
}: {
  selected: SelectedEntity;
  onSelect: (sel: SelectedEntity) => void;
  onOpenProcessConsole?: (processId: string) => void;
  embedded?: boolean;
}) {
  const { entityStore, activeRunId, activeSessionId, resolveApproval } =
    useChat();

  const items = useMemo(
    () => buildRunTimeline(entityStore, activeRunId),
    [entityStore, activeRunId],
  );

  if (items.length === 0) {
    return (
      <section
        className={`runtime-timeline empty${embedded ? ' embedded' : ''}`}
        aria-label="Runtime activity"
      >
        {!embedded ? (
          <div className="runtime-timeline-head">
            <span className="runtime-timeline-title">Runtime activity</span>
          </div>
        ) : null}
        <p className="runtime-timeline-empty">
          Tool calls, processes, approvals, and artifacts show up here while the
          agent works.
        </p>
      </section>
    );
  }

  function isSelected(item: TimelineItem): boolean {
    if (!selected) return false;
    if (item.kind === 'tool' && selected.kind === 'tool') {
      return item.tool.id === selected.id;
    }
    if (item.kind === 'process' && selected.kind === 'process') {
      return item.process.id === selected.id;
    }
    if (item.kind === 'approval' && selected.kind === 'approval') {
      return item.approval.id === selected.id;
    }
    if (item.kind === 'artifact' && selected.kind === 'artifact') {
      return item.artifact.id === selected.id;
    }
    if (item.kind === 'session' && selected.kind === 'session') {
      return item.id === selected.id;
    }
    return false;
  }

  return (
    <section
      className={`runtime-timeline${embedded ? ' embedded' : ''}`}
      aria-label="Runtime activity"
    >
      {!embedded ? (
        <div className="runtime-timeline-head">
          <span className="runtime-timeline-title">Runtime activity</span>
          <span className="runtime-timeline-count">{items.length}</span>
        </div>
      ) : null}
      <div className="runtime-timeline-list">
        {items.map((item) => {
          switch (item.kind) {
            case 'tool':
              return (
                <ToolExecutionCard
                  key={item.id}
                  tool={item.tool}
                  selected={isSelected(item)}
                  onSelect={(id) => onSelect({ kind: 'tool', id })}
                />
              );
            case 'process':
              return (
                <ProcessCard
                  key={item.id}
                  process={item.process}
                  selected={isSelected(item)}
                  onSelect={(id) => onSelect({ kind: 'process', id })}
                  onOpenConsole={onOpenProcessConsole}
                />
              );
            case 'approval':
              return (
                <ApprovalCard
                  key={item.id}
                  approval={item.approval}
                  selected={isSelected(item)}
                  onSelect={(id) => onSelect({ kind: 'approval', id })}
                  onApprove={(id) => void resolveApproval(id, 'approve')}
                  onReject={(id) => void resolveApproval(id, 'reject')}
                />
              );
            case 'artifact':
              return (
                <ArtifactCard
                  key={item.id}
                  artifact={item.artifact}
                  sessionId={activeSessionId}
                  selected={isSelected(item)}
                  onSelect={(id) => onSelect({ kind: 'artifact', id })}
                />
              );
            case 'session':
              return (
                <SessionEventCard
                  key={item.id}
                  id={item.id}
                  label={item.label}
                  detail={item.detail}
                />
              );
            default:
              return null;
          }
        })}
      </div>
    </section>
  );
}
