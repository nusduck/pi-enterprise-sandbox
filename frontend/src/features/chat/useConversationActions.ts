/**
 * Conversation lifecycle actions: select, create, delete, restore, and artifact operations.
 */
import {
  useCallback,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import {
  update,
  abortStream,
  persistConversationId,
  loadPersistedConversationId,
  clearPersistedChat,
  normalizeServerMessages,
  type ChatState,
} from '../../shared/state';
import {
  ensureSession,
  getConversation,
  deleteConversation,
  listArtifacts,
  importArtifact as apiImportArtifact,
} from '../../shared/api';
import type { EntityBridge } from './entityBridge';
import type { IdentityRevision } from './identityRevision';
import {
  beginConversationRestore,
  finishConversationRestore,
  failConversationRestore,
} from './conversationLoading';
import { mergeConversation } from './conversationProjection';

export function isMobile(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(max-width: 768px)').matches;
}

export interface ConversationActionsDeps {
  stateRef: MutableRefObject<ChatState>;
  setState: Dispatch<SetStateAction<ChatState>>;
  activeStreamGenRef: MutableRefObject<number>;
  conversationLoadGenerationRef: MutableRefObject<number>;
  sessionRevision: IdentityRevision;
  bridge: EntityBridge;
  currentSessionId: () => string | null;
  setStatus: (text: string, color?: string) => void;
  flashError: (msg: string) => void;
  applyModelForConversation: (convId: string | null) => void;
  refreshConversations: () => Promise<void>;
}

export interface ConversationActions {
  refreshArtifacts: (sessionId?: string | null) => Promise<void>;
  selectConversation: (id: string) => Promise<void>;
  startNewChat: () => Promise<void>;
  removeConversation: (id: string) => Promise<void>;
  importArtifactToConversation: (
    artifactId: string,
    targetConversationId: string,
    targetFilename?: string | null,
  ) => Promise<void>;
  ensureConversationSession: () => Promise<{
    sessionId: string | null;
    conversationId: string | null;
  }>;
  restoreLastConversation: () => Promise<void>;
}

export function useConversationActions({
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
}: ConversationActionsDeps): ConversationActions {
  const refreshArtifacts = useCallback(
    async (sessionId?: string | null) => {
      const generation = sessionRevision.current();
      const conversationGeneration = conversationLoadGenerationRef.current;
      const sid = sessionId || currentSessionId();
      if (!sid) {
        setState((s) => update(s, { artifacts: [] }));
        return;
      }
      try {
        const data = await listArtifacts(sid);
        if (
          !sessionRevision.isCurrent(generation) ||
          conversationGeneration !== conversationLoadGenerationRef.current ||
          sid !== currentSessionId()
        ) {
          return;
        }
        setState((s) => {
          if (
            !sessionRevision.isCurrent(generation) ||
            conversationGeneration !== conversationLoadGenerationRef.current ||
            sid !== currentSessionId()
          ) {
            return s;
          }
          return update(s, { artifacts: data.artifacts || [] });
        });
      } catch (err) {
        console.warn('[artifacts] list failed:', (err as Error).message);
      }
    },
    [currentSessionId, sessionRevision, conversationLoadGenerationRef, setState],
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
    [
      stateRef,
      conversationLoadGenerationRef,
      bridge,
      setState,
      activeStreamGenRef,
      setStatus,
      flashError,
      applyModelForConversation,
      refreshArtifacts,
    ],
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
    [flashError, selectConversation, setStatus, setState, stateRef],
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
  }, [
    conversationLoadGenerationRef,
    stateRef,
    setState,
    activeStreamGenRef,
    bridge,
    applyModelForConversation,
    setStatus,
  ]);

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
    [stateRef, setState, activeStreamGenRef, startNewChat, flashError],
  );

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
  }, [stateRef, setState, setStatus, refreshConversations]);

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
      setState((s) =>
        update(s, {
          conversationId: conv.id,
          messages,
          sessionId: conv.sandbox_session_id || null,
          conversations: mergeConversation(s.conversations, conv),
        }),
      );
      persistConversationId(conv.id);
      bridge.focusConversation(conv.id);
      try {
        await bridge.rehydrateConversation(conv.id);
      } catch (error) {
        console.warn('[boot] timeline restore failed:', (error as Error).message);
        if (!stale()) {
          flashError('Conversation loaded, but activity history could not be restored');
        }
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
  }, [
    conversationLoadGenerationRef,
    sessionRevision,
    setState,
    bridge,
    flashError,
    applyModelForConversation,
    refreshArtifacts,
    setStatus,
  ]);

  return {
    refreshArtifacts,
    selectConversation,
    startNewChat,
    removeConversation,
    importArtifactToConversation,
    ensureConversationSession,
    restoreLastConversation,
  };
}
