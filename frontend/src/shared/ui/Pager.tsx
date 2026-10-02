import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { IconChevronDown, IconCheck } from './Icons';
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

interface MenuPosition {
  top?: number;
  bottom?: number;
  left: number;
  minWidth: number;
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
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<MenuPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const updatePosition = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const spaceAbove = rect.top;
    const spaceBelow = window.innerHeight - rect.bottom;
    const placeAbove = spaceAbove >= 150 || spaceAbove > spaceBelow;

    setMenuPos({
      left: Math.max(8, rect.left),
      top: placeAbove ? undefined : rect.bottom + 4,
      bottom: placeAbove ? window.innerHeight - rect.top + 4 : undefined,
      minWidth: Math.max(80, rect.width),
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    updatePosition();
    const handleScroll = (e: Event) => {
      if (menuRef.current && menuRef.current.contains(e.target as Node)) return;
      setOpen(false);
    };
    const handleResize = () => setOpen(false);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleResize);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node;
      if (
        menuRef.current &&
        !menuRef.current.contains(target) &&
        triggerRef.current &&
        !triggerRef.current.contains(target)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => {
      const selectedBtn = menuRef.current?.querySelector<HTMLButtonElement>(
        '[aria-selected="true"]',
      );
      (selectedBtn || menuRef.current?.querySelector<HTMLButtonElement>('button'))?.focus();
    });
  }, [open]);

  const handleTriggerKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (loading) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setOpen((prev) => !prev);
    }
  };

  const handleMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    const buttons = menuRef.current
      ? Array.from(menuRef.current.querySelectorAll<HTMLButtonElement>('button'))
      : [];
    const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = (currentIndex + 1) % buttons.length;
      buttons[next]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = (currentIndex - 1 + buttons.length) % buttons.length;
      buttons[prev]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      buttons[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      buttons[buttons.length - 1]?.focus();
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  const portalTarget = typeof document !== 'undefined' ? document.body : null;

  return (
    <footer className={`${s.pager} ${className}`} aria-label="分页导航">
      <span className={s.summary}>
        第 {page} 页 · 本页 {count} 条
      </span>
      <div className={s.controls}>
        {pageSize && onPageSizeChange ? (
          <div className={s.pageSizeLabel}>
            <span>每页</span>
            <button
              ref={triggerRef}
              type="button"
              className={s.pageSizeTrigger}
              onClick={() => {
                if (loading) return;
                setOpen((prev) => !prev);
              }}
              onKeyDown={handleTriggerKeyDown}
              disabled={loading}
              aria-label="每页显示条数"
              aria-haspopup="listbox"
              aria-expanded={open}
            >
              <span>{pageSize} 条</span>
              <IconChevronDown
                size={14}
                className={`${s.chevron} ${open ? s.chevronOpen : ''}`}
              />
            </button>
            {open && portalTarget && menuPos
              ? createPortal(
                  <div
                    ref={menuRef}
                    role="listbox"
                    aria-label="每页条数选项"
                    className={s.pageSizeMenu}
                    style={{
                      left: `${menuPos.left}px`,
                      top: menuPos.top !== undefined ? `${menuPos.top}px` : undefined,
                      bottom:
                        menuPos.bottom !== undefined ? `${menuPos.bottom}px` : undefined,
                      minWidth: `${menuPos.minWidth}px`,
                    }}
                    onKeyDown={handleMenuKeyDown}
                  >
                    {pageSizeOptions.map((opt) => {
                      const isSelected = opt === pageSize;
                      return (
                        <button
                          key={opt}
                          type="button"
                          role="option"
                          aria-selected={isSelected}
                          className={`${s.optionItem} ${isSelected ? s.optionSelected : ''}`}
                          onClick={() => {
                            onPageSizeChange(opt);
                            setOpen(false);
                            triggerRef.current?.focus();
                          }}
                        >
                          <span>{opt} 条</span>
                          {isSelected ? (
                            <IconCheck size={14} className={s.checkIcon} />
                          ) : null}
                        </button>
                      );
                    })}
                  </div>,
                  portalTarget,
                )
              : null}
          </div>
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
