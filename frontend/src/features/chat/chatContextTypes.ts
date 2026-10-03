/**
 * Core type definitions for the Chat application context.
 */
import type { Agent, ModelItem } from '../../shared/api';
import type { AuthConfig, LoginCapabilities } from '../../shared/schemas/auth';
import type { EntityStore, ProcessEntity } from '../../entities';
import type { ChatMessage, ChatState } from '../../shared/state';

/** 登录能力投影的加载状态：加载失败不能当成「没有登录方式」。 */
export type AuthConfigState = {
  config: AuthConfig | null;
  capabilities: LoginCapabilities | null;
  loading: boolean;
  error: string | null;
};

export type ChatController = {
  state: ChatState;
  draftText: string;
  setDraftText: (t: string) => void;
  dropzoneVisible: boolean;
  models: ModelItem[];
  selectedModelId: string | null;
  /** Model pinned by the bound AgentVersion for the focused conversation. */
  fixedModelId: string | null;
  setSelectedModelId: (modelId: string | null) => void;
  /** org 内可选的智能体；只有一个时 UI 不渲染选择器（D2：一会话一 Agent）。 */
  agents: Agent[];
  selectedAgentId: string | null;
  setSelectedAgentId: (agentId: string | null) => void;
  agentNameById: (agentId: string | null | undefined) => string | null;
  // Conversations
  selectConversation: (id: string) => Promise<void>;
  startNewChat: () => Promise<void>;
  removeConversation: (id: string) => Promise<void>;
  importArtifactToConversation: (
    artifactId: string,
    targetConversationId: string,
    targetFilename?: string | null,
  ) => Promise<void>;
  toggleSidebar: () => void;
  closeSidebar: () => void;
  refreshConversations: () => Promise<void>;
  loadMoreConversations: () => Promise<void>;
  hasMoreConversations: boolean;
  loadingMoreConversations: boolean;
  conversationPagingError: string | null;
  // Messaging
  sendMessage: (text?: string) => Promise<void>;
  cancelStream: () => void;
  /** F4: user stop — abort stream + cancel run API. */
  stopRun: () => void;
  /** F4: steer current run (Running mode). */
  steerRun: (text: string) => Promise<boolean>;
  /** F4: queue follow-up after current work. */
  followUpRun: (text: string) => Promise<boolean>;
  /** F4: resume entry for interrupted runs. */
  resumeInterrupted: () => Promise<void>;
  respondInteraction: (response: unknown) => Promise<boolean>;
  // Attachments
  handleFilesSelected: (files: FileList | File[]) => Promise<void>;
  removeAttachmentDraft: (localId: string) => void;
  retryAttachmentDraft: (localId: string) => Promise<void>;
  setDropzoneVisible: (v: boolean) => void;
  // Approvals
  /** Decide a specific approval by id (entity card or banner). */
  resolveApproval: (
    approvalId: string,
    decision: 'approve' | 'reject',
    reason?: string | null,
  ) => Promise<boolean>;
  // Auth
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** 重新读一次 `me`。角色权威在服务端，撤销自己的 admin 后必须重新拉一次。 */
  refreshAuthUser: () => Promise<boolean>;
  /** 登录能力投影（`GET /api/auth/config`）；失败时 UI 显示错误与重试。 */
  authConfig: AuthConfigState;
  /** 重跑 config + `me` 检查；用于 503/加载失败后的可见重试。 */
  retryAuth: () => Promise<void>;
  /** 退出登录后服务端撤销未确认的可见提示；普通退出为 null。 */
  logoutWarning: string | null;
  // Flash
  clearFlash: () => void;
  // Display helpers
  displayMessages: ChatMessage[];
  canSend: boolean;
  /** F2 normalized entity store (Conversation / Session / Run hierarchy). */
  entityStore: EntityStore;
  /** Immediately update or insert a process entity in the store. */
  updateProcess: (entity: ProcessEntity) => void;
  /** Active run id, derived directly from EntityStore. */
  activeRunId: string | null;
  /** Active Sandbox session, preferring the focused run entity. */
  activeSessionId: string | null;
  /** Active trace, owned by the focused run entity. */
  activeTraceId: string | null;
  /** Inspector drawer open (tablet/mobile + desktop toggle). */
  inspectorOpen: boolean;
  setInspectorOpen: (open: boolean) => void;
  toggleInspector: () => void;
};
