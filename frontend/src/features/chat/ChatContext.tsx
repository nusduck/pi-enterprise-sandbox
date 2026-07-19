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
import {
  createRun as apiCreateRun,
  streamRunEvents,
  uploadDataset,
  ensureSession,
  listConversations,
  getConversation,
  deleteConversation,
  listArtifacts,
  decideApproval,
  login as apiLogin,
  register as apiRegister,
  logout as apiLogout,
  me as apiMe,
} from '../../shared/api';
import { createEntityBridge, type EntityBridge } from './entityBridge';
import type { EntityStore } from '../../entities';
import type { SSEEvent } from '../../shared/sse/parser';
import { projectConversationMessages } from './projections/conversationMessages';
import { runUploadQueue } from './uploads/runUploadQueue';
import { useRunControls } from './controllers/useRunControls';
import { resolveApprovalDecision } from './approvalDecision';

export type ChatController = {
  state: ChatState;
  draftText: string;
  setDraftText: (t: string) => void;
  dropzoneVisible: boolean;
  // Conversations
  selectConversation: (id: string) => Promise<void>;
  startNewChat: () => Promise<void>;
  removeConversation: (id: string) => Promise<void>;
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

  const refreshConversations = useCallback(async () => {
    try {
      const list = await listConversations();
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
    const sid = sessionId || currentSessionId();
    if (!sid) {
      setState((s) => update(s, { artifacts: [] }));
      return;
    }
    try {
      const data = await listArtifacts(sid);
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
      } else if (type === 'file_ready') {
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
    [setStatus, flashError, refreshArtifacts, bridge],
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
    setStatus('Agent Ready');
  }, [setStatus, bridge]);

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

      const userMsg = buildUserTurnWithAttachments(trimmed, cur.attachments);
      setDraftText('');

      const abortCtrl = new AbortController();
      let generation = 0;
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

      let runId: string | null = null;
      try {
        const created = await apiCreateRun({
          conversation_id: cur.conversationId,
          session_id: currentSessionId(),
          messages: [...cur.messages, userMsg],
        });
        if (!created.run_id) throw new Error('Run response is missing run_id');
        runId = bridge.beginRun({
          runId: created.run_id,
          conversationId: created.conversation_id || cur.conversationId,
          agentSessionId: created.agent_session_id || null,
          sessionId: created.session_id || currentSessionId(),
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
                (p.type === 'text' &&
                  'text' in p &&
                  String((p as { text?: unknown }).text || '').trim()) ||
                p.type === 'tool_use',
            ) ||
              Boolean(m._fileLinks?.length)),
        );
        setState((s) => {
          if (!isActiveGeneration(s, generation)) return s;
          let messages = s.messages;
          if (assistantCommitted.length) {
            messages = [...messages];
            for (const msg of assistantCommitted) {
              const exists = messages.some(
                (message) =>
                  message.role === 'assistant' &&
                  message._runId != null &&
                  message._runId === runId,
              );
              if (!exists) messages.push(msg);
            }
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
    ],
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
    if (!approval?.id) return;
    await resolveApproval(approval.id, 'approve');
  }, [bridge, resolveApproval]);

  const rejectPending = useCallback(async () => {
    const store = bridge.getStore();
    const runId = store.activeRunId;
    const approval = Object.values(store.approvalsById).find(
      (item) => item.runId === runId && item.status === 'pending',
    );
    if (!approval?.id) return;
    await resolveApproval(approval.id, 'reject');
  }, [bridge, resolveApproval]);

  const toggleInspector = useCallback(() => {
    setInspectorOpen((v) => !v);
  }, []);

  const login = useCallback(
    async (username: string, password: string) => {
      const data = await apiLogin({ username, password });
      setState((s) => update(s, { authUser: data.user || { username } }));
      setStatus(`Logged in as ${data.user?.username || username}`);
      await refreshConversations();
    },
    [setStatus, refreshConversations],
  );

  const register = useCallback(
    async (username: string, password: string) => {
      const data = await apiRegister({ username, password });
      setState((s) => update(s, { authUser: data.user || { username } }));
      setStatus(`Registered as ${data.user?.username || username}`);
      await refreshConversations();
    },
    [setStatus, refreshConversations],
  );

  const logout = useCallback(async () => {
    try {
      await apiLogout();
      setState((s) => update(s, { authUser: null }));
      setStatus('Logged out');
    } catch (err) {
      flashError((err as Error).message || 'Logout failed');
    }
  }, [flashError, setStatus]);

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
      try {
        const user = await apiMe();
        if (!cancelled) {
          setState((s) => update(s, { authUser: user }));
        }
      } catch {
        /* no active BFF session */
      }

      await refreshConversations();
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
  }, [refreshConversations, refreshArtifacts, setStatus, flashError, bridge]);

  // Dispose entity SSE managers on unmount (page unload)
  useEffect(() => {
    return () => {
      bridge.dispose();
    };
  }, [bridge]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'l') {
        e.preventDefault();
        void startNewChat();
      }
      if (e.ctrlKey && e.key === 'u') {
        e.preventDefault();
        // Triggered via composer upload button focus path — leave to Composer
      }
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
    selectConversation,
    startNewChat,
    removeConversation,
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
