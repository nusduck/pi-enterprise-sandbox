import type { ReactNode } from 'react';
import s from './statusBadge.module.css';

export type StatusBadgeVariant = 'running' | 'waiting' | 'success' | 'failed' | 'neutral';

export interface StatusBadgeProps {
  status: string;
  label?: ReactNode;
  variant?: StatusBadgeVariant;
  className?: string;
  title?: string;
}

export function resolveStatusVariant(status: string): StatusBadgeVariant {
  const norm = status.toLowerCase().trim();
  if (['running', 'in_progress', 'active', 'executing', 'streaming', 'starting', 'retrying', 'restoring_session', 'live', '运行中', '执行中', '启动中', '重试中', '恢复中', '进行中'].includes(norm)) {
    return 'running';
  }
  if (['pending', 'waiting', 'waiting_approval', 'waiting_input', 'interrupted', 'queued', 'accepted', '等待审批', '待审批', '等待中', '排队中', '等待回答', '已中断', '待处理', '中风险'].includes(norm)) {
    return 'waiting';
  }
  if (['success', 'completed', 'succeeded', 'approved', 'published', 'ready', 'ok', '成功', '已完成', '已发布', '已通过', '已批准', '正常', '可用', '低风险'].includes(norm)) {
    return 'success';
  }
  if (['failed', 'error', 'rejected', 'failure', 'revoked', 'err', 'high', 'critical', '失败', '错误', '已拒绝', '已驳回', '已吊销', '异常', '高风险', '极高风险'].includes(norm)) {
    return 'failed';
  }
  return 'neutral';
}

/**
 * 全站统一状态徽标：映射运行中/等待审批/成功/失败/已取消/草稿等状态。
 */
export function StatusBadge({ status, label, variant, className = '', title }: StatusBadgeProps) {
  const resolvedVariant = variant || resolveStatusVariant(status);
  const variantClass = s[resolvedVariant] || s.neutral;

  return (
    <span className={`${s.badge} ${variantClass} ${className}`} title={title || (typeof label === 'string' ? label : status)}>
      {label ?? status}
    </span>
  );
}
