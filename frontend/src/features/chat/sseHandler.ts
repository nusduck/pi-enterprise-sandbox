/**
 * SSE event reducer for legacy /chat stream events.
 * Pure-ish: returns a next state patch + side-effect descriptors.
 */
import type { SSEEvent } from '../../shared/sse/parser';
import type { ChatMessage, ChatState, ContentPart, FileLink } from '../../shared/state/types';
import { isActiveGeneration, update } from '../../shared/state/chatState';
import { getArtifactDownloadUrl, getDownloadUrl } from '../../shared/api/client';

export type SSESideEffect =
  | { type: 'setStatus'; text: string; color?: string }
  | { type: 'flashError'; message: string }
  | { type: 'refreshArtifacts'; sessionId: string }
  | { type: 'showApproval'; id: string; reason: string; generation: number }
  | { type: 'incBubble' }
  | { type: 'rerenderLast' };

export type SSEHandleResult = {
  state: ChatState;
  effects: SSESideEffect[];
};

/**
 * Apply one SSE event. Mutates currentMsg content in-place for token streaming
 * (same performance tradeoff as the legacy vanilla SPA).
 */
export function handleSSEEvent(
  state: ChatState,
  ev: SSEEvent,
  generation: number,
): SSEHandleResult {
  const effects: SSESideEffect[] = [];
  if (!isActiveGeneration(state, generation)) {
    return { state, effects };
  }

  let next = state;
  const type = String(ev.type || '');

  switch (type) {
    case 'trace':
      if (ev.trace_id) {
        next = update(next, { traceId: String(ev.trace_id) });
      }
      break;

    case 'session': {
      const sessionId = String(ev.session_id || '');
      next = update(next, { sessionId: sessionId || next.sessionId });
      if (ev.conversation_id) {
        next = update(next, { conversationId: String(ev.conversation_id) });
      }
      if (ev.trace_id) {
        next = update(next, { traceId: String(ev.trace_id) });
      }
      if (sessionId) {
        effects.push({
          type: 'setStatus',
          text: `Session ${sessionId.slice(-8)}`,
        });
        effects.push({ type: 'refreshArtifacts', sessionId });
      }
      break;
    }

    case 'token': {
      if (!next.currentMsg) break;
      const parts = next.currentMsg.content;
      const last = parts[parts.length - 1] as ContentPart | undefined;
      if (last && last.type === 'text' && 'text' in last) {
        last.text += String(ev.text || '');
      } else {
        parts.push({ type: 'text', text: String(ev.text || '') });
      }
      effects.push({ type: 'incBubble' });
      break;
    }

    case 'tool_start': {
      if (!next.currentMsg) break;
      next.currentMsg.content.push({
        type: 'tool_use',
        name: String(ev.name || 'tool'),
        input: ev.args || {},
        status: 'running',
      });
      next = update(next, {
        pendingTool: {
          id: ev.id != null ? String(ev.id) : undefined,
          name: ev.name != null ? String(ev.name) : undefined,
          args: ev.args,
        },
      });
      effects.push({ type: 'rerenderLast' });
      break;
    }

    case 'tool_end': {
      if (!next.currentMsg) break;
      for (let i = next.currentMsg.content.length - 1; i >= 0; i--) {
        const p = next.currentMsg.content[i];
        if (p.type === 'tool_use' && (p as { status?: string }).status === 'running') {
          (p as { status: string }).status = 'complete';
          (p as { isError?: boolean }).isError = Boolean(ev.isError);
          (p as { result?: unknown }).result = ev.result;
          break;
        }
      }
      next = update(next, { pendingTool: null });
      effects.push({ type: 'rerenderLast' });
      break;
    }

    case 'file_ready': {
      const artifactId = ev.artifact_id != null ? String(ev.artifact_id) : '';
      const path = ev.path != null ? String(ev.path) : '';
      const dedupeKey = artifactId || path;
      if (!next.sessionId || !dedupeKey || next.readyFiles.has(dedupeKey)) break;
      if (!artifactId && !path) break;

      const readyFiles = new Set(next.readyFiles);
      readyFiles.add(dedupeKey);
      next = update(next, { readyFiles });

      const name =
        (ev.name != null ? String(ev.name) : '') ||
        (path ? path.split('/').pop() : '') ||
        artifactId ||
        'file';
      const sessionId = next.sessionId;
      if (!sessionId) break;

      let url: string | null = null;
      if (artifactId) {
        url = getArtifactDownloadUrl(sessionId, artifactId);
      } else if (path) {
        url = getDownloadUrl(sessionId, path);
      }
      if (!url || !next.currentMsg) break;

      if (!next.currentMsg._fileLinks) next.currentMsg._fileLinks = [];
      const link: FileLink = {
        name,
        url,
        path: path || undefined,
        artifact_id: artifactId || undefined,
        mime_type: ev.mime_type != null ? String(ev.mime_type) : undefined,
        size: typeof ev.size === 'number' ? ev.size : undefined,
      };
      next.currentMsg._fileLinks.push(link);
      effects.push({ type: 'rerenderLast' });
      effects.push({ type: 'refreshArtifacts', sessionId });
      break;
    }

    case 'approval_required': {
      const approvalId = String(ev.approval_id || ev.id || '');
      if (!approvalId) break;
      const reason = String(ev.reason || ev.command || '');
      next = update(next, {
        pendingApproval: { id: approvalId, reason },
      });
      effects.push({
        type: 'showApproval',
        id: approvalId,
        reason: reason || approvalId,
        generation,
      });
      break;
    }

    case 'error': {
      const message = String(ev.message || ev.text || 'Unknown error');
      if (next.currentMsg) {
        next.currentMsg.content.push({
          type: 'text',
          text: `\n[Error: ${message}]`,
        });
        effects.push({ type: 'rerenderLast' });
      }
      effects.push({ type: 'flashError', message });
      break;
    }

    case 'done':
      break;

    case 'session_closed':
      effects.push({ type: 'setStatus', text: 'Session ended', color: '#64748b' });
      break;

    default:
      // Unknown event types are ignored (no side effects)
      break;
  }

  return { state: next, effects };
}

/** Clone currentMsg for React state immutability after in-place content mutation. */
export function cloneCurrentMsg(msg: ChatMessage | null): ChatMessage | null {
  if (!msg) return null;
  return {
    ...msg,
    content: msg.content.map((p) => ({ ...p })),
    _fileLinks: msg._fileLinks ? [...msg._fileLinks] : undefined,
  };
}
