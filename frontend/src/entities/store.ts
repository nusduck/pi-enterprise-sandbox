/**
 * Normalized entity store helpers (F2 / ADR 0003 §13).
 * Pure functions — no React, no I/O.
 */
import type {
  AgentSessionEntity,
  ApprovalEntity,
  ArtifactEntity,
  AttachmentEntity,
  ConversationEntity,
  EntityMap,
  EntityStore,
  MessageEntity,
  ProcessEntity,
  RunEntity,
  ToolExecutionEntity,
} from './types';

export const EMPTY_ENTITY_STORE: Readonly<EntityStore> = Object.freeze({
  conversationsById: Object.freeze({}),
  agentSessionsById: Object.freeze({}),
  runsById: Object.freeze({}),
  messagesById: Object.freeze({}),
  toolExecutionsById: Object.freeze({}),
  processesById: Object.freeze({}),
  approvalsById: Object.freeze({}),
  artifactsById: Object.freeze({}),
  attachmentsById: Object.freeze({}),
  activeConversationId: null,
  activeRunId: null,
});

export function createEntityStore(
  initial: Partial<EntityStore> = {},
): EntityStore {
  return {
    conversationsById: { ...(initial.conversationsById || {}) },
    agentSessionsById: { ...(initial.agentSessionsById || {}) },
    runsById: { ...(initial.runsById || {}) },
    messagesById: { ...(initial.messagesById || {}) },
    toolExecutionsById: { ...(initial.toolExecutionsById || {}) },
    processesById: { ...(initial.processesById || {}) },
    approvalsById: { ...(initial.approvalsById || {}) },
    artifactsById: { ...(initial.artifactsById || {}) },
    attachmentsById: { ...(initial.attachmentsById || {}) },
    activeConversationId:
      initial.activeConversationId !== undefined
        ? initial.activeConversationId
        : null,
    activeRunId: initial.activeRunId !== undefined ? initial.activeRunId : null,
  };
}

/** Shallow-clone the store (maps are new objects; entity values are shared). */
export function cloneEntityStore(store: EntityStore): EntityStore {
  return {
    conversationsById: { ...store.conversationsById },
    agentSessionsById: { ...store.agentSessionsById },
    runsById: { ...store.runsById },
    messagesById: { ...store.messagesById },
    toolExecutionsById: { ...store.toolExecutionsById },
    processesById: { ...store.processesById },
    approvalsById: { ...store.approvalsById },
    artifactsById: { ...store.artifactsById },
    attachmentsById: { ...store.attachmentsById },
    activeConversationId: store.activeConversationId,
    activeRunId: store.activeRunId,
  };
}

function upsert<T extends { id: string }>(
  map: EntityMap<T>,
  entity: T,
): EntityMap<T> {
  return { ...map, [entity.id]: entity };
}

function appendUnique(ids: string[], id: string): string[] {
  if (ids.includes(id)) return ids;
  return [...ids, id];
}

// ── Factory helpers ─────────────────────────────

export function createConversation(
  partial: Partial<ConversationEntity> & { id: string },
): ConversationEntity {
  return {
    title: 'New chat',
    agentSessionId: null,
    sandboxSessionId: null,
    runIds: [],
    messageIds: [],
    createdAt: null,
    updatedAt: null,
    ...partial,
  };
}

export function createAgentSession(
  partial: Partial<AgentSessionEntity> & { id: string; conversationId: string },
): AgentSessionEntity {
  return {
    sandboxSessionId: null,
    workspaceId: null,
    status: 'active',
    modelId: null,
    runIds: [],
    createdAt: null,
    updatedAt: null,
    ...partial,
  };
}

export function createRun(
  partial: Partial<RunEntity> & { id: string },
): RunEntity {
  return {
    conversationId: null,
    agentSessionId: null,
    sandboxSessionId: null,
    status: 'queued',
    messageIds: [],
    toolExecutionIds: [],
    processIds: [],
    approvalIds: [],
    artifactIds: [],
    attachmentIds: [],
    lastSequence: 0,
    lastEventId: null,
    traceId: null,
    error: null,
    budgetUsage: null,
    budgetLimits: null,
    budgetWarning: null,
    pendingInput: null,
    contextUsage: null,
    compactionStatus: 'idle',
    compactionError: null,
    taskPlan: [],
    startedAt: null,
    finishedAt: null,
    createdAt: null,
    updatedAt: null,
    ...partial,
  };
}

export function createMessage(
  partial: Partial<MessageEntity> & { id: string },
): MessageEntity {
  return {
    runId: null,
    conversationId: null,
    role: 'assistant',
    text: '',
    status: 'streaming',
    createdAt: null,
    updatedAt: null,
    ...partial,
  };
}

