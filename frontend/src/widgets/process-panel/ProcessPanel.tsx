/**
 * Process Panel (plan §19.6) — list + open console entry.
 */
import type { ProcessEntity } from '../../entities';
import { ProcessCard } from '../runtime-timeline/cards/ProcessCard';

export function ProcessPanel({
  processes,
  selectedId,
  onSelect,
  onOpenConsole,
  emptyHint = 'No managed processes for this run.',
}: {
  processes: ProcessEntity[];
  selectedId?: string | null;
  onSelect?: (processId: string) => void;
  onOpenConsole?: (processId: string) => void;
  emptyHint?: string;
}) {
  if (!processes.length) {
    return <p className="inspector-empty">{emptyHint}</p>;
  }
  return (
    <div className="process-panel" aria-label="Processes">
      {processes.map((process) => (
        <ProcessCard
          key={process.id}
          process={process}
          selected={selectedId === process.id}
          onSelect={onSelect}
          onOpenConsole={onOpenConsole}
        />
      ))}
    </div>
  );
}
