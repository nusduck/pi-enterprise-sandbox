export type SentinelState = 'loading' | 'error' | 'end' | 'idle';

export interface SentinelStateInput {
  loading: boolean;
  hasMore: boolean;
  error?: string | null;
  showEndMessage?: boolean;
}

/**
 * 计算哨兵当前应该展示的三种尾部状态之一（或空闲 sentinel）：
 * 1. error -> 'error' (加载失败，展示重试)
 * 2. loading -> 'loading' (正在加载更多…)
 * 3. hasMore === false -> 'end' (没有更早的会话了)
 * 4. 正常空闲 -> 'idle' (挂载 IntersectionObserver)
 */
export function resolveSentinelState({
  loading,
  hasMore,
  error,
  showEndMessage = true,
}: SentinelStateInput): SentinelState {
  if (error) return 'error';
  if (loading) return 'loading';
  if (!hasMore && showEndMessage) return 'end';
  return 'idle';
}
