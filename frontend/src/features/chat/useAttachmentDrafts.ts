/**
 * Controller hook for attachment drafts, drag-and-drop dropzone, and dataset uploads.
 */
import {
  useCallback,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import {
  update,
  patchAttachment,
  removeAttachment,
  validateNewAttachments,
  createAttachmentDraft,
  type ChatState,
} from '../../shared/state';
import { uploadDataset } from '../../shared/api';
import type { EntityBridge } from './entityBridge';
import { runUploadQueue } from './uploads/runUploadQueue';

export interface AttachmentDraftsDeps {
  stateRef: MutableRefObject<ChatState>;
  setState: Dispatch<SetStateAction<ChatState>>;
  bridge: EntityBridge;
  ensureConversationSession: () => Promise<{
    sessionId: string | null;
    conversationId: string | null;
  }>;
  flashError: (msg: string) => void;
}

export interface AttachmentDraftsController {
  dropzoneVisible: boolean;
  setDropzoneVisible: (visible: boolean) => void;
  runUploadForDraft: (
    localId: string,
    seed?: ChatState['attachments'][number],
  ) => Promise<void>;
  handleFilesSelected: (fileList: FileList | File[]) => Promise<void>;
  removeAttachmentDraft: (localId: string) => void;
  retryAttachmentDraft: (localId: string) => Promise<void>;
}

export function useAttachmentDrafts({
  stateRef,
  setState,
  bridge,
  ensureConversationSession,
  flashError,
}: AttachmentDraftsDeps): AttachmentDraftsController {
  const [dropzoneVisible, setDropzoneVisible] = useState(false);

  /**
   * Upload one draft. Prefer the optional `seed` draft: React setState is async,
   * so stateRef may not yet include drafts that were just enqueued.
   */
  const runUploadForDraft = useCallback(
    async (localId: string, seed?: ChatState['attachments'][number]) => {
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
    [ensureConversationSession, flashError, bridge, setState, stateRef],
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
    [flashError, runUploadForDraft, setState, stateRef],
  );

  const removeAttachmentDraft = useCallback((localId: string) => {
    setState((s) =>
      update(s, {
        attachments: removeAttachment(s.attachments, localId),
      }),
    );
  }, [setState]);

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
    [flashError, runUploadForDraft, setState, stateRef],
  );

  return {
    dropzoneVisible,
    setDropzoneVisible,
    runUploadForDraft,
    handleFilesSelected,
    removeAttachmentDraft,
    retryAttachmentDraft,
  };
}
