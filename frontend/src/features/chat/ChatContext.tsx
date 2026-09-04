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
  conversationTitleFromUserText,
  type ChatState,
  type ChatMessage,
} from '../../shared/state';
import { isNewChatShortcut } from '../../shared/ui/keyboard';
import {
  createRun as apiCreateRun,
  streamRunEvents,
  uploadDataset,
  ensureSession,
  listConversations,
  getConversation,
  deleteConversation,
  listArtifacts,
  importArtifact as apiImportArtifact,
  decideApproval,
  login as apiLogin,
  register as apiRegister,
  logout as apiLogout,
  me as apiMe,
  ApiError,
} from '../../shared/api';
import type { Agent, ModelItem } from '../../shared/api';
import { createEntityBridge, type EntityBridge } from './entityBridge';
import type { EntityStore } from '../../entities';
import type { SSEEvent } from '../../shared/sse/parser';
import { projectConversationMessages } from './projections/conversationMessages';
import { runUploadQueue } from './uploads/runUploadQueue';
import { useRunControls } from './controllers/useRunControls';
import { useModelSelection } from './useModelSelection';
import { useAgentSelection } from './useAgentSelection';
import { resolveApprovalDecision } from './approvalDecision';

export type ChatController = {
  state: ChatState;
  draftText: string;
  setDraftText: (t: string) => void;
  dropzoneVisible: boolean;
  models: ModelItem[];
  selectedModelId: string | null;
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
  approvePending: () => Promise<void>;
  rejectPending: () => Promise<void>;
  /** Decide a specific approval by id (entity card or banner). */
  resolveApproval: (
    approvalId: string,
    decision: 'approve' | 'reject',
  ) => Promise<boolean>;
  // Auth
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
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
  /** Invalidates account-scoped requests when login/logout changes identity. */
  const sessionGenerationRef = useRef(0);
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
  const {
    models,
    selectedModelId,
    setSelectedModelId,
    refreshModels,
    applyModelForConversation,
    resetModels,
  } = useModelSelection(bridge, currentConversationId);
  const {
    agents,
    selectedAgentId,
    setSelectedAgentId,
    refreshAgents,
    agentNameById,
    resetAgents,
  } = useAgentSelection();

  const refreshConversations = useCallback(async () => {
    const generation = sessionGenerationRef.current;
    try {
      const list = await listConversations();
      if (generation !== sessionGenerationRef.current) return;
      const conversations = (Array.isArray(list) ? list : []).map((c) => ({
        ...c,
        title: c.title ?? undefined,
        created_at: c.created_at ?? undefined,
        updated_at: c.updated_at ?? undefined,
        messages: c.messages as Array<{ role?: string; content?: unknown }> | undefined,
      }));
      setState((s) => update(s, { conversations }));
    } catch (err) {
      console.warn('[conv] list failed:', (err as Error).message);
    }
  }, []);

  const refreshArtifacts = useCallback(async (sessionId?: string | null) => {
    const generation = sessionGenerationRef.current;
    const sid = sessionId || currentSessionId();
    if (!sid) {
      setState((s) => update(s, { artifacts: [] }));
      return;
    }
    try {
      const data = await listArtifacts(sid);
      if (generation !== sessionGenerationRef.current) return;
      setState((s) => update(s, { artifacts: data.artifacts || [] }));
    } catch (err) {
      console.warn('[artifacts] list failed:', (err as Error).message);
    }
  }, [currentSessionId]);

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
      if (cur.isStreaming || cur.abortCtrl) {
        setState((s) => {
          // Detach UI without aborting the underlying AbortController —
          // the stream fetch keeps running so the server run is not cancelled.
          const n = update(s, {
            isStreaming: false,
            // EntityBridge keeps the per-run controller while focus detaches.
            abortCtrl: null,
            streamGeneration: (s.streamGeneration || 0) + 1,
          });
          activeStreamGenRef.current = n.streamGeneration;
          return n;
        });
      }

      try {
        setStatus('Loading…', '#94a3b8');
        const conv = await getConversation(id);
        if (loadGeneration !== conversationLoadGenerationRef.current) return;
        const messages = normalizeServerMessages(conv.messages);
        const sessionId = conv.sandbox_session_id || null;

        bridge.focusConversation(conv.id);

        setState((s) => {
          // Focus switch without aborting abortCtrl (background run continues)
          const n = update(s, {
            conversationId: conv.id,
            messages,
            sessionId,
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

        await bridge.rehydrateConversation(conv.id);
        if (loadGeneration !== conversationLoadGenerationRef.current) return;
        applyModelForConversation(conv.id);

        if (sessionId) {
          await refreshArtifacts(sessionId);
          setStatus(`Session ${sessionId.slice(-8)}`);
        } else {
          setStatus('Agent Ready');
        }
      } catch (err) {
        if (loadGeneration !== conversationLoadGenerationRef.current) return;
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
      if (cur.isStreaming) return;

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
      const selectedModel = models.find(
        (model) => (model.model_id || model.id) === selectedModelId,
      );
      const hasImage = uploaded.some((attachment) =>
        String(attachment.mimeType || '').toLowerCase().startsWith('image/'),
      );
      const modalities = Array.isArray(selectedModel?.input_modalities)
        ? selectedModel.input_modalities.map(String)
        : [];
      if (hasImage && (!selectedModel || !modalities.includes('image'))) {
        flashError('Choose a vision-capable model before sending image attachments');
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
          messages: [...cur.messages, userMsg],
        });
        if (!created.run_id) throw new Error('Run response is missing run_id');
        runId = created.run_id;

        // A first turn has no client-side conversation/session yet. The create
        // response is therefore authoritative for the identity that subsequent
        // turns must reuse. Relying on a legacy `session` SSE event left these
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
            if (!isActiveGeneration(s, generation)) return s;
            const existingConversation = (s.conversations || []).find(
              (conversation) => conversation.id === createdConversationId,
            );
            const hasPriorUserMessage = cur.messages.some(
              (message) => message.role === 'user',
            );
            const existingTitle = String(existingConversation?.title || '')
              .trim()
              .toLowerCase();
            const hasPlaceholderTitle =
              !existingTitle ||
              existingTitle === 'new chat' ||
              existingTitle === 'new conversation';
            const shouldSetInitialTitle =
              Boolean(createdConversationId) &&
              (!cur.conversationId ||
                (!hasPriorUserMessage && hasPlaceholderTitle));
            const now = new Date().toISOString();
            const conversations = shouldSetInitialTitle
              ? [
                  {
                    ...existingConversation,
                    id: createdConversationId as string,
                    title: conversationTitleFromUserText(trimmed),
                    created_at: existingConversation?.created_at || now,
                    updated_at: now,
                  },
                  ...(s.conversations || []).filter(
                    (conversation) =>
                      conversation.id !== createdConversationId,
                  ),
                ]
              : s.conversations;
            const next = update(s, {
              ...(createdConversationId
                ? { conversationId: createdConversationId }
                : {}),
              ...(createdSessionId ? { sessionId: createdSessionId } : {}),
              ...(shouldSetInitialTitle ? { conversations } : {}),
            });
            stateRef.current = next;
            return next;
          });
          if (createdConversationId) {
            persistConversationId(createdConversationId);
            bridge.focusConversation(createdConversationId);
          }
        }
        // Stamp the optimistic user message with run id for stable ordering.
        setState((s) => {
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
        // stream may have omitted a tool_end event, so closure alone is not a
        // success signal.
        try {
          await bridge.reconcileRun(runId);
        } catch (reconcileErr) {
          console.warn('[chat] post-stream reconciliation failed:', reconcileErr);
        }

        // Commit this run's assistant projection into ChatState so later turns
        // keep history even if activeRunId moves to another server run.
        const projected = bridge.projectRunMessages(runId);
        const assistantCommitted = projected.filter(
          (m) =>
            m.role === 'assistant' &&
            (m.content.some(
              (p) =>
                p.type === 'text' &&
                'text' in p &&
                String((p as { text?: unknown }).text || '').trim(),
            ) ||
              Boolean(m._hasRuntimeSteps) ||
              Boolean(m.thinking) ||
              Boolean(m._fileLinks?.length)),
        );
        setState((s) => {
          if (!isActiveGeneration(s, generation)) return s;
          let messages = s.messages;
          if (assistantCommitted.length) {
            messages = [...messages];
            assistantCommitted.forEach((msg, assistantIndex) => {
              const rid = String(runId);
              const runAssistantIndexes = messages.flatMap((message, index) =>
                message.role === 'assistant' && message._runId === rid
                  ? [index]
                  : [],
              );
              const durableMatch =
                msg._messageId && msg._messageId !== ''
                  ? messages.findIndex(
                      (message) =>
                        message.role === 'assistant' &&
                        message._runId === rid &&
                        message._messageId === msg._messageId,
                    )
                  : -1;
              const existingIdx =
                durableMatch >= 0
                  ? durableMatch
                  : (runAssistantIndexes[assistantIndex] ?? -1);
              if (existingIdx >= 0) {
                messages[existingIdx] = { ...msg, _runId: rid };
                return;
              }
              // Insert after this run's user turn — never blind-append after a
              // newer user message that was already sent while we streamed.
              const userIdx = messages.findIndex(
                (message) =>
                  message.role === 'user' &&
                  message._runId != null &&
                  message._runId === rid,
              );
              const tagged = { ...msg, _runId: rid };
              const lastAssistantIdx = runAssistantIndexes.at(-1);
              if (lastAssistantIdx != null) {
                messages.splice(lastAssistantIdx + 1, 0, tagged);
              } else if (userIdx >= 0) {
                messages.splice(userIdx + 1, 0, tagged);
              } else {
                messages.push(tagged);
              }
            });
          }
          return update(s, {
            isStreaming: false,
            abortCtrl: null,
            messages,
          });
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
      models,
      selectedModelId,
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
        decide: decideApproval,
        markApproval: (id, status) => bridge.markApproval(id, status),
        setStatus,
        flashError,
      });
    },
    [bridge, setStatus, flashError],
  );

  const approvePending = useCallback(async () => {
    const store = bridge.getStore();
    const runId = store.activeRunId;
    const approval = Object.values(store.approvalsById).find(
      (item) => item.runId === runId && item.status === 'pending',
    );
    if (!approval?.id) {
      // Never silent no-op: banner can show waiting_approval from run.status alone
      // while the approval entity was never rehydrated into the store.
      flashError(
        'No pending approval loaded for this run. Open Approval Center or refresh the conversation.',
      );
      if (runId) {
        try {
          await bridge.reconcileRun(runId);
        } catch {
          /* reconcile is best-effort */
        }
      }
      return;
    }
    await resolveApproval(approval.id, 'approve');
  }, [bridge, resolveApproval, flashError]);

  const rejectPending = useCallback(async () => {
    const store = bridge.getStore();
    const runId = store.activeRunId;
    const approval = Object.values(store.approvalsById).find(
      (item) => item.runId === runId && item.status === 'pending',
    );
    if (!approval?.id) {
      flashError(
        'No pending approval loaded for this run. Open Approval Center or refresh the conversation.',
      );
      if (runId) {
        try {
          await bridge.reconcileRun(runId);
        } catch {
          /* reconcile is best-effort */
        }
      }
      return;
    }
    await resolveApproval(approval.id, 'reject');
  }, [bridge, resolveApproval, flashError]);

  const toggleInspector = useCallback(() => {
    setInspectorOpen((v) => !v);
  }, []);

  const login = useCallback(
    async (username: string, password: string) => {
      sessionGenerationRef.current += 1;
      const data = await apiLogin({ username, password });
      setState((s) =>
        update(s, { authReady: true, authUser: data.user || { username } }),
      );
      setStatus(`Logged in as ${data.user?.username || username}`);
      await refreshConversations();
      await refreshModels();
      await refreshAgents();
    },
    [setStatus, refreshConversations, refreshModels, refreshAgents],
  );

  const register = useCallback(
    async (username: string, password: string) => {
      sessionGenerationRef.current += 1;
      const data = await apiRegister({ username, password });
      clearPersistedChat();
      bridge.reset();
      setState((s) => update(s, {
        authReady: true,
        authUser: data.user || { username },
        conversationId: null,
        sessionId: null,
        messages: [],
        attachments: [],
      }));
      setStatus(`Registered as ${data.user?.username || username}`);
      await refreshConversations();
      await refreshModels();
      await refreshAgents();
    },
    [setStatus, refreshConversations, refreshModels, refreshAgents, bridge],
  );

  const logout = useCallback(async () => {
    try {
      await apiLogout();
      sessionGenerationRef.current += 1;
      conversationLoadGenerationRef.current += 1;

      const previous = stateRef.current;
      previous.abortCtrl?.abort();
      for (const attachment of previous.attachments) attachment.abortCtrl?.abort();

      // A logout is an identity boundary. Disconnect and discard all runtime
      // entities before the next account can render this provider.
      bridge.reset();
      clearPersistedChat();
      setDraftText('');
      setDropzoneVisible(false);
      resetModels();
      resetAgents();
      setInspectorOpen(false);
      setState(() => {
        const next = createState({
          ...INITIAL,
          sidebarOpen: previous.sidebarOpen,
          statusLabel: 'Logged out',
          statusColor: '#22c55e',
          authReady: true,
        });
        stateRef.current = next;
        activeStreamGenRef.current = next.streamGeneration;
        return next;
      });
    } catch (err) {
      flashError((err as Error).message || 'Logout failed');
    }
  }, [bridge, flashError]);

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

  // Boot
  useEffect(() => {
    let cancelled = false;

    async function boot() {
      const loadGeneration = ++conversationLoadGenerationRef.current;
      // Auth
      let authedUser: Awaited<ReturnType<typeof apiMe>> | null = null;
      try {
        const user = await apiMe();
        authedUser = user;
        if (!cancelled) setState((s) => update(s, { authReady: true, authUser: user }));
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          try { await apiLogout(); } catch { /* Anonymous logout is best-effort. */ }
        }
        if (!cancelled) setState((s) => update(s, { authReady: true, authUser: null }));
      }

      if (!authedUser || cancelled) return;

      try {
        await refreshConversations();
        await refreshModels();
        await refreshAgents();
      } catch (error) {
        console.warn('[boot] catalog restore failed:', (error as Error).message);
      }
      if (cancelled) return;

      // UI preference only: restore last conversation id, then load messages
      // from the server. Never fall back to LocalStorage message cache.
      const savedConvId = loadPersistedConversationId();
      if (savedConvId) {
        try {
          const conv = await getConversation(savedConvId);
          if (
            cancelled ||
            loadGeneration !== conversationLoadGenerationRef.current
          ) return;
          const messages = normalizeServerMessages(conv.messages);
          setState((s) =>
            update(s, {
              conversationId: conv.id,
              messages,
              sessionId: conv.sandbox_session_id || null,
            }),
          );
          persistConversationId(conv.id);
          bridge.focusConversation(conv.id);
          try {
            await bridge.rehydrateConversation(conv.id);
          } catch (error) {
            console.warn('[boot] timeline restore failed:', (error as Error).message);
            flashError('Conversation loaded, but activity history could not be restored');
          }
          if (
            cancelled ||
            loadGeneration !== conversationLoadGenerationRef.current
          ) return;
          applyModelForConversation(conv.id);
          if (conv.sandbox_session_id) {
            await refreshArtifacts(conv.sandbox_session_id);
            setStatus(`Session ${conv.sandbox_session_id.slice(-8)}`);
          }
          return;
        } catch {
          clearPersistedChat();
        }
      }
    }

    boot().catch((err) => console.warn('[boot]', err));
    return () => {
      cancelled = true;
    };
  }, [refreshConversations, refreshArtifacts, refreshModels, refreshAgents, setStatus, flashError, bridge, applyModelForConversation]);

  // Dispose entity SSE managers on unmount (page unload)
  useEffect(() => {
    return () => {
      bridge.dispose();
    };
  }, [bridge]);

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
   * - ChatState.messages holds user turns + committed server history
   * - EntityStore holds live run projections (assistant/tools) per run
   *
   * Project **all runs for this conversation** (not only activeRunId), so
   * starting a second turn does not drop the previous assistant reply.
   */
  const displayMessages = useMemo(() => {
    return projectConversationMessages({
      serverMessages: state.messages,
      conversationId: state.conversationId,
      store: entityStore,
      activeRunId,
      projectRunMessages: bridge.projectRunMessages,
    });
  }, [state.messages, state.conversationId, entityStore, activeRunId, bridge]);

  const canSend = canSendAttachments(state.attachments);

  const value: ChatController = {
    state,
    draftText,
    setDraftText,
    dropzoneVisible,
    models,
    selectedModelId,
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
    approvePending,
    rejectPending,
    resolveApproval,
    login,
    register,
    logout,
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
