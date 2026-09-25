/**
 * Linear turn projection: one Run → the ordered items the conversation stream
 * renders (thinking, text segments, grouped tool calls, sub-tasks, …).
 *
 * Order comes from `seq`, the Run event sequence at which each entity first
 * appeared, so live SSE and refreshed history (same reducer) project the same
 * list. Entities without a sequence (snapshot-only rows) sort after sequenced
 * ones by creation time.
 */
import { isTerminalRunStatus } from '../../../entities/store';
import type {
  EntityStore,
  MessageEntity,
  ToolExecutionEntity,
} from '../../../entities/types';
import { isAskUserToolName } from '../../../widgets/runtime-steps/interactionFields';
import { isSpawnSubagentToolName } from '../../../widgets/runtime-steps/subagentFields';
import { isTodoToolName } from '../../../widgets/runtime-steps/taskStateFields';

export type TurnItem =
  | { kind: 'thinking'; seq: number | null; message: MessageEntity }
  | { kind: 'text'; seq: number | null; message: MessageEntity }
  /**
   * Adjacent ordinary tool calls (read, bash, grep, mcp__*, …) shown as one
   * line. Turns that only thought before calling more tools fold in as steps,
   * so the group is not split into "thinking / ran 2 commands / thinking …".
   */
  | { kind: 'tools'; seq: number | null; tools: ToolExecutionEntity[]; steps: ToolStep[] }
  /** Adjacent `subagent` / `delegate_to_agent` calls shown as one card. */
  | { kind: 'subtasks'; seq: number | null; tools: ToolExecutionEntity[] }
  | { kind: 'remote'; seq: number | null; tool: ToolExecutionEntity }
  | { kind: 'question'; seq: number | null; tool: ToolExecutionEntity }
  /** Positioned at the first todo call of the Run; shows the latest list. */
  | { kind: 'todo'; seq: number | null; tool: ToolExecutionEntity }
  /** Background job plus the job_output / job_kill calls that refer to it. */
  | { kind: 'job'; seq: number | null; jobId: string | null; tool: ToolExecutionEntity; related: ToolExecutionEntity[] }
  | { kind: 'artifact'; seq: number | null; tool: ToolExecutionEntity; artifactId: string | null };

export type ToolStep =
  | { kind: 'tool'; tool: ToolExecutionEntity }
  | { kind: 'thinking'; message: MessageEntity };

type Entry =
  | { type: 'message'; seq: number | null; at: string | null; message: MessageEntity }
  | { type: 'tool'; seq: number | null; at: string | null; tool: ToolExecutionEntity };

