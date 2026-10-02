import type { ReactNode } from 'react';
import s from './segmentedControl.module.css';

export interface SegmentedControlItem<T extends string = string> {
  value: T;
  label: ReactNode;
  count?: number;
}

export interface SegmentedControlProps<T extends string = string> {
  items?: Array<SegmentedControlItem<T>>;
  options?: Array<SegmentedControlItem<T>>;
  value: T;
  onChange: (value: T) => void;
  ariaLabel?: string;
  'aria-label'?: string;
  className?: string;
}

/**
 * 分段控件：替代页面自写的筛选 tab，高度 28px，语义符合 WAI-ARIA tablist。
 */
export function SegmentedControl<T extends string = string>({
  items,
  options,
  value,
  onChange,
  ariaLabel,
  'aria-label': ariaLabelAttr,
  className = '',
}: SegmentedControlProps<T>) {
  const list = items ?? options ?? [];
  const label = ariaLabel ?? ariaLabelAttr;
  return (
    <div
      role="tablist"
      aria-label={label}
      className={`${s.container} ${className}`}
    >
      {list.map((item) => {
        const isSelected = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={isSelected}
            tabIndex={isSelected ? 0 : -1}
            className={`${s.tab} ${isSelected ? s.active : ''}`}
            onClick={() => onChange(item.value)}
          >
            <span>{item.label}</span>
            {item.count !== undefined && item.count !== null ? (
              <span className={s.count}>{item.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
