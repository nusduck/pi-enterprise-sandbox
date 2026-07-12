/**
 * Chat application controller for the Agent Runtime Workbench.
 * Dual-writes legacy /chat SSE into the entity store via EntityBridge.
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
  sendChatMessage,
  uploadFile,
  ensureSession,
  listConversations,
  getConversation,
  deleteConversation,
  listArtifacts,
  decideApproval,
  getAuthToken,
  clearAuthToken,
  login as apiLogin,
  register as apiRegister,
  me as apiMe,
  cancelRun,
  steerRun as apiSteerRun,
  followUpRun as apiFollowUpRun,
  resumeApproval as apiResumeApproval,
} from '../../shared/api';
import { createEntityBridge, type EntityBridge } from './entityBridge';
import type { EntityStore } from '../../entities';
import type { SSEEvent } from '../../shared/sse/parser';

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
  ) => Promise<void>;
  // Auth
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string) => Promise<void>;
  logout: () => void;
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
  const [inspectorOpen, setInspectorOpen] = useState(() => !isMobile());

  // Always-current refs for async handlers
  const stateRef = useRef(state);
  stateRef.current = state;
  const activeStreamGenRef = useRef(0);
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
      // Runtime events have exactly one write path: legacy adapter -> reducer ->
      // EntityStore. Background runs keep updating when focus changes.
      if (runId) {
        try {
          bridge.ingestLegacyEvent(runId, ev);
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

      bridge.focusConversation(id);

      try {
        setStatus('Loading…', '#94a3b8');
        const conv = await getConversation(id);
        const messages = normalizeServerMessages(conv.messages);
        const sessionId = conv.sandbox_session_id || null;

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

        // Rehydrate any in-progress runs for this conversation (stub-safe)
        void bridge.rehydrateInProgress(conv.id).catch((err) => {
          console.warn('[entity] rehydrate failed:', (err as Error).message);
        });

        if (sessionId) {
          await refreshArtifacts(sessionId);
          setStatus(`Session ${sessionId.slice(-8)}`);
        } else {
          setStatus('Agent Ready');
        }
      } catch (err) {
        console.error('[conv] select failed:', err);
        flashError(`Failed to load conversation: ${(err as Error).message}`);
        setStatus('Agent Ready');
      }
    },
    [setStatus, flashError, refreshArtifacts, bridge],
  );

  const startNewChat = useCallback(async () => {
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
      // Open the single runtime entity path (synthetic id until POST /runs lands).
      const runId = bridge.beginRun({
        conversationId: cur.conversationId,
        sessionId: currentSessionId(),
      });
      bridge.attachTransport(runId, abortCtrl);

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
        await sendChatMessage(
          // Include user message we just added
          [...cur.messages, userMsg],
          (ev) => applySSE(ev, generation, runId),
          abortCtrl.signal,
          cur.conversationId,
        );

        setState((s) => {
          if (!isActiveGeneration(s, generation)) return s;
          return update(s, { isStreaming: false, abortCtrl: null });
        });
        await refreshConversations();
        await refreshArtifacts(currentSessionId());
      } catch (err) {
        const error = err as Error & { name?: string };
        if (error.name === 'AbortError') {
          bridge.interruptRun(runId, 'User stopped the run');
        } else {
          console.error('[chat] Error:', error);
          bridge.failRun(runId, error.message || 'Connection error');
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
        bridge.releaseTransport(runId);
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

  const cancelStream = useCallback(() => {
    // User-initiated Stop only — cancels the active fetch and entity SSE
    const runId = bridge.getStore().activeRunId;
    if (runId) bridge.abortRun(runId);
  }, [bridge]);

  const stopRun = useCallback(() => {
    const runId = bridge.getStore().activeRunId;
    cancelStream();
    if (runId) {
      void cancelRun(runId).then((ok) => {
        if (!ok) {
          // Soft-fail: local abort still applied
          console.warn('[runs] cancelRun soft-failed for', runId);
        }
      });
    }
    setStatus('Stopping…', '#f59e0b');
  }, [bridge, cancelStream, setStatus]);

  const steerRun = useCallback(
    async (text: string): Promise<boolean> => {
      const trimmed = text.trim();
      if (!trimmed) return false;
      const runId = bridge.getStore().activeRunId;
      if (!runId) {
        flashError('No active run to steer');
        return false;
      }
      try {
        const result = await apiSteerRun(runId, {
          text: trimmed,
          conversation_id: stateRef.current.conversationId,
        });
        if (!result.ok) {
          // Fallback: if API missing, surface error but keep draft
          flashError(result.error || 'Steer unavailable');
          return false;
        }
        setDraftText('');
        setStatus('Steered', '#3b82f6');
        return true;
      } catch (err) {
        flashError((err as Error).message || 'Steer failed');
        return false;
      }
    },
    [bridge, flashError, setStatus],
  );

  const followUpRun = useCallback(
    async (text: string): Promise<boolean> => {
      const trimmed = text.trim();
      if (!trimmed) return false;
      const runId = bridge.getStore().activeRunId;
      if (!runId) {
        flashError('No active run for follow-up');
        return false;
      }
      try {
        const result = await apiFollowUpRun(runId, {
          text: trimmed,
          conversation_id: stateRef.current.conversationId,
        });
        if (!result.ok) {
          flashError(result.error || 'Follow-up unavailable');
          return false;
        }
        setDraftText('');
        setStatus('Follow-up queued', '#8b5cf6');
        return true;
      } catch (err) {
        flashError((err as Error).message || 'Follow-up failed');
        return false;
      }
    },
    [bridge, flashError, setStatus],
  );

  /**
   * Resume entry for interrupted runs:
   * - waiting_approval → try resume-approval API
   * - otherwise focus composer so user can continue the conversation
   */
  const resumeInterrupted = useCallback(async () => {
    const runId = bridge.getStore().activeRunId;
    const store = bridge.getStore();
    const run = runId ? store.runsById[runId] : null;

    if (run?.status === 'waiting_approval' && runId) {
      try {
        const result = await apiResumeApproval(runId, {});
        if (result.ok) {
          setStatus('Resuming approval…', '#fbbf24');
          return;
        }
      } catch (err) {
        flashError((err as Error).message || 'Resume failed');
        return;
      }
    }

    // Rehydrate in-progress runs for this conversation (best-effort)
    const convId = stateRef.current.conversationId;
    if (convId) {
      try {
        await bridge.rehydrateInProgress(convId);
      } catch {
        /* stub-safe */
      }
    }

    setStatus('Ready to continue — type a message', '#22c55e');
    // Focus composer via known input id
    window.setTimeout(() => {
      const el = document.getElementById('input') as HTMLTextAreaElement | null;
      el?.focus();
    }, 0);
  }, [bridge, flashError, setStatus]);

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

  const runUploadForDraft = useCallback(
    async (localId: string) => {
      const draft = (stateRef.current.attachments || []).find(
        (a) => a.localId === localId,
      );
      if (!draft || !draft.file || draft.status === 'removed') return;

      const abortCtrl = new AbortController();
      setState((s) =>
        update(s, {
          attachments: patchAttachment(s.attachments, localId, {
            status: 'uploading',
            error: null,
            errorCode: null,
            abortCtrl,
          }),
        }),
      );

      try {
        const { sessionId } = await ensureConversationSession();
        if (!sessionId) throw new Error('No sandbox session');

        const current = (stateRef.current.attachments || []).find(
          (a) => a.localId === localId,
        );
        if (!current || current.status === 'removed') return;

        const result = await uploadFile(
          sessionId,
          current.file as File,
          abortCtrl.signal,
          {
            idempotencyKey: current.idempotencyKey,
            traceId: stateRef.current.traceId || undefined,
          },
        );

        const still = (stateRef.current.attachments || []).find(
          (a) => a.localId === localId,
        );
        if (!still || still.status === 'removed') return;

        setState((s) =>
          update(s, {
            attachments: patchAttachment(s.attachments, localId, {
              status: 'uploaded',
              attachmentId:
                result.attachment_id || result.attachmentId || null,
              path: result.path || null,
              size: result.size != null ? result.size : still.size,
              progress: 100,
              error: null,
              errorCode: null,
              traceId: result.trace_id || s.traceId || null,
              abortCtrl: null,
              file: still.file,
            }),
            ...(result.trace_id ? { traceId: result.trace_id } : {}),
          }),
        );
      } catch (err) {
        const error = err as Error & { name?: string; code?: string; traceId?: string };
        if (error.name === 'AbortError') return;
        console.error('[upload] Error:', error);
        const still = (stateRef.current.attachments || []).find(
          (a) => a.localId === localId,
        );
        if (!still || still.status === 'removed') return;
        const traceId = error.traceId || stateRef.current.traceId || null;
        setState((s) =>
          update(s, {
            attachments: patchAttachment(s.attachments, localId, {
              status: 'failed',
              error: error.message || 'Upload failed',
              errorCode: error.code || null,
              traceId,
              abortCtrl: null,
            }),
            ...(traceId ? { traceId } : {}),
          }),
        );
        const t = traceId ? ` [trace ${String(traceId).slice(0, 8)}]` : '';
        flashError(`Upload error: ${error.message || 'failed'}${t}`);
      }
    },
    [ensureConversationSession, flashError],
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
      setState((s) =>
        update(s, {
          attachments: [...(s.attachments || []), ...drafts],
        }),
      );

      await Promise.all(drafts.map((d) => runUploadForDraft(d.localId)));
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
      setState((s) =>
        update(s, {
          attachments: patchAttachment(s.attachments, localId, {
            status: 'queued',
            error: null,
            errorCode: null,
            progress: 0,
          }),
        }),
      );
      await runUploadForDraft(localId);
    },
    [flashError, runUploadForDraft],
  );

  const resolveApproval = useCallback(
    async (approvalId: string, decision: 'approve' | 'reject') => {
      if (!approvalId) return;
      try {
        await decideApproval(approvalId, decision);
        bridge.markApproval(
          approvalId,
          decision === 'approve' ? 'approved' : 'rejected',
        );
        setStatus(
          decision === 'approve' ? 'Approved' : 'Rejected',
          decision === 'approve' ? '#22c55e' : '#ef4444',
        );
      } catch (err) {
        flashError((err as Error).message);
      }
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

  const logout = useCallback(() => {
    clearAuthToken();
    setState((s) => update(s, { authUser: null }));
    setStatus('Logged out');
  }, [setStatus]);

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
      // Auth
      const token = getAuthToken();
      if (token) {
        try {
          const user = await apiMe();
          if (!cancelled) {
            setState((s) => update(s, { authUser: user }));
          }
        } catch {
          /* stale token */
        }
      }

      await refreshConversations();
      if (cancelled) return;

      // UI preference only: restore last conversation id, then load messages
      // from the server. Never fall back to LocalStorage message cache.
      const savedConvId = loadPersistedConversationId();
      if (savedConvId) {
        try {
          const conv = await getConversation(savedConvId);
          if (cancelled) return;
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
          // F2: rehydrate in-progress runs after refresh (API may be stub)
          void bridge.rehydrateInProgress(conv.id).catch(() => {
            /* endpoint may not exist yet */
          });
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
  }, [refreshConversations, refreshArtifacts, setStatus, bridge]);

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

  const displayMessages = useMemo(() => {
    if (!activeRunId) return state.messages;
    const run = entityStore.runsById[activeRunId];
    if (!run || (state.conversationId && run.conversationId !== state.conversationId)) {
      return state.messages;
    }
    const projected = bridge.projectRunMessages(activeRunId);
    const result = [...state.messages];
    for (const message of projected) {
      const text = message.content
        .filter((part) => part.type === 'text' && 'text' in part)
        .map((part) => String((part as { text?: unknown }).text || ''))
        .join('');
      let match = -1;
      for (let i = result.length - 1; i >= 0; i -= 1) {
        if (result[i].role !== message.role) continue;
        const existingText = result[i].content
          .filter((part) => part.type === 'text' && 'text' in part)
          .map((part) => String((part as { text?: unknown }).text || ''))
          .join('');
        if (existingText === text) {
          match = i;
          break;
        }
      }
      if (match >= 0) {
        // Replace matching server history with the richer entity projection
        // when it carries tool/artifact/interrupted runtime detail.
        if (
          message._fileLinks?.length ||
          message.content.some((part) => part.type === 'tool_use') ||
          message.interrupted
        ) {
          result[match] = message;
        }
      } else {
        result.push(message);
      }
    }
    return result;
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
