import type { EntityStore, MessageEntity, RunEntity } from '../../../entities';
import type { ChatMessage } from '../../../shared/state/types';
import { runHasTurnEntities } from './turnItems';

/** Run statuses that end a turn without a normal completion. */
const INTERRUPTED_STATUSES = new Set(['interrupted', 'cancelled', 'orphaned']);
const FAILED_STATUSES = new Set([
  'failed',
  'cancelled',
  'interrupted',
  'budget_exceeded',
  'orphaned',
]);

/** A terminal run that failed and says why: the turn needs a host for the notice. */
export function runFailureReason(run: RunEntity | undefined): string | null {
  if (!run || !FAILED_STATUSES.has(String(run.status))) return null;
  return run.error ? String(run.error) : null;
}

function messageEntities(store: EntityStore, run: RunEntity): MessageEntity[] {
  return run.messageIds
    .map((id) => store.messagesById[id])
    .filter((m): m is MessageEntity => Boolean(m));
}

function textMessage(
  entity: MessageEntity,
  runId: string,
): ChatMessage {
  return {
    role: entity.role,
    content: [{ type: 'text', text: entity.text }],
    _runId: runId,
    _messageId: entity.id,
    createdAt: entity.createdAt || undefined,
  };
}

/**
 * The single assistant row of a Run. The Run *is* the turn: thinking, text
 * segments and tool activity render from the EntityStore via TurnStream, so
 * this row only carries what the bubble chrome needs — the copyable answer
 * text, the turn-start timestamp and the interrupted flag.
 */
function assistantRow(store: EntityStore, run: RunEntity): ChatMessage {
  const text = messageEntities(store, run)
    .filter((m) => m.role === 'assistant' && m.text)
    .map((m) => m.text)
    .join('\n\n');
  return {
    role: 'assistant',
    content: text ? [{ type: 'text', text }] : [],
    _runId: run.id,
    createdAt: run.startedAt || run.createdAt || undefined,
    ...(INTERRUPTED_STATUSES.has(String(run.status))
      ? { interrupted: true, status: 'interrupted' }
      : {}),
  };
}

function showsTurn(store: EntityStore, run: RunEntity): boolean {
  return runHasTurnEntities(store, run.id) || runFailureReason(run) !== null;
}

/**
 * Persisted rows first, in database order; rows the server has not sequenced
 * yet (optimistic sends) keep their arrival order after them.
 */
function sortUserRows(rows: ChatMessage[]): ChatMessage[] {
  return rows
    .map((message, index) => ({ message, index }))
    .sort((a, b) => {
      const sa = Number(a.message.sequenceNo);
      const sb = Number(b.message.sequenceNo);
      const fa = Number.isFinite(sa);
      const fb = Number.isFinite(sb);
      if (fa && fb) return sa - sb || a.index - b.index;
      if (fa !== fb) return fa ? -1 : 1;
      return a.index - b.index;
    })
    .map(({ message }) => message);
}

/**
 * Conversation transcript = the user's turns (ChatState) interleaved with one
 * entity-derived assistant row per Run.
 *
 * A user row is linked to its Run by `_runId` (durable from the server, stamped
 * on optimistic rows once create-run answers). A Run whose user row is not in
 * ChatState — started from another tab, say — is appended with the prompt
 * taken from its own user MessageEntity.
 */
export function projectConversationMessages(options: {
  userMessages: ChatMessage[];
  conversationId: string | null;
  store: EntityStore;
  activeRunId: string | null;
}): ChatMessage[] {
  const { userMessages, conversationId, store, activeRunId } = options;

  const runs = Object.values(store.runsById)
    .filter((run): run is RunEntity => {
      if (!run || !conversationId) return false;
      return run.conversationId === conversationId || run.id === activeRunId;
    })
    .sort((a, b) =>
      String(a.startedAt || a.createdAt || a.id).localeCompare(
        String(b.startedAt || b.createdAt || b.id),
      ),
    );
  const runsById = new Map(runs.map((run) => [run.id, run]));

  const result: ChatMessage[] = [];
  const placed = new Set<string>();
  const place = (run: RunEntity) => {
    placed.add(run.id);
    if (showsTurn(store, run)) result.push(assistantRow(store, run));
  };

  for (const user of sortUserRows(userMessages.filter((m) => m.role === 'user'))) {
    result.push(user);
    const run = user._runId != null ? runsById.get(String(user._runId)) : undefined;
    if (run && !placed.has(run.id)) place(run);
  }

  for (const run of runs) {
    if (placed.has(run.id)) continue;
    const prompt = messageEntities(store, run).find(
      (m) => m.role === 'user' && m.text.trim(),
    );
    if (prompt) result.push(textMessage(prompt, run.id));
    place(run);
  }
  return result;
}
