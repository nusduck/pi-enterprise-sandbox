import type { ReactNode } from 'react';
import s from './pageHeader.module.css';

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  action?: ReactNode;
  className?: string;
}

/**
 * 页面头部：标题 22px + 说明 13.5px + 右侧操作区（至多 1 主 1 次）。
 */
export function PageHeader({ title, description, actions, action, className = '' }: PageHeaderProps) {
  const renderedActions = actions ?? action;
  return (
    <header className={`${s.header} ${className}`}>
      <div className={s.titles}>
        <h1 className={s.title}>{title}</h1>
        {description ? <p className={s.description}>{description}</p> : null}
      </div>
      {renderedActions ? <div className={s.actions}>{renderedActions}</div> : null}
    </header>
  );
}
