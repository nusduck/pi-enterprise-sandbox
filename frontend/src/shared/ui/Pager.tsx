import { useCallback, useState, type ReactNode } from 'react';
import s from './pager.module.css';

export interface PagerProps {
  page: number;
  count: number;
  pageSize?: number;
  pageSizeOptions?: number[];
  onPageSizeChange?: (size: number) => void;
  onPrev: () => void;
  onNext: () => void;
  hasPrev: boolean;
  hasNext: boolean;
  loading?: boolean;
  className?: string;
}

export interface UseCursorPaginationOptions {
  initialPageSize?: number;
}

/**
 * 管理 cursor 翻页栈的 Hook。
 * 栈结构保证「上一页」可回溯历史游标，筛选变化调用 reset() 回到第 1 页。
 */
export function useCursorPagination(options: UseCursorPaginationOptions = {}) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(options.initialPageSize ?? 20);
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([null]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  const currentCursor = cursorStack[page - 1] ?? null;
  const hasPrev = page > 1;
  const hasNext = Boolean(nextCursor);

  const setPageData = useCallback((next_cursor: string | null) => {
    setNextCursor(next_cursor);
  }, []);

  const goToNextPage = useCallback(() => {
    if (!nextCursor) return;
    setCursorStack((prev) => {
      const nextStack = prev.slice(0, page);
      nextStack.push(nextCursor);
      return nextStack;
    });
    setPage((p) => p + 1);
    setNextCursor(null);
  }, [nextCursor, page]);

  const goToPrevPage = useCallback(() => {
    if (page <= 1) return;
    setPage((p) => p - 1);
    setNextCursor(cursorStack[page - 1] ?? null);
  }, [page, cursorStack]);

  const reset = useCallback(() => {
    setPage(1);
    setCursorStack([null]);
    setNextCursor(null);
  }, []);

  return {
    page,
    pageSize,
    setPageSize,
    currentCursor,
    hasPrev,
    hasNext,
    setPageData,
    goToNextPage,
    goToPrevPage,
    reset,
    cursorStack,
  };
}

/**
 * 分页页脚组件：「第 N 页 · 本页 M 条」+ 每页条数 + 上一页/下一页。
 */
export function Pager({
  page,
  count,
  pageSize,
  pageSizeOptions = [10, 20, 25, 50],
  onPageSizeChange,
  onPrev,
  onNext,
  hasPrev,
  hasNext,
  loading = false,
  className = '',
}: PagerProps) {
  return (
    <footer className={`${s.pager} ${className}`} aria-label="分页导航">
      <span className={s.summary}>
        第 {page} 页 · 本页 {count} 条
      </span>
      <div className={s.controls}>
        {pageSize && onPageSizeChange ? (
          <label className={s.pageSizeLabel}>
            <span>每页</span>
            <select
              className={s.pageSizeSelect}
              value={pageSize}
              onChange={(e) => onPageSizeChange(Number(e.target.value))}
              disabled={loading}
              aria-label="每页显示条数"
            >
              {pageSizeOptions.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <div className={s.buttons}>
          <button
            type="button"
            className={s.btn}
            onClick={onPrev}
            disabled={!hasPrev || loading}
            aria-label="上一页"
          >
            上一页
          </button>
          <button
            type="button"
            className={s.btn}
            onClick={onNext}
            disabled={!hasNext || loading}
            aria-label="下一页"
          >
            下一页
          </button>
        </div>
      </div>
    </footer>
  );
}
