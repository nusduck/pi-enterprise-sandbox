import type { ReactNode } from 'react';
import s from './formField.module.css';

export interface FormFieldProps {
  label: ReactNode;
  htmlFor?: string;
  required?: boolean;
  optional?: boolean;
  error?: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}

/**
 * 表单字段容器：标签在上（13px/550）、控件、说明或错误（role="alert"），默认字段间 16px。
 */
export function FormField({
  label,
  htmlFor,
  required,
  optional,
  error,
  hint,
  children,
  className = '',
}: FormFieldProps) {
  return (
    <div className={`${s.field} ${className}`}>
      <label htmlFor={htmlFor} className={s.label}>
        <span>{label}</span>
        {required ? <span className={s.required} aria-hidden="true">*</span> : null}
        {optional ? <span className={s.optional}>可选</span> : null}
      </label>
      <div className={s.control}>{children}</div>
      {error ? (
        <div role="alert" className={s.error}>
          {error}
        </div>
      ) : hint ? (
        <div className={s.hint}>{hint}</div>
      ) : null}
    </div>
  );
}
