import type { ReactNode } from 'react';
import s from './toolbar.module.css';

export interface ToolbarProps {
  children: ReactNode;
  className?: string;
}

/**
 * 工具栏：搜索、分段筛选、下拉与操作按钮容器，控件间距 12px，可换行。
 */
export function Toolbar({ children, className = '' }: ToolbarProps) {
  return (
    <div className={`${s.toolbar} ${className}`}>
      {children}
    </div>
  );
}
