/**
 * Tool Call Panel (plan §19.5) — thin wrapper over ToolExecutionCard list.
 */
import type { ToolExecutionEntity } from '../../entities';
import { ToolExecutionCard } from '../runtime-timeline/cards/ToolExecutionCard';

export function ToolCallPanel({
  tools,
  selectedId,
  onSelect,
  emptyHint = 'No tool calls for this run.',
}: {
  tools: ToolExecutionEntity[];
  selectedId?: string | null;
  onSelect?: (toolId: string) => void;
  emptyHint?: string;
}) {
  if (!tools.length) {
    return <p className="inspector-empty">{emptyHint}</p>;
  }
  return (
    <div className="tool-call-panel" aria-label="Tool calls">
      {tools.map((tool) => (
        <ToolExecutionCard
          key={tool.id}
          tool={tool}
          selected={selectedId === tool.id}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}
