/** Content part shapes used by the chat UI. */

export type TextPart = { type: 'text'; text: string };

export type ToolUsePart = {
  type: 'tool_use';
  name: string;
  input?: unknown;
  status?: 'running' | 'complete' | string;
  isError?: boolean;
  result?: unknown;
};

export type ContentPart = TextPart | ToolUsePart | { type: string; [k: string]: unknown };

export type FileLink = {
  name: string;
  url: string;
  path?: string;
  artifact_id?: string;
  mime_type?: string;
  size?: number;
};

export type ChatMessage = {
  role: 'user' | 'assistant' | string;
  content: ContentPart[];
  attachments?: AttachmentManifestItem[];
  interrupted?: boolean;
  status?: string;
  stopReason?: string;
  _fileLinks?: FileLink[];
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
  title?: string;
  updated_at?: string;
  created_at?: string;
  sandbox_session_id?: string | null;
  messages?: Array<{ role?: string; content?: unknown }>;
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

export type PendingTool = {
  id?: string;
  name?: string;
  args?: unknown;
} | null;

export type PendingApproval = {
  id: string;
  reason?: string;
} | null;

export type ChatState = {
  messages: ChatMessage[];
  isStreaming: boolean;
  abortCtrl: AbortController | null;
  currentMsg: ChatMessage | null;
  sessionId: string | null;
  conversationId: string | null;
  readyFiles: Set<string>;
  pendingTool: PendingTool;
  pendingApproval: PendingApproval;
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
  /** Auth user label */
  authUser: { username?: string; [k: string]: unknown } | null;
};

export type AttachmentLimits = {
  maxCount: number;
  maxFileBytes: number;
  maxTurnBytes: number;
};
