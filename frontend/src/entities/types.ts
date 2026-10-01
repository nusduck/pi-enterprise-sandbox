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

export type ApprovalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'cancelled';

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
  /** Model that served this run, from the Agent Run row (`model_id`). */
  modelId: string | null;
  error: string | null;
  pendingInput: {
    interactionId: string;
    interactionType: string;
    title: string;
    message: string | null;
    options: string[];
  } | null;
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
  /** Provider-emitted reasoning/thinking content (never synthesized). */
  thinking: string;
  thinkingStatus: 'idle' | 'streaming' | 'complete';
  status: MessageStatus;
  /**
   * Run event sequence at which this entity first appeared. Orders thinking,
   * text segments and tool calls inside one turn; null for snapshot-only rows.
   */
  seq: number | null;
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
  /**
   * Run event sequence at which this entity first appeared. Orders thinking,
   * text segments and tool calls inside one turn; null for snapshot-only rows.
   */
  seq: number | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type ProcessEntity = {
  id: string;
  runId: string;
  /**
   * Sandbox session that owns the process. Managed processes outlive the run
   * that started them, so the authoritative list is fetched per session.
   */
  sessionId: string | null;
  toolExecutionId: string | null;
  status: ProcessStatus;
  command: string | null;
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
  /**
   * 交付物审核状态（design `agent-output-review.md` §4 / §8）。
   *
   * - `pending`：review 会话里刚提交、还没审（卡片显示「已提交审核」，**没有下载按钮**）；
   * - `released`：审核通过（`revised` 为真时标注「经审核员修订」）；
   * - `rejected`：驳回（卡片显示反馈）；
   * - `null`：direct 会话的普通交付物（既有行为，不显示任何审核字样）。
   */
  reviewStatus: 'pending' | 'released' | 'rejected' | null;
  /** 通过时这一版是不是审核员的修订版（服务端在 `artifact.released` 里给）。 */
  reviewRevised: boolean;
  /** 驳回反馈（`review.rejected` 事件负载）。 */
  reviewFeedback: string | null;
  /** 通过时实际放行的 artifact id；有修订时与 `id`（智能体提交的原件）不同，下载走它。 */
  reviewReleasedId: string | null;
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

// ── Normalized store shape ──────────────────────

export type EntityMap<T> = Record<string, T>;

/**
 * 后台进程列表的拉取状态，按 sandbox session 记。
 *
 * 服务端在 review 工作区对进程接口返回 404（design agent-output-review E6）；
 * **拉取失败不能渲染成空状态**（AGENTS.md §3），所以列表之外还要记住「这次是失败了
 * 还是真的没有」。
 */
export type ProcessListState = 'loading' | 'ready' | 'error';

export type EntityStore = {
  conversationsById: EntityMap<ConversationEntity>;
  runsById: EntityMap<RunEntity>;
  messagesById: EntityMap<MessageEntity>;
  toolExecutionsById: EntityMap<ToolExecutionEntity>;
  processesById: EntityMap<ProcessEntity>;
  /** 每个 session 的进程列表拉取状态（T3）。 */
  processListStateById: Record<string, ProcessListState>;
  approvalsById: EntityMap<ApprovalEntity>;
  artifactsById: EntityMap<ArtifactEntity>;
  datasetsById: EntityMap<DatasetEntity>;
  traceSpansById: EntityMap<TraceSpanEntity>;
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
