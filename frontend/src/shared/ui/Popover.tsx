import {
  useEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import { arrowFocusIndex, initialFocusIndex } from './popoverFocus';
import s from './popover.module.css';

export interface PopoverProps {
  open: boolean;
  onClose: () => void;
  triggerRef: RefObject<HTMLElement | null>;
  children: ReactNode;
  ariaLabel?: string;
  placement?: 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end';
  className?: string;
  style?: CSSProperties;
}

const FOCUSABLE_SELECTOR =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * 锚定弹层（非模态）。
 *
 * - 打开时把焦点移进弹层（规则见 `popoverFocus.ts`），否则键盘用户点开后焦点还在
 *   触发器上，弹层自己的按键处理永远收不到事件。
 * - Esc 在 document 上监听：焦点在触发器或弹层内都能关闭；关闭后焦点回到触发器。
 * - 点外部关闭时不抢焦点——用户点了别处，焦点就该留在别处。
 * - 方向键 / Home / End 在弹层内的可聚焦元素间循环移动。
 */
export function Popover({
  open,
  onClose,
  triggerRef,
  children,
  ariaLabel,
  placement = 'bottom-start',
  className = '',
  style,
}: PopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const wasOpenRef = useRef(false);
  /** 本次关闭是否由点外部触发；为 true 时不把焦点拉回触发器。 */
  const closedByOutsideRef = useRef(false);

  const focusables = () =>
    popoverRef.current
      ? Array.from(popoverRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      : [];

  // 打开：焦点移入弹层；关闭：除点外部外，焦点回到触发器。
  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      closedByOutsideRef.current = false;
      const items = focusables();
      const index = initialFocusIndex(items);
      (index >= 0 ? items[index] : popoverRef.current)?.focus();
      return;
    }
    if (wasOpenRef.current) {
      wasOpenRef.current = false;
      if (!closedByOutsideRef.current) triggerRef.current?.focus();
    }
  }, [open, triggerRef]);

  // 点外部关闭
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node;
      if (
        popoverRef.current &&
        !popoverRef.current.contains(target) &&
        (!triggerRef.current || !triggerRef.current.contains(target))
      ) {
        closedByOutsideRef.current = true;
        onClose();
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
    };
  }, [open, onClose, triggerRef]);

  // Esc 与方向键：挂在 document（捕获阶段），焦点在触发器上时也生效。
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      const active = document.activeElement;
      const inside =
        !!active &&
        (popoverRef.current?.contains(active) || triggerRef.current?.contains(active));
      if (!inside) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      const items = focusables();
      const next = arrowFocusIndex(e.key, items.indexOf(active as HTMLElement), items.length);
      if (next === null) return;
      // 搜索框里 Home/End 是移动光标，不抢。
      if ((e.key === 'Home' || e.key === 'End') && active instanceof HTMLInputElement) return;
      e.preventDefault();
      items[next].focus();
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [open, onClose, triggerRef]);

  if (!open) return null;

  return (
    <div
      ref={popoverRef}
      role="dialog"
      aria-label={ariaLabel}
      tabIndex={-1}
      className={`${s.popover} ${s[placement] || s['bottom-start']} ${className}`}
      style={style}
    >
      {children}
    </div>
  );
}
