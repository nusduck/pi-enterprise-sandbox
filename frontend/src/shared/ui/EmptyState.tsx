import { isValidElement, type ReactNode } from 'react';
import { Link } from 'react-router';
import s from './emptyState.module.css';

export type EmptyStateVariant = 'empty' | 'error' | 'forbidden';

export type EmptyStateAction =
  | ReactNode
  | {
      label: string;
      onClick?: () => void;
      to?: string;
    };

export interface EmptyStateProps {
  variant?: EmptyStateVariant;
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: EmptyStateAction;
  traceId?: string;
  onRetry?: () => void;
  className?: string;
}

function DefaultIcon({ variant }: { variant: EmptyStateVariant }) {
  if (variant === 'error') {
    return (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 9v4" />
        <path d="M12 17h.01" />
        <path d="M10.3 3.9L2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      </svg>
    );
  }
  if (variant === 'forbidden') {
    return (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="4" y="11" width="16" height="10" rx="2" />
        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      </svg>
    );
  }
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

/**
 * 空状态 / 加载失败 / 无权限组件：图标 + 标题 + 说明 + 可选动作。
 */
export function EmptyState({
  variant = 'empty',
  icon,
  title,
  description,
  action,
  traceId,
  onRetry,
  className = '',
}: EmptyStateProps) {
  const iconBoxClass = variant === 'error' ? s.iconBoxError : s.iconBoxNeutral;

  return (
    <div className={`${s.emptyState} ${className}`} role="status">
      <div className={`${s.iconBox} ${iconBoxClass}`}>
        {icon ?? <DefaultIcon variant={variant} />}
      </div>
      <div className={s.title}>{title}</div>
      {description || traceId ? (
        <div className={s.description}>
          {description}
          {traceId ? <span className={s.traceId}>trace {traceId}</span> : null}
        </div>
      ) : null}
      {action ? (
        <div className={s.action}>
          {isValidElement(action) || typeof action === 'string' || typeof action === 'number' ? (
            action
          ) : action && typeof action === 'object' && 'label' in action ? (
            (action as { to?: string; onClick?: () => void; label: string }).to ? (
              <Link to={(action as { to: string }).to} className={s.retryButton}>
                {(action as { label: string }).label}
              </Link>
            ) : (
              <button
                type="button"
                className={s.retryButton}
                onClick={(action as { onClick?: () => void }).onClick}
              >
                {(action as { label: string }).label}
              </button>
            )
          ) : null}
        </div>
      ) : onRetry ? (
        <div className={s.action}>
          <button type="button" className={s.retryButton} onClick={onRetry}>
            重试
          </button>
        </div>
      ) : null}
    </div>
  );
}
