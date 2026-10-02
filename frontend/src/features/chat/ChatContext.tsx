/**
 * Chat application controller for the Agent Runtime Workbench.
 * Projects Agent Run SSE into the normalized entity store via EntityBridge.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  INITIAL,
  createState,
  update,
  anonymousState,
  startStream,
  abortStream,
  isActiveGeneration,
  persistConversationId,
  loadPersistedConversationId,
  persistSidebarOpen,
  loadPersistedSidebarOpen,
  clearPersistedChat,
  writeConversationModelId,
  normalizeServerMessages,
  createAttachmentDraft,
  patchAttachment,
  removeAttachment,
  validateNewAttachments,
  canSendAttachments,
  uploadedAttachments,
  buildUserTurnWithAttachments,
  activeAttachments,
  type ChatState,
  type ChatMessage,
} from '../../shared/state';
import { isNewChatShortcut } from '../../shared/ui/keyboard';
import {
  createRun as apiCreateRun,
  streamRunEvents,
  uploadDataset,
  ensureSession,
  getConversation,
  deleteConversation,
  listArtifacts,
  importArtifact as apiImportArtifact,
  decideApproval,
} from '../../shared/api';
import { useConversationPaging } from './conversationPaging';
import type { Agent, ModelItem } from '../../shared/api';
import type { AuthConfig } from '../../shared/schemas/auth';
import { projectLoginCapabilities, type LoginCapabilities } from '../../shared/schemas/auth';
import { createEntityBridge, type EntityBridge } from './entityBridge';
import { useReviewResultPolling } from './useReviewResultPolling';
import type { EntityStore } from '../../entities';
import type { SSEEvent } from '../../shared/sse/parser';
import { projectConversationMessages } from './projections/conversationMessages';
import { beginConversationRestore, finishConversationRestore, failConversationRestore } from './conversationLoading';
import { bindCreatedRunIdentity } from './conversationIdentity';
import { runUploadQueue } from './uploads/runUploadQueue';
import { useRunControls } from './controllers/useRunControls';
import { useModelSelection } from './useModelSelection';
import { fixedModelIdOf, mergeConversation } from './conversationProjection';
import { effectiveModel, supportsImages } from './effectiveModel';
import { useAgentSelection } from './useAgentSelection';
import { resolveApprovalDecision } from './approvalDecision';
import { createIdentityRevision, type IdentityRevision } from './identityRevision';
import { useAuthSession } from './useAuthSession';

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
  ) => Promise<boolean>;
  // Auth
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /**
   * 重新读一次 `me`。角色权威在服务端（BFF 每个请求都重读账本），撤销自己的 admin
   * 后必须重新拉一次，AdminShell 的 isAdmin 闸门才会立刻变 false。
   * 返回 false 表示没刷新成功（调用方应提示手动刷新）。
   */
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

const ChatCtx = createContext<ChatController | null>(null);

export function useChat(): ChatController {
  const ctx = useContext(ChatCtx);
  if (!ctx) throw new Error('useChat must be used within ChatProvider');
  return ctx;
}

function isMobile(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(max-width: 768px)').matches;
}

