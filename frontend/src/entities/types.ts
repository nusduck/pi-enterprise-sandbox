/**
 * Normalized entity types for Agent Runtime Workbench (F2 / ADR 0003 §13).
 * Relationships are ID-based; runtime content has no parallel chat-state copy.
 */

// ── Status enums ────────────────────────────────

export type RunStatus =
  | 'queued'
  | 'restoring_session'
  | 'running'
  | 'waiting_approval'
  | 'waiting_input'
  | 'cancel_requested'
  | 'cancelled'
  | 'succeeded'
  | 'failed'
  | 'interrupted'
  | 'budget_exceeded'
  | 'orphaned';

export type ToolExecutionStatus =
  | 'prepared'
  | 'waiting_approval'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ProcessStatus =
  | 'created'
  | 'running'
  | 'waiting_input'
  | 'completed'
  | 'failed'
  | 'cancel_requested'
  | 'cancelled'
  | 'timeout'
  | 'orphaned';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export type AgentSessionStatus = 'active' | 'compacted' | 'failed' | 'archived';

export type MessageRole = 'user' | 'assistant' | 'system';

export type MessageStatus = 'streaming' | 'complete' | 'interrupted' | 'error';

// ── Entities ────────────────────────────────────

export type ConversationEntity = {
  id: string;
  title: string;
  agentSessionId: string | null;
  sandboxSessionId: string | null;
  runIds: string[];
  messageIds: string[];
  createdAt: string | null;
  updatedAt: string | null;
};

export type AgentSessionEntity = {
  id: string;
  conversationId: string;
  sandboxSessionId: string | null;
  workspaceId: string | null;
  status: AgentSessionStatus;
  modelId: string | null;
  runIds: string[];
  createdAt: string | null;
  updatedAt: string | null;
};

/** Run budget usage counters (ADR §4.9) — present when backend provides usage. */
export type RunBudgetUsage = {
  steps?: number;
  tool_calls?: number;
  llm_tokens?: number;
  cost?: number;
  consecutive_tool_failures?: number;
  processes?: number;
  duration_seconds?: number;
  started_at?: number;
  [key: string]: unknown;
};

export type RunBudgetLimits = {
  max_steps?: number | null;
  max_tool_calls?: number | null;
  max_run_duration?: number | null;
  max_llm_tokens?: number | null;
  max_cost?: number | null;
  max_consecutive_tool_failures?: number | null;
  max_processes?: number | null;
  [key: string]: unknown;
};

