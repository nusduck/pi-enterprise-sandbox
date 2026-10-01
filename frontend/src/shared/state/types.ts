/** Content part shapes used by the chat UI. */

export type TextPart = { type: 'text'; text: string };

export type ContentPart = TextPart | { type: string; [k: string]: unknown };

/**
 * A row of the conversation transcript: a user turn, or the single assistant
 * row of a Run (whose body renders from the EntityStore, not from this row).
 */
export type ChatMessage = {
  role: 'user' | 'assistant' | string;
  content: ContentPart[];
  attachments?: AttachmentManifestItem[];
  interrupted?: boolean;
  status?: string;
  /** Runtime identity used for stable merge/dedupe; never used as display text. */
  _runId?: string;
  _messageId?: string;
  /** Durable conversation-message order from the server append-only ledger. */
  sequenceNo?: number;
  /** ISO 8601 UTC timestamp supplied by the server. */
  createdAt?: string;
};

export type AttachmentStatus =
  | 'queued'
  | 'uploading'
  | 'uploaded'
  | 'failed'
  | 'removed';

export type AttachmentDraft = {
  localId: string;
  status: AttachmentStatus;
  name: string;
  size: number;
  mimeType: string;
  file: File | Blob | { name?: string; size?: number; type?: string } | null;
  attachmentId: string | null;
  path: string | null;
  idempotencyKey: string;
  error: string | null;
  errorCode: string | null;
  traceId: string | null;
  progress: number;
  abortCtrl: AbortController | null;
};

/** ADR §4.5 attachment metadata on a user message. */
export type AttachmentManifestItem = {
  attachment_id: string | null | undefined;
  filename?: string;
  name: string;
  path: string | null | undefined;
  workspace_path?: string | null;
  mime_type?: string;
  size: number;
  upload_time?: string | null;
};

export type ConversationSummary = {
  id: string;
  title?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
  /** Server-resolved Agent identity for this conversation (immutable). */
  agent_id?: string | null;
  agent_version_id?: string | null;
  agent_version_no?: number | null;
  /**
   * 交付策略（design agent-output-review §2/§8）。`review` = 这个会话绑定的版本要求
   * 交付物人工审核：工作区文件面板不引导用户去点（服务端本来就会 404）。
   */
  delivery_mode?: string | null;
  model_policy?: { fixed_model_id: string | null } | null;
  sandbox_session_id?: string | null;
  messages?: Array<{
    role?: string;
    content?: unknown;
    message_id?: string | number | null;
    messageId?: string | number | null;
    run_id?: string | number | null;
    runId?: string | number | null;
    sequence_no?: string | number | null;
    sequenceNo?: string | number | null;
    created_at?: string | null;
    createdAt?: string | null;
    [k: string]: unknown;
  }>;
  [k: string]: unknown;
};

export type Artifact = {
  artifact_id?: string;
  id?: string;
  name?: string;
  path?: string;
  size?: number;
  [k: string]: unknown;
};

export type ChatState = {
  messages: ChatMessage[];
  isStreaming: boolean;
  abortCtrl: AbortController | null;
  sessionId: string | null;
  conversationId: string | null;
  /** Conversation whose Run timeline must finish restoring before display. */
  restoringConversationId: string | null;
  conversations: ConversationSummary[];
  artifacts: Artifact[];
  attachments: AttachmentDraft[];
  traceId: string | null;
  sidebarOpen: boolean;
  streamGeneration: number;
  /** UI status label in header */
  statusLabel: string;
  statusColor: string;
  /** Ephemeral flash errors */
  flashMessage: string | null;
  /** True once the initial browser session check has completed. */
  authReady: boolean;
  /** Auth user label */
  authUser: { username?: string; [k: string]: unknown } | null;
};

export type AttachmentLimits = {
  maxCount: number;
  maxFileBytes: number;
  maxTurnBytes: number;
};
