/**
 * 审核结果邮件（design `agent-output-review.md` §4 A3）。
 *
 * 与 Run 终态邮件同一纪律：只放结果、会话标题与一个链接，不放产物内容、不放审核
 * 反馈全文以外的自由文本。审核反馈是审核员写的，会进正文（发起人必须看到它），
 * 所以按 `safeTaskTitle` 的同一手法压平空白并去掉链接。
 */

import type { MailMessage } from './smtp-mailer.js';
import { safeTaskTitle } from './run-completion-email.js';

const MAX_FEEDBACK_CHARS = 500;

export const REVIEW_NOTIFICATION_KIND_RELEASED = 'review_released';
export const REVIEW_NOTIFICATION_KIND_REJECTED = 'review_rejected';

export function safeReviewFeedback(feedback: string | null | undefined): string {
  const cleaned = String(feedback ?? '')
    .replace(/\b(?:https?|ftp):\/\/\S+/gi, '…')
    .replace(/\bwww\.\S+/gi, '…')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  const chars = Array.from(cleaned);
  return chars.length > MAX_FEEDBACK_CHARS
    ? `${chars.slice(0, MAX_FEEDBACK_CHARS - 1).join('')}…`
    : cleaned;
}

export function buildReviewDecisionEmail(input: {
  to: string;
  approved: boolean;
  title: string | null;
  displayName: string | null;
  artifactNames: readonly string[];
  feedback: string | null;
  conversationUrl: string;
}): MailMessage {
  const title = safeTaskTitle(input.title);
  const greeting = input.displayName ? `${safeTaskTitle(input.displayName)}，你好：` : '你好：';
  const names = input.artifactNames.length > 0
    ? input.artifactNames.map((name) => `- ${safeTaskTitle(name)}`).join('\n')
    : '- （无交付物清单）';
  const lines = input.approved
    ? [
        greeting,
        '',
        `你发起的任务「${title}」的交付物已通过人工审核，现在可以在会话与产物库里查看：`,
        names,
        '',
        `查看：${input.conversationUrl}`,
      ]
    : [
        greeting,
        '',
        `你发起的任务「${title}」的交付物未通过人工审核，没有交付。`,
        names,
        '',
        `审核反馈：${safeReviewFeedback(input.feedback) || '（未填写）'}`,
        '',
        `你可以在会话里查看反馈并重新发起。查看：${input.conversationUrl}`,
      ];
  lines.push('', '这封邮件在审核结束时自动发送。可以在「账户设置」里关闭「审核结果」通知。');
  return {
    to: input.to,
    subject: input.approved
      ? `[交付物已通过审核] ${title}`
      : `[交付物未通过审核] ${title}`,
    text: lines.join('\n'),
  };
}
