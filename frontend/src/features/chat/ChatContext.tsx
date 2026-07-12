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
  endStream,
  abortStream,
  errorStream,
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
import { handleSSEEvent, cloneCurrentMsg } from './sseHandler';
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
  /** Active run id for the current stream (entity layer). */
  activeRunId: string | null;
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
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
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
      if (store.activeRunId) setActiveRunId(store.activeRunId);
    });
  }
  const bridge = bridgeRef.current;

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
    const sid = sessionId || stateRef.current.sessionId;
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
  }, []);

  const applySSE = useCallback(
    (ev: SSEEvent, generation: number, runId?: string | null) => {
      // F2: always dual-write into entity store (even if UI generation is stale).
      // Background runs keep updating entities when the user switches conversations.
      if (runId) {
        try {
          bridge.ingestLegacyEvent(runId, ev);
        } catch (err) {
          console.warn('[entity] ingest failed:', (err as Error).message);
        }
      }

      setState((s) => {
        // UI layer: only apply to currentMsg when this generation is focused
        if (!isActiveGeneration(s, generation)) return s;
        const { state: next, effects } = handleSSEEvent(s, ev, generation);
        // Schedule side effects outside of setState
        Promise.resolve().then(() => {
          for (const fx of effects) {
            switch (fx.type) {
              case 'setStatus':
                setStatus(fx.text, fx.color);
                break;
              case 'flashError':
                flashError(fx.message);
                break;
              case 'refreshArtifacts':
                void refreshArtifacts(fx.sessionId);
                break;
              case 'showApproval':
                // pendingApproval already set on state
                break;
              default:
                break;
            }
          }
        });
        // Force React to see content mutations on currentMsg
        if (next.currentMsg && next.currentMsg === s.currentMsg) {
          return {
            ...next,
            currentMsg: cloneCurrentMsg(next.currentMsg),
          };
        }
        return { ...next };
      });
    },
    [setStatus, flashError, refreshArtifacts, bridge],
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
      // Only detach UI focus (bump generation so late events skip currentMsg).
      // Entity store continues receiving dual-written events for in-flight runs.
      if (cur.isStreaming || cur.abortCtrl) {
        setState((s) => {
          // Detach UI without aborting the underlying AbortController —
          // the stream fetch keeps running so the server run is not cancelled.
          const n = update(s, {
            isStreaming: false,
            // Keep abortCtrl so Stop can still cancel the background run
            currentMsg: null,
            pendingTool: null,
            pendingApproval: null,
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
            currentMsg: null,
            readyFiles: new Set(),
            artifacts: [],
            attachments: [],
            pendingTool: null,
            pendingApproval: null,
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
          currentMsg: null,
          pendingTool: null,
          pendingApproval: null,
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
        currentMsg: null,
        readyFiles: new Set(),
        artifacts: [],
        attachments: [],
        pendingTool: null,
        pendingApproval: null,
        traceId: null,
        isStreaming: false,
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
      // F2: open a run entity for dual-write (synthetic id until POST /runs lands)
      const runId = bridge.beginRun({
        conversationId: cur.conversationId,
        sessionId: cur.sessionId,
      });
      setActiveRunId(runId);

      setState((s) => {
        let n = update(s, {
          messages: [...s.messages, userMsg],
          attachments: [],
          pendingApproval: null,
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
          if (s.currentMsg) {
            const newMessages = [...s.messages, s.currentMsg];
            return endStream(s, { messages: newMessages });
          }
          return endStream(s);
        });
        await refreshConversations();
        await refreshArtifacts(stateRef.current.sessionId);
      } catch (err) {
        const error = err as Error & { name?: string };
        setState((s) => {
          if (!isActiveGeneration(s, generation)) return s;

          if (error.name === 'AbortError') {
            if (s.currentMsg) {
              const msg = {
                ...s.currentMsg,
                stopReason: 'aborted',
                interrupted: true,
                status: 'interrupted',
              };
              const messages = [...s.messages, msg];
              activeStreamGenRef.current = (s.streamGeneration || 0) + 1;
              return abortStream(s, { messages, currentMsg: null });
            }
            activeStreamGenRef.current = (s.streamGeneration || 0) + 1;
            return abortStream(s);
          }

          console.error('[chat] Error:', error);
          const trace = s.traceId ? ` [trace ${s.traceId.slice(0, 8)}]` : '';
          Promise.resolve().then(() =>
            flashError(`Connection error: ${error.message}${trace}`),
          );
          if (s.currentMsg) {
            const content = [
              ...s.currentMsg.content,
              { type: 'text' as const, text: `\n[Connection error: ${error.message}]` },
            ];
            const msg: ChatMessage = {
              ...s.currentMsg,
              content,
              interrupted: true,
              status: 'interrupted',
            };
            const messages = [...s.messages, msg];
            return errorStream(s, { messages, currentMsg: null });
          }
          return errorStream(s);
        });
      } finally {
        setState((s) => {
          if (!isActiveGeneration(s, generation)) return s;
          if (s.isStreaming) {
            return update(s, { isStreaming: false, abortCtrl: null });
          }
          return s;
        });
      }
    },
    [draftText, applySSE, flashError, refreshConversations, refreshArtifacts, bridge],
  );

  const cancelStream = useCallback(() => {
    // User-initiated Stop only — cancels the active fetch and entity SSE
    const ctrl = stateRef.current.abortCtrl;
    if (ctrl) ctrl.abort();
    const runId = bridge.getStore().activeRunId || activeRunId;
    if (runId) bridge.stopRun(runId);
  }, [bridge, activeRunId]);

  const stopRun = useCallback(() => {
    const runId = bridge.getStore().activeRunId || activeRunId;
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
  }, [bridge, activeRunId, cancelStream, setStatus]);

  const steerRun = useCallback(
    async (text: string): Promise<boolean> => {
      const trimmed = text.trim();
      if (!trimmed) return false;
      const runId = bridge.getStore().activeRunId || activeRunId;
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
    [bridge, activeRunId, flashError, setStatus],
  );

  const followUpRun = useCallback(
    async (text: string): Promise<boolean> => {
      const trimmed = text.trim();
      if (!trimmed) return false;
      const runId = bridge.getStore().activeRunId || activeRunId;
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
    [bridge, activeRunId, flashError, setStatus],
  );

  /**
   * Resume entry for interrupted runs:
   * - waiting_approval → try resume-approval API
   * - otherwise focus composer so user can continue the conversation
   */
  const resumeInterrupted = useCallback(async () => {
    const runId = bridge.getStore().activeRunId || activeRunId;
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
  }, [bridge, activeRunId, flashError, setStatus]);

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
        setState((s) =>
          update(s, {
            pendingApproval:
              s.pendingApproval?.id === approvalId ? null : s.pendingApproval,
          }),
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
    const approval = stateRef.current.pendingApproval;
    if (!approval?.id) return;
    await resolveApproval(approval.id, 'approve');
  }, [resolveApproval]);

  const rejectPending = useCallback(async () => {
    const approval = stateRef.current.pendingApproval;
    if (!approval?.id) return;
    await resolveApproval(approval.id, 'reject');
  }, [resolveApproval]);

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
    return state.currentMsg
      ? [...state.messages, state.currentMsg]
      : state.messages;
  }, [state.messages, state.currentMsg]);

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
    inspectorOpen,
    setInspectorOpen,
    toggleInspector,
  };

  return <ChatCtx.Provider value={value}>{children}</ChatCtx.Provider>;
}
