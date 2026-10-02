import { useEffect, useRef, type ReactNode } from 'react';
import { resolveSentinelState, type SentinelState } from './loadMoreSentinelState';
import s from './loadMoreSentinel.module.css';

export * from './loadMoreSentinelState';

export interface LoadMoreSentinelProps {
  onLoadMore: () => void;
  loading: boolean;
  hasMore: boolean;
  error?: string | null;
  onRetry?: () => void;
  rootMargin?: string;
  endText?: ReactNode;
  loadingText?: ReactNode;
  showEndMessage?: boolean;
  className?: string;
}

/**
 * 增量加载哨兵：IntersectionObserver 触底 200px 自动拉下一页，展示三种尾部状态（加载中 / 失败重试 / 到底）。
 */
export function LoadMoreSentinel({
  onLoadMore,
  loading,
  hasMore,
  error,
  onRetry,
  rootMargin = '200px',
  endText = '没有更早的会话了',
  loadingText = '正在加载更多…',
  showEndMessage = true,
  className = '',
}: LoadMoreSentinelProps) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const state: SentinelState = resolveSentinelState({
    loading,
    hasMore,
    error,
    showEndMessage,
  });

  useEffect(() => {
    if (state !== 'idle' || !hasMore) return;
    const el = sentinelRef.current;
    if (!el) return;

    if (typeof IntersectionObserver === 'undefined') {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const first = entries[0];
        if (first?.isIntersecting) {
          onLoadMore();
        }
      },
      { rootMargin },
    );

    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [onLoadMore, state, rootMargin]);

  if (state === 'error') {
    return (
      <div className={`${s.stateBox} ${s.error} ${className}`} role="alert">
        <span>{error}</span>
        {onRetry ? (
          <button type="button" className={s.retryLink} onClick={onRetry}>
            重试
          </button>
        ) : null}
      </div>
    );
  }

  if (state === 'loading') {
    return (
      <div className={`${s.stateBox} ${s.loading} ${className}`} role="status">
        <svg
          className={s.spinner}
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
        >
          <path d="M21 12a9 9 0 1 1-6.2-8.6" />
        </svg>
        <span>{loadingText}</span>
      </div>
    );
  }

  if (state === 'end') {
    return (
      <div className={`${s.stateBox} ${s.end} ${className}`} role="status">
        <span>{endText}</span>
      </div>
    );
  }

  if (state === 'idle' && !hasMore) {
    return null;
  }

  // Active sentinel container while idle with more to load
  return <div ref={sentinelRef} className={s.sentinel} aria-hidden="true" />;
}
