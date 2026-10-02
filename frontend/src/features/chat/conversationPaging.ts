/**
 * 会话列表分页与去重逻辑（§2.4）。
 *
 * 独立于 ChatContext.tsx，以满足仓库代码行数限制，同时方便对增量加载去重、
 * 游标维护和状态机进行单元测试。
 */
import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { ConversationSummary, ChatState } from '../../shared/state/types';
import { listConversations } from '../../shared/api/client';
import type { IdentityRevision } from './identityRevision';
import { update } from '../../shared/state';

export const CONVERSATION_PAGE_SIZE = 30;

/**
 * 规范化服务端返回的会话数据结构。
 */
export function normalizeServerConversation(c: any): ConversationSummary {
  const id = String(c.conversation_id || c.id || '');
  return {
    ...c,
    id,
    title: c.title ?? undefined,
    created_at: c.created_at ?? undefined,
    updated_at: c.updated_at ?? undefined,
    messages: c.messages as Array<{ role?: string; content?: unknown }> | undefined,
  };
}

/**
 * 按 conversation_id / id 对增量拉取的会话进行去重追加（§2.4）。
 * 已存在的条目保留在原有位置（或最新位置），新加载的条目追加在末尾。
 */
export function appendConversations(
  existing: readonly ConversationSummary[] | null | undefined,
  incoming: readonly any[],
): ConversationSummary[] {
  const current = existing ? [...existing] : [];
  const seenIds = new Set(current.map((c) => c.id));
  const normalizedIncoming = incoming.map(normalizeServerConversation);

  for (const item of normalizedIncoming) {
    if (!item.id || seenIds.has(item.id)) continue;
    seenIds.add(item.id);
    current.push(item);
  }

  return current;
}

export interface UseConversationPagingOptions {
  sessionRevision: IdentityRevision;
  setState: Dispatch<SetStateAction<ChatState>>;
}

export interface ConversationPagingResult {
  hasMoreConversations: boolean;
  loadingMoreConversations: boolean;
  conversationPagingError: string | null;
  loadMoreConversations: () => Promise<void>;
  refreshConversations: () => Promise<void>;
}

/**
 * 管理会话列表分页游标与增量拉取的 Hook。
 */
export function useConversationPaging({
  sessionRevision,
  setState,
}: UseConversationPagingOptions): ConversationPagingResult {
  const nextCursorRef = useRef<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pagingError, setPagingError] = useState<string | null>(null);

  /**
   * 刷新会话列表首页（首屏 30 条）。
   */
  const refreshConversations = useCallback(async () => {
    const generation = sessionRevision.current();
    setPagingError(null);
    try {
      const page = await listConversations({ limit: CONVERSATION_PAGE_SIZE });
      if (!sessionRevision.isCurrent(generation)) return;

      nextCursorRef.current = page.next_cursor;
      setHasMore(Boolean(page.next_cursor));

      const conversations = (page.conversations || []).map(normalizeServerConversation);
      setState((s) => update(s, { conversations }));
    } catch (err) {
      if (sessionRevision.isCurrent(generation)) {
        const msg = (err as Error).message || '读取会话失败';
        console.warn('[conv] list failed:', msg);
        setPagingError(msg);
      }
    }
  }, [sessionRevision, setState]);

  /**
   * 触底增量拉取下一页（§2.4）。
   */
  const loadMoreConversations = useCallback(async () => {
    const cursor = nextCursorRef.current;
    if (!cursor || loadingMore) return;

    const generation = sessionRevision.current();
    setLoadingMore(true);
    setPagingError(null);

    try {
      const page = await listConversations({
        limit: CONVERSATION_PAGE_SIZE,
        cursor,
      });

      if (!sessionRevision.isCurrent(generation)) return;

      nextCursorRef.current = page.next_cursor;
      setHasMore(Boolean(page.next_cursor));

      setState((s) =>
        update(s, {
          conversations: appendConversations(s.conversations, page.conversations || []),
        }),
      );
    } catch (err) {
      if (sessionRevision.isCurrent(generation)) {
        const msg = (err as Error).message || '增量加载会话失败';
        console.warn('[conv] loadMore failed:', msg);
        setPagingError(msg);
      }
    } finally {
      if (sessionRevision.isCurrent(generation)) {
        setLoadingMore(false);
      }
    }
  }, [sessionRevision, setState, loadingMore]);

  return {
    hasMoreConversations: hasMore,
    loadingMoreConversations: loadingMore,
    conversationPagingError: pagingError,
    loadMoreConversations,
    refreshConversations,
  };
}
