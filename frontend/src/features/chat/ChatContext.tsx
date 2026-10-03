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
  persistSidebarOpen,
  loadPersistedSidebarOpen,
  loadPersistedConversationId,
  clearPersistedChat,
  writeConversationModelId,
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
  decideApproval,
} from '../../shared/api';
import { useConversationPaging } from './conversationPaging';
import { projectLoginCapabilities } from '../../shared/schemas/auth';
import { createEntityBridge, type EntityBridge } from './entityBridge';
import { useReviewResultPolling } from './useReviewResultPolling';
import type { EntityStore, ProcessEntity } from '../../entities';
import type { SSEEvent } from '../../shared/sse/parser';
import { projectConversationMessages } from './projections/conversationMessages';
import { bindCreatedRunIdentity } from './conversationIdentity';
import { useRunControls } from './controllers/useRunControls';
import { useModelSelection } from './useModelSelection';
import { fixedModelIdOf } from './conversationProjection';
import { effectiveModel, supportsImages } from './effectiveModel';
import { useAgentSelection } from './useAgentSelection';
import { resolveApprovalDecision } from './approvalDecision';
import { createIdentityRevision, type IdentityRevision } from './identityRevision';
import { useAuthSession } from './useAuthSession';
import type { AuthConfigState, ChatController } from './chatContextTypes';
import { useUserMessageMutations } from './useUserMessageMutations';
import { useAttachmentDrafts } from './useAttachmentDrafts';
import { useConversationActions, isMobile } from './useConversationActions';

export type { AuthConfigState, ChatController } from './chatContextTypes';
export { useUserMessageMutations } from './useUserMessageMutations';
export { useAttachmentDrafts } from './useAttachmentDrafts';
export { useConversationActions } from './useConversationActions';

const ChatCtx = createContext<ChatController | null>(null);

export function useChat(): ChatController {
  const ctx = useContext(ChatCtx);
  if (!ctx) throw new Error('useChat must be used within ChatProvider');
  return ctx;
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

  const {
    refreshArtifacts,
    selectConversation,
    startNewChat,
    removeConversation,
    importArtifactToConversation,
    ensureConversationSession,
    restoreLastConversation,
  } = useConversationActions({
    stateRef,
    setState,
    activeStreamGenRef,
    conversationLoadGenerationRef,
    sessionRevision,
    bridge,
    currentSessionId,
    setStatus,
    flashError,
    applyModelForConversation,
    refreshConversations,
  });

  const {
    dropzoneVisible,
    setDropzoneVisible,
    handleFilesSelected,
    removeAttachmentDraft,
    retryAttachmentDraft,
  } = useAttachmentDrafts({
    stateRef,
    setState,
    bridge,
    ensureConversationSession,
    flashError,
  });

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

  const {
    appendUserMessage,
    removeUserMessage,
    patchUserMessage,
  } = useUserMessageMutations({ stateRef, setState });

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

  const resolveApproval = useCallback(
    async (approvalId: string, decision: 'approve' | 'reject', reason?: string | null) => {
      return resolveApprovalDecision(approvalId, decision, {
        decide: decideApproval, markApproval: (id, status, r) => bridge.markApproval(id, status, r),
        setStatus,
        flashError,
        followRun: () => void bridge.rehydrateInProgress(stateRef.current.conversationId).catch(() => {}),
      }, reason);
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
  }, [bridge, resetAgents, resetModels, sessionRevision, setDropzoneVisible]);

  /** 切号后重新拉当前身份的会话/模型/Agent 目录。 */
  const afterIdentitySwitch = useCallback(async () => {
    await refreshConversations();
    await refreshModels();
    await refreshAgents();
  }, [refreshAgents, refreshConversations, refreshModels]);

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
    updateProcess: bridge.updateProcess,
    activeRunId,
    activeSessionId,
    activeTraceId,
    inspectorOpen,
    setInspectorOpen,
    toggleInspector,
  };

  return <ChatCtx.Provider value={value}>{children}</ChatCtx.Provider>;
}
