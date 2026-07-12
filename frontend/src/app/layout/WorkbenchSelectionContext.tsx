import { createContext, useContext } from 'react';
import type {
  InspectorTabId,
  SelectedEntity,
} from '../../widgets/runtime-timeline/buildTimeline';

export type WorkbenchSelectionValue = {
  selected: SelectedEntity;
  setSelected: (sel: SelectedEntity) => void;
  inspectorTab: InspectorTabId;
  setInspectorTab: (tab: InspectorTabId) => void;
  /** Process console sheet target (F4); null when closed. */
  consoleProcessId: string | null;
  openProcessConsole: (processId: string) => void;
  closeProcessConsole: () => void;
  /** Runtime activity drawer under the chat (collapsed by default when empty). */
  activityOpen: boolean;
  setActivityOpen: (open: boolean) => void;
  toggleActivity: () => void;
};

const WorkbenchSelectionContext = createContext<WorkbenchSelectionValue | null>(
  null,
);

export { WorkbenchSelectionContext };

export function useWorkbenchSelection(): WorkbenchSelectionValue {
  const ctx = useContext(WorkbenchSelectionContext);
  if (!ctx) {
    throw new Error(
      'useWorkbenchSelection must be used within AppShell / WorkbenchSelectionContext',
    );
  }
  return ctx;
}