const REMOTE_DELEGATE = 'delegate_to_remote_agent';
const ARTIFACT_TOOL = 'submit_artifact';
const JOB_FOLLOW_UP = new Set(['job_output', 'job_kill', 'job_list']);

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Tool results arrive as `{ value, content, isError }` or as the bare value. */
function resultValue(result: unknown): Record<string, unknown> | null {
  const outer = record(result);
  return record(outer?.value) || outer;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

export function backgroundJobId(tool: ToolExecutionEntity): string | null {
  if (tool.name !== 'bash') return null;
  const value = resultValue(tool.result);
  if (value?.kind === 'background') return str(value.jobId) || str(value.job_id);
  return record(tool.input)?.run_in_background === true ? '' : null;
}

function referencedJobId(tool: ToolExecutionEntity): string | null {
  const input = record(tool.input);
  return str(input?.job_id) || str(input?.jobId);
}

function artifactId(tool: ToolExecutionEntity): string | null {
  const value = resultValue(tool.result);
  return str(value?.artifact_id) || str(value?.artifactId);
}

function compareEntries(a: Entry, b: Entry): number {
  if (a.seq != null && b.seq != null) return a.seq - b.seq;
  if (a.seq != null) return -1;
  if (b.seq != null) return 1;
  return String(a.at || '').localeCompare(String(b.at || ''));
}

function runEntries(store: EntityStore, runId: string): Entry[] {
  const entries: Entry[] = [];
  for (const message of Object.values(store.messagesById)) {
    if (message.runId !== runId || message.role !== 'assistant') continue;
    entries.push({ type: 'message', seq: message.seq, at: message.createdAt, message });
  }
  for (const tool of Object.values(store.toolExecutionsById)) {
    if (tool.runId !== runId) continue;
    entries.push({ type: 'tool', seq: tool.seq, at: tool.createdAt, tool });
  }
  return entries.sort(compareEntries);
}

export function projectTurnItems(store: EntityStore, runId: string): TurnItem[] {
  const entries = runEntries(store, runId);
  const todoCalls = entries.filter(
    (e): e is Extract<Entry, { type: 'tool' }> => e.type === 'tool' && isTodoToolName(e.tool.name),
  );
  const latestTodo = todoCalls.length ? todoCalls[todoCalls.length - 1].tool : null;

  const items: TurnItem[] = [];
  const jobs = new Map<string, Extract<TurnItem, { kind: 'job' }>>();
  let todoPlaced = false;
  // A turn that only thought (no text yet) waits here: if ordinary tools follow
  // it joins their group as a step, otherwise it stands alone.
  let pending: { seq: number | null; message: MessageEntity } | null = null;
  const flush = () => {
    if (pending) items.push({ kind: 'thinking', seq: pending.seq, message: pending.message });
    pending = null;
  };

  for (const entry of entries) {
    if (entry.type === 'message') {
      const { message } = entry;
      flush();
      if (message.thinking && !message.text) {
        pending = { seq: entry.seq, message };
        continue;
      }
      if (message.thinking) items.push({ kind: 'thinking', seq: entry.seq, message });
      if (message.text) items.push({ kind: 'text', seq: entry.seq, message });
      continue;
    }

    const { tool } = entry;

    if (isTodoToolName(tool.name)) {
      if (!todoPlaced && latestTodo) {
        items.push({ kind: 'todo', seq: entry.seq, tool: latestTodo });
        todoPlaced = true;
      }
      continue;
    }

    if (JOB_FOLLOW_UP.has(tool.name)) {
      const target = jobs.get(referencedJobId(tool) || '');
      if (target) {
        target.related.push(tool);
        continue;
      }
    }

    if (!isOrdinaryTool(tool)) flush();
    const last = items[items.length - 1];

    const jobId = backgroundJobId(tool);
    if (jobId != null) {
      const item: Extract<TurnItem, { kind: 'job' }> = {
        kind: 'job', seq: entry.seq, jobId: jobId || null, tool, related: [],
      };
      if (jobId) jobs.set(jobId, item);
      items.push(item);
      continue;
    }

    if (isSpawnSubagentToolName(tool.name)) {
      if (last?.kind === 'subtasks') last.tools.push(tool);
      else items.push({ kind: 'subtasks', seq: entry.seq, tools: [tool] });
    } else if (tool.name === REMOTE_DELEGATE) {
      items.push({ kind: 'remote', seq: entry.seq, tool });
    } else if (isAskUserToolName(tool.name)) {
      items.push({ kind: 'question', seq: entry.seq, tool });
    } else if (tool.name === ARTIFACT_TOOL) {
      items.push({ kind: 'artifact', seq: entry.seq, tool, artifactId: artifactId(tool) });
    } else {
      const steps: ToolStep[] = pending ? [{ kind: 'thinking', message: pending.message }] : [];
      steps.push({ kind: 'tool', tool });
      if (last?.kind === 'tools') {
        last.tools.push(tool);
        last.steps.push(...steps);
      } else {
        items.push({ kind: 'tools', seq: pending?.seq ?? entry.seq, tools: [tool], steps });
      }
      pending = null;
    }
  }
  flush();
  return items;
}

function isOrdinaryTool(tool: ToolExecutionEntity): boolean {
  return !isSpawnSubagentToolName(tool.name)
    && tool.name !== REMOTE_DELEGATE
    && !isAskUserToolName(tool.name)
    && tool.name !== ARTIFACT_TOOL
    && !isTodoToolName(tool.name)
    && !JOB_FOLLOW_UP.has(tool.name)
    && backgroundJobId(tool) == null;
}

/**
 * True when this Run should render as a turn stream: it has replayed or live
 * entities, or it is still running. A turn can consist of nothing but a tool
 * call parked at an approval gate (no text, tool not started yet), so pending
 * approvals count too — otherwise the approval card would have no host.
 */
export function runHasTurnEntities(store: EntityStore, runId: string | null): boolean {
  if (!runId) return false;
  const run = store.runsById[runId];
  if (!run) return false;
  return run.messageIds.some((id) => store.messagesById[id]?.role === 'assistant')
    || run.toolExecutionIds.length > 0
    || run.approvalIds.length > 0
    || !isTerminalRunStatus(String(run.status));
}
