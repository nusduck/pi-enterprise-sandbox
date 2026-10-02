/**
 * 待我审核邮件（design `notification-scenarios.md` §4.2）。
 *
 * 发给组织内持有 `reviewer` 角色、不是发起人本人的成员，每人一封。只放发起人
 * 显示名、交付物数量、时间与审核工作台链接，不放产物内容与模型输出。
 */

import type { MailMessage } from './smtp-mailer.js';
import { safeTaskTitle } from './run-completion-email.js';

export const NOTIFICATION_KIND_REVIEW_PENDING = 'review_pending';

function formatInstant(value: string | null): string {
  if (!value) return '—';
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return value;
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

export function buildReviewPendingEmail(input: {
  to: string;
  /** 会话标题；没有时用智能体名；都没有时调用方传 null，这里写「新的交付物」。 */
  title: string | null;
  requesterDisplayName: string | null;
  itemCount: number;
  taskCreatedAt: string | null;
  reviewsUrl: string;
}): MailMessage {
  const title = input.title ? safeTaskTitle(input.title) : null;
  const subjectTitle = title ?? '新的交付物';
  const requester = input.requesterDisplayName ? safeTaskTitle(input.requesterDisplayName) : '一位同事';
  return {
    to: input.to,
    subject: `【待审核】${subjectTitle} 有新的交付物待审核`,
    text: [
      '你好：',
      '',
      `${requester}发起的任务「${subjectTitle}」提交了 ${input.itemCount} 件交付物，等待人工审核。`,
      '',
      `提交时间：${formatInstant(input.taskCreatedAt)}`,
      `去审核：${input.reviewsUrl}`,
      '',
      '这封邮件在交付物提交审核时自动发送。可以在「账户设置」里关闭「待我审核」通知。',
    ].join('\n'),
  };
}