export function ChatProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ChatState>(() => {
    const savedSidebar = loadPersistedSidebarOpen();
    return createState({
      ...INITIAL,
      restoringConversationId: loadPersistedConversationId(),
      // Mobile always starts closed; desktop uses saved UI preference.
      sidebarOpen: isMobile() ? false : (savedSidebar ?? true),
    });
  });
  const [draftText, setDraftText] = useState('');
  const [dropzoneVisible, setDropzoneVisible] = useState(false);
  const [entityStore, setEntityStore] = useState<EntityStore>(() =>
    createEntityBridge().getStore(),
  );
  // Closed by default — chat is primary; open via Details or entity select.
  const [inspectorOpen, setInspectorOpen] = useState(false);

  // Always-current refs for async handlers
  const stateRef = useRef(state);
  stateRef.current = state;
  const activeStreamGenRef = useRef(0);
  const conversationLoadGenerationRef = useRef(0);
  /** 身份边界（登录/注册/退出）的代次：过期响应不得灌回新身份。 */
  const sessionRevisionRef = useRef<IdentityRevision | null>(null);
  if (!sessionRevisionRef.current) sessionRevisionRef.current = createIdentityRevision();
  const sessionRevision = sessionRevisionRef.current;
  /** F2 entity bridge — multi-run SSE + normalized stores. */
  const bridgeRef = useRef<EntityBridge | null>(null);
  if (!bridgeRef.current) {
    bridgeRef.current = createEntityBridge((store) => {
      setEntityStore(store);
    });
  }
  const bridge = bridgeRef.current;
  const activeRunId = entityStore.activeRunId;
  const activeRun = activeRunId ? entityStore.runsById[activeRunId] : null;
  const activeSessionId = activeRun?.sandboxSessionId || state.sessionId;
  const activeTraceId = activeRun?.traceId || state.traceId;

  const currentSessionId = useCallback(() => {
    const store = bridge.getStore();
    const run = store.activeRunId ? store.runsById[store.activeRunId] : null;
    return run?.sandboxSessionId || stateRef.current.sessionId;
  }, [bridge]);

  const currentTraceId = useCallback(() => {
    const store = bridge.getStore();
    const run = store.activeRunId ? store.runsById[store.activeRunId] : null;
    return run?.traceId || stateRef.current.traceId;
  }, [bridge]);

  const setStatus = useCallback((text: string, color = '#22c55e') => {
    setState((s) => update(s, { statusLabel: text, statusColor: color }));
  }, []);

  const flashError = useCallback((msg: string) => {
    setState((s) => update(s, { flashMessage: msg || null }));
    if (msg) {
      window.setTimeout(() => {
        setState((s) =>
          s.flashMessage === msg ? update(s, { flashMessage: null }) : s,
        );
      }, 4000);
    }
  }, []);

  const clearFlash = useCallback(() => {
    setState((s) => update(s, { flashMessage: null }));
  }, []);

  const currentConversationId = useCallback(
    () => stateRef.current.conversationId,
    [],
  );
  const fixedModelIdForConversation = useCallback(
    (conversationId: string | null | undefined) =>
      fixedModelIdOf(stateRef.current.conversations, conversationId),
    [],
  );
  const {
    models,
    selectedModelId,
    fixedModelId,
    setSelectedModelId,
    refreshModels,
    applyModelForConversation,
    resetModels,
  } = useModelSelection(bridge, currentConversationId, fixedModelIdForConversation, sessionRevision);
  const {
    agents,
    selectedAgentId,
    setSelectedAgentId,
    refreshAgents,
    agentNameById,
    resetAgents,
  } = useAgentSelection(sessionRevision);

  const {
    hasMoreConversations,
    loadingMoreConversations,
    conversationPagingError,
    loadMoreConversations,
    refreshConversations,
  } = useConversationPaging({ sessionRevision, setState });

  const refreshArtifacts = useCallback(async (sessionId?: string | null) => {
    const generation = sessionRevision.current();
    const conversationGeneration = conversationLoadGenerationRef.current;
    const sid = sessionId || currentSessionId();
    if (!sid) {
      setState((s) => update(s, { artifacts: [] }));
      return;
    }
    try {
      const data = await listArtifacts(sid);
      if (!sessionRevision.isCurrent(generation) ||
          conversationGeneration !== conversationLoadGenerationRef.current ||
          sid !== currentSessionId()) return;
      setState((s) => {
        if (!sessionRevision.isCurrent(generation) ||
            conversationGeneration !== conversationLoadGenerationRef.current ||
            sid !== currentSessionId()) return s;
        return update(s, { artifacts: data.artifacts || [] });
      });
    } catch (err) {
      console.warn('[artifacts] list failed:', (err as Error).message);
    }
  }, [currentSessionId, sessionRevision]);

  const applySSE = useCallback(
    (ev: SSEEvent, generation: number, runId?: string | null) => {
      // Runtime events have exactly one write path: Agent adapter -> reducer ->
      // EntityStore. Background runs keep updating when focus changes.
      if (runId) {
        try {
          bridge.ingestAgentEvent(runId, ev);
        } catch (err) {
          console.warn('[entity] ingest failed:', (err as Error).message);
        }
      }

      // UI-only effects may follow the event, but never store a second copy of
      // runtime messages/tools/approvals/artifacts.
      if (!isActiveGeneration(stateRef.current, generation)) return;
      const type = String(ev.type || '');
      if (type === 'session') {
        const sessionId = ev.session_id ? String(ev.session_id) : null;
        const conversationId = ev.conversation_id
          ? String(ev.conversation_id)
          : null;
        if (conversationId && conversationId !== stateRef.current.conversationId) {
          setState((s) => update(s, { conversationId }));
          persistConversationId(conversationId);
        }
        if (sessionId) {
          setStatus(`Session ${sessionId.slice(-8)}`);
          void refreshArtifacts(sessionId);
        }
      } else if (type === 'file_ready' || type === 'artifact.ready') {
        // submit_artifact → artifact.ready is the only durable deliverable path.
        // Refresh the session artifact list so export chips appear without waiting
        // for a conversation reload.
        const sessionId = currentSessionId();
        if (sessionId) void refreshArtifacts(sessionId);
      } else if (type === 'error') {
        flashError(String(ev.message || ev.text || 'Unknown error'));
      } else if (type === 'session_closed') {
        setStatus('Session ended', '#64748b');
      }
    },
    [setStatus, flashError, refreshArtifacts, bridge, currentSessionId],
  );

  const selectConversation = useCallback(
    async (id: string) => {
      const cur = stateRef.current;
      if (!id || id === cur.conversationId) {
        if (isMobile()) {
          setState((s) => update(s, { sidebarOpen: false }));
        }
        return;
      }
      const loadGeneration = ++conversationLoadGenerationRef.current;

      // F2: do NOT abort background runs / SSE managers on conversation switch.
      // Only detach UI focus. EntityStore continues receiving events for
      // in-flight background runs.
      bridge.focusConversation(null);
      // Optimistically focus the target conversation ID for instant feedback.
      setState((s) => {
        const n = update(beginConversationRestore(s, id), {
          conversationId: id,
          sessionId: null,
          artifacts: [],
          attachments: [],
          traceId: null,
          isStreaming: false,
          // EntityBridge keeps the per-run controller while focus detaches.
          abortCtrl: null,
          streamGeneration: (s.streamGeneration || 0) + 1,
        });
        activeStreamGenRef.current = n.streamGeneration;
        return n;
      });

      try {
        setStatus('Loading…', '#94a3b8');
        const conv = await getConversation(id);
        if (loadGeneration !== conversationLoadGenerationRef.current) return;
        const messages = normalizeServerMessages(conv.messages);
        const sessionId = conv.sandbox_session_id || null;

        bridge.focusConversation(conv.id);

        setState((s) => {
          // Focus switch without aborting abortCtrl (background run continues)
          const conversations = mergeConversation(s.conversations, conv);
          const n = update(s, {
            conversationId: conv.id,
            messages,
            sessionId,
            conversations,
            artifacts: [],
            attachments: [],
            traceId: null,
            isStreaming: false,
            streamGeneration: (s.streamGeneration || 0) + 1,
            sidebarOpen: isMobile() ? false : s.sidebarOpen,
          });
          activeStreamGenRef.current = n.streamGeneration;
          return n;
        });
        persistConversationId(conv.id);

        try {
          await bridge.rehydrateConversation(conv.id);
        } catch (error) {
          console.warn('[conv] timeline restore failed:', error);
          flashError('Conversation loaded, but activity history could not be restored');
        }
        if (loadGeneration !== conversationLoadGenerationRef.current) return;
        setState((s) => finishConversationRestore(s, id));
        applyModelForConversation(conv.id);

        if (sessionId) {
          await refreshArtifacts(sessionId);
          if (loadGeneration !== conversationLoadGenerationRef.current) return;
          setStatus(`Session ${sessionId.slice(-8)}`);
        } else {
          setStatus('Agent Ready');
        }
      } catch (err) {
        if (loadGeneration !== conversationLoadGenerationRef.current) return;
        bridge.focusConversation(null);
        setState((s) => failConversationRestore(s, id));
        console.error('[conv] select failed:', err);
        flashError(`Failed to load conversation: ${(err as Error).message}`);
        setStatus('Agent Ready');
      }
    },
    [setStatus, flashError, refreshArtifacts, bridge, applyModelForConversation],
  );

  const importArtifactToConversation = useCallback(
    async (
      artifactId: string,
      targetConversationId: string,
      targetFilename?: string | null,
    ) => {
      try {
        setStatus('Importing artifact…', '#94a3b8');
        const result = await apiImportArtifact({
          artifactId,
          targetConversationId,
          targetFilename,
        });

        if (stateRef.current.conversationId !== targetConversationId) {
          await selectConversation(targetConversationId);
        }
        if (stateRef.current.conversationId !== targetConversationId) {
          setStatus(`Imported ${result.workspace_file.name}`);
          flashError(
            `Imported ${result.workspace_file.name}, but the target conversation could not be opened. The file is available at ${result.workspace_file.path}.`,
          );
          return;
        }

        const file = result.workspace_file;
        const localId =
          globalThis.crypto?.randomUUID?.() ??
          `import_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        setState((s) => {
          const next = update(s, {
            attachments: [
              ...(s.attachments || []),
              {
                localId,
                status: 'uploaded',
                name: file.name,
                size: file.size,
                mimeType: file.mime_type,
                file: null,
                attachmentId: result.import_id,
                path: file.path,
                idempotencyKey: `artifact_import_${result.import_id}`,
                error: null,
                errorCode: null,
                traceId: null,
                progress: 100,
                abortCtrl: null,
              },
            ],
          });
          stateRef.current = next;
          return next;
        });
        setStatus(`Imported ${file.name}`);
        flashError(
          `Imported ${file.name} into this conversation. It is ready in the composer.`,
        );
      } catch (err) {
        setStatus('Artifact import failed', '#ef4444');
        flashError(`Import failed: ${(err as Error).message}`);
        throw err;
      }
    },
    [flashError, selectConversation, setStatus],
  );

  const startNewChat = useCallback(async () => {
    conversationLoadGenerationRef.current += 1;
    const cur = stateRef.current;
    // F2: detaching UI focus does not cancel background runs
    if (cur.isStreaming) {
      setState((s) => {
        const n = update(s, {
          isStreaming: false,
          streamGeneration: (s.streamGeneration || 0) + 1,
        });
        activeStreamGenRef.current = n.streamGeneration;
        return n;
      });
    }

    bridge.focusConversation(null);

    setState((s) => {
      const n = update(s, {
        conversationId: null,
        restoringConversationId: null,
        messages: [],
        sessionId: null,
        artifacts: [],
        attachments: [],
        traceId: null,
        isStreaming: false,
        abortCtrl: null,
        streamGeneration: (s.streamGeneration || 0) + 1,
        sidebarOpen: isMobile() ? false : s.sidebarOpen,
      });
      activeStreamGenRef.current = n.streamGeneration;
      return n;
    });
    clearPersistedChat();
    applyModelForConversation(null);
    setStatus('Agent Ready');
  }, [setStatus, bridge, applyModelForConversation]);

  const removeConversation = useCallback(
    async (id: string) => {
      if (!id) return;
      const cur = stateRef.current;
      if (cur.isStreaming && id === cur.conversationId) {
        setState((s) => {
          const n = abortStream(s);
          activeStreamGenRef.current = n.streamGeneration;
          return n;
        });
      }
      if (
        !confirm(
          'Delete this conversation? Workspace and linked session may be cleaned up.',
        )
      ) {
        return;
      }
      try {
        await deleteConversation(id);
        setState((s) =>
          update(s, {
            conversations: (s.conversations || []).filter((c) => c.id !== id),
          }),
        );
        if (stateRef.current.conversationId === id) {
          await startNewChat();
        }
      } catch (err) {
        console.error('[conv] delete failed:', err);
        flashError(`Delete failed: ${(err as Error).message}`);
      }
    },
    [startNewChat, flashError],
  );

  const sendMessage = useCallback(
    async (text?: string) => {
      const cur = stateRef.current;
      if (cur.isStreaming || cur.restoringConversationId) return;

      if (!canSendAttachments(cur.attachments)) {
        const active = activeAttachments(cur.attachments);
        const failed = active.some((a) => a.status === 'failed');
        flashError(
          failed
            ? 'Remove or retry failed attachments before sending'
            : 'Wait for uploads to finish before sending',
        );
        return;
      }

      const uploaded = uploadedAttachments(cur.attachments);
      const trimmed = (text ?? draftText).trim();
      if (!trimmed && uploaded.length === 0) return;
      const hasImage = uploaded.some((attachment) =>
        String(attachment.mimeType || '').toLowerCase().startsWith('image/'),
      );
      // No selection means the catalog default serves the turn, not "no model".
      if (hasImage && !supportsImages(effectiveModel(models, selectedModelId, fixedModelId))) {
        flashError('当前模型不支持图片，请在模型菜单里换一个支持看图的模型');
        return;
      }

      // Keep a local identity through the asynchronous create-run round trip.
      // Selecting the "latest untagged user" races when two send attempts
      // overlap: the first response can otherwise tag the second bubble and
      // invert the two turns.
      const localMessageId =
        globalThis.crypto?.randomUUID?.() ??
        `local_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const userMsg = {
        ...buildUserTurnWithAttachments(trimmed, cur.attachments),
        _messageId: localMessageId,
        createdAt: new Date().toISOString(),
      };
      setDraftText('');

      const abortCtrl = new AbortController();
      const sendConversationGeneration = conversationLoadGenerationRef.current;
      let generation = 0;
      // runId assigned after create; tag user bubble once we have it so order
      // merge can place the assistant after this user even if a later turn starts.
      let runId: string | null = null;
      setState((s) => {
        let n = update(s, {
          messages: [...s.messages, userMsg],
          attachments: [],
        });
        n = startStream(n, { abortCtrl });
        generation = n.streamGeneration;
        activeStreamGenRef.current = generation;
        return n;
      });

      try {
        const created = await apiCreateRun({
          conversation_id: cur.conversationId,
          session_id: currentSessionId(),
          model_id: selectedModelId,
          // 首轮就是建会话：这里选 Agent。既有会话不传——它的 Agent 已经钉死，
          // 换 Agent 要新建会话（D2）。
          agent_id: cur.conversationId ? null : selectedAgentId,
          messages: [userMsg],
        });
        if (!created.run_id) throw new Error('Run response is missing run_id');
        runId = created.run_id;
        // The run still belongs to A if the user selected B while create-run
        // was pending, but its response must not refocus or persist A in B's UI.
        const canFocus = sendConversationGeneration === conversationLoadGenerationRef.current &&
          isActiveGeneration(stateRef.current, generation);

        // A first turn has no client-side conversation/session yet. The create
        // response is therefore authoritative for the identity that subsequent
        // turns must reuse. Relying on a `session` SSE event left these
        // fields null when the durable run stream only emitted platform events,
        // so every send after the first silently created a new conversation.
        const createdConversationId = created.conversation_id || cur.conversationId;
        if (createdConversationId) {
          writeConversationModelId(createdConversationId, selectedModelId);
        }
        const createdSessionId = created.session_id || currentSessionId();
        if (createdConversationId || createdSessionId) {
          setState((s) => {
            // A user may have detached to another conversation while this
            // asynchronous create request was in flight. Do not steal focus
            // back from that newer UI generation.
            if (!canFocus || !isActiveGeneration(s, generation)) return s;
            const next = bindCreatedRunIdentity(s, cur, createdConversationId, createdSessionId, trimmed);
            stateRef.current = next;
            return next;
          });
          if (createdConversationId && canFocus) {
            persistConversationId(createdConversationId);
            bridge.focusConversation(createdConversationId);
          }
        }
        // Stamp the optimistic user message with run id for stable ordering.
        setState((s) => {
          if (!canFocus || !isActiveGeneration(s, generation)) return s;
          const messages = [...s.messages];
          for (let i = messages.length - 1; i >= 0; i -= 1) {
            if (messages[i]._messageId === localMessageId) {
              messages[i] = { ...messages[i], _runId: runId as string };
              break;
            }
          }
          return update(s, { messages });
        });
        bridge.beginRun({
          runId: created.run_id,
          conversationId: createdConversationId,
          agentSessionId: created.agent_session_id || null,
          sessionId: createdSessionId,
          focus: canFocus,
        });
        bridge.attachTransport(runId, abortCtrl);
        await streamRunEvents(
          runId,
          (envelope) => {
            // Keep the BFF relay envelope `{ sequence, event, ts }` intact.
            // Stripping to `envelope.event` drops sequence/event_id and the
            // reducer then treats every frame as sequence 0 (duplicate) so the
            // assistant bubble never updates during a live run.
            applySSE(envelope, generation, runId as string);
          },
          { signal: abortCtrl.signal },
        );
        // Refresh the durable ledger even after a clean stream close. The
        // stream may have omitted a tool.execution.completed event, so closure alone is not a
        // success signal.
        try {
          await bridge.reconcileRun(runId);
        } catch (reconcileErr) {
          console.warn('[chat] post-stream reconciliation failed:', reconcileErr);
        }

        setState((s) => {
          if (!isActiveGeneration(s, generation)) return s;
          return update(s, { isStreaming: false, abortCtrl: null });
        });
        await refreshConversations();
        await refreshArtifacts(currentSessionId());
      } catch (err) {
        const error = err as Error & { name?: string };
        if (error.name === 'AbortError') {
          if (runId) bridge.interruptRun(runId, 'User stopped the run');
        } else {
          console.error('[chat] Error:', error);
          let authoritative = false;
          if (runId) {
            try {
              const recovered = await bridge.reconcileRun(runId);
              // Any successfully fetched snapshot is authoritative, even if
              // it is still running. Transport loss must not rewrite that
              // durable state into a guessed failed/succeeded event.
              authoritative = Boolean(recovered);
            } catch (reconcileErr) {
              console.warn('[chat] authoritative run recovery failed:', reconcileErr);
            }
          }
          // Do not manufacture a failed/succeeded result from transport
          // state. Only use a local failure marker when the authoritative
          // snapshot itself could not be obtained.
          if (runId && !authoritative) {
            bridge.failRun(runId, error.message || 'Connection error');
          }
          const traceId = currentTraceId();
          const trace = traceId ? ` [trace ${traceId.slice(0, 8)}]` : '';
          flashError(`Connection error: ${error.message}${trace}`);
        }
        setState((s) => {
          if (!isActiveGeneration(s, generation)) return s;
          if (error.name === 'AbortError') {
            activeStreamGenRef.current = (s.streamGeneration || 0) + 1;
            return abortStream(s);
          }
          return update(s, { isStreaming: false, abortCtrl: null });
        });
      } finally {
        if (runId) bridge.releaseTransport(runId);
        setState((s) => {
          if (!isActiveGeneration(s, generation)) return s;
          if (s.isStreaming) {
            return update(s, { isStreaming: false, abortCtrl: null });
          }
          return s;
        });
      }
    },
    [
      draftText,
      applySSE,
      flashError,
      refreshConversations,
      refreshArtifacts,
      bridge,
      currentSessionId,
      currentTraceId,
      models, selectedModelId, fixedModelId,
      selectedAgentId,
    ],
  );

  const appendUserMessage = useCallback((message: ChatMessage) => {
    setState((s) => {
      const next = update(s, { messages: [...s.messages, message] });
      stateRef.current = next;
      return next;
    });
  }, []);

  const removeUserMessage = useCallback((messageId: string) => {
    const id = String(messageId || '').trim();
    if (!id) return;
    setState((s) => {
      const next = update(s, {
        messages: s.messages.filter((m) => m._messageId !== id),
      });
      stateRef.current = next;
      return next;
    });
  }, []);

  const patchUserMessage = useCallback(
    (messageId: string, patch: Partial<ChatMessage>) => {
      const id = String(messageId || '').trim();
      if (!id) return;
      setState((s) => {
        const messages = s.messages.map((m) =>
          m._messageId === id ? { ...m, ...patch } : m,
        );
        const next = update(s, { messages });
        stateRef.current = next;
        return next;
      });
    },
    [],
  );

  const {
    cancelStream,
    stopRun,
    steerRun,
    followUpRun,
    resumeInterrupted,
    respondInteraction,
  } = useRunControls({
    bridge,
    stateRef,
    setDraftText,
    setStatus,
    flashError,
    appendUserMessage,
    removeUserMessage,
    patchUserMessage,
  });

  const ensureConversationSession = useCallback(async () => {
    const cur = stateRef.current;
    if (cur.sessionId && cur.conversationId) {
      return { sessionId: cur.sessionId, conversationId: cur.conversationId };
    }
    try {
      const data = await ensureSession(cur.conversationId);
      const conversationId = data.conversation_id || cur.conversationId;
      const sessionId = data.session_id;
      setState((s) => {
        const patch: Partial<ChatState> = {};
        if (conversationId && conversationId !== s.conversationId) {
          patch.conversationId = conversationId;
          persistConversationId(conversationId);
        }
        if (sessionId) patch.sessionId = sessionId;
        if (data.trace_id) patch.traceId = data.trace_id;
        return Object.keys(patch).length ? update(s, patch) : s;
      });
      if (sessionId) setStatus(`Session ${sessionId.slice(-8)}`);
      await refreshConversations();
      return { sessionId, conversationId };
    } catch (err) {
      const e = err as Error & { traceId?: string };
      const trace = e.traceId ? ` [trace ${String(e.traceId).slice(0, 8)}]` : '';
      throw new Error(`${e.message || 'Failed to prepare session'}${trace}`);
    }
  }, [setStatus, refreshConversations]);

  /**
   * Upload one draft. Prefer the optional `seed` draft: React setState is async,
   * so stateRef may not yet include drafts that were just enqueued.
   */
  const runUploadForDraft = useCallback(
    async (localId: string, seed?: (typeof state.attachments)[number]) => {
      const fromRef = (stateRef.current.attachments || []).find(
        (a) => a.localId === localId,
      );
      const draft = fromRef || seed;
      if (!draft || !draft.file || draft.status === 'removed') return;

      // Capture file + key now — do not depend on a later ref lookup for the blob.
      const file = draft.file as File;
      const idempotencyKey = draft.idempotencyKey;

      const abortCtrl = new AbortController();
      setState((s) => {
        const next = update(s, {
          attachments: patchAttachment(s.attachments, localId, {
            status: 'uploading',
            error: null,
            errorCode: null,
            abortCtrl,
          }),
        });
        stateRef.current = next;
        return next;
      });

      try {
        const { sessionId, conversationId } = await ensureConversationSession();
        if (!sessionId) throw new Error('No sandbox session');
        if (!conversationId) throw new Error('No conversation');

        const current = (stateRef.current.attachments || []).find(
          (a) => a.localId === localId,
        );
        if (current?.status === 'removed') return;

        const result = await uploadDataset({
          sessionId,
          conversationId,
          file,
          signal: abortCtrl.signal,
          idempotencyKey,
          traceId: stateRef.current.traceId || undefined,
        });

        // Dataset Panel and composer share the same successful server result:
        // publish the formal row immediately while retaining a sendable draft.
        bridge.recordDataset(result, { conversationId, sessionId });

        const still = (stateRef.current.attachments || []).find(
          (a) => a.localId === localId,
        );
        if (still?.status === 'removed') return;

        setState((s) => {
          const next = update(s, {
            attachments: patchAttachment(s.attachments, localId, {
              status: 'uploaded',
              attachmentId: result.dataset_id,
              path: result.path,
              size: result.size,
              progress: 100,
              error: null,
              errorCode: null,
              traceId: result.trace_id || s.traceId || null,
              abortCtrl: null,
              file: still?.file ?? file,
            }),
            ...(result.trace_id ? { traceId: result.trace_id } : {}),
          });
          stateRef.current = next;
          return next;
        });
      } catch (err) {
        const error = err as Error & {
          name?: string;
          code?: string;
          traceId?: string;
        };
        if (error.name === 'AbortError') return;
        console.error('[upload] Error:', error);
        const still = (stateRef.current.attachments || []).find(
          (a) => a.localId === localId,
        );
        if (still?.status === 'removed') return;
        const traceId = error.traceId || stateRef.current.traceId || null;
        setState((s) => {
          const next = update(s, {
            attachments: patchAttachment(s.attachments, localId, {
              status: 'failed',
              error: error.message || 'Upload failed',
              errorCode: error.code || null,
              traceId,
              abortCtrl: null,
            }),
            ...(traceId ? { traceId } : {}),
          });
          stateRef.current = next;
          return next;
        });
        const t = traceId ? ` [trace ${String(traceId).slice(0, 8)}]` : '';
        flashError(`Upload error: ${error.message || 'failed'}${t}`);
      }
    },
    [ensureConversationSession, flashError, bridge],
  );

  const handleFilesSelected = useCallback(
    async (fileList: FileList | File[]) => {
      if (stateRef.current.restoringConversationId) return;
      const files = Array.from(fileList || []).filter(Boolean) as File[];
      if (!files.length) return;

      const check = validateNewAttachments(stateRef.current.attachments, files);
      if (!check.ok) {
        flashError(check.message);
        return;
      }

      const drafts = files.map((f) => createAttachmentDraft(f));
      // Synchronously publish drafts into stateRef before kicking off uploads.
      // Otherwise runUploadForDraft cannot find them (setState is async).
      setState((s) => {
        const next = update(s, {
          attachments: [...(s.attachments || []), ...drafts],
        });
        stateRef.current = next;
        return next;
      });

      await runUploadQueue(
        drafts,
        (draft) => runUploadForDraft(draft.localId, draft),
        3,
      );
    },
    [flashError, runUploadForDraft],
  );

  const removeAttachmentDraft = useCallback((localId: string) => {
    setState((s) =>
      update(s, {
        attachments: removeAttachment(s.attachments, localId),
      }),
    );
  }, []);

  const retryAttachmentDraft = useCallback(
    async (localId: string) => {
      const draft = (stateRef.current.attachments || []).find(
        (a) => a.localId === localId,
      );
      if (!draft || draft.status === 'removed') return;
      if (!draft.file) {
        flashError('Cannot retry: original file is no longer available');
        return;
      }
      const retried = {
        ...draft,
        status: 'queued' as const,
        error: null,
        errorCode: null,
        progress: 0,
      };
      setState((s) => {
        const next = update(s, {
          attachments: patchAttachment(s.attachments, localId, {
            status: 'queued',
            error: null,
            errorCode: null,
            progress: 0,
          }),
        });
        stateRef.current = next;
        return next;
      });
      await runUploadForDraft(localId, retried);
    },
    [flashError, runUploadForDraft],
  );

  const resolveApproval = useCallback(
    async (approvalId: string, decision: 'approve' | 'reject') => {
      return resolveApprovalDecision(approvalId, decision, {
        decide: decideApproval, markApproval: (id, status) => bridge.markApproval(id, status),
        setStatus,
        flashError,
        followRun: () => void bridge.rehydrateInProgress(stateRef.current.conversationId).catch(() => {}),
      });
    },
    [bridge, setStatus, flashError],
  );

  const toggleInspector = useCallback(() => {
    setInspectorOpen((v) => !v);
  }, []);

  /**
   * 身份边界：清空本机用户/流/实体/附件/持久化会话。即使服务端撤销未确认
   * （409/503/网络失败）也必须清——这是本机已经退出的事实。依赖都是稳定引用，
   * 回调跨渲染保持稳定，认证该不该跑一次不会被重建的 callback 触发。
   */
  const clearIdentity = useCallback((opts: { statusLabel: string; statusColor?: string }) => {
    sessionRevision.bump();
    conversationLoadGenerationRef.current += 1;
    const previous = stateRef.current;
    previous.abortCtrl?.abort();
    for (const attachment of previous.attachments) attachment.abortCtrl?.abort();
    bridge.reset();
    clearPersistedChat();
    setDraftText('');
    setDropzoneVisible(false);
    resetModels();
    resetAgents();
    setInspectorOpen(false);
    setState(() => {
      const next = anonymousState(previous, {
        statusLabel: opts.statusLabel,
        statusColor: opts.statusColor,
      });
      stateRef.current = next;
      activeStreamGenRef.current = next.streamGeneration;
      return next;
    });
  }, [bridge, resetAgents, resetModels, sessionRevision]);

  /** 切号后重新拉当前身份的会话/模型/Agent 目录。 */
  const afterIdentitySwitch = useCallback(async () => {
    await refreshConversations();
    await refreshModels();
    await refreshAgents();
  }, [refreshAgents, refreshConversations, refreshModels]);

  /** 恢复上次聚焦会话：会话切换或身份边界发生后，任何后续落地都必须作废。 */
  const restoreLastConversation = useCallback(async () => {
    const savedConvId = loadPersistedConversationId();
    if (!savedConvId) return;
    const loadGeneration = ++conversationLoadGenerationRef.current;
    const snapshot = sessionRevision.current();
    const stale = () =>
      loadGeneration !== conversationLoadGenerationRef.current ||
      !sessionRevision.isCurrent(snapshot);
    try {
      const conv = await getConversation(savedConvId);
      if (stale()) return;
      const messages = normalizeServerMessages(conv.messages);
      setState((s) => update(s, {
        conversationId: conv.id,
        messages,
        sessionId: conv.sandbox_session_id || null,
        conversations: mergeConversation(s.conversations, conv),
      }));
      persistConversationId(conv.id);
      bridge.focusConversation(conv.id);
      try {
        await bridge.rehydrateConversation(conv.id);
      } catch (error) {
        console.warn('[boot] timeline restore failed:', (error as Error).message);
        if (!stale()) flashError('Conversation loaded, but activity history could not be restored');
      }
      if (stale()) return;
      setState((s) => finishConversationRestore(s, savedConvId));
      applyModelForConversation(conv.id);
      if (conv.sandbox_session_id) {
        await refreshArtifacts(conv.sandbox_session_id);
        if (stale()) return;
        setStatus(`Session ${conv.sandbox_session_id.slice(-8)}`);
      }
    } catch {
      if (!stale()) {
        setState((s) => finishConversationRestore(s, savedConvId));
        clearPersistedChat();
      }
    }
  }, [applyModelForConversation, bridge, flashError, refreshArtifacts, sessionRevision, setStatus]);

  /** 认证字段的集中写点（与 clearIdentity 的身份清理分开：这里只写认证投影）。 */
  const applyAuth = useCallback(
    (patch: Partial<Pick<ChatState, 'authReady' | 'authUser' | 'authError'>>) => {
      setState((s) => update(s, patch));
    },
    [],
  );

  /**
   * 浏览器会话与身份边界（P1b）：config + `me` 检查、登录/注册/退出、
   * 401/503 分流与重试。实现在 `useAuthSession.ts`。
   */
  const authSession = useAuthSession({
    authUser: state.authUser,
    authError: state.authError,
    authReady: state.authReady,
    applyAuth,
    setStatus,
    flashError,
    revision: sessionRevision,
    clearIdentity,
    afterIdentitySwitch,
  });

  /** 登录能力投影：加载失败保留错误与重试，绝不静默当成空能力。 */
  const authConfig: AuthConfigState = {
    config: authSession.authConfig,
    capabilities: authSession.authConfig
      ? projectLoginCapabilities(authSession.authConfig)
      : null,
    loading: authSession.configLoading,
    error: authSession.configError,
  };

  const login = useCallback(
    (username: string, password: string) => authSession.login(username, password),
    [authSession.login],
  );

  const register = useCallback(
    (username: string, password: string) => authSession.register(username, password),
    [authSession.register],
  );

  const logout = useCallback(
    () => authSession.logout(),
    [authSession.logout],
  );

  /**
   * 角色权威在服务端：`me` 每次请求都重读账本。撤销自己的 admin 之后重新拉一次，
   * 闸门立刻生效，不必整页刷新（design §6）。实现与 401/503 分流的细节在
   * `useAuthSession.ts`。
   */
  const refreshAuthUser = useCallback(
    () => authSession.refreshAuthUser(),
    [authSession.refreshAuthUser],
  );

  const retryAuth = useCallback(async () => {
    const result = await authSession.retryAuth();
    if (result.status === 'authenticated') await restoreLastConversation();
  }, [authSession.retryAuth, restoreLastConversation]);

  const toggleSidebar = useCallback(() => {
    setState((s) => {
      const next = !s.sidebarOpen;
      if (!isMobile()) persistSidebarOpen(next);
      return update(s, { sidebarOpen: next });
    });
  }, []);

  const closeSidebar = useCallback(() => {
    setState((s) => {
      if (!isMobile()) persistSidebarOpen(false);
      return update(s, { sidebarOpen: false });
    });
  }, []);

  // Boot：config + `me` 检查（401/503 的语义在 useAuthSession），
  // 只有身份确认后才恢复目录与上次聚焦的会话。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await authSession.retryAuth();
      if (cancelled || result.status !== 'authenticated') return;
      await restoreLastConversation();
    })().catch((err) => console.warn('[boot]', err));
    return () => {
      cancelled = true;
    };
    // 只在挂载时跑一次；retryAuth 的依赖都是稳定引用（见 useAuthSession）。
  }, [authSession.retryAuth, restoreLastConversation]);

  // Dispose entity SSE managers on unmount (page unload)
  useEffect(() => {
    return () => {
      bridge.dispose();
    };
  }, [bridge]);

  /**
   * T1：发起人页面上还有待审交付物时定时重拉会话事件（审核结果是 Run 结束之后才
   * 追加的，Run SSE 那时已经关了）。判定与计时器的细节在
   * `useReviewResultPolling.ts`——那是行数棘轮之外的文件。
   */
  useReviewResultPolling(bridge, entityStore, state.conversationId);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (
        isNewChatShortcut({
          key: e.key,
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
          shiftKey: e.shiftKey,
          isComposing: e.isComposing,
        })
      ) {
        e.preventDefault();
        void startNewChat();
      }
      // Ctrl+U (attach files) is handled inside the Composer, next to the
      // file input it triggers.
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [startNewChat]);

  /**
   * Conversation transcript:
   * - ChatState.messages holds the user turns (server history + optimistic sends)
   * - EntityStore holds each Run's assistant output (text, thinking, tools)
   *
   * Project **all runs for this conversation** (not only activeRunId), so
   * starting a second turn does not drop the previous assistant reply.
   */
  const displayMessages = useMemo(() => {
    return projectConversationMessages({
      userMessages: state.messages,
      conversationId: state.conversationId,
      store: entityStore,
      activeRunId,
    });
  }, [state.messages, state.conversationId, entityStore, activeRunId]);

  const canSend = canSendAttachments(state.attachments);

  const value: ChatController = {
    state,
    draftText,
    setDraftText,
    dropzoneVisible,
    models,
    selectedModelId,
    fixedModelId,
    setSelectedModelId,
    agents,
    selectedAgentId,
    setSelectedAgentId,
    agentNameById,
    selectConversation,
    startNewChat,
    removeConversation,
    importArtifactToConversation,
    toggleSidebar,
    closeSidebar,
    refreshConversations,
    loadMoreConversations,
    hasMoreConversations,
    loadingMoreConversations,
    conversationPagingError,
    sendMessage,
    cancelStream,
    stopRun,
    steerRun,
    followUpRun,
    resumeInterrupted,
    respondInteraction,
    handleFilesSelected,
    removeAttachmentDraft,
    retryAttachmentDraft,
    setDropzoneVisible,
    resolveApproval,
    login,
    register,
    logout,
    refreshAuthUser,
    authConfig,
    retryAuth,
    logoutWarning: authSession.logoutWarning,
    clearFlash,
    displayMessages,
    canSend,
    entityStore,
    activeRunId,
    activeSessionId,
    activeTraceId,
    inspectorOpen,
    setInspectorOpen,
    toggleInspector,
  };

  return <ChatCtx.Provider value={value}>{children}</ChatCtx.Provider>;
}
