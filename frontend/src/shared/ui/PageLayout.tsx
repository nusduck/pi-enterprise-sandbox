import type { ReactNode } from 'react';
import s from './pageLayout.module.css';

export interface PageLayoutProps {
  children: ReactNode;
  width?: 'list' | 'form' | 'full';
  className?: string;
}

/**
 * 页面骨架：统一内边距 32px 40px、统一左对齐、提供 list (1200px) / form (760px) 宽度变体。
 */
export function PageLayout({ children, width = 'list', className = '' }: PageLayoutProps) {
  const widthClass = width === 'form' ? s.form : width === 'full' ? s.full : s.list;
  return (
    <div className={`${s.layout} ${widthClass} ${className}`}>
      {children}
    </div>
  );
}