export function createToolExecution(
  partial: Partial<ToolExecutionEntity> & { id: string; runId: string },
): ToolExecutionEntity {
  return {
    name: 'tool',
    status: 'prepared',
    input: null,
    result: null,
    isError: false,
    approvalId: null,
    processId: null,
    summary: null,
    createdAt: null,
    updatedAt: null,
    ...partial,
  };
}

export function createProcess(
  partial: Partial<ProcessEntity> & { id: string; runId: string },
): ProcessEntity {
  return {
    toolExecutionId: null,
    status: 'created',
    command: null,
    stdout: '',
    stderr: '',
    exitCode: null,
    startedAt: null,
    finishedAt: null,
    createdAt: null,
    updatedAt: null,
    ...partial,
  };
}

export function createApproval(
  partial: Partial<ApprovalEntity> & { id: string; runId: string },
): ApprovalEntity {
  return {
    toolExecutionId: null,
    idempotencyKey: null,
    status: 'pending',
    reason: '',
    command: null,
    createdAt: null,
    decidedAt: null,
    ...partial,
  };
}

export function createArtifact(
  partial: Partial<ArtifactEntity> & { id: string },
): ArtifactEntity {
  return {
    runId: null,
    sessionId: null,
    name: 'file',
    path: null,
    mimeType: null,
    size: null,
    createdAt: null,
    ...partial,
  };
}

export function createAttachment(
  partial: Partial<AttachmentEntity> & { id: string },
): AttachmentEntity {
  return {
    conversationId: null,
    runId: null,
    name: 'file',
    path: null,
    size: 0,
    mimeType: null,
    status: 'queued',
    createdAt: null,
    ...partial,
  };
}

// ── Upsert helpers (return new store) ───────────

export function upsertConversation(
  store: EntityStore,
  entity: ConversationEntity,
): EntityStore {
  const next = cloneEntityStore(store);
  next.conversationsById = upsert(next.conversationsById, entity);
  return next;
}

export function upsertAgentSession(
  store: EntityStore,
  entity: AgentSessionEntity,
): EntityStore {
  const next = cloneEntityStore(store);
  next.agentSessionsById = upsert(next.agentSessionsById, entity);
  return next;
}

export function upsertRun(store: EntityStore, entity: RunEntity): EntityStore {
  const next = cloneEntityStore(store);
  next.runsById = upsert(next.runsById, entity);

  // Link run → conversation
  if (entity.conversationId) {
    const conv =
      next.conversationsById[entity.conversationId] ||
      createConversation({ id: entity.conversationId });
    next.conversationsById = upsert(next.conversationsById, {
      ...conv,
      runIds: appendUnique(conv.runIds, entity.id),
      sandboxSessionId: entity.sandboxSessionId || conv.sandboxSessionId,
      agentSessionId: entity.agentSessionId || conv.agentSessionId,
    });
  }

  // Link run → agent session
  if (entity.agentSessionId) {
    const sess = next.agentSessionsById[entity.agentSessionId];
    if (sess) {
      next.agentSessionsById = upsert(next.agentSessionsById, {
        ...sess,
        runIds: appendUnique(sess.runIds, entity.id),
      });
    }
  }

  return next;
}

export function upsertMessage(
  store: EntityStore,
  entity: MessageEntity,
): EntityStore {
  const next = cloneEntityStore(store);
  next.messagesById = upsert(next.messagesById, entity);

  if (entity.runId) {
    const run = next.runsById[entity.runId];
    if (run) {
      next.runsById = upsert(next.runsById, {
        ...run,
        messageIds: appendUnique(run.messageIds, entity.id),
      });
    }
  }

  if (entity.conversationId) {
    const conv = next.conversationsById[entity.conversationId];
    if (conv) {
      next.conversationsById = upsert(next.conversationsById, {
        ...conv,
        messageIds: appendUnique(conv.messageIds, entity.id),
      });
    }
  }

  return next;
}

export function upsertToolExecution(
  store: EntityStore,
  entity: ToolExecutionEntity,
): EntityStore {
  const next = cloneEntityStore(store);
  next.toolExecutionsById = upsert(next.toolExecutionsById, entity);
  const run = next.runsById[entity.runId];
  if (run) {
    next.runsById = upsert(next.runsById, {
      ...run,
      toolExecutionIds: appendUnique(run.toolExecutionIds, entity.id),
    });
  }
  return next;
}

export function upsertProcess(
  store: EntityStore,
  entity: ProcessEntity,
): EntityStore {
  const next = cloneEntityStore(store);
  next.processesById = upsert(next.processesById, entity);
  const run = next.runsById[entity.runId];
  if (run) {
    next.runsById = upsert(next.runsById, {
      ...run,
      processIds: appendUnique(run.processIds, entity.id),
    });
  }
  return next;
}