export type RunEntity = {
  id: string;
  conversationId: string | null;
  agentSessionId: string | null;
  sandboxSessionId: string | null;
  status: RunStatus;
  /** Ordered child entity IDs (not nested payloads). */
  messageIds: string[];
  toolExecutionIds: string[];
  processIds: string[];
  approvalIds: string[];
  artifactIds: string[];
  datasetIds: string[];
  attachmentIds: string[];
  /** Trace span ids under this run (Trace Panel). */
  traceSpanIds: string[];
  /** Highest applied event sequence for this run. */
  lastSequence: number;
  /** Last applied event_id (for Last-Event-ID resume). */
  lastEventId: string | null;
  /** End-to-end request trace carried by this run. */
  traceId: string | null;
  error: string | null;
  /** Live budget usage when backend/SSE provides it (F4). */
  budgetUsage: RunBudgetUsage | null;
  /** Budget limits for this run (F4). */
  budgetLimits: RunBudgetLimits | null;
  /** 'warning' | 'exceeded' | null */
  budgetWarning: string | null;
  pendingInput: {
    interactionId: string;
    interactionType: string;
    title: string;
    message: string | null;
    options: string[];
  } | null;
  contextUsage: {
    tokens: number | null;
    contextWindow: number | null;
    percent: number | null;
    warning: boolean;
  } | null;
  compactionStatus: 'idle' | 'running' | 'completed' | 'failed';
  compactionError: string | null;
  taskPlan: Array<{
    taskId: string;
    content: string;
    status: string;
    evidence: string | null;
  }>;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type MessageEntity = {
  id: string;
  runId: string | null;
  conversationId: string | null;
  role: MessageRole;
  /** Accumulated text body (deltas append here). */
  text: string;
  status: MessageStatus;
  createdAt: string | null;
  updatedAt: string | null;
};

/** Where a tool call is executed (plan §19.5). */
export type ToolSource = 'sandbox' | 'mcp' | 'internal' | 'unknown';

export type ToolExecutionEntity = {
  id: string;
  runId: string;
  name: string;
  status: ToolExecutionStatus;
  /** Sandbox / MCP / Internal — backend-supplied when available. */
  source: ToolSource;
  input: unknown;
  result: unknown;
  isError: boolean;
  approvalId: string | null;
  processId: string | null;
  summary: string | null;
  /** Trace span for this tool when present. */
  spanId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type ProcessEntity = {
  id: string;
  runId: string;
  toolExecutionId: string | null;
  status: ProcessStatus;
  command: string | null;
  stdout: string;
  stderr: string;
  /** Cursor for log resume / process.output (plan §19.6). */
  cursor: number | null;
  /** True when live buffers were truncated to cap memory growth. */
  logTruncated: boolean;
  exitCode: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type ApprovalEntity = {
  id: string;
  runId: string;
  toolExecutionId: string | null;
  /** Durable Sandbox approval scope; distinct SDK tool_call_ids may share it. */
  idempotencyKey: string | null;
  status: ApprovalStatus;
  reason: string;
  command: string | null;
  /** Risk / policy note from backend (plan §19.9). */
  risk: string | null;
  expiresAt: string | null;
  createdAt: string | null;
  decidedAt: string | null;
};

/**
 * Explicit user-deliverable only (submit_artifact → artifact.ready).
 * Intermediate workspace writes never become ArtifactEntity rows.
 */
export type ArtifactEntity = {
  id: string;
  runId: string | null;
  sessionId: string | null;
  name: string;
  path: string | null;
  mimeType: string | null;
  size: number | null;
  sha256: string | null;
  description: string | null;
  /** Always submit_artifact for platform artifacts. */
  source: 'submit_artifact';
  createdAt: string | null;
};

export type DatasetStatus =
  | 'uploading'
  | 'ready'
  | 'failed'
  | 'removed';

/** User dataset streamed into the session workspace (plan §19.7). */
export type DatasetEntity = {
  id: string;
  conversationId: string | null;
  sessionId: string | null;
  runId: string | null;
  name: string;
  path: string | null;
  size: number | null;
  mimeType: string | null;
  sha256: string | null;
  status: DatasetStatus;
  /** 0–100 when progress events supply it. */
  progress: number | null;
  agentVisible: boolean;
  createdAt: string | null;
  updatedAt: string | null;
};

/** Trace span node for the Trace Panel tree (plan §19.10). */
export type TraceSpanKind =
  | 'run'
  | 'queue'
  | 'model'
  | 'tool'
  | 'sandbox'
  | 'mcp'
  | 'artifact'
  | 'session'
  | 'a2a'
  | 'error'
  | 'other';

export type TraceSpanEntity = {
  id: string;
  runId: string;
  orgId: string | null;
  userId: string | null;
  parentId: string | null;
  kind: TraceSpanKind;
  name: string;
  status: 'running' | 'ok' | 'error' | 'cancelled';
  spanId: string | null;
  durationMs: number | null;
  tokens: number | null;
  cost: number | null;
  error: string | null;
  metadata: Record<string, unknown> | null;
  startedAt: string | null;
  finishedAt: string | null;
};

export type AttachmentEntity = {
  id: string;
  conversationId: string | null;
  runId: string | null;
  name: string;
  path: string | null;
  size: number;
  mimeType: string | null;
  status: 'queued' | 'uploading' | 'uploaded' | 'failed' | 'removed';
  createdAt: string | null;
};

// ── Normalized store shape ──────────────────────

export type EntityMap<T> = Record<string, T>;

export type EntityStore = {
  conversationsById: EntityMap<ConversationEntity>;
  agentSessionsById: EntityMap<AgentSessionEntity>;
  runsById: EntityMap<RunEntity>;
  messagesById: EntityMap<MessageEntity>;
  toolExecutionsById: EntityMap<ToolExecutionEntity>;
  processesById: EntityMap<ProcessEntity>;
  approvalsById: EntityMap<ApprovalEntity>;
  artifactsById: EntityMap<ArtifactEntity>;
  datasetsById: EntityMap<DatasetEntity>;
  traceSpansById: EntityMap<TraceSpanEntity>;
  attachmentsById: EntityMap<AttachmentEntity>;
  /** Currently focused conversation in the UI (does not cancel background runs). */
  activeConversationId: string | null;
  /** Currently focused run for the active conversation timeline. */
  activeRunId: string | null;
};

export type ConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'closed'
  | 'error';

/** Per-run SSE connection bookkeeping (ADR 0003 §14). */
export type RunSSEState = {
  runId: string;
  lastEventId: string | null;
  lastSequence: number;
  connectionStatus: ConnectionStatus;
  retryCount: number;
  /** Seen event_ids for dedupe across reconnects. */
  seenEventIds: Set<string>;
};