export function upsertApproval(
  store: EntityStore,
  entity: ApprovalEntity,
): EntityStore {
  const next = cloneEntityStore(store);
  next.approvalsById = upsert(next.approvalsById, entity);
  const run = next.runsById[entity.runId];
  if (run) {
    next.runsById = upsert(next.runsById, {
      ...run,
      approvalIds: appendUnique(run.approvalIds, entity.id),
    });
  }
  return next;
}

export function upsertArtifact(
  store: EntityStore,
  entity: ArtifactEntity,
): EntityStore {
  const next = cloneEntityStore(store);
  next.artifactsById = upsert(next.artifactsById, entity);
  if (entity.runId) {
    const run = next.runsById[entity.runId];
    if (run) {
      next.runsById = upsert(next.runsById, {
        ...run,
        artifactIds: appendUnique(run.artifactIds, entity.id),
      });
    }
  }
  return next;
}

export function upsertAttachment(
  store: EntityStore,
  entity: AttachmentEntity,
): EntityStore {
  const next = cloneEntityStore(store);
  next.attachmentsById = upsert(next.attachmentsById, entity);
  if (entity.runId) {
    const run = next.runsById[entity.runId];
    if (run) {
      next.runsById = upsert(next.runsById, {
        ...run,
        attachmentIds: appendUnique(run.attachmentIds, entity.id),
      });
    }
  }
  return next;
}

// ── Selectors ───────────────────────────────────

export function getRun(store: EntityStore, runId: string): RunEntity | null {
  return store.runsById[runId] || null;
}

export function getActiveRun(store: EntityStore): RunEntity | null {
  if (!store.activeRunId) return null;
  return store.runsById[store.activeRunId] || null;
}

export function listRunsForConversation(
  store: EntityStore,
  conversationId: string,
): RunEntity[] {
  return Object.values(store.runsById).filter(
    (r) => r.conversationId === conversationId,
  );
}

export function listActiveRuns(store: EntityStore): RunEntity[] {
  const terminal = new Set([
    'succeeded',
    'failed',
    'cancelled',
    'interrupted',
    'budget_exceeded',
    'orphaned',
  ]);
  return Object.values(store.runsById).filter((r) => !terminal.has(r.status));
}

export function getRunMessages(
  store: EntityStore,
  runId: string,
): MessageEntity[] {
  const run = store.runsById[runId];
  if (!run) return [];
  return run.messageIds
    .map((id) => store.messagesById[id])
    .filter((m): m is MessageEntity => Boolean(m));
}

export function getRunToolExecutions(
  store: EntityStore,
  runId: string,
): ToolExecutionEntity[] {
  const run = store.runsById[runId];
  if (!run) return [];
  return run.toolExecutionIds
    .map((id) => store.toolExecutionsById[id])
    .filter((t): t is ToolExecutionEntity => Boolean(t));
}

export function getRunProcesses(
  store: EntityStore,
  runId: string,
): ProcessEntity[] {
  const run = store.runsById[runId];
  if (!run) return [];
  return run.processIds
    .map((id) => store.processesById[id])
    .filter((p): p is ProcessEntity => Boolean(p));
}

export function getRunApprovals(
  store: EntityStore,
  runId: string,
): ApprovalEntity[] {
  const run = store.runsById[runId];
  if (!run) return [];
  return run.approvalIds
    .map((id) => store.approvalsById[id])
    .filter((a): a is ApprovalEntity => Boolean(a));
}

export function getRunArtifacts(
  store: EntityStore,
  runId: string,
): ArtifactEntity[] {
  const run = store.runsById[runId];
  if (!run) return [];
  return run.artifactIds
    .map((id) => store.artifactsById[id])
    .filter((a): a is ArtifactEntity => Boolean(a));
}

/**
 * Switch the active conversation focus without touching run SSE connections.
 * Background runs keep streaming into the entity store.
 */
export function setActiveConversation(
  store: EntityStore,
  conversationId: string | null,
  opts: { activeRunId?: string | null } = {},
): EntityStore {
  const next = cloneEntityStore(store);
  next.activeConversationId = conversationId;
  if (opts.activeRunId !== undefined) {
    next.activeRunId = opts.activeRunId;
  } else if (conversationId) {
    // Focus the latest run for this conversation if any
    const runs = listRunsForConversation(next, conversationId);
    next.activeRunId = runs.length ? runs[runs.length - 1].id : null;
  } else {
    next.activeRunId = null;
  }
  return next;
}

/** Terminal run statuses — SSE manager should close after these. */
export function isTerminalRunStatus(status: string): boolean {
  return (
    status === 'succeeded' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'interrupted' ||
    status === 'budget_exceeded' ||
    status === 'orphaned'
  );
}
